import 'dotenv/config';

import { Wallet } from 'ethers';
import { ClobClient } from '@polymarket/clob-client';
import fs from 'node:fs/promises';
import yaml from 'yaml';
import { logger } from './lib/logger.js';

// --- Types ---

type Side = 'BUY' | 'SELL';

type TokenRef = {
  tokenId: string;
  label?: string; // e.g. YES/NO/outcome name
};

type MarketSpec = {
  id: string; // local identifier
  // A "market" can be:
  // - binary (YES/NO) => 2 tokens
  // - multi-outcome => N tokens
  outcomes: TokenRef[];
  // optional conditionId for logging only
  conditionId?: string;

  // Strategy toggles (default true)
  enableArb?: boolean;
  enableStaleCapture?: boolean;
  enableMarketMaking?: boolean;
};

type QuantConfig = {
  runtime: {
    pollMs: number;
    paper: boolean;
  };

  risk: {
    // Absolute caps (USDC).
    maxDailyNotionalUsdc: number;
    maxOpenNotionalUsdcTotal: number;
    maxOpenNotionalUsdcPerMarket: number;
    maxOrderNotionalUsdc: number;
    maxOpenOrders: number;

    // Circuit breaker
    maxConsecutiveFailures: number;
    maxDataLatencyMs: number;
    cooldownAfterHaltMs: number;
  };

  marketFilter: {
    // General illiquidity guard
    minTopLevels: number; // must have at least N levels on each side
    minTopDepthShares: number; // sum shares in top N levels must exceed

    // Spread guards (absolute price, 0..1)
    maxSpreadAbs: number;
    minSpreadAbs: number;

    // Activity guard (trades)
    minTradesLookbackSec: number;
    minTradesCount: number;

    // Avoid markets too close to resolution.
    // NOTE: We can only enforce this if you provide closeTimeMs in config.
    minTimeToCloseMs: number;
  };

  metrics: {
    depthLevels: number; // N for depth-based metrics
    volatilityWindow: number; // number of mid samples
    micropriceLevels: number; // currently uses top-of-book only
  };

  strategies: {
    arbitrage: {
      enabled: boolean;
      edgeAbs: number; // e.g. 0.01 means 1% edge on 1.0 payout basket
      maxLegNotionalUsdc: number;
      legTimeoutMs: number;
      // If one leg fills and the other doesn't, we will try to hedge out via crossing.
      hedgeTimeoutMs: number;
    };

    staleCapture: {
      enabled: boolean;

      // Jump + burst detection
      jumpAbs: number;
      windowSec: number;
      burstTradesMin: number;

      // Large wrong-side liquidity near the old price
      wrongSideMinLevelShares: number;
      wrongSideMaxDistanceAbs: number;

      // Fair/value
      fairEmaAlpha: number; // EMA for fair price proxy
      edgeAbs: number;

      // Sizing/TTL
      maxNotionalUsdc: number;
      orderTtlMs: number;

      // Exits
      timeStopMs: number;
      takeProfitAbs: number;
      stopLossAbs: number;
    };

    marketMaking: {
      enabled: boolean;

      spreadMinAbs: number;
      spreadTargetAbs: number;
      volMax: number;

      deltaRequoteAbs: number;
      quoteTtlMs: number;
      replaceCooldownMs: number;

      invMaxNotionalUsdc: number;
      invSkewK: number;

      quoteNotionalUsdc: number;
    };
  };

  markets: MarketSpec[];
};

// --- Helpers ---

type BookLevel = { price: number; size: number };

type Book = {
  bids: BookLevel[];
  asks: BookLevel[];
  tickSize: number;
};

type RecentTrade = {
  timestamp: number; // seconds
  price: number;
  size: number;
  side?: Side;
};

type MarketSnapshot = {
  tokenId: string;
  fetchedAtMs: number;
  book: Book;
  trades: RecentTrade[];
  mid: number;
  spread: number;
  microprice: number;
  imbalance: number;
  volatilityMid: number;
  cancelRate: number;
};

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

function sumDepth(levels: BookLevel[], n: number): number {
  return levels.slice(0, n).reduce((a, l) => a + (Number(l.size) || 0), 0);
}

function computeMicroprice(bestBid: BookLevel, bestAsk: BookLevel): number {
  // Classic microprice using top-of-book sizes.
  const bb = bestBid.price;
  const ba = bestAsk.price;
  const qb = bestBid.size;
  const qa = bestAsk.size;
  const denom = qb + qa;
  if (!Number.isFinite(denom) || denom <= 0) return (bb + ba) / 2;
  return (bb * qa + ba * qb) / denom;
}

