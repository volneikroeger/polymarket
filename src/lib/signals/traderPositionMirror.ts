import EventEmitter from 'node:events';
import { logger } from '../logger.js';
import type { CopySignal } from './types.js';
import { checkSignalExecuted, recordSignalExecution, type ExecutedSignal } from '../database.js';

type Params = {
  traders: string[];
  pollIntervalMs: number;
};

type MirrorStats = {
  detectedTrades: number;
  emittedSignals: number;
  skippedInvalidPrice: number;
  skippedInvalidUsdc: number;
  adjustedToMinShares: number;
  adjustedToMaxCap: number;
  accumulatorTtlResets: number;
};

type DataApiActivityItem = {
  proxyWallet: string;
  timestamp: number; // unix seconds
  conditionId: string;
  type: string; // TRADE, etc
  size: number; // shares
  usdcSize?: number;
  transactionHash?: string;
  price?: number;
  asset: string; // token id
  side?: 'BUY' | 'SELL';
  title?: string;
  slug?: string;
  outcome?: string;
  negativeRisk?: boolean;
};

const DATA_API_BASE = process.env.DATA_API_BASE ?? 'https://data-api.polymarket.com';
const ACTIVITY_LIMIT = Number(process.env.ACTIVITY_LIMIT ?? '50');
// Minimum notional (USDC) we will actually send for a copied trade.
// Useful when COPY_RATIO makes trades too tiny to be accepted.
const MIN_MY_USDC_PER_SIGNAL = Number(process.env.MIN_MY_USDC_PER_SIGNAL ?? '0.5');
const MIN_SHARES_PER_ORDER = Number(process.env.MIN_SHARES_PER_ORDER ?? '5');
const ACCUM_TTL_MS = Number(process.env.ACCUM_TTL_MS ?? String(30 * 60 * 1000));

// Prevent duplicate orders when Data API emits multiple TRADE items for the same fill/tx.
// TTL-based in-memory dedupe (per process).
const SIGNAL_DEDUPE_TTL_MS = Number(process.env.SIGNAL_DEDUPE_TTL_MS ?? String(60 * 1000));

// Copy sizing
// Option A: set COPY_RATIO directly (e.g. 0.0001 means copy 0.01% of detected notional)
// Option B: set MY_PORTFOLIO_USDC and TRADER_PORTFOLIO_USDC and we compute ratio.
const COPY_RATIO = process.env.COPY_RATIO ? Number(process.env.COPY_RATIO) : undefined;
const MY_PORTFOLIO_USDC = process.env.MY_PORTFOLIO_USDC ? Number(process.env.MY_PORTFOLIO_USDC) : undefined;
const TRADER_PORTFOLIO_USDC = process.env.TRADER_PORTFOLIO_USDC ? Number(process.env.TRADER_PORTFOLIO_USDC) : undefined;
const MAX_MY_USDC_PER_SIGNAL = Number(process.env.MAX_MY_USDC_PER_SIGNAL ?? '5');

// Optional trade filter (apply per-service via env). If set, only emits signals for trades whose
// title/slug match the regex (case-insensitive by default when you include (?i) or use lowercasing).
const TRADE_FILTER_REGEX_RAW = process.env.TRADE_FILTER_REGEX;
const TRADE_FILTER_REGEX = TRADE_FILTER_REGEX_RAW ? new RegExp(TRADE_FILTER_REGEX_RAW, 'i') : null;

function getCopyRatio(): number {
  if (COPY_RATIO !== undefined && Number.isFinite(COPY_RATIO) && COPY_RATIO > 0) return COPY_RATIO;
  if (
    MY_PORTFOLIO_USDC !== undefined &&
    TRADER_PORTFOLIO_USDC !== undefined &&
    Number.isFinite(MY_PORTFOLIO_USDC) &&
    Number.isFinite(TRADER_PORTFOLIO_USDC) &&
    MY_PORTFOLIO_USDC > 0 &&
    TRADER_PORTFOLIO_USDC > 0
  ) {
    return MY_PORTFOLIO_USDC / TRADER_PORTFOLIO_USDC;
  }
  // Default: very small
  return 0.0001;
}

