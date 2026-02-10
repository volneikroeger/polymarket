import 'dotenv/config';
import { ClobClient } from '@polymarket/clob-client';
import { Wallet } from 'ethers';
import { logger } from './lib/logger.js';
import { getBtcSpotUsd } from './btcFeed.js';

type Parsed = { kind: 'ABOVE' | 'BELOW'; strike: number };

function parseBtcStrike(question: string): Parsed | null {
  const q = question.toLowerCase();
  const above =
    q.includes(' above ') ||
    q.includes(' over ') ||
    q.includes(' at least ') ||
    q.includes(' reach ') ||
    q.includes(' hit ') ||
    q.includes(' trade above ') ||
    q.includes(' >= ');
  const below = q.includes(' below ') || q.includes(' under ') || q.includes(' trade below ') || q.includes(' <= ');

  const kind: Parsed['kind'] | null = above ? 'ABOVE' : below ? 'BELOW' : null;
  if (!kind) return null;

  const m = question.match(/\$\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{3,7})/);
  if (!m) return null;
  const strike = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(strike) || strike <= 0) return null;
  return { kind, strike };
}

function pickOutcomeToken(tokens: any[], outcome: string): string | null {
  const t = (tokens || []).find((x) => String(x?.outcome).toLowerCase() === outcome.toLowerCase());
  const tokenId = t?.token_id;
  return tokenId ? String(tokenId) : null;
}

function clamp(n: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, n));
}

type PaperPosition = {
  tokenId: string;
  marketQuestion: string;
  side: 'BUY';
  outcome: 'Yes' | 'No';
  entryPrice: number;
  entryTsMs: number;
  notionalUsdc: number;
};

function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  const v = xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (xs.length - 1);
  return Math.sqrt(Math.max(0, v));
}