function std(xs: number[]): number {
  const vals = xs.filter((x) => Number.isFinite(x));
  if (vals.length < 2) return 0;
  const m = vals.reduce((a, b) => a + b, 0) / vals.length;
  const v = vals.reduce((a, b) => a + (b - m) ** 2, 0) / (vals.length - 1);
  return Math.sqrt(v);
}

function calcSlippageNotional(book: Book, notionalUsdc: number, side: Side): { avgPrice: number; worstPrice: number } | null {
  // Walk the book to estimate average execution price for a LIMIT-cross (aggressive) fill.
  // Uses shares*price approximation for notional.
  const levels = (side === 'BUY' ? book.asks : book.bids).slice();
  if (levels.length === 0) return null;

  let remainingUsdc = notionalUsdc;
  let gotShares = 0;
  let spentUsdc = 0;
  let worst = levels[0].price;

  for (const lv of levels) {
    const p = lv.price;
    const s = lv.size;
    if (!Number.isFinite(p) || p <= 0 || !Number.isFinite(s) || s <= 0) continue;

    // Max shares we can take at this level if we spend remainingUsdc.
    const maxSharesAtLevel = remainingUsdc / p;
    const takeShares = Math.min(s, maxSharesAtLevel);

    if (takeShares <= 0) break;

    const takeUsdc = takeShares * p;
    gotShares += takeShares;
    spentUsdc += takeUsdc;
    remainingUsdc -= takeUsdc;
    worst = p;

    if (remainingUsdc <= 1e-9) break;
  }

  if (gotShares <= 0 || spentUsdc <= 0) return null;
  return { avgPrice: spentUsdc / gotShares, worstPrice: worst };
}

// --- Risk / State ---

type OpenOrder = {
  orderId: string;
  tokenId: string;
  side: Side;
  price: number;
  size: number;
  createdAtMs: number;
};

type Position = {
  tokenId: string;
  shares: number;
};

type MarketState = {
  fairEma?: number;
  // mid samples for volatility + jump detection
  midHistory: number[];
  midSamples: { t: number; mid: number }[];

  lastTopChangeAtMs?: number;
  topChanges: number[]; // timestamps in ms

  lastQuoteReplaceAtMs?: number;
  lastMmRefMid?: number;

  // position mgmt (best-effort)
  lastEntryAtMs?: number;
  lastEntryPrice?: number;
};

type BotState = {
  dailyNotionalUsdc: number;
  dailyWindowStartMs: number;
  consecutiveFailures: number;
  halted: boolean;
  openOrders: Map<string, OpenOrder>; // orderId -> order
  // tokenId -> shares (approx; for strict truth, we should query account positions regularly)
  positions: Map<string, Position>;
  marketState: Map<string, MarketState>; // tokenId -> state
};

function resetDailyIfNeeded(state: BotState, nowMs: number) {
  const elapsed = nowMs - state.dailyWindowStartMs;
  if (elapsed > 24 * 60 * 60 * 1000) {
    state.dailyWindowStartMs = nowMs;
    state.dailyNotionalUsdc = 0;
    logger.warn('reset daily notional window');
  }
}

// --- Execution adapter (LIMIT only) ---

class Execution {
  constructor(private readonly client: ClobClient, private readonly paper: boolean) {}

  async getBook(tokenId: string): Promise<Book | null> {
    const t0 = Date.now();
    try {
      const ob: any = await (this.client as any).getOrderBook?.(tokenId);
      const tickSize = Number(ob?.tick_size ?? '0.01');
      const bids: BookLevel[] = Array.isArray(ob?.bids)
        ? ob.bids
            .map((b: any) => ({ price: Number(b.price), size: Number(b.size) }))
            .filter((x: any) => Number.isFinite(x.price) && Number.isFinite(x.size))
        : [];
      const asks: BookLevel[] = Array.isArray(ob?.asks)
        ? ob.asks
            .map((a: any) => ({ price: Number(a.price), size: Number(a.size) }))
            .filter((x: any) => Number.isFinite(x.price) && Number.isFinite(x.size))
        : [];

      // sort best-first
      bids.sort((a, b) => b.price - a.price);
      asks.sort((a, b) => a.price - b.price);

      const dt = Date.now() - t0;
      return { bids, asks, tickSize: Number.isFinite(tickSize) && tickSize > 0 ? tickSize : 0.01, _dt: dt } as any;
    } catch (err) {
      logger.debug({ err, tokenId }, 'getBook failed');
      return null;
    }
  }