function isRetryableFetchError(err: any): boolean {
  const msg = String(err?.message ?? err);
  // undici/network transient errors
  return (
    msg.includes('ECONNRESET') ||
    msg.includes('ETIMEDOUT') ||
    msg.includes('EAI_AGAIN') ||
    msg.includes('fetch failed') ||
    msg.includes('socket hang up') ||
    err?.name === 'AbortError'
  );
}

async function fetchJson<T>(url: string, timeoutMs = Number(process.env.FETCH_TIMEOUT_MS ?? '15000')): Promise<T> {
  const maxRetries = Number(process.env.FETCH_RETRIES ?? '4');

  let lastErr: any;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const resp = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: ctrl.signal,
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        // HTTP errors usually aren't transient (except some 5xx); treat 429/5xx as retryable.
        const retryableHttp = resp.status === 429 || (resp.status >= 500 && resp.status <= 599);
        const e = new Error(`HTTP ${resp.status} ${resp.statusText} for ${url}${text ? ` :: ${text.slice(0, 200)}` : ''}`);
        (e as any).status = resp.status;
        if (!retryableHttp) throw e;
        lastErr = e;
        throw e;
      }
      return (await resp.json()) as T;
    } catch (err) {
      lastErr = err;
      const retryable = isRetryableFetchError(err) || Number((err as any)?.status) >= 500 || Number((err as any)?.status) === 429;
      if (attempt >= maxRetries || !retryable) throw err;

      const backoffMs = Math.min(10_000, 400 * 2 ** attempt) + Math.floor(Math.random() * 250);
      logger.warn({ url, attempt: attempt + 1, maxRetries, backoffMs, err: String(err) }, 'fetchJson retrying');
      await new Promise((r) => setTimeout(r, backoffMs));
    } finally {
      clearTimeout(t);
    }
  }

  throw lastErr;
}

/**
 * v1 signal source (Path A): poll Polymarket Data API for a trader's positions,
 * detect deltas, and emit CopySignals.
 *
 * Data API is public and provides user positions/activity:
 *   https://data-api.polymarket.com/positions?user=<address>
 *
 * Limitation: this mirrors *observable position changes*, not real-time order placement.
 */
export class TraderPositionMirror {
  private readonly traders: string[];
  private readonly pollIntervalMs: number;
  private readonly emitter = new EventEmitter();
  private timer?: NodeJS.Timeout;
  private statsTimer?: NodeJS.Timeout;

  // dedupeKey -> expiresAtMs
  private recentSignals = new Map<string, number>();

  // trader -> last seen trade marker
  private lastSeen = new Map<string, { ts: number; tx?: string }>();

  // tokenId -> per-side accumulated notional (USDC)
  private accum = new Map<string, { BUY: { usdc: number; updatedAt: number }; SELL: { usdc: number; updatedAt: number } }>();

  private statsByTrader = new Map<string, MirrorStats>();

  private inFlight = false;

  constructor(params: Params) {
    this.traders = params.traders.map((t) => t.toLowerCase());
    this.pollIntervalMs = params.pollIntervalMs;
  }

  onSignal(handler: (signal: CopySignal) => void | Promise<void>) {
    this.emitter.on('signal', handler);
  }

