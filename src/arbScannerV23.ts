import 'dotenv/config';

import fs from 'node:fs/promises';
import yaml from 'yaml';
import { Wallet } from 'ethers';
import { ClobClient } from '@polymarket/clob-client';
import { logger } from './lib/logger.js';
import { ArbScannerV23Schema, type ArbScannerV23Config } from './lib/arbScannerConfig.js';
import { DEFAULT_TZ, loadRiskState, makeDayKey, newRiskState, saveRiskState, type RiskState } from './lib/riskState.js';

// =========================================================
// Arb Scanner V2.3 (profit-focused, safe rollout)
//
// Rollout rules (hard):
// - default PAPER + DRY_RUN (no orders)
// - LIVE requires: runtime.paper=false AND runtime.liveArmed=true AND runtime.dryRun=false
//   otherwise process.exit(3)
//
// Quant upgrades:
// - decision by TARGET SHARES using executable cost (walk book)
// - bufferedProfitUsdc and minRoiPct
// - quantitative unwind gate BEFORE leg1
// - marketable LIMIT price = worstPrice +/- execBufferAbs
// - config dump + validation (zod) + git commit
// =========================================================

type Side = 'BUY' | 'SELL';

type BookLevel = { price: number; size: number };

type Book = { bids: BookLevel[]; asks: BookLevel[]; tickSize: number };

type CandidateMarket = {
  conditionId: string;
  yes: { tokenId: string; outcome?: string };
  no: { tokenId: string; outcome?: string };
  score: number;
};

type CostResult = {
  shares: number;
  avgPrice: number;
  worstPrice: number;
  notionalUsdc: number;
};

type OrderStatus = {
  orderId: string;
  tokenId: string;
  side: Side;
  price: number;
  size: number;
  filledSize: number;
  remainingSize: number;
  status?: string;
};

function nowMs() {
  return Date.now();
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function clampToTick(price: number, tick: number): number {
  const t = Number.isFinite(tick) && tick > 0 ? tick : 0.01;
  const p = Math.min(1 - t, Math.max(t, price));
  return Math.round(p / t) * t;
}

function asArray(resp: any): any[] {
  if (Array.isArray(resp)) return resp;
  if (Array.isArray(resp?.data)) return resp.data;
  if (Array.isArray(resp?.markets)) return resp.markets;
  return [];
}

function parseBook(ob: any): Book {
  const bids: BookLevel[] = Array.isArray(ob?.bids)
    ? ob.bids
        .map((x: any) => ({ price: Number(x.price), size: Number(x.size) }))
        .filter((x: any) => Number.isFinite(x.price) && Number.isFinite(x.size) && x.price > 0 && x.size > 0)
    : [];

  const asks: BookLevel[] = Array.isArray(ob?.asks)
    ? ob.asks
        .map((x: any) => ({ price: Number(x.price), size: Number(x.size) }))
        .filter((x: any) => Number.isFinite(x.price) && Number.isFinite(x.size) && x.price > 0 && x.size > 0)
    : [];

  bids.sort((a: BookLevel, b: BookLevel) => b.price - a.price);
  asks.sort((a: BookLevel, b: BookLevel) => a.price - b.price);

  const tickSize = Number(ob?.tick_size ?? '0.01');
  return { bids, asks, tickSize: Number.isFinite(tickSize) && tickSize > 0 ? tickSize : 0.01 };
}

function sumTopAskNotionalUsdc(asks: BookLevel[], topN: number): number {
  return asks.slice(0, topN).reduce((a, l) => a + l.price * l.size, 0);
}

function sumTopBidNotionalUsdc(bids: BookLevel[], topN: number): number {
  return bids.slice(0, topN).reduce((a, l) => a + l.price * l.size, 0);
}

// =========================================================
// Executable cost (walk book) — by SHARES
// =========================================================

export function costToBuyShares(asks: BookLevel[], shares: number): CostResult | null {
  let remaining = shares;
  let got = 0;
  let spent = 0;
  let worst = 0;

  for (const l of asks) {
    if (remaining <= 1e-9) break;
    const p = l.price;
    const s = l.size;
    const take = Math.min(s, remaining);
    if (take <= 0) continue;

    got += take;
    spent += take * p;
    remaining -= take;
    worst = p;
  }

  if (got <= 0) return null;
  if (remaining > 1e-6) return null; // insufficient depth

  return { shares: got, avgPrice: spent / got, worstPrice: worst, notionalUsdc: spent };
}

export function costToSellShares(bids: BookLevel[], shares: number): CostResult | null {
  let remaining = shares;
  let sold = 0;
  let received = 0;
  let worst = 0;

  for (const l of bids) {
    if (remaining <= 1e-9) break;
    const p = l.price;
    const s = l.size;
    const take = Math.min(s, remaining);
    if (take <= 0) continue;

    sold += take;
    received += take * p;
    remaining -= take;
    worst = p;
  }

  if (sold <= 0) return null;
  if (remaining > 1e-6) return null;

  return { shares: sold, avgPrice: received / sold, worstPrice: worst, notionalUsdc: received };
}

// =========================================================
// Git/version
// =========================================================

async function tryGetGitCommitShort(): Promise<string | null> {
  try {
    const head = (await fs.readFile('/root/.openclaw/workspace/polymarket-copytrader/.git/HEAD', 'utf8')).trim();
    if (head.startsWith('ref:')) {
      const refPath = head.replace('ref:', '').trim();
      const ref = (await fs.readFile(`/root/.openclaw/workspace/polymarket-copytrader/.git/${refPath}`, 'utf8')).trim();
      return ref.slice(0, 8);
    }
    return head.slice(0, 8);
  } catch {
    return null;
  }
}

// =========================================================
// Client + execution
// =========================================================

async function createClient(): Promise<ClobClient> {
  const host = process.env.CLOB_HOST ?? 'https://clob.polymarket.com';
  const chainId = Number(process.env.CHAIN_ID ?? '137');

  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) throw new Error('Missing PRIVATE_KEY');

  const signatureType = Number(process.env.SIGNATURE_TYPE ?? '0');
  const funder = process.env.FUNDER && process.env.FUNDER.trim() ? process.env.FUNDER.trim() : undefined;

  const signer = new Wallet(privateKey);

  let creds: any = undefined;
  if (process.env.POLY_API_KEY && process.env.POLY_API_SECRET && process.env.POLY_API_PASSPHRASE) {
    creds = { key: process.env.POLY_API_KEY, secret: process.env.POLY_API_SECRET, passphrase: process.env.POLY_API_PASSPHRASE };
  }

  const useServerTime = process.env.USE_SERVER_TIME === 'true';
  return new ClobClient(host, chainId, signer, creds, signatureType as any, funder, undefined, useServerTime);
}