  async getRecentTrades(tokenId: string, limit: number): Promise<RecentTrade[]> {
    try {
      const resp: any = await (this.client as any).getTrades?.(tokenId, { limit });
      const rows = Array.isArray(resp) ? resp : resp?.trades ?? resp?.data ?? [];
      const out: RecentTrade[] = [];
      for (const r of rows) {
        const ts = Number(r?.timestamp ?? r?.time ?? r?.t);
        const price = Number(r?.price);
        const size = Number(r?.size ?? r?.amount);
        const side = String(r?.side ?? r?.taker_side ?? '').toUpperCase();
        if (!Number.isFinite(ts) || !Number.isFinite(price) || !Number.isFinite(size)) continue;
        out.push({ timestamp: ts, price, size, side: side === 'BUY' || side === 'SELL' ? (side as Side) : undefined });
      }
      // keep newest->oldest then sort old->new for calculations
      out.sort((a, b) => a.timestamp - b.timestamp);
      return out;
    } catch (err) {
      logger.debug({ err, tokenId }, 'getRecentTrades failed');
      return [];
    }
  }

  clampToTick(price: number, tickSize: number): number {
    const p = clamp01(price);
    const t = Number.isFinite(tickSize) && tickSize > 0 ? tickSize : 0.01;
    return Math.round(p / t) * t;
  }

  async placeLimit(params: { tokenId: string; side: Side; price: number; size: number; tickSize: number; reason: string }): Promise<string | null> {
    const safePrice = this.clampToTick(params.price, params.tickSize);
    if (!Number.isFinite(params.size) || params.size <= 0) return null;

    if (this.paper) {
      const fake = `paper_${Date.now()}_${Math.random().toString(16).slice(2)}`;
      logger.warn({ ...params, safePrice, orderId: fake }, 'PAPER placeLimit');
      return fake;
    }

    try {
      const order: any = await this.client.createAndPostOrder(
        { tokenID: params.tokenId, price: safePrice, size: params.size, side: params.side } as any,
        { tickSize: params.tickSize.toString() as any, negRisk: false } as any
      );
      if (order?.error) {
        logger.error({ order, params }, 'order rejected');
        return null;
      }
      const orderId = String(order?.orderID ?? order?.id ?? order?.orderId ?? '');
      logger.info({ orderId, ...params, safePrice }, 'order placed');
      return orderId || null;
    } catch (err) {
      logger.error({ err, params }, 'placeLimit threw');
      return null;
    }
  }

  async cancel(orderId: string): Promise<boolean> {
    if (this.paper) {
      logger.warn({ orderId }, 'PAPER cancel');
      return true;
    }
    try {
      const resp: any = await (this.client as any).cancelOrder?.(orderId);
      if (resp?.error) {
        logger.error({ resp, orderId }, 'cancelOrder rejected');
        return false;
      }
      logger.info({ orderId }, 'order canceled');
      return true;
    } catch (err) {
      logger.error({ err, orderId }, 'cancelOrder threw');
      return false;
    }
  }

  async getOpenOrders(): Promise<any[]> {
    try {
      const resp: any = await (this.client as any).getOpenOrders?.();
      const rows = Array.isArray(resp) ? resp : resp?.orders ?? resp?.data ?? [];
      return Array.isArray(rows) ? rows : [];
    } catch {
      return [];
    }
  }

  async getBalanceAllowance(): Promise<any | null> {
    try {
      return await (this.client as any).getBalanceAllowance?.();
    } catch {
      return null;
    }
  }
}

// --- Market filter ---

function marketEligible(cfg: QuantConfig, snap: MarketSnapshot, closeTimeMs?: number): { ok: boolean; reason?: string } {
  const f = cfg.marketFilter;

  const bids = snap.book.bids;
  const asks = snap.book.asks;
  if (bids.length < f.minTopLevels || asks.length < f.minTopLevels) return { ok: false, reason: 'not enough book levels' };

  const topDepth = Math.min(cfg.metrics.depthLevels, f.minTopLevels);
  const bidDepth = sumDepth(bids, topDepth);
  const askDepth = sumDepth(asks, topDepth);
  if (bidDepth < f.minTopDepthShares || askDepth < f.minTopDepthShares) return { ok: false, reason: 'insufficient top depth' };

  if (snap.spread > f.maxSpreadAbs) return { ok: false, reason: 'spread too wide' };
  if (snap.spread < f.minSpreadAbs) return { ok: false, reason: 'spread too tight' };

  const nowSec = Math.floor(Date.now() / 1000);
  const cutoff = nowSec - Math.floor(f.minTradesLookbackSec);
  const recent = snap.trades.filter((t) => (t.timestamp ?? 0) >= cutoff);
  if (recent.length < f.minTradesCount) return { ok: false, reason: 'not enough recent trades' };

  if (closeTimeMs && f.minTimeToCloseMs > 0) {
    const dt = closeTimeMs - Date.now();
    if (dt < f.minTimeToCloseMs) return { ok: false, reason: 'too close to resolution' };
  }

  return { ok: true };
}

// --- Strategies ---

