import 'dotenv/config';

import fs from 'node:fs/promises';
import yaml from 'yaml';
import { Wallet } from 'ethers';
import { ClobClient } from '@polymarket/clob-client';
import { logger } from './lib/logger.js';

type Side = 'BUY' | 'SELL';

type BookLevel = { price: number; size: number };

type Book = {
  bids: BookLevel[];
  asks: BookLevel[];
  tickSize: number;
};

type CandidateMarket = {
  conditionId: string;
  question?: string;
  marketSlug?: string;
  yes: { tokenId: string; outcome?: string };
  no: { tokenId: string; outcome?: string };
  score: number;
};

type ScannerConfig = {
  runtime: {
    paper: boolean;
  };

  refresh: {
    universeRefreshMs: number;
    monitorPollMs: number;
    maxMarketsMonitored: number;
  };

  filter: {
    // quick filter for initial scoring
    maxDisplayedSum: number; // use displayed token prices from simplified markets

    // book-level eligibility (hard guards)
    maxSpreadAbs: number; // per-leg spread
    minAskDepthTopN: number; // min shares in top N asks
    topN: number;

    // ignore absurd prices near 0/1
    minBestAsk: number;
    maxBestAsk: number;
  };

  arb: {
    edgeAbs: number; // trigger when sumAsk < 1 - edgeAbs
    legNotionalUsdc: number;
    maxConcurrentOpps: number;
    orderTtlMs: number;
  };

  risk: {
    maxDailyNotionalUsdc: number;
    maxConsecutiveFailures: number;
    cooldownAfterHaltMs: number;
  };
};

function asArray(resp: any): any[] {
  if (Array.isArray(resp)) return resp;
  if (Array.isArray(resp?.data)) return resp.data;
  if (Array.isArray(resp?.markets)) return resp.markets;
  return [];
}

function parseBook(ob: any): Book {
  const bids = Array.isArray(ob?.bids)
    ? ob.bids
        .map((x: any) => ({ price: Number(x.price), size: Number(x.size) }))
        .filter((x: any) => Number.isFinite(x.price) && Number.isFinite(x.size) && x.price > 0 && x.size > 0)
    : [];
  const asks = Array.isArray(ob?.asks)
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

async function loadCfg(): Promise<ScannerConfig> {
  const p = process.env.ARB_SCANNER_CONFIG_PATH ?? 'arb-scanner.yml';
  const raw = await fs.readFile(p, 'utf8');
  return yaml.parse(raw) as ScannerConfig;
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
  const client = new ClobClient(host, chainId, signer, creds, signatureType as any, funder, undefined, useServerTime);

  // We *can* operate read-only without L2 creds, but for order posting we need them.
  // Try to derive; tolerate intermittent 400 noise (observed in other services).
  if (!creds) {
    try {
      logger.warn('Deriving Polymarket API key (L2 creds) via L1...');
      const derived: any = await client.createOrDeriveApiKey();
      const missing = !derived?.key || !derived?.secret || !derived?.passphrase;
      if (!derived || derived.error || missing) {
        logger.warn({ err: derived?.error ?? 'missing key/secret/passphrase' }, 'deriveApiKey failed; continuing in read-only mode');
        return client;
      }
      return new ClobClient(host, chainId, signer, derived, signatureType as any, funder, undefined, useServerTime);
    } catch (err) {
      logger.warn({ err }, 'deriveApiKey threw; continuing in read-only mode');
      return client;
    }
  }

  return client;
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

  async cancel(orderId: string): Promise<void> {
    if (this.paper) return;
    try {
      await (this.client as any).cancelOrder?.(orderId);
    } catch {}
  }
}

function scoreCandidateFromDisplayedPrices(m: any): number {
  // Use simplified token displayed prices as a cheap heuristic for "arb-likeness".
  // In theory yes+no ~ 1. If it is below 1, we might have a shot — but must confirm with book asks.
  const toks = Array.isArray(m?.tokens) ? m.tokens : [];
  if (toks.length !== 2) return -Infinity;
  const p0 = Number(toks[0]?.price);
  const p1 = Number(toks[1]?.price);
  if (!Number.isFinite(p0) || !Number.isFinite(p1)) return -Infinity;
  const sum = p0 + p1;
  return 1 - sum; // larger is better
}

async function buildUniverse(cfg: ScannerConfig, client: ClobClient): Promise<CandidateMarket[]> {
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

    cands.push({
      conditionId: String(m.condition_id ?? ''),
      yes: { tokenId: yesId, outcome: yes?.outcome },
      no: { tokenId: noId, outcome: no?.outcome },
      score,
    });
  }

  cands.sort((a, b) => b.score - a.score);
  return cands.slice(0, cfg.refresh.maxMarketsMonitored);
}