class Exec {
  public lastHttpErrorAtMs = 0;

  private orderTs: number[] = [];
  private cancelTs: number[] = [];

  constructor(private readonly client: ClobClient, private readonly cfg: ArbScannerV23Config) {}

  private prune60s(arr: number[]) {
    const cutoff = nowMs() - 60_000;
    while (arr.length && arr[0] < cutoff) arr.shift();
  }

  private canPlaceOrder(): boolean {
    this.prune60s(this.orderTs);
    return this.orderTs.length < this.cfg.risk.maxOrdersPerMinute;
  }

  private canCancel(): boolean {
    this.prune60s(this.cancelTs);
    return this.cancelTs.length < this.cfg.risk.maxCancelsPerMinute;
  }

  async l2Healthcheck() {
    const resp: any = await (this.client as any).getApiKeys?.();
    if (resp?.error) throw new Error(String(resp.error));
  }

  async getBook(tokenId: string): Promise<{ book: Book; fetchedAtMs: number; latencyMs: number } | null> {
    const t0 = nowMs();
    try {
      const ob: any = await (this.client as any).getOrderBook?.(tokenId);
      const fetchedAtMs = nowMs();
      const latencyMs = fetchedAtMs - t0;
      return { book: parseBook(ob), fetchedAtMs, latencyMs };
    } catch (err) {
      this.lastHttpErrorAtMs = nowMs();
      logger.debug({ err, tokenId }, 'getOrderBook failed');
      return null;
    }
  }

  async getOrder(orderId: string): Promise<OrderStatus | null> {
    try {
      const o: any = await (this.client as any).getOrder?.(orderId);
      if (!o) return null;

      const size = Number(o?.size ?? o?.original_size ?? o?.originalSize ?? o?.amount ?? 0);
      const filled = Number(o?.filled_size ?? o?.filledSize ?? o?.filled ?? 0);
      const remaining = Math.max(0, size - filled);

      const side = String(o?.side ?? '').toUpperCase();
      const tokenId = String(o?.tokenID ?? o?.tokenId ?? '');
      const price = Number(o?.price ?? 0);

      if (!orderId || !tokenId || (side !== 'BUY' && side !== 'SELL')) return null;
      if (!Number.isFinite(size) || size <= 0) return null;

      return {
        orderId,
        tokenId,
        side: side as Side,
        price,
        size,
        filledSize: Number.isFinite(filled) ? filled : 0,
        remainingSize: Number.isFinite(remaining) ? remaining : size,
        status: String(o?.status ?? ''),
      };
    } catch {
      return null;
    }
  }

  async getOpenOrders(): Promise<OrderStatus[]> {
    try {
      const resp: any = await (this.client as any).getOpenOrders?.();
      const rows = Array.isArray(resp) ? resp : resp?.orders ?? resp?.data ?? [];
      const out: OrderStatus[] = [];
      for (const o of rows) {
        const orderId = String(o?.orderID ?? o?.id ?? o?.orderId ?? '');
        const side = String(o?.side ?? '').toUpperCase();
        const tokenId = String(o?.tokenID ?? o?.tokenId ?? '');
        const price = Number(o?.price ?? 0);
        const size = Number(o?.size ?? o?.original_size ?? 0);
        const filled = Number(o?.filled_size ?? o?.filledSize ?? 0);
        if (!orderId || !tokenId || (side !== 'BUY' && side !== 'SELL')) continue;
        if (!Number.isFinite(size) || size <= 0) continue;
        out.push({
          orderId,
          tokenId,
          side: side as Side,
          price,
          size,
          filledSize: Number.isFinite(filled) ? filled : 0,
          remainingSize: Math.max(0, size - (Number.isFinite(filled) ? filled : 0)),
        });
      }
      return out;
    } catch {
      return [];
    }
  }

  async placeLimit(p: { marketKey?: string; tokenId: string; side: Side; price: number; size: number; tickSize: number; reason: string }): Promise<string | null> {
    const safePrice = clampToTick(p.price, p.tickSize);
    if (!Number.isFinite(p.size) || p.size <= 0) return null;

    // Local rate limit
    if (!this.canPlaceOrder()) {
      logger.error({ event: 'risk.reject', reason: 'maxOrdersPerMinute', max: this.cfg.risk.maxOrdersPerMinute, marketKey: p.marketKey, tokenId: p.tokenId }, 'rate limit: orders/min');
      return null;
    }

    // DRY RUN: never post.
    if (this.cfg.runtime.dryRun) {
      this.orderTs.push(nowMs());
      logger.warn({ ...p, safePrice }, 'DRY_RUN placeLimit (skipped posting)');
      return null;
    }

    // PAPER: simulate but do not post.
    if (this.cfg.runtime.paper) {
      this.orderTs.push(nowMs());
      const id = `paper_${Date.now()}_${Math.random().toString(16).slice(2)}`;
      logger.warn({ ...p, safePrice, orderId: id }, 'PAPER placeLimit');
      return id;
    }

    try {
      this.orderTs.push(nowMs());
      const order: any = await (this.client as any).createAndPostOrder?.(
        { tokenID: p.tokenId, price: safePrice, size: p.size, side: p.side } as any,
        { tickSize: p.tickSize.toString() as any, negRisk: false } as any
      );
      if (order?.error) {
        logger.error({ order, p }, 'order rejected');
        return null;
      }
      const orderId = String(order?.orderID ?? order?.id ?? order?.orderId ?? '');
      logger.info({ orderId, ...p, safePrice }, 'order placed');
      return orderId || null;
    } catch (err) {
      logger.error({ err, p }, 'placeLimit threw');
      return null;
    }
  }