async function tryArbitrage(cfg: QuantConfig, exec: Execution, state: BotState, market: MarketSpec, books: Map<string, MarketSnapshot>) {
  const sCfg = cfg.strategies.arbitrage;
  if (!cfg.strategies.arbitrage.enabled) return;
  if (market.enableArb === false) return;

  // Only implement logical arb for binary and multi-outcome baskets.
  // "Buy package" means buy 1 share of each outcome (payout 1 if any outcome wins).
  // For binary (YES/NO): if ask_yes + ask_no < 1 - edge => riskless theoretical profit.

  const snaps = market.outcomes
    .map((o) => books.get(o.tokenId))
    .filter(Boolean) as MarketSnapshot[];
  if (snaps.length !== market.outcomes.length) return;

  // Need best ask/bid for each outcome.
  const asks = snaps.map((sn) => sn.book.asks[0]?.price).map(Number);
  const bids = snaps.map((sn) => sn.book.bids[0]?.price).map(Number);

  if (asks.some((p) => !Number.isFinite(p) || p <= 0) || bids.some((p) => !Number.isFinite(p) || p <= 0)) return;

  const sumAsk = asks.reduce((a, b) => a + b, 0);
  const sumBid = bids.reduce((a, b) => a + b, 0);

  const edge = sCfg.edgeAbs;

  // BUY basket
  if (sumAsk < 1 - edge) {
    const legNotional = Math.min(sCfg.maxLegNotionalUsdc, cfg.risk.maxOrderNotionalUsdc);
    const sizes = snaps.map((sn, i) => legNotional / asks[i]);

    logger.warn({ market: market.id, sumAsk, edge, legNotional }, 'ARB: detected buy-basket opportunity');

    // Two-leg control generalized to N legs:
    // Place all legs at current best ask (aggressive LIMIT), then wait briefly.
    // If any leg fails to post, cancel what we posted.

    const placed: { tokenId: string; orderId: string }[] = [];
    for (let i = 0; i < snaps.length; i++) {
      const tokenId = market.outcomes[i].tokenId;
      const orderId = await exec.placeLimit({
        tokenId,
        side: 'BUY',
        price: asks[i],
        size: sizes[i],
        tickSize: snaps[i].book.tickSize,
        reason: 'arb_buy_basket',
      });
      if (!orderId) {
        // rollback
        for (const p of placed) await exec.cancel(p.orderId);
        state.consecutiveFailures += 1;
        return;
      }
      placed.push({ tokenId, orderId });
      state.openOrders.set(orderId, { orderId, tokenId, side: 'BUY', price: asks[i], size: sizes[i], createdAtMs: Date.now() });
      state.dailyNotionalUsdc += legNotional;
    }

    // We rely on TTL cancels elsewhere; arb positions can be held to expiry. Here, just fire.
    return;
  }

  // SELL basket (only if we already hold inventory).
  if (sumBid > 1 + edge) {
    // We only implement sell-basket if positions exist.
    const legNotional = Math.min(sCfg.maxLegNotionalUsdc, cfg.risk.maxOrderNotionalUsdc);
    logger.warn({ market: market.id, sumBid, edge, legNotional }, 'ARB: detected sell-basket opportunity');

    for (let i = 0; i < snaps.length; i++) {
      const tokenId = market.outcomes[i].tokenId;
      const pos = state.positions.get(tokenId);
      if (!pos || pos.shares <= 0) continue;
      const maxShares = legNotional / bids[i];
      const shares = Math.min(pos.shares, maxShares);
      if (shares <= 0) continue;

      const orderId = await exec.placeLimit({
        tokenId,
        side: 'SELL',
        price: bids[i],
        size: shares,
        tickSize: snaps[i].book.tickSize,
        reason: 'arb_sell_basket',
      });
      if (!orderId) {
        state.consecutiveFailures += 1;
        return;
      }
      state.openOrders.set(orderId, { orderId, tokenId, side: 'SELL', price: bids[i], size: shares, createdAtMs: Date.now() });
      state.dailyNotionalUsdc += shares * bids[i];
    }
  }
}