async function checkAndMaybeArb(cfg: ScannerConfig, exec: Executor, state: any, m: CandidateMarket) {
  const bYes = await exec.getBook(m.yes.tokenId);
  const bNo = await exec.getBook(m.no.tokenId);
  if (!bYes || !bNo) return;

  const yesBid = bYes.bids[0]?.price;
  const yesAsk = bYes.asks[0]?.price;
  const noBid = bNo.bids[0]?.price;
  const noAsk = bNo.asks[0]?.price;

  if (![yesBid, yesAsk, noBid, noAsk].every((x) => Number.isFinite(x) && (x as number) > 0)) return;

  const yesSpread = (yesAsk as number) - (yesBid as number);
  const noSpread = (noAsk as number) - (noBid as number);

  // Hard guards
  if (yesSpread > cfg.filter.maxSpreadAbs || noSpread > cfg.filter.maxSpreadAbs) return;

  const yesDepthAsk = sumTop(bYes.asks, cfg.filter.topN);
  const noDepthAsk = sumTop(bNo.asks, cfg.filter.topN);
  if (yesDepthAsk < cfg.filter.minAskDepthTopN || noDepthAsk < cfg.filter.minAskDepthTopN) return;

  if ((yesAsk as number) < cfg.filter.minBestAsk || (yesAsk as number) > cfg.filter.maxBestAsk) return;
  if ((noAsk as number) < cfg.filter.minBestAsk || (noAsk as number) > cfg.filter.maxBestAsk) return;

  const sumAsk = (yesAsk as number) + (noAsk as number);

  logger.info(
    {
      conditionId: m.conditionId,
      sumAsk,
      edgeAbs: cfg.arb.edgeAbs,
      yes: { bid: yesBid, ask: yesAsk, spread: yesSpread, depthAskTopN: yesDepthAsk },
      no: { bid: noBid, ask: noAsk, spread: noSpread, depthAskTopN: noDepthAsk },
    },
    'arb scan'
  );

  if (sumAsk >= 1 - cfg.arb.edgeAbs) return;

  if (state.inFlightOpps >= cfg.arb.maxConcurrentOpps) return;

  // Risk caps
  const nowMs = Date.now();
  if (nowMs - state.dailyWindowStartMs > 24 * 60 * 60 * 1000) {
    state.dailyWindowStartMs = nowMs;
    state.dailyNotionalUsdc = 0;
  }
  const notionalTwoLeg = cfg.arb.legNotionalUsdc * 2;
  if (state.dailyNotionalUsdc + notionalTwoLeg > cfg.risk.maxDailyNotionalUsdc) {
    logger.warn({ dailyNotionalUsdc: state.dailyNotionalUsdc, notionalTwoLeg, max: cfg.risk.maxDailyNotionalUsdc }, 'daily notional cap; skipping arb');
    return;
  }

  logger.warn({ conditionId: m.conditionId, sumAsk, edgeAbs: cfg.arb.edgeAbs }, 'ARB OPPORTUNITY: BUY YES+NO');

  state.inFlightOpps += 1;
  try {
    const sizeYes = cfg.arb.legNotionalUsdc / (yesAsk as number);
    const sizeNo = cfg.arb.legNotionalUsdc / (noAsk as number);

    const oidYes = await exec.placeLimit({
      tokenId: m.yes.tokenId,
      side: 'BUY',
      price: yesAsk as number,
      size: sizeYes,
      tickSize: bYes.tickSize,
      reason: 'arb_buy_yes',
    });

    if (!oidYes) {
      state.consecutiveFailures += 1;
      return;
    }

    const oidNo = await exec.placeLimit({
      tokenId: m.no.tokenId,
      side: 'BUY',
      price: noAsk as number,
      size: sizeNo,
      tickSize: bNo.tickSize,
      reason: 'arb_buy_no',
    });

    if (!oidNo) {
      // rollback first leg
      await exec.cancel(oidYes);
      state.consecutiveFailures += 1;
      return;
    }

    state.dailyNotionalUsdc += notionalTwoLeg;

    // TTL cancel (best-effort): if these are resting and not filled, cancel later.
    state.openOrders.push({ orderId: oidYes, createdAtMs: nowMs });
    state.openOrders.push({ orderId: oidNo, createdAtMs: nowMs });
  } finally {
    state.inFlightOpps -= 1;
  }
}

async function main() {
  const cfg = await loadCfg();
  const client = await createClient();

  // L2 healthcheck (requested): if LIVE, verify we can do L2-authenticated calls.
  // This prevents running "half-authenticated" and failing only when a rare arb appears.
  if (!cfg.runtime.paper && process.env.VERIFY_L2 === 'true') {
    try {
      const resp: any = await (client as any).getApiKeys?.();
      if (resp?.error) throw new Error(String(resp.error));
      logger.warn('L2 healthcheck ok (getApiKeys succeeded).');
    } catch (err) {
      logger.error({ err }, 'L2 healthcheck failed; HALTING arbScanner');
      // Hard halt: do not scan/execute until restart (or until operator fixes creds).
      // Using process exit ensures systemd restart loop, but avoids trading in a bad auth state.
      process.exit(2);
    }
  }

  const exec = new Executor(client, cfg.runtime.paper);

  const state = {
    halted: false,
    haltedAtMs: 0,
    consecutiveFailures: 0,
    dailyNotionalUsdc: 0,
    dailyWindowStartMs: Date.now(),
    inFlightOpps: 0,
    openOrders: [] as { orderId: string; createdAtMs: number }[],
  };

  logger.warn({ cfg: { ...cfg, secrets: 'redacted' } }, 'starting arbScanner');

  let universe: CandidateMarket[] = [];
  let lastUniverseAt = 0;

  while (true) {
    await new Promise((r) => setTimeout(r, cfg.refresh.monitorPollMs));

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

    // Cancel expired orders (TTL)
    if (cfg.arb.orderTtlMs > 0 && state.openOrders.length) {
      const keep: typeof state.openOrders = [];
      for (const o of state.openOrders) {
        if (nowMs - o.createdAtMs > cfg.arb.orderTtlMs) {
          await exec.cancel(o.orderId);
        } else {
          keep.push(o);
        }
      }
      state.openOrders = keep;
    }

    // Scan selected universe
    for (const m of universe) {
      await checkAndMaybeArb(cfg, exec, state, m);
      if (state.halted) break;
    }

    // If we got through a full loop without incrementing failures, decay failures.
    if (state.consecutiveFailures > 0) state.consecutiveFailures = Math.max(0, state.consecutiveFailures - 1);
  }
}

main().catch((err) => {
  logger.error({ err }, 'fatal');
  process.exit(1);
});