  async cancel(orderId: string): Promise<boolean> {
    // In DRY_RUN/PAPER we don't cancel remotely.
    if (this.cfg.runtime.dryRun || this.cfg.runtime.paper) return true;

    if (!this.canCancel()) {
      logger.error({ event: 'risk.reject', reason: 'maxCancelsPerMinute', max: this.cfg.risk.maxCancelsPerMinute, orderId }, 'rate limit: cancels/min');
      return false;
    }

    try {
      this.cancelTs.push(nowMs());
      const resp: any = await (this.client as any).cancelOrder?.(orderId);
      if (resp?.error) return false;
      return true;
    } catch {
      return false;
    }
  }
}

// =========================================================
// Universe selection heuristic
// =========================================================

function scoreCandidateFromDisplayedPrices(m: any): number {
  const toks = Array.isArray(m?.tokens) ? m.tokens : [];
  if (toks.length !== 2) return -Infinity;
  const p0 = Number(toks[0]?.price);
  const p1 = Number(toks[1]?.price);
  if (!Number.isFinite(p0) || !Number.isFinite(p1)) return -Infinity;
  return 1 - (p0 + p1);
}

async function buildUniverse(cfg: ArbScannerV23Config, client: ClobClient): Promise<CandidateMarket[]> {
  const simsRaw: any = await (client as any).getSamplingSimplifiedMarkets?.();
  const sims = asArray(simsRaw);

  const cands: CandidateMarket[] = [];
  for (const m of sims) {
    if (!m?.active || m?.closed || m?.archived || !m?.accepting_orders) continue;
    const toks = Array.isArray(m?.tokens) ? m.tokens : [];
    if (toks.length !== 2) continue;

    const score = scoreCandidateFromDisplayedPrices(m);
    if (!Number.isFinite(score)) continue;

    const sumDisplayed = 1 - score;
    if (sumDisplayed > cfg.filter.maxDisplayedSum) continue;

    const yes = toks.find((t: any) => String(t?.outcome ?? '').toLowerCase() === 'yes') ?? toks[0];
    const no = toks.find((t: any) => String(t?.outcome ?? '').toLowerCase() === 'no') ?? toks[1];

    const yesId = String(yes?.token_id ?? yes?.tokenId ?? '');
    const noId = String(no?.token_id ?? no?.tokenId ?? '');
    if (!yesId || !noId) continue;

    cands.push({ conditionId: String(m.condition_id ?? ''), yes: { tokenId: yesId, outcome: yes?.outcome }, no: { tokenId: noId, outcome: no?.outcome }, score });
  }

  cands.sort((a, b) => b.score - a.score);
  return cands.slice(0, cfg.refresh.maxMarketsMonitored);
}

// =========================================================
// Decision + unwind gate (profit & risk)
// =========================================================

type Decision = {
  ok: boolean;
  reason?: string;
  targetShares?: number;
  yes?: { buy: CostResult; sellWorst?: CostResult; tickSize: number; bestAsk: number; bestBid: number };
  no?: { buy: CostResult; tickSize: number; bestAsk: number; bestBid: number };
  profit?: {
    expectedProfitUsdc: number;
    bufferedProfitUsdc: number;
    roiPct: number;
    feeCostUsdc: number;
    slippageCostUsdc: number;
  };
  unwind?: {
    unwindLossWorstUsdc: number;
    unwindLossWorstPct: number;
  };
};

function decide(cfg: ArbScannerV23Config, yes: Book, no: Book): Decision {
  const yesAsk = yes.asks[0]?.price;
  const yesBid = yes.bids[0]?.price;
  const noAsk = no.asks[0]?.price;
  const noBid = no.bids[0]?.price;

  if (![yesAsk, yesBid, noAsk, noBid].every((x) => Number.isFinite(x) && (x as number) > 0)) return { ok: false, reason: 'invalid top-of-book' };

  const yesSpread = (yesAsk as number) - (yesBid as number);
  const noSpread = (noAsk as number) - (noBid as number);
  if (yesSpread > cfg.filter.maxSpreadAbs || noSpread > cfg.filter.maxSpreadAbs) return { ok: false, reason: 'spread too wide' };

  if ((yesAsk as number) < cfg.filter.minBestAsk || (yesAsk as number) > cfg.filter.maxBestAsk) return { ok: false, reason: 'yes ask out of bounds' };
  if ((noAsk as number) < cfg.filter.minBestAsk || (noAsk as number) > cfg.filter.maxBestAsk) return { ok: false, reason: 'no ask out of bounds' };

  const yesAskNotionalTopN = sumTopAskNotionalUsdc(yes.asks, cfg.filter.topN);
  const noAskNotionalTopN = sumTopAskNotionalUsdc(no.asks, cfg.filter.topN);
  const yesBidNotionalTopN = sumTopBidNotionalUsdc(yes.bids, cfg.filter.topN);
  const noBidNotionalTopN = sumTopBidNotionalUsdc(no.bids, cfg.filter.topN);

  if (yesAskNotionalTopN < cfg.filter.minAskNotionalTopNUsdc || noAskNotionalTopN < cfg.filter.minAskNotionalTopNUsdc) {
    return { ok: false, reason: 'insufficient ask notional depth' };
  }

  // Unwind feasibility guard: require bids notional as well.
  if (yesBidNotionalTopN < cfg.filter.minBidNotionalTopNUsdc || noBidNotionalTopN < cfg.filter.minBidNotionalTopNUsdc) {
    return { ok: false, reason: 'insufficient bid notional depth (unwind risk)' };
  }

  // Propose targetShares from per-leg notional budget at current best asks.
  let targetShares = Math.min(cfg.arb.legNotionalUsdc / (yesAsk as number), cfg.arb.legNotionalUsdc / (noAsk as number));
  if (!Number.isFinite(targetShares) || targetShares <= 0) return { ok: false, reason: 'bad targetShares seed' };

  // Try to find feasible shares that have sufficient depth on both legs.
  let buyYes: CostResult | null = null;
  let buyNo: CostResult | null = null;
  for (let i = 0; i < 6; i++) {
    buyYes = costToBuyShares(yes.asks, targetShares);
    buyNo = costToBuyShares(no.asks, targetShares);
    if (buyYes && buyNo) break;
    targetShares = targetShares * 0.8;
  }

  if (!buyYes || !buyNo) return { ok: false, reason: 'insufficient depth for targetShares' };

  // Profit model
  const totalCostUsdc = buyYes.notionalUsdc + buyNo.notionalUsdc;
  const expectedProfitUsdc = buyYes.shares * 1.0 - totalCostUsdc;

  const feeCostUsdc = cfg.arb.feeBufferAbs * buyYes.shares;
  const slippageCostUsdc = cfg.arb.slippageBufferAbs * buyYes.shares;

  const bufferedProfitUsdc = expectedProfitUsdc - feeCostUsdc - slippageCostUsdc - cfg.arb.safetyMarginUsdc;
  const roiPct = totalCostUsdc > 0 ? bufferedProfitUsdc / totalCostUsdc : -1;

  if (bufferedProfitUsdc < cfg.arb.minProfitUsdc) return { ok: false, reason: 'bufferedProfit < minProfitUsdc' };
  if (roiPct < cfg.arb.minRoiPct) return { ok: false, reason: 'roiPct < minRoiPct' };

  // Unwind gate (worst-case): if we get stuck long YES, what is worst loss to sell YES immediately?
  const sellYes = costToSellShares(yes.bids, buyYes.shares);
  if (!sellYes) return { ok: false, reason: 'cannot unwind yes leg (insufficient bids)' };

  const unwindLossWorstUsdc = buyYes.notionalUsdc - sellYes.notionalUsdc;
  const unwindLossWorstPct = buyYes.notionalUsdc > 0 ? unwindLossWorstUsdc / buyYes.notionalUsdc : 1;

  if (unwindLossWorstUsdc > cfg.arb.maxUnwindLossUsdc) return { ok: false, reason: 'unwindLossWorstUsdc > maxUnwindLossUsdc' };
  if (unwindLossWorstPct > cfg.arb.maxUnwindLossPct) return { ok: false, reason: 'unwindLossWorstPct > maxUnwindLossPct' };

  return {
    ok: true,
    targetShares: buyYes.shares,
    yes: { buy: buyYes, sellWorst: sellYes, tickSize: yes.tickSize, bestAsk: yesAsk as number, bestBid: yesBid as number },
    no: { buy: buyNo, tickSize: no.tickSize, bestAsk: noAsk as number, bestBid: noBid as number },
    profit: { expectedProfitUsdc, bufferedProfitUsdc, roiPct, feeCostUsdc, slippageCostUsdc },
    unwind: { unwindLossWorstUsdc, unwindLossWorstPct },
  };
}