async function tryStaleCapture(cfg: QuantConfig, exec: Execution, state: BotState, tokenId: string, snap: MarketSnapshot) {
  const sCfg = cfg.strategies.staleCapture;
  if (!sCfg.enabled) return;

  const ms = state.marketState.get(tokenId) ?? { midHistory: [], midSamples: [], topChanges: [] };

  // --- PARTE 4: detecção de movimento brusco (jump + burst) ---
  const nowMs = Date.now();
  const wMs = Math.max(1, Math.floor(sCfg.windowSec * 1000));
  const cutoff = nowMs - wMs;
  const samples = (ms.midSamples ?? []).filter((x) => x.t >= cutoff);
  const oldMid = samples.length ? samples[0].mid : undefined;
  const jump = oldMid !== undefined ? Math.abs(snap.mid - oldMid) : 0;

  const nowSec = Math.floor(nowMs / 1000);
  const tradesW = snap.trades.filter((t) => (t.timestamp ?? 0) >= nowSec - Math.floor(sCfg.windowSec));
  const burstOk = tradesW.length >= sCfg.burstTradesMin;
  const jumpOk = jump >= sCfg.jumpAbs;

  // Confirmação de "liquidez do lado antigo":
  // Se mid subiu muito, procuramos asks ainda "baixos" perto do preço antigo.
  // Se mid caiu muito, procuramos bids ainda "altos" perto do preço antigo.
  let wrongSideOk = false;
  if (oldMid !== undefined) {
    const dist = sCfg.wrongSideMaxDistanceAbs;
    const minSz = sCfg.wrongSideMinLevelShares;
    if (snap.mid > oldMid) {
      // move up: stale asks <= oldMid + dist
      wrongSideOk = snap.book.asks.some((lv) => lv.size >= minSz && lv.price <= oldMid + dist);
    } else if (snap.mid < oldMid) {
      // move down: stale bids >= oldMid - dist
      wrongSideOk = snap.book.bids.some((lv) => lv.size >= minSz && lv.price >= oldMid - dist);
    }
  }

  const triggered = jumpOk && burstOk && wrongSideOk;
  if (!triggered) {
    // update fair EMA anyway
    const fair0 = ms.fairEma ?? snap.microprice;
    ms.fairEma = sCfg.fairEmaAlpha * snap.microprice + (1 - sCfg.fairEmaAlpha) * fair0;
    state.marketState.set(tokenId, ms);
    return;
  }

  // Fair price proxy: mid_novo (como você pediu) + suavização EMA para não overreact.
  const fair0 = ms.fairEma ?? snap.mid;
  const fair = sCfg.fairEmaAlpha * snap.mid + (1 - sCfg.fairEmaAlpha) * fair0;
  ms.fairEma = fair;
  state.marketState.set(tokenId, ms);

  const bestBid = snap.book.bids[0];
  const bestAsk = snap.book.asks[0];
  if (!bestBid || !bestAsk) return;

  // --- Entrada: atacar liquidez do lado antigo com LIMIT agressiva ---
  // Caso 1 (move up): stale ask muito baixa vs fair => BUY
  const buyEdge = fair - bestAsk.price;
  if (buyEdge >= sCfg.edgeAbs) {
    const notional = Math.min(sCfg.maxNotionalUsdc, cfg.risk.maxOrderNotionalUsdc);
    const size = notional / bestAsk.price;

    logger.warn(
      { tokenId, fair, oldMid, mid: snap.mid, jump, tradesW: tradesW.length, bestAsk: bestAsk.price, buyEdge },
      'STALE: jump+burst detected; buying stale ask'
    );

    const orderId = await exec.placeLimit({ tokenId, side: 'BUY', price: bestAsk.price, size, tickSize: snap.book.tickSize, reason: 'stale_jump_buy' });
    if (orderId) {
      state.openOrders.set(orderId, { orderId, tokenId, side: 'BUY', price: bestAsk.price, size, createdAtMs: nowMs });
      state.dailyNotionalUsdc += notional;
      ms.lastEntryAtMs = nowMs;
      ms.lastEntryPrice = bestAsk.price;
      state.marketState.set(tokenId, ms);
    } else {
      state.consecutiveFailures += 1;
    }
    return;
  }

  // Caso 2 (move down): stale bid muito alta vs fair => SELL (se houver inventário)
  const sellEdge = bestBid.price - fair;
  if (sellEdge >= sCfg.edgeAbs) {
    const pos = state.positions.get(tokenId);
    if (!pos || pos.shares <= 0) return;

    const notional = Math.min(sCfg.maxNotionalUsdc, cfg.risk.maxOrderNotionalUsdc);
    const size = Math.min(pos.shares, notional / bestBid.price);

    logger.warn(
      { tokenId, fair, oldMid, mid: snap.mid, jump, tradesW: tradesW.length, bestBid: bestBid.price, sellEdge },
      'STALE: jump+burst detected; selling stale bid'
    );

    const orderId = await exec.placeLimit({ tokenId, side: 'SELL', price: bestBid.price, size, tickSize: snap.book.tickSize, reason: 'stale_jump_sell' });
    if (orderId) {
      state.openOrders.set(orderId, { orderId, tokenId, side: 'SELL', price: bestBid.price, size, createdAtMs: nowMs });
      state.dailyNotionalUsdc += size * bestBid.price;
    } else {
      state.consecutiveFailures += 1;
    }
  }
}