  async start() {
    logger.warn(
      {
        traders: this.traders,
        pollIntervalMs: this.pollIntervalMs,
        dataApiBase: DATA_API_BASE,
        activityLimit: ACTIVITY_LIMIT,
        minMyUsdcPerSignal: MIN_MY_USDC_PER_SIGNAL,
        copyRatio: getCopyRatio(),
        maxMyUsdcPerSignal: MAX_MY_USDC_PER_SIGNAL,
        minSharesPerOrder: MIN_SHARES_PER_ORDER,
      },
      'starting TraderPositionMirror (data-api activity)'
    );

    // Initial snapshot so we don't fire signals on boot.
    await this.pollOnce(true);

    this.timer = setInterval(() => {
      void this.pollOnce(false);
    }, this.pollIntervalMs);

    // Periodic summary to help choose traders / tune parameters.
    this.statsTimer = setInterval(() => {
      const snapshot = [...this.statsByTrader.entries()].map(([trader, s]) => ({ trader, ...s }));
      if (snapshot.length > 0) {
        logger.warn({ snapshot }, 'mirror stats (since process start)');
      }
    }, Number(process.env.MIRROR_STATS_INTERVAL_MS ?? String(10 * 60 * 1000)));
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.statsTimer) clearInterval(this.statsTimer);
  }

  private bump(trader: string, key: keyof MirrorStats, by = 1) {
    const cur = this.statsByTrader.get(trader) ?? {
      detectedTrades: 0,
      emittedSignals: 0,
      skippedInvalidPrice: 0,
      skippedInvalidUsdc: 0,
      adjustedToMinShares: 0,
      adjustedToMaxCap: 0,
      accumulatorTtlResets: 0,
    };
    cur[key] += by;
    this.statsByTrader.set(trader, cur);
  }

  private async shouldEmitSignal(dedupeKey: string, nowMs: number): Promise<boolean> {
    const alreadyExecuted = await checkSignalExecuted(dedupeKey);
    if (alreadyExecuted) {
      return false;
    }

    const exp = this.recentSignals.get(dedupeKey);
    if (exp && exp > nowMs) return false;

    this.recentSignals.set(dedupeKey, nowMs + SIGNAL_DEDUPE_TTL_MS);

    if (this.recentSignals.size > 5000) {
      for (const [k, exp] of this.recentSignals.entries()) {
        if (exp <= nowMs) this.recentSignals.delete(k);
      }
    }

    return true;
  }

  private async pollOnce(isBoot: boolean) {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      for (const trader of this.traders) {
        await this.pollTrader(trader, isBoot);
      }
    } catch (err) {
      logger.warn({ err }, 'position mirror poll error');
    } finally {
      this.inFlight = false;
    }
  }

  private async pollTrader(trader: string, isBoot: boolean) {
    const url = `${DATA_API_BASE}/activity?user=${encodeURIComponent(trader)}&limit=${ACTIVITY_LIMIT}`;
    const items = await fetchJson<DataApiActivityItem[]>(url);

    const onlyTrades = items.filter((i) => String(i.type).toUpperCase() === 'TRADE');
    onlyTrades.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0)); // oldest -> newest

    // On boot, set lastSeen to newest trade to avoid replaying history.
    if (isBoot) {
      if (onlyTrades.length > 0) {
        const newest = onlyTrades[onlyTrades.length - 1];
        this.lastSeen.set(trader, { ts: Number(newest.timestamp ?? 0), tx: newest.transactionHash });
        logger.info({ trader, ts: newest.timestamp, tx: newest.transactionHash }, 'boot snapshot: lastSeen trade set');
      }
      return;
    }

    const last = this.lastSeen.get(trader);

    for (const it of onlyTrades) {
      const ts = Number(it.timestamp ?? 0);
      const tx = it.transactionHash;

      if (last) {
        if (ts < last.ts) continue;
        if (ts === last.ts && tx && last.tx && tx === last.tx) continue;
      }

      const price = Number(it.price ?? 0);
      const side = (it.side ?? 'BUY').toUpperCase() as 'BUY' | 'SELL';
      const tokenId = String(it.asset);

      // Dedupe: the Data API can emit multiple TRADE records for effectively the same event.
      // Prefer tx hash when present; otherwise fall back to a signature that tends to be stable
      // for duplicates (same second + token + side + rounded price).
      const dedupeKey = tx
        ? `${trader}:${tx}`
        : `${trader}:${tokenId}:${side}:${ts}:${Math.round(price * 1000)}`;

      // Optional per-service filter (e.g. only Counter-Strike markets).
      if (TRADE_FILTER_REGEX) {
        const text = `${it.slug ?? ''} ${it.title ?? ''}`;
        if (!TRADE_FILTER_REGEX.test(text)) {
          // Advance lastSeen so we don't reprocess filtered trades forever.
          this.lastSeen.set(trader, { ts, tx });
          continue;
        }
      }

      const traderUsdc = Number(it.usdcSize ?? (Number(it.size ?? 0) * price));

      this.bump(trader, 'detectedTrades', 1);

      if (!Number.isFinite(price) || price <= 0) {
        this.bump(trader, 'skippedInvalidPrice', 1);
        logger.debug({ trader, tokenId, ts, tx }, 'skipping trade: missing/invalid price');
        continue;
      }
      if (!Number.isFinite(traderUsdc) || traderUsdc <= 0) {
        this.bump(trader, 'skippedInvalidUsdc', 1);
        logger.debug({ trader, tokenId, ts, tx }, 'skipping trade: missing/invalid usdcSize');
        continue;
      }

      const ratio = getCopyRatio();
      const scaledNotional = traderUsdc * ratio;

      const minNotionalForMinShares = MIN_SHARES_PER_ORDER * price;

      const now = Date.now();

      if (!(await this.shouldEmitSignal(dedupeKey, now))) {
        logger.info({ trader, tokenId, side, ts, tx, dedupeKey }, 'dedupe: skipping duplicate trade signal');
        this.lastSeen.set(trader, { ts, tx });
        continue;
      }

      // Always copy the trade, adjusting size to respect limits
      // Start with scaled notional, then apply min/max bounds
      let notionalUsdc = scaledNotional;

      // Apply minimum limit
      if (notionalUsdc < MIN_MY_USDC_PER_SIGNAL) {
        notionalUsdc = MIN_MY_USDC_PER_SIGNAL;
        this.bump(trader, 'adjustedToMinShares', 1);
      }

      // Apply maximum limit
      if (notionalUsdc > MAX_MY_USDC_PER_SIGNAL) {
        notionalUsdc = MAX_MY_USDC_PER_SIGNAL;
        this.bump(trader, 'adjustedToMaxCap', 1);
      }

      // Calculate resulting shares
      const resultingShares = notionalUsdc / price;

      const signal: CopySignal = {
        trader,
        market: String(it.conditionId ?? it.slug ?? it.title ?? ''),
        assetId: tokenId,
        outcome: it.outcome,
        side,
        notionalUsdc,
        price,
        detectedAt: now,
      };

      // Log with details about adjustments
      const logData: any = {
        tokenId,
        side,
        traderUsdc,
        scaledNotional,
        finalNotionalUsdc: notionalUsdc,
        resultingShares: resultingShares.toFixed(2),
        price,
      };

      let logMessage = 'emitting copy signal';

      if (notionalUsdc === MAX_MY_USDC_PER_SIGNAL && scaledNotional > MAX_MY_USDC_PER_SIGNAL) {
        logMessage += ' (reduced to MAX_MY_USDC_PER_SIGNAL cap)';
        logData.originalScaled = scaledNotional;
      } else if (notionalUsdc === MIN_MY_USDC_PER_SIGNAL && scaledNotional < MIN_MY_USDC_PER_SIGNAL) {
        logMessage += ' (increased to MIN_MY_USDC_PER_SIGNAL)';
        logData.originalScaled = scaledNotional;
      }

      if (resultingShares < MIN_SHARES_PER_ORDER) {
        logMessage += ` [WARNING: ${resultingShares.toFixed(2)} shares < MIN_SHARES_PER_ORDER=${MIN_SHARES_PER_ORDER}]`;
      }

      logger.warn(logData, logMessage);

      this.bump(trader, 'emittedSignals', 1);
      this.emitter.emit('signal', signal);
      this.lastSeen.set(trader, { ts, tx });
    }
  }
}