// =========================================================
// Two-leg executor (simplified for DRY_RUN/PAPER)
// =========================================================

async function pollFilled(exec: Exec, orderId: string, timeoutMs: number, pollIntervalMs: number): Promise<number> {
  const start = nowMs();
  while (nowMs() - start <= timeoutMs) {
    const st = await exec.getOrder(orderId);
    if (st) return Math.max(0, st.filledSize);
    await sleep(pollIntervalMs);
  }
  return 0;
}

type AlertFn = (text: string) => Promise<void>;

type OrderRecord = {
  orderId: string;
  marketKey: string;
  tokenId: string;
  side: Side;
  price: number;
  size: number;
};

type OrderRecorder = (rec: OrderRecord) => void;

type OppResult =
  | { status: 'skipped'; reason?: string }
  | {
      status: 'done';
      marketKey: string;
      shares: number;
      yes: { tokenId: string; buyPx: number; buyCostUsdc: number };
      no: { tokenId: string; buyPx: number; buyCostUsdc: number };
      lockedProfitUsdc: number;
      pnl_estimated: true;
    }
  | {
      status: 'failed';
      marketKey: string;
      sharesLeg1: number;
      yes: { tokenId: string; buyPx: number; buyCostUsdc: number };
      unwind?: { sellPx: number; soldShares: number; receivedUsdc: number; pnlUsdc: number; pnl_estimated: true };
      reason: string;
    };