async function tryMarketMake(cfg: QuantConfig, exec: Execution, state: BotState, tokenId: string, snap: MarketSnapshot) {
  const sCfg = cfg.strategies.marketMaking;
  if (!sCfg.enabled) return;

  // Regras de regime: spread >= spreadMin, vol <= volMax.
  if (snap.spread < sCfg.spreadMinAbs) return;
  if (sCfg.volMax > 0 && snap.volatilityMid > sCfg.volMax) return;

  const ms = state.marketState.get(tokenId) ?? { midHistory: [], midSamples: [], topChanges: [] };

  // Fair (conservador): microprice EMA.
  const fair0 = ms.fairEma ?? snap.microprice;
  const fair = 0.25 * snap.microprice + 0.75 * fair0;
  ms.fairEma = fair;

  // Spread target: base + widen by vol (sem inventar fee; calibrar em config).
  const spreadTarget = Math.max(sCfg.spreadMinAbs, sCfg.spreadTargetAbs);
  const half = spreadTarget / 2;

  // Inventory management (aprox): se inventário (notional) > invMax, não postar mais bid.
  const pos = state.positions.get(tokenId);
  const invNotional = pos && pos.shares > 0 ? pos.shares * fair : 0;
  const invTooLong = sCfg.invMaxNotionalUsdc > 0 && invNotional > sCfg.invMaxNotionalUsdc;

  // Skew: se long, empurra quotes para baixo.
  const skew = sCfg.invSkewK * invNotional;

  // Quoted prices around mid (como pedido), mas sem cruzar book.
  const bestBid = snap.book.bids[0];
  const bestAsk = snap.book.asks[0];
  if (!bestBid || !bestAsk) return;

  let bidPx = clamp01(snap.mid - half - skew);
  let askPx = clamp01(snap.mid + half - skew);

  // Não cruzar: bid <= bestBid; ask >= bestAsk.
  bidPx = Math.min(bidPx, bestBid.price);
  askPx = Math.max(askPx, bestAsk.price);

  const nowMs = Date.now();
  const lastReplace = ms.lastQuoteReplaceAtMs ?? 0;
  if (nowMs - lastReplace < sCfg.replaceCooldownMs) {
    state.marketState.set(tokenId, ms);
    return;
  }

  // Requote se mid moveu demais.
  const ref = ms.lastMmRefMid;
  const midMoved = ref !== undefined ? Math.abs(snap.mid - ref) >= sCfg.deltaRequoteAbs : true;

  // Cancel aged / requote orders on this token.
  for (const [oid, o] of state.openOrders.entries()) {
    if (o.tokenId !== tokenId) continue;
    const age = nowMs - o.createdAtMs;
    if (age > sCfg.quoteTtlMs || midMoved) {
      await exec.cancel(oid);
      state.openOrders.delete(oid);
    }
  }

  const notional = Math.min(sCfg.quoteNotionalUsdc, cfg.risk.maxOrderNotionalUsdc);
  const bidSize = notional / Math.max(0.01, bidPx);
  const askSize = notional / Math.max(0.01, askPx);

  const haveBid = [...state.openOrders.values()].some((o) => o.tokenId === tokenId && o.side === 'BUY');
  const haveAsk = [...state.openOrders.values()].some((o) => o.tokenId === tokenId && o.side === 'SELL');

  if (!haveBid && !invTooLong) {
    const oid = await exec.placeLimit({ tokenId, side: 'BUY', price: bidPx, size: bidSize, tickSize: snap.book.tickSize, reason: 'mm_bid' });
    if (oid) state.openOrders.set(oid, { orderId: oid, tokenId, side: 'BUY', price: bidPx, size: bidSize, createdAtMs: nowMs });
  }

  // Conservador: ask só se tiver inventário.
  if (!haveAsk && pos && pos.shares > 0) {
    const size = Math.min(pos.shares, askSize);
    const oid = await exec.placeLimit({ tokenId, side: 'SELL', price: askPx, size, tickSize: snap.book.tickSize, reason: 'mm_ask' });
    if (oid) state.openOrders.set(oid, { orderId: oid, tokenId, side: 'SELL', price: askPx, size, createdAtMs: nowMs });
  }

  ms.lastQuoteReplaceAtMs = nowMs;
  ms.lastMmRefMid = snap.mid;
  state.marketState.set(tokenId, ms);
}

// --- Main loop ---

async function loadQuantConfig(): Promise<QuantConfig> {
  const p = process.env.QUANT_CONFIG_PATH ?? 'quant-config.yml';
  const raw = await fs.readFile(p, 'utf8');
  const cfg = yaml.parse(raw) as QuantConfig;
  if (!cfg?.markets?.length) throw new Error(`quant config missing markets: ${p}`);
  return cfg;
}

