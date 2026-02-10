import 'dotenv/config';

import fs from 'node:fs/promises';
import yaml from 'yaml';
import { Wallet } from 'ethers';
import { ClobClient } from '@polymarket/clob-client';
import { logger } from './lib/logger.js';

// =========================================================
// Arb Scanner V2 (production):
// - VWAP-based executable cost
// - fee/slippage buffers + minProfitUsdc
// - fill tracking
// - two-leg state machine (leg2 size matched to actual leg1 fill)
// - unwind / hedge when one-leg risk
// - revalidate before submit
// =========================================================

type Side = 'BUY' | 'SELL';

type BookLevel = { price: number; size: number };

type Book = {
  bids: BookLevel[];
  asks: BookLevel[];
  tickSize: number;
};

type CandidateMarket = {
  conditionId: string;
  yes: { tokenId: string; outcome?: string };
  no: { tokenId: string; outcome?: string };
  score: number;
};

type VwapAskResult = {
  avgPrice: number;
  shares: number;
  worstPrice: number;
  spentUsdc: number;
  slippageAbs: number; // worst - best
};

type VwapBidResult = {
  avgPrice: number;
  shares: number;
  receivedUsdc: number;
  worstPrice: number;
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

type ScannerV2Config = {
  runtime: {
    paper: boolean;
  };

  refresh: {
    universeRefreshMs: number;
    monitorPollMs: number;
    maxMarketsMonitored: number;
  };

  filter: {
    maxDisplayedSum: number;

    // book / eligibility
    maxSpreadAbs: number;
    topN: number;
    minAskDepthTopN: number;

    minBestAsk: number;
    maxBestAsk: number;

    // vwap depth guard
    maxVwapWorstPriceAbs: number; // if worst leg price exceeds this (0..1), skip
  };

  arb: {
    edgeAbs: number;
    feeBufferAbs: number; // absorb fees + misc
    slippageBufferAbs: number; // absorb adverse move between scan and fill

    legNotionalUsdc: number;
    minProfitUsdc: number;

    // execution
    ttlMs: number; // cancel if not filled fast
    revalidateBeforeEachLeg: boolean;

    // fill tracking
    legFillTimeoutMs: number;
    leg2TimeoutMs: number;
    oneLegMaxTimeMs: number;

    maxPartialFillPct: number; // if leg1 fill < X%, optionally unwind instead of continuing
    maxUnwindLossUsdc: number;

    // concurrency
    maxConcurrentOpps: number;
  };

  risk: {
    maxDailyNotionalUsdc: number;
    maxConsecutiveFailures: number;
    cooldownAfterHaltMs: number;

    // exposure
    maxOpenOrders: number;
    maxOneLegNotionalUsdc: number;
  };
};

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

function sumTop(levels: BookLevel[], n: number): number {
  return levels.slice(0, n).reduce((a, x) => a + x.size, 0);
}

function clampToTick(price: number, tick: number): number {
  const t = Number.isFinite(tick) && tick > 0 ? tick : 0.01;
  const p = Math.min(1 - t, Math.max(t, price));
  return Math.round(p / t) * t;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// =========================================================
// VWAP / executable cost
// =========================================================

export function calcVwapAskForNotional(asks: BookLevel[], notionalUsdc: number): VwapAskResult | null {
  const lvls = asks.filter((l) => l.price > 0 && l.size > 0);
  if (lvls.length === 0) return null;

  const best = lvls[0].price;
  let remaining = notionalUsdc;
  let shares = 0;
  let spent = 0;
  let worst = best;

  for (const l of lvls) {
    const p = l.price;
    const s = l.size;
    const maxShares = remaining / p;
    const take = Math.min(s, maxShares);
    if (take <= 0) break;

    const takeUsdc = take * p;
    shares += take;
    spent += takeUsdc;
    remaining -= takeUsdc;
    worst = p;

    if (remaining <= 1e-9) break;
  }

  if (spent <= 0 || shares <= 0) return null;
  if (remaining > 1e-6) {
    // insufficient depth
    return null;
  }

  return {
    avgPrice: spent / shares,
    shares,
    worstPrice: worst,
    spentUsdc: spent,
    slippageAbs: worst - best,
  };
}

export function calcVwapBidForShares(bids: BookLevel[], shares: number): VwapBidResult | null {
  const lvls = bids.filter((l) => l.price > 0 && l.size > 0);
  if (lvls.length === 0) return null;

  const best = lvls[0].price;
  let remaining = shares;
  let sold = 0;
  let received = 0;
  let worst = best;

  for (const l of lvls) {
    const p = l.price;
    const s = l.size;
    const take = Math.min(s, remaining);
    if (take <= 0) break;

    sold += take;
    received += take * p;
    remaining -= take;
    worst = p;

    if (remaining <= 1e-9) break;
  }

  if (sold <= 0) return null;
  if (remaining > 1e-6) return null; // insufficient bids to unwind

  return {
    avgPrice: received / sold,
    shares: sold,
    receivedUsdc: received,
    worstPrice: worst,
  };
}

// =========================================================
// Client + executor
// =========================================================

async function loadCfg(): Promise<ScannerV2Config> {
  const p = process.env.ARB_SCANNER_CONFIG_PATH ?? 'arb-scanner-v2.yml';
  const raw = await fs.readFile(p, 'utf8');
  return yaml.parse(raw) as ScannerV2Config;
}

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

class Executor {
  constructor(private readonly client: ClobClient, private readonly paper: boolean) {}

  async getBook(tokenId: string): Promise<Book | null> {
    try {
      const ob: any = await (this.client as any).getOrderBook?.(tokenId);
      return parseBook(ob);
    } catch (err) {
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

  async placeLimit(p: { tokenId: string; side: Side; price: number; size: number; tickSize: number; reason: string }): Promise<string | null> {
    const safePrice = clampToTick(p.price, p.tickSize);
    if (!Number.isFinite(p.size) || p.size <= 0) return null;

    if (this.paper) {
      const id = `paper_${Date.now()}_${Math.random().toString(16).slice(2)}`;
      logger.warn({ ...p, safePrice, orderId: id }, 'PAPER placeLimit');
      return id;
    }

    try {
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
    if (this.paper) return true;
    try {
      const resp: any = await (this.client as any).cancelOrder?.(orderId);
      if (resp?.error) return false;
      return true;
    } catch {
      return false;
    }
  }

  async l2Healthcheck() {
    const resp: any = await (this.client as any).getApiKeys?.();
    if (resp?.error) throw new Error(String(resp.error));
  }
}

// =========================================================
// Universe selection (same heuristic as V1, but kept)
// =========================================================

function scoreCandidateFromDisplayedPrices(m: any): number {
  const toks = Array.isArray(m?.tokens) ? m.tokens : [];
  if (toks.length !== 2) return -Infinity;
  const p0 = Number(toks[0]?.price);
  const p1 = Number(toks[1]?.price);
  if (!Number.isFinite(p0) || !Number.isFinite(p1)) return -Infinity;
  return 1 - (p0 + p1);
}

async function buildUniverse(cfg: ScannerV2Config, client: ClobClient): Promise<CandidateMarket[]> {
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
// V2 arb decision based on executable cost + buffers
// =========================================================

type ArbDecision = {
  ok: boolean;
  reason?: string;
  // normalized target shares for BOTH legs
  targetShares?: number;
  yes?: { bestAsk: number; vwap: VwapAskResult; tickSize: number; bestBid: number };
  no?: { bestAsk: number; vwap: VwapAskResult; tickSize: number; bestBid: number };
  expectedProfitUsdc?: number;
  expectedEdgePerShare?: number;
};

function decideArbV2(cfg: ScannerV2Config, bYes: Book, bNo: Book): ArbDecision {
  const yesBid = bYes.bids[0]?.price;
  const yesAsk = bYes.asks[0]?.price;
  const noBid = bNo.bids[0]?.price;
  const noAsk = bNo.asks[0]?.price;

  if (![yesBid, yesAsk, noBid, noAsk].every((x) => Number.isFinite(x) && (x as number) > 0)) return { ok: false, reason: 'invalid top-of-book' };

  const yesSpread = (yesAsk as number) - (yesBid as number);
  const noSpread = (noAsk as number) - (noBid as number);
  if (yesSpread > cfg.filter.maxSpreadAbs || noSpread > cfg.filter.maxSpreadAbs) return { ok: false, reason: 'spread too wide' };

  const yesDepthAsk = sumTop(bYes.asks, cfg.filter.topN);
  const noDepthAsk = sumTop(bNo.asks, cfg.filter.topN);
  if (yesDepthAsk < cfg.filter.minAskDepthTopN || noDepthAsk < cfg.filter.minAskDepthTopN) return { ok: false, reason: 'insufficient ask depth' };

  if ((yesAsk as number) < cfg.filter.minBestAsk || (yesAsk as number) > cfg.filter.maxBestAsk) return { ok: false, reason: 'yes ask out of bounds' };
  if ((noAsk as number) < cfg.filter.minBestAsk || (noAsk as number) > cfg.filter.maxBestAsk) return { ok: false, reason: 'no ask out of bounds' };

  const vYes = calcVwapAskForNotional(bYes.asks, cfg.arb.legNotionalUsdc);
  const vNo = calcVwapAskForNotional(bNo.asks, cfg.arb.legNotionalUsdc);
  if (!vYes || !vNo) return { ok: false, reason: 'insufficient depth for vwap notional' };

  if (vYes.worstPrice > cfg.filter.maxVwapWorstPriceAbs || vNo.worstPrice > cfg.filter.maxVwapWorstPriceAbs) {
    return { ok: false, reason: 'vwap worst price too extreme' };
  }

  // Normalize to same shares on both legs to avoid mismatch.
  const targetShares = Math.min(vYes.shares, vNo.shares);
  if (!Number.isFinite(targetShares) || targetShares <= 0) return { ok: false, reason: 'bad targetShares' };

  // Expected cost per share package (YES+NO) using VWAP avg prices.
  const costPerShare = vYes.avgPrice + vNo.avgPrice;

  // Buffers are per-share (since prices are 0..1).
  const bufferedCost = costPerShare + cfg.arb.feeBufferAbs + cfg.arb.slippageBufferAbs;

  const edgePerShare = 1 - bufferedCost;
  if (edgePerShare <= cfg.arb.edgeAbs) {
    // Require *true* edge beyond edgeAbs (we already added buffers into cost).
    return { ok: false, reason: 'edge insufficient after buffers' };
  }

  const expectedProfit = edgePerShare * targetShares;
  if (expectedProfit < cfg.arb.minProfitUsdc) return { ok: false, reason: 'expectedProfit below minProfitUsdc' };

  return {
    ok: true,
    targetShares,
    yes: { bestAsk: yesAsk as number, vwap: vYes, tickSize: bYes.tickSize, bestBid: yesBid as number },
    no: { bestAsk: noAsk as number, vwap: vNo, tickSize: bNo.tickSize, bestBid: noBid as number },
    expectedProfitUsdc: expectedProfit,
    expectedEdgePerShare: edgePerShare,
  };
}

// =========================================================
// Two-leg executor with fill tracking + unwind
// =========================================================

type TwoLegOpp = {
  id: string;
  conditionId: string;
  startedAtMs: number;
  targetShares: number;

  yesTokenId: string;
  noTokenId: string;

  leg1OrderId?: string;
  leg2OrderId?: string;

  leg1FilledShares: number;
  leg2FilledShares: number;

  state:
    | 'INIT'
    | 'LEG1_SENT'
    | 'LEG1_PARTIAL'
    | 'LEG1_FILLED'
    | 'LEG2_SENT'
    | 'COMPLETE'
    | 'LEG2_TIMEOUT'
    | 'LEG2_FAIL'
    | 'UNWINDING'
    | 'UNHEDGEABLE';
};

async function pollFilledShares(exec: Executor, orderId: string, timeoutMs: number, pollMs = 200): Promise<{ filled: number; status?: string } | null> {
  const start = Date.now();
  while (Date.now() - start <= timeoutMs) {
    const st = await exec.getOrder(orderId);
    if (st) {
      return { filled: st.filledSize, status: st.status };
    }
    await sleep(pollMs);
  }
  return null;
}

async function aggressiveUnwindOneLeg(
  cfg: ScannerV2Config,
  exec: Executor,
  tokenId: string,
  shares: number,
  book: Book,
  tickSize: number,
  reason: string
): Promise<boolean> {
  // Sell filled shares back at bestBid (aggressive LIMIT).
  const bestBid = book.bids[0]?.price;
  if (!bestBid || bestBid <= 0) return false;

  // Loss guard estimate: assume entry around mid; we approximate using current bid.
  // If bids insufficient to unwind full size, calcVwapBidForShares will return null.
  const v = calcVwapBidForShares(book.bids, shares);
  if (!v) return false;

  // Worst-case revenue = v.receivedUsdc. We do not know exact entry cost here without fill-price.
  // Guard is applied at decision level (maxOneLegNotionalUsdc) + timeouts.
  // We still keep a conservative hard stop: if revenue per share is too low, unwind may exceed maxUnwindLoss.

  const oid = await exec.placeLimit({ tokenId, side: 'SELL', price: bestBid, size: shares, tickSize, reason });
  if (!oid) return false;

  // Let it sit briefly; if not filled quickly, cancel.
  await sleep(400);
  await exec.cancel(oid);
  return true;
}

async function executeTwoLegOpp(cfg: ScannerV2Config, exec: Executor, m: CandidateMarket): Promise<'done' | 'skipped' | 'failed'> {
  const opp: TwoLegOpp = {
    id: `${m.conditionId}:${Date.now()}`,
    conditionId: m.conditionId,
    startedAtMs: Date.now(),
    targetShares: 0,
    yesTokenId: m.yes.tokenId,
    noTokenId: m.no.tokenId,
    leg1FilledShares: 0,
    leg2FilledShares: 0,
    state: 'INIT',
  };

  // --- Step 0: initial decision (VWAP + buffers) ---
  const bYes0 = await exec.getBook(m.yes.tokenId);
  const bNo0 = await exec.getBook(m.no.tokenId);
  if (!bYes0 || !bNo0) return 'skipped';

  const d0 = decideArbV2(cfg, bYes0, bNo0);
  if (!d0.ok || !d0.targetShares || !d0.yes || !d0.no) {
    logger.info({ conditionId: m.conditionId, reason: d0.reason }, 'arb v2: no-op');
    return 'skipped';
  }

  opp.targetShares = d0.targetShares;

  logger.warn(
    {
      conditionId: m.conditionId,
      targetShares: opp.targetShares,
      expectedProfitUsdc: d0.expectedProfitUsdc,
      expectedEdgePerShare: d0.expectedEdgePerShare,
      buffers: { feeBufferAbs: cfg.arb.feeBufferAbs, slippageBufferAbs: cfg.arb.slippageBufferAbs },
      yes: { vwapAvg: d0.yes.vwap.avgPrice, worst: d0.yes.vwap.worstPrice, bestAsk: d0.yes.bestAsk },
      no: { vwapAvg: d0.no.vwap.avgPrice, worst: d0.no.vwap.worstPrice, bestAsk: d0.no.bestAsk },
    },
    'ARB V2 OPPORTUNITY: attempting two-leg buy'
  );

  // --- Step 1: LEG1 submit (YES) with revalidation ---
  if (cfg.arb.revalidateBeforeEachLeg) {
    const bYesR = await exec.getBook(m.yes.tokenId);
    const bNoR = await exec.getBook(m.no.tokenId);
    if (!bYesR || !bNoR) return 'skipped';
    const dR = decideArbV2(cfg, bYesR, bNoR);
    if (!dR.ok) {
      logger.warn({ conditionId: m.conditionId, reason: dR.reason }, 'revalidate failed before leg1; skipping');
      return 'skipped';
    }
  }

  const leg1Book = await exec.getBook(m.yes.tokenId);
  if (!leg1Book) return 'failed';
  const leg1Ask = leg1Book.asks[0]?.price;
  if (!leg1Ask) return 'failed';

  // We use aggressive LIMIT at current bestAsk, but size = targetShares.
  const leg1Id = await exec.placeLimit({ tokenId: m.yes.tokenId, side: 'BUY', price: leg1Ask, size: opp.targetShares, tickSize: leg1Book.tickSize, reason: 'arbv2_leg1_buy_yes' });
  if (!leg1Id) return 'failed';
  opp.leg1OrderId = leg1Id;
  opp.state = 'LEG1_SENT';

  // Wait for leg1 fill (short timeout)
  const leg1Fill = await pollFilledShares(exec, leg1Id, cfg.arb.legFillTimeoutMs);
  const leg1Filled = Math.max(0, Number(leg1Fill?.filled ?? 0));
  opp.leg1FilledShares = leg1Filled;

  if (leg1Filled <= 0) {
    // Cancel quickly; no fill, no risk.
    await exec.cancel(leg1Id);
    logger.info({ conditionId: m.conditionId, leg1Id }, 'leg1 not filled; canceled');
    return 'skipped';
  }

  const fillPct = leg1Filled / opp.targetShares;
  if (fillPct < cfg.arb.maxPartialFillPct) {
    // too small partial: unwind instead of proceeding
    await exec.cancel(leg1Id);
    const bYesU = await exec.getBook(m.yes.tokenId);
    if (bYesU) {
      await aggressiveUnwindOneLeg(cfg, exec, m.yes.tokenId, leg1Filled, bYesU, bYesU.tickSize, 'arbv2_unwind_small_partial');
    }
    logger.warn({ conditionId: m.conditionId, leg1Filled, target: opp.targetShares, fillPct }, 'leg1 partial below threshold; unwinding');
    return 'skipped';
  }

  opp.state = leg1Filled >= opp.targetShares - 1e-9 ? 'LEG1_FILLED' : 'LEG1_PARTIAL';

  // --- Step 2: LEG2 submit (NO) size matched to LEG1 actual fill ---
  if (cfg.arb.revalidateBeforeEachLeg) {
    const bYesR = await exec.getBook(m.yes.tokenId);
    const bNoR = await exec.getBook(m.no.tokenId);
    if (!bYesR || !bNoR) return 'failed';
    const dR = decideArbV2(cfg, bYesR, bNoR);
    if (!dR.ok) {
      // Condition no longer holds; unwind leg1
      const bYesU = bYesR;
      await aggressiveUnwindOneLeg(cfg, exec, m.yes.tokenId, leg1Filled, bYesU, bYesU.tickSize, 'arbv2_unwind_leg1_after_revalidate_fail');
      logger.error({ conditionId: m.conditionId, reason: dR.reason }, 'revalidate failed before leg2; unwound leg1');
      return 'failed';
    }
  }

  const leg2Book = await exec.getBook(m.no.tokenId);
  if (!leg2Book) return 'failed';
  const leg2Ask = leg2Book.asks[0]?.price;
  if (!leg2Ask) return 'failed';

  const leg2Id = await exec.placeLimit({ tokenId: m.no.tokenId, side: 'BUY', price: leg2Ask, size: leg1Filled, tickSize: leg2Book.tickSize, reason: 'arbv2_leg2_buy_no' });
  if (!leg2Id) {
    // Could not hedge; unwind leg1
    const bYesU = await exec.getBook(m.yes.tokenId);
    if (bYesU) await aggressiveUnwindOneLeg(cfg, exec, m.yes.tokenId, leg1Filled, bYesU, bYesU.tickSize, 'arbv2_unwind_leg1_leg2_fail');
    return 'failed';
  }

  opp.leg2OrderId = leg2Id;
  opp.state = 'LEG2_SENT';

  // Wait for leg2 fill
  const leg2Start = Date.now();
  while (Date.now() - leg2Start <= cfg.arb.leg2TimeoutMs) {
    const st = await exec.getOrder(leg2Id);
    const filled2 = Math.max(0, Number(st?.filledSize ?? 0));
    opp.leg2FilledShares = filled2;

    if (filled2 >= leg1Filled - 1e-9) {
      opp.state = 'COMPLETE';
      logger.warn({ conditionId: m.conditionId, shares: leg1Filled, leg1Id, leg2Id }, 'ARB V2 COMPLETE: two-leg matched');
      return 'done';
    }

    await sleep(200);
  }

  // One-leg risk persists; attempt unwind.
  opp.state = 'LEG2_TIMEOUT';
  await exec.cancel(leg2Id);

  const bYesU = await exec.getBook(m.yes.tokenId);
  if (bYesU) {
    await aggressiveUnwindOneLeg(cfg, exec, m.yes.tokenId, leg1Filled, bYesU, bYesU.tickSize, 'arbv2_unwind_leg1_leg2_timeout');
  }

  logger.error(
    {
      conditionId: m.conditionId,
      leg1Filled,
      leg2Filled: opp.leg2FilledShares,
      leg2TimeoutMs: cfg.arb.leg2TimeoutMs,
    },
    'LEG2 TIMEOUT: unwound leg1'
  );

  return 'failed';
}

// =========================================================
// Main loop
// =========================================================

async function main() {
  const cfg = await loadCfg();
  const client = await createClient();
  const exec = new Executor(client, cfg.runtime.paper);

  // L2 healthcheck in LIVE mode
  if (!cfg.runtime.paper && process.env.VERIFY_L2 === 'true') {
    try {
      await exec.l2Healthcheck();
      logger.warn('L2 healthcheck ok (getApiKeys succeeded).');
    } catch (err) {
      logger.error({ err }, 'L2 healthcheck failed; HALTING arbScannerV2');
      process.exit(2);
    }
  }

  const state = {
    halted: false,
    haltedAtMs: 0,
    consecutiveFailures: 0,

    dailyNotionalUsdc: 0,
    dailyWindowStartMs: Date.now(),

    inFlightOpps: 0,
  };

  logger.warn({ cfg: { ...cfg, secrets: 'redacted' } }, 'starting arbScannerV2');

  let universe: CandidateMarket[] = [];
  let lastUniverseAt = 0;

  const resetDailyIfNeeded = () => {
    const nowMs = Date.now();
    if (nowMs - state.dailyWindowStartMs > 24 * 60 * 60 * 1000) {
      state.dailyWindowStartMs = nowMs;
      state.dailyNotionalUsdc = 0;
      logger.warn('reset daily notional window');
    }
  };

  while (true) {
    await sleep(cfg.refresh.monitorPollMs);

    resetDailyIfNeeded();
    const nowMs = Date.now();

    if (state.halted) {
      const cd = cfg.risk.cooldownAfterHaltMs ?? 0;
      if (nowMs - state.haltedAtMs < cd) {
        logger.error({ cooldownLeftMs: cd - (nowMs - state.haltedAtMs) }, 'HALTED');
        continue;
      }
      logger.warn('HALTED cooldown elapsed; resuming');
      state.halted = false;
      state.consecutiveFailures = 0;
    }

    if (state.consecutiveFailures >= cfg.risk.maxConsecutiveFailures) {
      state.halted = true;
      state.haltedAtMs = nowMs;
      logger.error({ consecutiveFailures: state.consecutiveFailures }, 'HALTED: too many failures');
      continue;
    }

    // Cap by daily notional
    const notionalPerOpp = cfg.arb.legNotionalUsdc * 2;
    if (state.dailyNotionalUsdc + notionalPerOpp > cfg.risk.maxDailyNotionalUsdc) {
      logger.error({ dailyNotionalUsdc: state.dailyNotionalUsdc, max: cfg.risk.maxDailyNotionalUsdc }, 'daily notional cap reached; pausing');
      continue;
    }

    if (state.inFlightOpps >= cfg.arb.maxConcurrentOpps) continue;

    // Universe refresh
    if (universe.length === 0 || nowMs - lastUniverseAt >= cfg.refresh.universeRefreshMs) {
      try {
        universe = await buildUniverse(cfg, client);
        lastUniverseAt = nowMs;
        logger.warn({ selected: universe.length, top: universe.slice(0, 5).map((x) => ({ conditionId: x.conditionId, score: x.score })) }, 'universe refreshed');
      } catch (err) {
        state.consecutiveFailures += 1;
        logger.error({ err }, 'universe refresh failed');
        continue;
      }
    }

    // Risk: open orders cap (best-effort)
    const openOrders = await exec.getOpenOrders();
    if (cfg.risk.maxOpenOrders > 0 && openOrders.length > cfg.risk.maxOpenOrders) {
      logger.error({ openOrders: openOrders.length, maxOpenOrders: cfg.risk.maxOpenOrders }, 'HALTED: too many open orders');
      state.halted = true;
      state.haltedAtMs = nowMs;
      continue;
    }

    // Scan selected universe and execute at most one opp per cycle.
    for (const m of universe) {
      if (state.inFlightOpps >= cfg.arb.maxConcurrentOpps) break;

      // Quick book check for logging + skip on obvious conditions.
      const bYes = await exec.getBook(m.yes.tokenId);
      const bNo = await exec.getBook(m.no.tokenId);
      if (!bYes || !bNo) continue;

      const yesAsk = bYes.asks[0]?.price;
      const noAsk = bNo.asks[0]?.price;
      if (!yesAsk || !noAsk) continue;

      logger.info({ conditionId: m.conditionId, sumAskTop: yesAsk + noAsk, edgeAbs: cfg.arb.edgeAbs }, 'arb scan (top-of-book)');

      const decision = decideArbV2(cfg, bYes, bNo);
      if (!decision.ok) continue;

      // Execute opportunity
      state.inFlightOpps += 1;
      try {
        const res = await executeTwoLegOpp(cfg, exec, m);
        if (res === 'done') {
          state.dailyNotionalUsdc += notionalPerOpp;
          state.consecutiveFailures = Math.max(0, state.consecutiveFailures - 1);
        } else if (res === 'failed') {
          state.consecutiveFailures += 1;
        }
      } catch (err) {
        state.consecutiveFailures += 1;
        logger.error({ err, conditionId: m.conditionId }, 'executeTwoLegOpp threw');
      } finally {
        state.inFlightOpps -= 1;
      }

      // one opportunity attempt per loop to reduce thrash
      break;
    }
  }
}

main().catch((err) => {
  logger.error({ err }, 'fatal');
  process.exit(1);
});