async function runOpp(cfg: ArbScannerV23Config, exec: Exec, m: CandidateMarket, alert: AlertFn, recordOrder: OrderRecorder): Promise<OppResult> {
  const bYes0 = await exec.getBook(m.yes.tokenId);
  const bNo0 = await exec.getBook(m.no.tokenId);
  if (!bYes0 || !bNo0) return { status: 'skipped', reason: 'book fetch failed' };

  const d0 = decide(cfg, bYes0.book, bNo0.book);
  if (!d0.ok || !d0.targetShares || !d0.yes || !d0.no || !d0.profit || !d0.unwind) {
    logger.info({ event: 'decision.reject', conditionId: m.conditionId, reason: d0.reason }, 'arb v2.3 reject');
    return { status: 'skipped', reason: d0.reason };
  }

  logger.warn(
    {
      event: 'opp.detected',
      conditionId: m.conditionId,
      targetShares: d0.targetShares,
      totalCostUsdc: d0.yes.buy.notionalUsdc + d0.no.buy.notionalUsdc,
      profit: d0.profit,
      unwind: d0.unwind,
      yes: { bestAsk: d0.yes.bestAsk, worstBuy: d0.yes.buy.worstPrice, bestBid: d0.yes.bestBid },
      no: { bestAsk: d0.no.bestAsk, worstBuy: d0.no.buy.worstPrice, bestBid: d0.no.bestBid },
    },
    'ARB V2.3 opportunity'
  );

  await alert(
    `ARB opp detected\ncond=${m.conditionId}\nshares=${d0.targetShares.toFixed(4)}\nprofitBuffered=${d0.profit.bufferedProfitUsdc.toFixed(4)} USDC (roi=${(d0.profit.roiPct * 100).toFixed(2)}%)\nunwindWorst=${d0.unwind.unwindLossWorstUsdc.toFixed(4)} USDC`
  );

  // Revalidate before leg1
  if (cfg.arb.revalidateBeforeEachLeg) {
    const bYesR = await exec.getBook(m.yes.tokenId);
    const bNoR = await exec.getBook(m.no.tokenId);
    if (!bYesR || !bNoR) return { status: 'skipped', reason: 'revalidate book fetch failed' };
    const dR = decide(cfg, bYesR.book, bNoR.book);
    if (!dR.ok) {
      logger.warn({ event: 'opp.revalidate_fail', when: 'before_leg1', conditionId: m.conditionId, reason: dR.reason }, 'revalidate fail');
      return { status: 'skipped', reason: `revalidate before_leg1: ${dR.reason}` };
    }
  }

  // Marketable LIMIT price = worstPrice + execBufferAbs
  const leg1LimitPx = clampToTick(Math.min(0.999, d0.yes.buy.worstPrice + cfg.arb.execBufferAbs), d0.yes.tickSize);
  const leg2LimitPx = clampToTick(Math.min(0.999, d0.no.buy.worstPrice + cfg.arb.execBufferAbs), d0.no.tickSize);

  // DRY_RUN will stop inside placeLimit.
  const leg1Id = await exec.placeLimit({
    marketKey: m.conditionId,
    tokenId: m.yes.tokenId,
    side: 'BUY',
    price: leg1LimitPx,
    size: d0.targetShares,
    tickSize: d0.yes.tickSize,
    reason: 'arbv23_leg1_buy_yes',
  });

  if (leg1Id && !cfg.runtime.dryRun && !cfg.runtime.paper) {
    recordOrder({ orderId: leg1Id, marketKey: m.conditionId, tokenId: m.yes.tokenId, side: 'BUY', price: leg1LimitPx, size: d0.targetShares });
  }

  if (!leg1Id) {
    // In DRY_RUN/PAPER this is expected.
    return cfg.runtime.dryRun || cfg.runtime.paper ? { status: 'skipped', reason: 'no order placed (dryrun/paper or rate limit)' } : { status: 'failed', marketKey: m.conditionId, sharesLeg1: 0, yes: { tokenId: m.yes.tokenId, buyPx: leg1LimitPx, buyCostUsdc: 0 }, reason: 'leg1 place failed' };
  }

  const filled1 = await pollFilled(exec, leg1Id, cfg.arb.legFillTimeoutMs, cfg.arb.pollIntervalMsExec);
  if (filled1 <= 0) {
    await exec.cancel(leg1Id);
    logger.info({ event: 'leg1.no_fill', conditionId: m.conditionId, leg1Id }, 'leg1 no fill');
    return { status: 'skipped', reason: 'leg1 no fill' };
  }

  const fillPct = filled1 / d0.targetShares;
  if (fillPct < cfg.arb.maxPartialFillPct) {
    await exec.cancel(leg1Id);
    logger.warn({ event: 'leg1.partial_too_small', conditionId: m.conditionId, filled1, target: d0.targetShares, fillPct }, 'partial too small');
    return {
      status: 'failed',
      marketKey: m.conditionId,
      sharesLeg1: filled1,
      yes: { tokenId: m.yes.tokenId, buyPx: leg1LimitPx, buyCostUsdc: leg1LimitPx * filled1 },
      reason: 'leg1 partial too small',
    };
  }

  // Revalidate before leg2
  if (cfg.arb.revalidateBeforeEachLeg) {
    const bYesR = await exec.getBook(m.yes.tokenId);
    const bNoR = await exec.getBook(m.no.tokenId);
    if (!bYesR || !bNoR)
      return {
        status: 'failed',
        marketKey: m.conditionId,
        sharesLeg1: filled1,
        yes: { tokenId: m.yes.tokenId, buyPx: leg1LimitPx, buyCostUsdc: leg1LimitPx * filled1 },
        reason: 'revalidate before_leg2 book fetch failed',
      };
    const dR = decide(cfg, bYesR.book, bNoR.book);
    if (!dR.ok) {
      logger.error({ event: 'opp.revalidate_fail', when: 'before_leg2', conditionId: m.conditionId, reason: dR.reason }, 'revalidate fail');
      return {
        status: 'failed',
        marketKey: m.conditionId,
        sharesLeg1: filled1,
        yes: { tokenId: m.yes.tokenId, buyPx: leg1LimitPx, buyCostUsdc: leg1LimitPx * filled1 },
        reason: `revalidate before_leg2: ${dR.reason}`,
      };
    }
  }

  const leg2Id = await exec.placeLimit({
    marketKey: m.conditionId,
    tokenId: m.no.tokenId,
    side: 'BUY',
    price: leg2LimitPx,
    size: filled1,
    tickSize: d0.no.tickSize,
    reason: 'arbv23_leg2_buy_no',
  });

  if (leg2Id && !cfg.runtime.dryRun && !cfg.runtime.paper) {
    recordOrder({ orderId: leg2Id, marketKey: m.conditionId, tokenId: m.no.tokenId, side: 'BUY', price: leg2LimitPx, size: filled1 });
  }

  if (!leg2Id) {
    logger.error({ event: 'leg2.fail', conditionId: m.conditionId }, 'leg2 failed');
    return {
      status: 'failed',
      marketKey: m.conditionId,
      sharesLeg1: filled1,
      yes: { tokenId: m.yes.tokenId, buyPx: leg1LimitPx, buyCostUsdc: leg1LimitPx * filled1 },
      reason: 'leg2 place failed',
    };
  }

  const filled2 = await pollFilled(exec, leg2Id, cfg.arb.leg2TimeoutMs, cfg.arb.pollIntervalMsExec);
  if (filled2 >= filled1 - 1e-9) {
    logger.warn({ event: 'opp.complete', conditionId: m.conditionId, shares: filled1, leg1Id, leg2Id }, 'ARB V2.3 COMPLETE');
    await alert(`ARB complete\ncond=${m.conditionId}\nmatchedShares=${filled1.toFixed(4)}`);

    const yesCost = leg1LimitPx * filled1;
    const noCost = leg2LimitPx * filled1;
    const lockedProfitUsdc = filled1 * 1.0 - (yesCost + noCost);

    return {
      status: 'done',
      marketKey: m.conditionId,
      shares: filled1,
      yes: { tokenId: m.yes.tokenId, buyPx: leg1LimitPx, buyCostUsdc: yesCost },
      no: { tokenId: m.no.tokenId, buyPx: leg2LimitPx, buyCostUsdc: noCost },
      lockedProfitUsdc,
      pnl_estimated: true,
    };
  }

  await exec.cancel(leg2Id);
  logger.error({ event: 'leg2.timeout', conditionId: m.conditionId, filled1, filled2 }, 'leg2 timeout (one-leg risk)');

  const buyCost = leg1LimitPx * filled1;

  // Best-effort unwind: sell the filled YES back to bid (marketable limit).
  let unwind:
    | { sellPx: number; soldShares: number; receivedUsdc: number; pnlUsdc: number; pnl_estimated: true }
    | undefined;
  const yesBook = await exec.getBook(m.yes.tokenId);
  const bestBid = yesBook?.book?.bids?.[0]?.price;
  const tick = yesBook?.book?.tickSize ?? d0.yes.tickSize;

  if (yesBook && Number.isFinite(bestBid) && (bestBid as number) > 0) {
    const sellPx = clampToTick(Math.max(0.001, (bestBid as number) - cfg.arb.execBufferAbs), tick);
    const sellId = await exec.placeLimit({
      marketKey: m.conditionId,
      tokenId: m.yes.tokenId,
      side: 'SELL',
      price: sellPx,
      size: filled1,
      tickSize: tick,
      reason: 'arbv23_unwind_sell_yes',
    });

    if (sellId && !cfg.runtime.dryRun && !cfg.runtime.paper) {
      recordOrder({ orderId: sellId, marketKey: m.conditionId, tokenId: m.yes.tokenId, side: 'SELL', price: sellPx, size: filled1 });
    }

    if (sellId) {
      const sold = await pollFilled(exec, sellId, cfg.arb.leg2TimeoutMs, cfg.arb.pollIntervalMsExec);
      const received = sellPx * sold;
      const pnlUsdc = received - buyCost;
      unwind = { sellPx, soldShares: sold, receivedUsdc: received, pnlUsdc, pnl_estimated: true };
      logger.error({ event: 'unwind.attempt', conditionId: m.conditionId, filled1, sold, sellPx, sellId, pnlUsdc }, 'unwind attempted');
    }
  }

  await alert(`ARB unwind needed\ncond=${m.conditionId}\nleg2Timeout filled1=${filled1.toFixed(4)} filled2=${filled2.toFixed(4)}`);
  return {
    status: 'failed',
    marketKey: m.conditionId,
    sharesLeg1: filled1,
    yes: { tokenId: m.yes.tokenId, buyPx: leg1LimitPx, buyCostUsdc: buyCost },
    unwind,
    reason: 'leg2 timeout',
  };
}