async function createClientFromEnv(): Promise<ClobClient> {
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
  const client = new ClobClient(host, chainId, signer, creds, signatureType as any, funder, undefined, useServerTime);

  if (!creds) {
    logger.warn('Deriving Polymarket API key (L2 creds) via L1...');
    const derived: any = await client.createOrDeriveApiKey();
    const missing = !derived?.key || !derived?.secret || !derived?.passphrase;
    if (!derived || derived.error || missing) {
      throw new Error(`Failed to derive Polymarket API creds: ${derived?.error ?? 'missing key/secret/passphrase'}`);
    }
    const client2 = new ClobClient(host, chainId, signer, derived, signatureType as any, funder, undefined, useServerTime);
    if (process.env.VERIFY_L2 === 'true') await client2.getApiKeys();
    return client2;
  }

  if (process.env.VERIFY_L2 === 'true') await client.getApiKeys();
  return client;
}

async function buildSnapshot(cfg: QuantConfig, exec: Execution, state: BotState, tokenId: string): Promise<MarketSnapshot | null> {
  const t0 = Date.now();
  const book0 = await exec.getBook(tokenId);
  if (!book0) return null;

  const book = book0 as any;
  const bestBid = book.bids[0];
  const bestAsk = book.asks[0];
  if (!bestBid || !bestAsk) return null;

  const mid = (bestBid.price + bestAsk.price) / 2;
  const spread = bestAsk.price - bestBid.price;
  const microprice = computeMicroprice(bestBid, bestAsk);

  const trades = await exec.getRecentTrades(tokenId, 50);

  const ms = state.marketState.get(tokenId) ?? { midHistory: [], midSamples: [], topChanges: [] };
  ms.midHistory.push(mid);
  while (ms.midHistory.length > cfg.metrics.volatilityWindow) ms.midHistory.shift();

  ms.midSamples.push({ t: Date.now(), mid });
  // keep ~2 minutes of mids for jump logic (cheap)
  const msCutoff = Date.now() - 120_000;
  ms.midSamples = ms.midSamples.filter((x) => x.t >= msCutoff);

  // cancel_rate proxy: count top-of-book price changes in last minute.
  const topKey = `${bestBid.price.toFixed(4)}_${bestAsk.price.toFixed(4)}`;
  const prevTopKey = (ms as any)._prevTopKey;
  if (prevTopKey !== topKey) {
    ms.topChanges.push(Date.now());
    (ms as any)._prevTopKey = topKey;
  }
  const cutoff = Date.now() - 60_000;
  ms.topChanges = ms.topChanges.filter((t) => t >= cutoff);
  const cancelRate = ms.topChanges.length; // per minute

  // imbalance over first N levels
  const n = cfg.metrics.depthLevels;
  const bidDepth = sumDepth(book.bids, n);
  const askDepth = sumDepth(book.asks, n);
  const denom = bidDepth + askDepth;
  const imbalance = denom > 0 ? (bidDepth - askDepth) / denom : 0;

  const volatilityMid = std(ms.midHistory);

  state.marketState.set(tokenId, ms);

  const fetchedAtMs = Date.now();
  const snap: MarketSnapshot = { tokenId, fetchedAtMs, book, trades, mid, spread, microprice, imbalance, volatilityMid, cancelRate };

  const dt = fetchedAtMs - t0;
  if (dt > cfg.risk.maxDataLatencyMs) {
    logger.error({ tokenId, dt, maxDataLatencyMs: cfg.risk.maxDataLatencyMs }, 'data latency too high');
    state.halted = true;
  }

  // INFO snapshot for observability (demo-friendly).
  logger.info(
    {
      tokenId,
      bestBid: bestBid.price,
      bestAsk: bestAsk.price,
      mid,
      spread,
      depthBidTopN: sumDepth(book.bids, cfg.metrics.depthLevels),
      depthAskTopN: sumDepth(book.asks, cfg.metrics.depthLevels),
      tradesFetched: trades.length,
      volatilityMid,
      imbalance,
      cancelRate,
      latencyMs: dt,
    },
    'snapshot'
  );

  return snap;
}