// Normal CDF approximation (good enough for v1 sizing/selection)
function normCdf(x: number): number {
  // Abramowitz-Stegun approximation via erf
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x) / Math.SQRT2;
  // erf approximation
  const t = 1 / (1 + 0.3275911 * ax);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const erf = 1 - (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t) * Math.exp(-ax * ax);
  return 0.5 * (1 + sign * erf);
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout after ${ms}ms (${label})`)), ms);
    p.then((v) => {
      clearTimeout(t);
      resolve(v);
    }).catch((e) => {
      clearTimeout(t);
      reject(e);
    });
  });
}

async function main() {
  const host = process.env.CLOB_HOST ?? 'https://clob.polymarket.com';
  const chainId = Number(process.env.CHAIN_ID ?? '137');

  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) throw new Error('Missing PRIVATE_KEY');

  const signatureType = Number(process.env.SIGNATURE_TYPE ?? '1');
  const funder = process.env.FUNDER && process.env.FUNDER.trim() ? process.env.FUNDER.trim() : undefined;

  const signer = new Wallet(privateKey);
  const client = new ClobClient(host, chainId as any, signer, undefined, signatureType as any, funder, undefined, true);

  const pollMs = Number(process.env.BTC_TRADER_POLL_MS ?? '15000');
  const maxPages = Number(process.env.BTC_TRADER_MAX_PAGES ?? '10');
  const targetCandidates = Number(process.env.BTC_TRADER_TARGET_CANDIDATES ?? '40');
  const clientTimeoutMs = Number(process.env.BTC_TRADER_CLIENT_TIMEOUT_MS ?? '12000');

  const maxSpreadAbs = Number(process.env.MAX_SPREAD_ABS ?? '0.01');

  // Market selection window (avoid stale/ancient markets and ultra-long dated ones)
  const minDaysToExpiry = Number(process.env.BTC_TRADER_MIN_DAYS_TO_EXPIRY ?? '2');
  const maxDaysToExpiry = Number(process.env.BTC_TRADER_MAX_DAYS_TO_EXPIRY ?? '14');

  // Risk knobs (paper)
  const maxActivePositions = Number(process.env.BTC_TRADER_MAX_ACTIVE_POSITIONS ?? '1');
  const usdcPerTrade = Number(process.env.BTC_TRADER_USDC_PER_TRADE ?? '1');
  const maxDailyNotionalUsdc = Number(process.env.BTC_TRADER_MAX_DAILY_NOTIONAL_USDC ?? '15');

  // Exit rules (token price moves)
  const takeProfitAbs = Number(process.env.BTC_TRADER_TAKE_PROFIT_ABS ?? '0.02');
  const stopLossAbs = Number(process.env.BTC_TRADER_STOP_LOSS_ABS ?? '0.02');
  const maxHoldMs = Number(process.env.BTC_TRADER_MAX_HOLD_MS ?? String(6 * 60 * 60 * 1000));

  // Entry rule: only if strike within this % of spot
  const maxStrikeDistPct = Number(process.env.BTC_TRADER_MAX_STRIKE_DIST_PCT ?? '0.08');

  // Momentum/vol window: last N samples.
  const momWindow = Number(process.env.BTC_TRADER_MOM_WINDOW ?? '20');
  const minEdgeAbs = Number(process.env.BTC_TRADER_MIN_EDGE_ABS ?? '0.03');
  const minSigmaStep = Number(process.env.BTC_TRADER_MIN_SIGMA_STEP ?? '0.0005');

  const btcHistory: number[] = [];

  let positions: PaperPosition[] = [];

  // Simple bankroll control: cap daily notional so a bad day can't spiral.
  let dailyNotionalUsdc = 0;
  let dailyWindowStartMs = Date.now();
  function resetDailyIfNeeded(nowMs: number) {
    if (nowMs - dailyWindowStartMs > 24 * 60 * 60 * 1000) {
      dailyWindowStartMs = nowMs;
      dailyNotionalUsdc = 0;
      logger.warn({ maxDailyNotionalUsdc }, 'reset BTC trader daily window');
    }
  }

  logger.warn(
    {
      pollMs,
      maxPages,
      targetCandidates,
      maxSpreadAbs,
      minDaysToExpiry,
      maxDaysToExpiry,
      maxActivePositions,
      usdcPerTrade,
      takeProfitAbs,
      stopLossAbs,
      maxHoldMs,
      maxStrikeDistPct,
      momWindow,
      btcFeed: process.env.BTC_FEED ?? 'coinbase,kraken,coingecko',
    },
    'starting BTC range TRADER (PAPER only for now)'
  );

  async function getMid(tokenId: string): Promise<number | null> {
    try {
      const m: any = await withTimeout((client as any).getMidpoint?.(tokenId), clientTimeoutMs, 'getMidpoint');
      const mid = Number(m?.midpoint ?? m?.price ?? m);
      if (!Number.isFinite(mid) || mid <= 0) return null;
      return mid;
    } catch {
      return null;
    }
  }

  async function getSpreadOk(tokenId: string): Promise<{ ok: boolean; bestBid?: number; bestAsk?: number; spread?: number }>{
    try {
      const book: any = await withTimeout((client as any).getOrderBook?.(tokenId), clientTimeoutMs, 'getOrderBook');
      const bids = Array.isArray(book?.bids) ? book.bids : [];
      const asks = Array.isArray(book?.asks) ? book.asks : [];
      const bestBid = bids.length ? Math.max(...bids.map((b: any) => Number(b.price)).filter((n: number) => Number.isFinite(n))) : NaN;
      const bestAsk = asks.length ? Math.min(...asks.map((a: any) => Number(a.price)).filter((n: number) => Number.isFinite(n))) : NaN;
      if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk)) return { ok: false };
      const spread = bestAsk - bestBid;
      return { ok: spread <= maxSpreadAbs, bestBid, bestAsk, spread };
    } catch {
      return { ok: false };
    }
  }

  function btcSma(): number | null {
    if (btcHistory.length < Math.max(3, momWindow)) return null;
    const w = btcHistory.slice(-momWindow);
    return w.reduce((a, b) => a + b, 0) / w.length;
  }

  function btcSigmaStep(): number | null {
    // Estimate per-sample log-return volatility over the last momWindow samples.
    if (btcHistory.length < Math.max(4, momWindow)) return null;
    const w = btcHistory.slice(-momWindow);
    const rets: number[] = [];
    for (let i = 1; i < w.length; i++) {
      const r = Math.log(w[i] / w[i - 1]);
      if (Number.isFinite(r)) rets.push(r);
    }
    const s = std(rets);
    if (!Number.isFinite(s) || s <= 0) return null;
    return Math.max(s, minSigmaStep);
  }

  function modelProbYes(kind: Parsed['kind'], spot: number, strike: number, daysToExpiry: number, sigmaStep: number, stepSec: number): number {
    // Very simple lognormal model with zero drift.
    const tSec = Math.max(60, daysToExpiry * 24 * 60 * 60);
    const sigmaT = sigmaStep * Math.sqrt(tSec / Math.max(1, stepSec));
    const d = Math.log(spot / strike) / Math.max(1e-9, sigmaT);
    const pAbove = clamp(normCdf(d), 0, 1);
    if (kind === 'ABOVE') return pAbove;
    // BELOW
    return 1 - pAbove;
  }

  async function scanCandidates(): Promise<
    { question: string; end: string; endMs: number; kind: 'ABOVE' | 'BELOW'; strike: number; tokenYes: string; tokenNo: string }[]
  > {
    const out: any[] = [];
    let cursor: string | undefined = undefined;

    for (let page = 0; page < maxPages; page++) {
      const resp: any = await withTimeout(client.getMarkets(cursor), clientTimeoutMs, 'getMarkets');
      const markets: any[] = resp?.data ?? [];
      cursor = resp?.next_cursor;

      const nowMs = Date.now();
      const minEndMs = nowMs + minDaysToExpiry * 24 * 60 * 60 * 1000;
      const maxEndMs = nowMs + maxDaysToExpiry * 24 * 60 * 60 * 1000;

      for (const m of markets) {
        if (!m?.accepting_orders || !m?.active || m?.closed || m?.archived) continue;
        let end = '';
        let endMs = NaN;
        {
          end = String(m?.end_date_iso ?? '');
          endMs = end ? Date.parse(end) : NaN;
          if (!Number.isFinite(endMs)) continue;
          if (endMs <= nowMs) continue;
          if (endMs < minEndMs || endMs > maxEndMs) continue;
        }
        const q = String(m?.question ?? '');
        const ql = q.toLowerCase();
        if (!(ql.includes('btc') || ql.includes('bitcoin'))) continue;

        const parsed = parseBtcStrike(q);
        if (!parsed) continue;

        const tokenYes = pickOutcomeToken(m.tokens, 'Yes');
        const tokenNo = pickOutcomeToken(m.tokens, 'No');
        if (!tokenYes || !tokenNo) continue;

        out.push({ question: q, end, endMs, ...parsed, tokenYes, tokenNo });
        if (out.length >= targetCandidates) return out;
      }

      if (!cursor) break;
    }

    return out;
  }

  while (true) {
    try {
      resetDailyIfNeeded(Date.now());
      logger.info({ openPositions: positions.length, dailyNotionalUsdc, maxDailyNotionalUsdc }, 'btc-range-trader tick start');

      const spot = await withTimeout(getBtcSpotUsd(), 12_000, 'btcFeed');
      btcHistory.push(spot.price);
      if (btcHistory.length > 500) btcHistory.splice(0, btcHistory.length - 500);

      const sma = btcSma();

      // 1) Manage exits
      const now = Date.now();
      const stillOpen: PaperPosition[] = [];
      for (const p of positions) {
        const mid = await getMid(p.tokenId);
        if (!mid) {
          stillOpen.push(p);
          continue;
        }
        const move = mid - p.entryPrice;
        const age = now - p.entryTsMs;

        const hitTp = move >= takeProfitAbs;
        const hitSl = move <= -stopLossAbs;
        const hitTime = age >= maxHoldMs;

        if (hitTp || hitSl || hitTime) {
          const pnl = (mid - p.entryPrice) * p.notionalUsdc; // rough, paper
          logger.warn(
            {
              market: p.marketQuestion,
              outcome: p.outcome,
              entry: p.entryPrice,
              exit: mid,
              move,
              ageMs: age,
              reason: hitTp ? 'take-profit' : hitSl ? 'stop-loss' : 'time-stop',
              pnlApproxUsdc: Number(pnl.toFixed(4)),
            },
            'PAPER EXIT'
          );
          continue;
        }

        stillOpen.push(p);
      }
      positions = stillOpen;

      // 2) Entries
      if (positions.length < maxActivePositions) {
        if (dailyNotionalUsdc + usdcPerTrade > maxDailyNotionalUsdc) {
          logger.warn({ dailyNotionalUsdc, usdcPerTrade, maxDailyNotionalUsdc }, 'daily bankroll cap reached; skipping entries');
        } else {
        const candidates = await scanCandidates();
        // score candidates: nearest strike to spot first
        const scored = candidates
          .map((c) => {
            const distPct = Math.abs(spot.price - c.strike) / spot.price;
            return { c, distPct };
          })
          .filter((x) => x.distPct <= maxStrikeDistPct)
          .sort((a, b) => a.distPct - b.distPct)
          .slice(0, 10);

        logger.info({ candidates: candidates.length, scored: scored.length, sma }, 'btc-range-trader candidates');

        const sigmaStep = btcSigmaStep();
        const stepSec = pollMs / 1000;

        for (const s of scored) {
          if (positions.length >= maxActivePositions) break;

          // Need some volatility estimate to avoid random entries.
          if (!sigmaStep) continue;

          const daysToExpiry = Math.max(0.01, (s.c.endMs - Date.now()) / (24 * 60 * 60 * 1000));
          const pYes = modelProbYes(s.c.kind, spot.price, s.c.strike, daysToExpiry, sigmaStep, stepSec);

          // Market-implied prices (midpoints).
          const midYes = await getMid(s.c.tokenYes);
          const midNo = await getMid(s.c.tokenNo);
          if (!midYes || !midNo) continue;

          const edgeYes = pYes - midYes;
          const edgeNo = (1 - pYes) - midNo;

          // Pick the better edge.
          const outcome: 'Yes' | 'No' = edgeYes >= edgeNo ? 'Yes' : 'No';
          const bestEdge = Math.max(edgeYes, edgeNo);

          if (bestEdge < minEdgeAbs) continue;

          const tokenId = outcome === 'Yes' ? s.c.tokenYes : s.c.tokenNo;

          // liquidity guard
          const sp = await getSpreadOk(tokenId);
          if (!sp.ok) {
            logger.info({ tokenId, spread: sp.spread, bestBid: sp.bestBid, bestAsk: sp.bestAsk }, 'skip candidate (spread)');
            continue;
          }

          const entryPrice = clamp(outcome === 'Yes' ? midYes : midNo, 0.0001, 0.9999);

          positions.push({
            tokenId,
            marketQuestion: s.c.question,
            side: 'BUY',
            outcome,
            entryPrice,
            entryTsMs: Date.now(),
            notionalUsdc: usdcPerTrade,
          });
          dailyNotionalUsdc += usdcPerTrade;

          logger.warn(
            {
              btc: spot.price,
              btcSource: spot.source,
              sma,
              sigmaStep,
              daysToExpiry: Number(daysToExpiry.toFixed(2)),
              kind: s.c.kind,
              strike: s.c.strike,
              distPct: Number(s.distPct.toFixed(4)),
              modelPYes: Number(pYes.toFixed(4)),
              midYes: Number(midYes.toFixed(4)),
              midNo: Number(midNo.toFixed(4)),
              edgeYes: Number(edgeYes.toFixed(4)),
              edgeNo: Number(edgeNo.toFixed(4)),
              minEdgeAbs,
              chosenOutcome: outcome,
              tokenId,
              entryPrice,
              spread: sp.spread,
              end: s.c.end,
            },
            'PAPER ENTRY'
          );
        }
      }
      }

      logger.info({ btc: spot.price, btcSource: spot.source, sma, openPositions: positions.length }, 'btc-range-trader tick');
    } catch (err) {
      logger.warn({ err }, 'btc-range-trader loop error');
    }

    await new Promise((r) => setTimeout(r, pollMs));
  }
}

main().catch((err) => {
  logger.error({ err }, 'fatal');
  process.exit(1);
});