// =========================================================
// Main
// =========================================================

async function loadConfigValidated(): Promise<{ cfg: ArbScannerV23Config; raw: any; path: string }> {
  const path = process.env.ARB_SCANNER_CONFIG_PATH ?? 'arb-scanner-v23.yml';
  const rawText = await fs.readFile(path, 'utf8');
  const raw = yaml.parse(rawText);

  const parsed = ArbScannerV23Schema.safeParse(raw);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Config invalid: ${msg}`);
  }

  return { cfg: parsed.data, raw, path };
}

async function main() {
  const commit = await tryGetGitCommitShort();
  const { cfg, path } = await loadConfigValidated();

  const telegram = {
    enabled: cfg.runtime.telegramEnabled === true,
    token: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID,
  };

  const sendTelegram = async (text: string) => {
    if (!telegram.enabled) return;
    if (!telegram.token || !telegram.chatId) return;
    try {
      const url = `https://api.telegram.org/bot${telegram.token}/sendMessage`;
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: telegram.chatId, text, disable_web_page_preview: true }),
      });
    } catch (err) {
      logger.warn({ err }, 'telegram send failed');
    }
  };

  // Rollout safety: do not allow live unless armed.
  if (cfg.runtime.paper === false && cfg.runtime.liveArmed !== true) {
    logger.error({ event: 'arming.reject', paper: cfg.runtime.paper, liveArmed: cfg.runtime.liveArmed }, 'LIVE requested but not armed; exiting');
    process.exit(3);
  }

  // Dump effective config + version
  logger.warn(
    {
      event: 'boot.config',
      commit,
      configPath: path,
      effective: cfg,
    },
    'arbScannerV2.3 config loaded'
  );

  await sendTelegram(`arb-scanner V2.3 boot: paper=${cfg.runtime.paper} dryRun=${cfg.runtime.dryRun} liveArmed=${cfg.runtime.liveArmed} commit=${commit ?? 'n/a'}`);

  const client = await createClient();
  const ex = new Exec(client, cfg);

  // L2 healthcheck only required when LIVE is armed.
  if (!cfg.runtime.paper && process.env.VERIFY_L2 === 'true') {
    await ex.l2Healthcheck();
    logger.warn({ event: 'boot.l2_ok' }, 'L2 healthcheck ok');
  }

  // ==============================
  // Risk engine state (V2.3.1)
  // ==============================
  const tz = DEFAULT_TZ;
  let risk: RiskState = await loadRiskState(cfg.risk.statePath, nowMs(), tz);
  logger.warn({ event: 'risk.state.load', statePath: cfg.risk.statePath, dayKey: risk.dayKey, realizedPnlUsdc: risk.realizedPnlUsdc, exposureTotalUsdc: risk.exposureTotalUsdc }, 'risk state loaded');

  const saveRisk = async (reason: string) => {
    // throttle saves
    const t0 = nowMs();
    if (t0 - (risk.lastSaveMs ?? 0) < 1000) return;
    risk.lastSaveMs = t0;
    await saveRiskState(cfg.risk.statePath, risk);
    logger.info({ event: 'risk.state.save', reason, statePath: cfg.risk.statePath }, 'risk state saved');
  };

  const dayRolloverIfNeeded = async () => {
    const t = nowMs();
    const dk = makeDayKey(tz, t);
    if (risk.dayKey !== dk) {
      logger.warn({ event: 'risk.day.rollover', from: risk.dayKey, to: dk, realizedPnlUsdc: risk.realizedPnlUsdc, exposureTotalUsdc: risk.exposureTotalUsdc }, 'daily rollover');
      risk = newRiskState(t, tz);
      await saveRisk('rollover');
    }
  };

  const halt = async (haltReason: string) => {
    const t = nowMs();
    risk.haltedUntilMs = Math.max(risk.haltedUntilMs ?? 0, t + cfg.risk.haltDurationMs);
    risk.haltReason = haltReason;
    logger.error(
      {
        event: 'risk.halt',
        haltReason,
        haltedUntil: risk.haltedUntilMs,
        snapshot: {
          exposureTotalUsdc: risk.exposureTotalUsdc,
          exposureByMarketUsdc: risk.exposureByMarketUsdc,
          realizedPnlUsdc: risk.realizedPnlUsdc,
          consecutiveUnwinds: risk.consecutiveUnwinds,
          httpErrorsInRow: risk.httpErrorsInRow,
          latencyBreachesInRow: risk.latencyBreachesInRow,
        },
      },
      'RISK HALT'
    );
    await sendTelegram(`RISK HALT: ${haltReason} until=${new Date(risk.haltedUntilMs).toISOString()}`);
    await saveRisk('halt');

    // Best-effort cancel open orders if LIVE.
    if (!cfg.runtime.paper && !cfg.runtime.dryRun) {
      const open = await ex.getOpenOrders();
      for (const o of open) {
        await ex.cancel(o.orderId);
      }
    }
  };

  const riskReject = (reason: string, marketKey?: string) => {
    const per = marketKey ? (risk.exposureByMarketUsdc?.[marketKey] ?? 0) : undefined;
    logger.info(
      {
        event: 'risk.reject',
        reason,
        marketKey,
        exposureTotalUsdc: risk.exposureTotalUsdc,
        exposurePerMarketUsdc: per,
        dailyPnlUsdc: risk.realizedPnlUsdc,
        consecutiveUnwinds: risk.consecutiveUnwinds,
        httpErrorsInRow: risk.httpErrorsInRow,
        feedStaleMs: cfg.risk.feedStaleMs,
      },
      'risk reject'
    );
  };

  // NOTE: per-minute rate limiting is handled inside Exec (placeLimit/cancel).

  const state = {
    inFlightOpps: 0,
    consecutiveFailures: 0,
  };

  let universe: CandidateMarket[] = [];
  let lastUniverseAt = 0;

  while (true) {
    await sleep(cfg.refresh.monitorPollMs);

    const t = nowMs();
    await dayRolloverIfNeeded();

    // Hard halt window
    if ((risk.haltedUntilMs ?? 0) > t) {
      continue;
    }

    if (state.consecutiveFailures >= cfg.risk.maxConsecutiveFailures) {
      await halt('maxConsecutiveFailures');
      continue;
    }

    // Daily loss enforcement (hard until day rollover)
    if (risk.realizedPnlUsdc <= -Math.abs(cfg.risk.maxDailyLossUsdc)) {
      await halt('maxDailyLossUsdc');
      continue;
    }

    // Exposure enforcement
    if (risk.exposureTotalUsdc > cfg.risk.maxOpenExposureUsdc) {
      await halt('maxOpenExposureUsdc');
      continue;
    }

    // Universe refresh
    if (universe.length === 0 || t - lastUniverseAt >= cfg.refresh.universeRefreshMs) {
      try {
        universe = await buildUniverse(cfg, client);
        lastUniverseAt = t;
        logger.warn({ event: 'universe.refreshed', selected: universe.length, top: universe.slice(0, 5).map((x) => ({ conditionId: x.conditionId, score: x.score })) }, 'universe refreshed');
      } catch (err) {
        state.consecutiveFailures += 1;
        logger.error({ event: 'universe.error', err }, 'universe refresh failed');
        continue;
      }
    }

    // open orders snapshot + exposure recompute
    const openOrders = await ex.getOpenOrders();

    // reconcile openOrdersById (best-effort)
    const seen = new Set<string>();
    for (const o of openOrders) {
      seen.add(o.orderId);
      const prev = risk.openOrdersById?.[o.orderId];
      risk.openOrdersById[o.orderId] = {
        orderId: o.orderId,
        marketKey: prev?.marketKey ?? null,
        tokenId: o.tokenId,
        side: o.side,
        price: o.price,
        remainingSize: o.remainingSize,
      };
    }
    for (const k of Object.keys(risk.openOrdersById ?? {})) {
      if (!seen.has(k)) delete risk.openOrdersById[k];
    }

    // recompute exposure = filled exposure + active orders
    const activeByMarket: Record<string, number> = {};
    let activeTotal = 0;
    for (const o of Object.values(risk.openOrdersById ?? {})) {
      const notional = Math.max(0, (Number(o.price) || 0) * (Number(o.remainingSize) || 0));
      activeTotal += notional;
      const mk = (o.marketKey ?? '__unknown__').toLowerCase();
      activeByMarket[mk] = (activeByMarket[mk] ?? 0) + notional;
    }

    const filledByMarket = risk.filledExposureByMarketUsdc ?? {};
    const exposureByMarket: Record<string, number> = {};
    const marketKeys = new Set([...Object.keys(activeByMarket), ...Object.keys(filledByMarket)]);
    let exposureTotal = 0;
    for (const mk of marketKeys) {
      const v = (activeByMarket[mk] ?? 0) + (filledByMarket[mk] ?? 0);
      exposureByMarket[mk] = v;
      exposureTotal += v;
    }

    risk.exposureByMarketUsdc = exposureByMarket;
    risk.exposureTotalUsdc = exposureTotal;

    // open orders cap
    if (cfg.risk.maxOpenOrders > 0 && openOrders.length > cfg.risk.maxOpenOrders) {
      await halt('maxOpenOrders');
      continue;
    }

    if (state.inFlightOpps >= cfg.arb.maxConcurrentOpps) continue;

    for (const m of universe) {
      // quick scan log (top-of-book) and basic feed latency guard
      const yes = await ex.getBook(m.yes.tokenId);
      const no = await ex.getBook(m.no.tokenId);

      if (!yes || !no) {
        risk.httpErrorsInRow = (risk.httpErrorsInRow ?? 0) + 1;
        if (risk.httpErrorsInRow >= cfg.risk.httpErrorsHaltThreshold) {
          await halt('httpErrorsInRow');
        } else {
          riskReject('httpErrorsInRow', m.conditionId);
        }
        await saveRisk('http error');
        continue;
      }

      // reset http error streak on success
      risk.httpErrorsInRow = 0;

      // book update timestamps (feed staleness checks)
      risk.lastBookUpdateMsByToken[m.yes.tokenId] = yes.fetchedAtMs;
      risk.lastBookUpdateMsByToken[m.no.tokenId] = no.fetchedAtMs;

      // latency kill switch
      const maxLat = Math.max(yes.latencyMs, no.latencyMs);
      if (maxLat > cfg.risk.latencyMaxMs) {
        risk.latencyBreachesInRow = (risk.latencyBreachesInRow ?? 0) + 1;
      } else {
        risk.latencyBreachesInRow = 0;
      }
      if (risk.latencyBreachesInRow >= cfg.risk.latencyMaxBreachesToHalt) {
        await halt('latencyMaxMs');
        continue;
      }

      // feed stale guard (do not enter new opps when feed stale)
      const yesAge = t - yes.fetchedAtMs;
      const noAge = t - no.fetchedAtMs;
      if (yesAge > cfg.risk.feedStaleMs || noAge > cfg.risk.feedStaleMs) {
        riskReject('feedStale', m.conditionId);
        await halt('feedStale');
        continue;
      }

      // market cooldown guard
      const cdUntil = risk.marketCooldownUntilMs?.[m.conditionId.toLowerCase()] ?? 0;
      if (cdUntil > t) {
        riskReject('marketCooldown', m.conditionId);
        continue;
      }

      // exposure per market guard
      // IMPORTANT: in this strategy YES+NO is a hedged pair; the main risk is one-leg exposure.
      // So the projection uses ONE LEG notional (conservative proxy) rather than 2 legs.
      const mkLower = m.conditionId.toLowerCase();
      const perMkt = risk.exposureByMarketUsdc?.[mkLower] ?? 0;
      const projectedOneLeg = perMkt + cfg.arb.legNotionalUsdc;
      if (perMkt > cfg.risk.maxExposurePerMarketUsdc || projectedOneLeg > cfg.risk.maxExposurePerMarketUsdc) {
        riskReject('maxExposurePerMarketUsdc', m.conditionId);
        continue;
      }

      const sumAskTop = (yes.book.asks[0]?.price ?? 0) + (no.book.asks[0]?.price ?? 0);
      logger.info({ event: 'scan.top', conditionId: m.conditionId, sumAskTop }, 'scan');

      // decision happens inside runOpp (re-fetches)
      state.inFlightOpps += 1;
      try {
        const recordOrder: OrderRecorder = (rec) => {
          const id = String(rec.orderId);
          if (!id) return;
          // Only LIVE can create real open orders.
          if (cfg.runtime.dryRun || cfg.runtime.paper) return;
          risk.openOrdersById[id] = {
            orderId: id,
            marketKey: rec.marketKey,
            tokenId: rec.tokenId,
            side: rec.side,
            price: rec.price,
            remainingSize: rec.size,
          };
        };

        const res = await runOpp(cfg, ex, m, sendTelegram, recordOrder);

        if (res.status === 'done') {
          // Cycle completed: treat profit as realized (LOCKED) but estimated=true.
          const feeSlippage = res.shares * (cfg.arb.feeBufferAbs + cfg.arb.slippageBufferAbs);
          const realized = res.lockedProfitUsdc - feeSlippage - cfg.arb.safetyMarginUsdc;
          risk.realizedPnlUsdc += realized;
          risk.realizedTrades += 1;
          risk.dailyNotionalUsdc += res.yes.buyCostUsdc + res.no.buyCostUsdc;

          // Exposure: YES+NO are hedged (offset), so for risk purposes treat as 0 open exposure.
          const mk = res.marketKey.toLowerCase();
          risk.filledExposureByMarketUsdc[mk] = 0;

          // unwind streak resets on clean completion
          risk.consecutiveUnwinds = 0;

          state.consecutiveFailures = Math.max(0, state.consecutiveFailures - 1);
          await saveRisk('opp.complete');

          logger.warn(
            {
              event: 'pnl.realized',
              marketKey: mk,
              realizedPnlUsdc: realized,
              realizedPnlUsdcTotal: risk.realizedPnlUsdc,
              pnl_estimated: true,
            },
            'realized pnl (estimated)'
          );
        } else if (res.status === 'failed') {
          state.consecutiveFailures += 1;

          const mk = res.marketKey.toLowerCase();
          const cooldown = cfg.risk.cooldownPerMarketMs ?? cfg.risk.marketCooldownMs;
          risk.marketCooldownUntilMs[mk] = nowMs() + cooldown;

          // track unwinds / one-leg risk
          if (res.unwind) {
            risk.consecutiveUnwinds = (risk.consecutiveUnwinds ?? 0) + 1;
            risk.realizedPnlUsdc += res.unwind.pnlUsdc;
            risk.realizedTrades += 1;

            // Exposure after unwind: conservative remaining exposure = max(0, buyCost - received)
            const left = Math.max(0, res.yes.buyCostUsdc - res.unwind.receivedUsdc);
            risk.filledExposureByMarketUsdc[mk] = left;

            logger.error(
              {
                event: 'unwind.done',
                marketKey: mk,
                pnlUsdc: res.unwind.pnlUsdc,
                remainingExposureUsdc: left,
                pnl_estimated: true,
                consecutiveUnwinds: risk.consecutiveUnwinds,
              },
              'unwind completed (estimated)'
            );
          } else if (res.sharesLeg1 > 0) {
            // Leg1 filled but no unwind executed: count as one-leg exposure.
            risk.consecutiveUnwinds = (risk.consecutiveUnwinds ?? 0) + 1;
            risk.filledExposureByMarketUsdc[mk] = (risk.filledExposureByMarketUsdc[mk] ?? 0) + res.yes.buyCostUsdc;
          }

          if (risk.consecutiveUnwinds >= cfg.risk.maxConsecutiveUnwinds) {
            await halt('maxConsecutiveUnwinds');
          }

          await saveRisk('opp failed');
        } else {
          // skipped
          state.consecutiveFailures = Math.max(0, state.consecutiveFailures - 1);
        }
      } catch (err) {
        state.consecutiveFailures += 1;
        logger.error({ event: 'opp.error', conditionId: m.conditionId, err }, 'opp threw');
      } finally {
        state.inFlightOpps -= 1;
      }

      // one attempt per tick
      break;
    }
  }
}

main().catch((err) => {
  logger.error({ err }, 'fatal');
  process.exit(1);
});