async function main() {
  const cfg = await loadQuantConfig();
  const client = await createClientFromEnv();
  const exec = new Execution(client, cfg.runtime.paper);

  const state: BotState = {
    dailyNotionalUsdc: 0,
    dailyWindowStartMs: Date.now(),
    consecutiveFailures: 0,
    halted: false,
    openOrders: new Map(),
    positions: new Map(),
    marketState: new Map(),
  };

  logger.warn({ cfg: { ...cfg, secrets: 'redacted' } }, 'starting quantBot');

  // Prime open orders (if any)
  const existing = await exec.getOpenOrders();
  for (const o of existing) {
    const oid = String(o?.orderID ?? o?.id ?? o?.orderId ?? '');
    const tokenId = String(o?.tokenID ?? o?.tokenId ?? '');
    const side = String(o?.side ?? '').toUpperCase() as Side;
    const price = Number(o?.price);
    const size = Number(o?.size);
    if (!oid || !tokenId || (side !== 'BUY' && side !== 'SELL')) continue;
    state.openOrders.set(oid, { orderId: oid, tokenId, side, price, size, createdAtMs: Date.now() });
  }

  let haltedAtMs: number | null = null;

  while (true) {
    await new Promise((r) => setTimeout(r, cfg.runtime.pollMs));
    const nowMs = Date.now();
    resetDailyIfNeeded(state, nowMs);

    if (state.halted) {
      if (haltedAtMs === null) haltedAtMs = nowMs;
      const cd = cfg.risk.cooldownAfterHaltMs ?? 0;
      if (cd > 0 && nowMs - haltedAtMs < cd) {
        logger.error({ cooldownLeftMs: cd - (nowMs - haltedAtMs) }, 'HALTED: cooldown');
        continue;
      }
      // after cooldown, allow retry
      logger.warn('HALTED: cooldown elapsed; resuming');
      state.halted = false;
      state.consecutiveFailures = 0;
      haltedAtMs = null;
    }

    if (state.consecutiveFailures >= cfg.risk.maxConsecutiveFailures) {
      state.halted = true;
      logger.error({ consecutiveFailures: state.consecutiveFailures }, 'HALTED: too many consecutive failures');
      continue;
    }

    if (state.dailyNotionalUsdc >= cfg.risk.maxDailyNotionalUsdc) {
      logger.error({ dailyNotionalUsdc: state.dailyNotionalUsdc, maxDailyNotionalUsdc: cfg.risk.maxDailyNotionalUsdc }, 'daily notional cap reached');
      continue;
    }

    // For now we treat positions as best-effort. In a production version, we should query account positions.
    // NOTE: We intentionally do NOT call getBalanceAllowance here because some CLOB deployments
    // return noisy 400s (e.g. "Invalid asset type") depending on account/asset settings.

    // Build snapshots for all tokens in config.
    const tokenIds = new Set<string>();
    for (const m of cfg.markets) for (const o of m.outcomes) tokenIds.add(String(o.tokenId));

    const snaps = new Map<string, MarketSnapshot>();
    for (const tid of tokenIds) {
      const snap = await buildSnapshot(cfg, exec, state, tid);
      if (snap) snaps.set(tid, snap);
    }

    // Global risk: max_open_orders
    if (cfg.risk.maxOpenOrders > 0 && state.openOrders.size > cfg.risk.maxOpenOrders) {
      logger.error({ openOrders: state.openOrders.size, maxOpenOrders: cfg.risk.maxOpenOrders }, 'HALTED: too many open orders');
      state.halted = true;
      continue;
    }

    // Cancel stale orders (generic TTL) to avoid being picked off.
    const maxTtl = Math.max(cfg.strategies.staleCapture.orderTtlMs, cfg.strategies.marketMaking.quoteTtlMs);
    for (const [oid, o] of state.openOrders.entries()) {
      if (Date.now() - o.createdAtMs > maxTtl) {
        await exec.cancel(oid);
        state.openOrders.delete(oid);
      }
    }

    // Run strategies.
    for (const m of cfg.markets) {
      // Eligibility must hold for ALL outcomes we might touch.
      const localSnaps = m.outcomes.map((o) => snaps.get(o.tokenId)).filter(Boolean) as MarketSnapshot[];
      if (localSnaps.length !== m.outcomes.length) continue;

      // Use the first outcome as the "representative" for filter; for arb we need all.
      const elig = marketEligible(cfg, localSnaps[0]);
      if (!elig.ok) {
        logger.info({ market: m.id, reason: elig.reason }, 'market ineligible');
        continue;
      }

      logger.info({ market: m.id }, 'market eligible');

      if (cfg.strategies.arbitrage.enabled) {
        await tryArbitrage(cfg, exec, state, m, snaps);
      }

      // Stale capture + MM are per-token.
      for (const o of m.outcomes) {
        const snap = snaps.get(o.tokenId);
        if (!snap) continue;

        if (cfg.strategies.staleCapture.enabled && m.enableStaleCapture !== false) {
          await tryStaleCapture(cfg, exec, state, o.tokenId, snap);
        }
        if (cfg.strategies.marketMaking.enabled && m.enableMarketMaking !== false) {
          await tryMarketMake(cfg, exec, state, o.tokenId, snap);
        }
      }
    }

    // Reset failure counter on a clean loop.
    state.consecutiveFailures = 0;
  }
}

main().catch((err) => {
  logger.error({ err }, 'fatal');
  process.exit(1);
});
