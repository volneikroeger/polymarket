import { ClobClient } from '@polymarket/clob-client';

type ApiCreds = {
  key: string;
  secret: string;
  passphrase: string;
};
import { Wallet } from 'ethers';
import { logger } from '../logger.js';
import type { CopySignal } from '../signals/types.js';
import {
  recordSignalExecution,
  getOpenPosition,
  upsertOpenPosition,
  deleteOpenPosition,
  getDailyLimit,
  incrementDailyNotional,
  updateDailyPnl,
  type ExecutedSignal,
  type OpenPosition as DbOpenPosition,
} from '../database.js';
import { fetchMarketMetadata, calculateHoursUntilResolution } from './api.js';

type CreateParams = {
  enableTrading: boolean;
  fixedUsdcPerTrade: number;
  maxPriceMove: number;
  marketable?: boolean;
  allowMarkets?: string[];
  denyMarkets?: string[];
  maxUsdcPerTrade?: number;
  maxOpenUsdcPerMarket?: number;
  maxActiveMarkets?: number;

  // Interpreted as MAX DAILY LOSS (USDC). Only blocks when realized PnL is negative beyond this.
  maxDailyLossUsdc?: number;

  // Optional cap for total daily notional (0/undefined disables).
  maxDailyNotionalUsdc?: number;
};

type OpenPosition = {
  marketKey: string;
  assetId: string;
  outcome?: string;
  notionalUsdc: number;
  shares: number; // approximate filled shares tracked by our own order sizes
  entryPrice: number; // approx avg entry
  bestPrice: number;
  openedAtMs: number;
  buysCount: number;
  lastBuyAtMs: number;
  lastBuyPrice: number;
};

export class PolymarketExecutor {
  private readonly marketable: boolean;
  private readonly allowMarkets: string[];
  private readonly denyMarkets: string[];
  private readonly maxUsdcPerTrade: number;
  private readonly maxOpenUsdcPerMarket: number;
  private readonly maxActiveMarkets: number;
  private readonly maxDailyLossUsdc: number;
  private readonly maxDailyNotionalUsdc: number; // 0 disables

  // Microstructure / execution guards
  private readonly maxSpreadAbs: number;
  private readonly maxSpreadBps: number;

  // Circuit breaker
  private readonly maxConsecutiveFailures: number;
  private readonly circuitBreakerCooldownMs: number;

  // Entry throttles / anti-overtrading
  private readonly maxBuysPerAsset: number;
  private readonly buyCooldownMs: number;
  private readonly buyMinPriceDeltaAbs: number;

  // Simple in-memory guards (approximate).
  private openNotionalByMarket = new Map<string, number>();
  private openPositions = new Map<string, OpenPosition>();
  private dailyNotionalUsdc = 0;
  private dailyRealizedPnlUsdc = 0;
  private dayKey = '';
  private dailyWindowStartMs = Date.now();
  private consecutiveOrderFailures = 0;
  private tradingHalted = false;
  private circuitBreakerTrippedAtMs = 0;

  private constructor(
    private readonly client: ClobClient,
    private readonly enableTrading: boolean,
    private readonly fixedUsdcPerTrade: number,
    private readonly maxPriceMove: number,
    params: CreateParams
  ) {
    this.marketable = params.marketable ?? false;
    this.allowMarkets = (params.allowMarkets ?? []).map((s) => s.toLowerCase());
    this.denyMarkets = (params.denyMarkets ?? []).map((s) => s.toLowerCase());
    this.maxUsdcPerTrade = params.maxUsdcPerTrade ?? 25;
    this.maxOpenUsdcPerMarket = params.maxOpenUsdcPerMarket ?? 100;
    this.maxActiveMarkets = params.maxActiveMarkets ?? 10;

    this.maxDailyLossUsdc = params.maxDailyLossUsdc ?? 50;
    this.maxDailyNotionalUsdc = params.maxDailyNotionalUsdc ?? 0;

    this.dayKey = this.getDayKey();

    this.maxSpreadAbs = Number(process.env.MAX_SPREAD_ABS ?? '0'); // 0 disables
    this.maxSpreadBps = Number(process.env.MAX_SPREAD_BPS ?? '0'); // 0 disables

    this.maxConsecutiveFailures = Number(process.env.MAX_CONSECUTIVE_ORDER_FAILURES ?? '20');
    this.circuitBreakerCooldownMs = Number(process.env.CIRCUIT_BREAKER_COOLDOWN_MS ?? String(5 * 60 * 1000)); // 5 min default

    // One-position-per-asset v2: allow N buys per asset (default 1). This allows multiple
    // positions in different assets of the same market. Backward compatible with
    // ONE_POSITION_PER_MARKET=true and MAX_BUYS_PER_MARKET env vars.
    const rawOpm = String(process.env.ONE_POSITION_PER_MARKET ?? '').trim().toLowerCase();
    const envMaxBuys = Number(process.env.MAX_BUYS_PER_MARKET ?? '');
    let maxBuys = 1;
    if (Number.isFinite(envMaxBuys) && envMaxBuys > 0) {
      maxBuys = Math.floor(envMaxBuys);
    } else if (rawOpm === 'true') {
      maxBuys = 1;
    } else if (rawOpm && rawOpm !== 'false') {
      const n = Number(rawOpm);
      if (Number.isFinite(n) && n > 0) maxBuys = Math.floor(n);
    }
    this.maxBuysPerAsset = Math.max(1, maxBuys);

    // Anti-duplicate guard when a trader spams near-identical BUYs.
    this.buyCooldownMs = Number(process.env.BUY_COOLDOWN_MS ?? String(60 * 1000));
    this.buyMinPriceDeltaAbs = Number(process.env.BUY_MIN_PRICE_DELTA_ABS ?? '0');
  }

  private getDayKey(nowMs = Date.now()): string {
    // Use Sao Paulo day boundary by default (can override with TZ env if desired)
    const tz = process.env.EXEC_DAILY_TZ ?? 'America/Sao_Paulo';
    const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
    return fmt.format(new Date(nowMs));
  }

  private resetDailyIfNeeded(nowMs = Date.now()) {
    const dk = this.getDayKey(nowMs);
    if (this.dayKey && dk === this.dayKey) return;

    const prev = this.dayKey;
    this.dayKey = dk;
    this.dailyWindowStartMs = nowMs;
    this.dailyNotionalUsdc = 0;
    this.dailyRealizedPnlUsdc = 0;

    if (prev) {
      logger.warn({ prevDayKey: prev, newDayKey: dk }, 'daily rollover (executor)');
    }
  }

  static async createFromEnv(params: CreateParams): Promise<PolymarketExecutor> {
    const host = process.env.CLOB_HOST ?? 'https://clob.polymarket.com';
    const chainId = Number(process.env.CHAIN_ID ?? '137');

    const privateKey = process.env.PRIVATE_KEY;
    if (!privateKey) {
      throw new Error('Missing PRIVATE_KEY in env');
    }

    const signatureType = Number(process.env.SIGNATURE_TYPE ?? '0');
    const funder = process.env.FUNDER && process.env.FUNDER.trim() ? process.env.FUNDER.trim() : undefined;

    const signer = new Wallet(privateKey);

    logger.info(
      {
        signer: signer.address,
        signatureType,
        funder,
      },
      'polymarket executor signer config'
    );

    // If user supplied L2 creds, use them; otherwise derive.
    let creds: ApiCreds | undefined;
    if (process.env.POLY_API_KEY && process.env.POLY_API_SECRET && process.env.POLY_API_PASSPHRASE) {
      // clob-client expects ApiCreds as { key, secret, passphrase }
      // (NOT { apiKey, ... }). If "key" is missing, POLY_API_KEY won't be sent and you'll get 401.
      creds = {
        key: process.env.POLY_API_KEY,
        secret: process.env.POLY_API_SECRET,
        passphrase: process.env.POLY_API_PASSPHRASE,
      } as any;
    }

    const useServerTime = process.env.USE_SERVER_TIME === 'true';
    logger.info({ host, chainId, useServerTime, hasCreds: !!creds }, 'Creating ClobClient...');
    const client = new ClobClient(host, chainId, signer, creds, signatureType as any, funder, undefined, useServerTime);
    logger.info('ClobClient created successfully');

    if (!creds) {
      logger.info('Deriving Polymarket API key (L2 creds) via L1...');

      // Add timeout to prevent hanging
      const derivePromise = client.createOrDeriveApiKey();
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Timeout deriving API key after 30s')), 30000)
      );

      const derived: any = await Promise.race([derivePromise, timeoutPromise]);
      // clob-client's error handler returns objects that may not throw; sometimes the
      // error payload becomes { key: undefined, secret: undefined, passphrase: undefined }.
      const missing = !derived?.key || !derived?.secret || !derived?.passphrase;
      if (!derived || derived.error || missing) {
        throw new Error(
          `Failed to derive Polymarket API creds: ${derived?.error ?? 'missing key/secret/passphrase (see CLOB Client request error above)'}`
        );
      }
      logger.info('Derived Polymarket API creds (stored only in memory). Consider exporting to env for stability.');
      // Re-init with creds for L2 methods.
      const client2 = new ClobClient(host, chainId, signer, derived, signatureType as any, funder, undefined, useServerTime);

      if (process.env.VERIFY_L2 === 'true') {
        const resp: any = await client2.getApiKeys();
        if (resp?.error) {
          throw new Error(`Polymarket L2 credential check failed (derived creds): ${resp.error} (status ${resp.status ?? 'n/a'})`);
        }
        logger.info('Verified Polymarket L2 API creds (derived creds; getApiKeys succeeded).');
      }

      return new PolymarketExecutor(client2, params.enableTrading, params.fixedUsdcPerTrade, params.maxPriceMove, params);
    }

    // Optional: verify L2 creds are valid without placing orders.
    if (process.env.VERIFY_L2 === 'true') {
      const resp: any = await client.getApiKeys();
      if (resp?.error) {
        throw new Error(`Polymarket L2 credential check failed: ${resp.error} (status ${resp.status ?? 'n/a'})`);
      }
      logger.info('Verified Polymarket L2 API creds (getApiKeys succeeded).');
    }

    return new PolymarketExecutor(client, params.enableTrading, params.fixedUsdcPerTrade, params.maxPriceMove, params);
  }

  /**
   * Execute a copy signal.
   * NOTE: This is intentionally conservative and incomplete until we finalize the signal source.
   */
  async getOpenPositions(): Promise<OpenPosition[]> {
    const dbPositions = await (await import('../database.js')).getAllOpenPositions();

    const result: OpenPosition[] = dbPositions.map((p) => ({
      marketKey: p.market_key,
      assetId: p.asset_id,
      outcome: p.outcome,
      notionalUsdc: Number(p.notional_usdc),
      shares: Number(p.shares),
      entryPrice: Number(p.entry_price),
      bestPrice: Number(p.best_price),
      openedAtMs: new Date(p.opened_at).getTime(),
      buysCount: p.buys_count,
      lastBuyAtMs: p.last_buy_at ? new Date(p.last_buy_at).getTime() : new Date(p.opened_at).getTime(),
      lastBuyPrice: p.last_buy_price ? Number(p.last_buy_price) : Number(p.entry_price),
    }));

    for (const p of result) {
      const assetKey = p.assetId.toLowerCase();
      this.openPositions.set(assetKey, p);
      this.openNotionalByMarket.set(assetKey, p.notionalUsdc);
    }

    return result;
  }

  private dbToOpenPosition(dbPos: DbOpenPosition): OpenPosition {
    return {
      marketKey: dbPos.market_key,
      assetId: dbPos.asset_id,
      outcome: dbPos.outcome,
      notionalUsdc: Number(dbPos.notional_usdc),
      shares: Number(dbPos.shares),
      entryPrice: Number(dbPos.entry_price),
      bestPrice: Number(dbPos.best_price),
      openedAtMs: new Date(dbPos.opened_at).getTime(),
      buysCount: dbPos.buys_count,
      lastBuyAtMs: dbPos.last_buy_at ? new Date(dbPos.last_buy_at).getTime() : new Date(dbPos.opened_at).getTime(),
      lastBuyPrice: dbPos.last_buy_price ? Number(dbPos.last_buy_price) : Number(dbPos.entry_price),
    };
  }

  async updateBestPrice(assetId: string, bestPrice: number) {
    const assetKey = assetId.toLowerCase();
    let cur = this.openPositions.get(assetKey);
    if (!cur) {
      const dbPos = await getOpenPosition(assetKey);
      if (dbPos) {
        cur = this.dbToOpenPosition(dbPos);
      }
    }
    if (!cur) return;
    if (bestPrice > cur.bestPrice) {
      const updated = { ...cur, bestPrice };
      this.openPositions.set(assetKey, updated);

      await upsertOpenPosition({
        market_key: cur.marketKey,
        asset_id: updated.assetId,
        outcome: updated.outcome,
        notional_usdc: updated.notionalUsdc,
        shares: updated.shares,
        entry_price: updated.entryPrice,
        best_price: bestPrice,
        opened_at: new Date(updated.openedAtMs).toISOString(),
        buys_count: updated.buysCount,
        last_buy_at: updated.lastBuyAtMs ? new Date(updated.lastBuyAtMs).toISOString() : undefined,
        last_buy_price: updated.lastBuyPrice,
      });
    }
  }

  async getMidpoint(assetId: string): Promise<number | null> {
    try {
      const mid: any = await (this.client as any).getMidpoint?.(assetId);
      const v = Number(mid?.midpoint ?? mid?.price ?? mid);
      if (!Number.isFinite(v) || v <= 0) return null;
      return v;
    } catch {
      return null;
    }
  }

  async hasOpenPosition(assetId: string): Promise<boolean> {
    const assetKey = assetId.toLowerCase();
    const cached = this.openPositions.get(assetKey);
    if (cached) return cached.notionalUsdc > 0;

    const dbPos = await getOpenPosition(assetKey);
    if (dbPos) {
      return Number(dbPos.notional_usdc) > 0;
    }
    return false;
  }

  // (removed) legacy resetDailyIfNeeded(nowMs:number) — replaced by timezone dayKey rollover.

  private marketAllowed(signal: CopySignal): boolean {
    const key = `${signal.market ?? ''} ${signal.assetId ?? ''}`.toLowerCase();
    if (this.denyMarkets.some((m) => key.includes(m.toLowerCase()))) return false;
    if (this.allowMarkets.length === 0) return true;
    return this.allowMarkets.some((m) => key.includes(m.toLowerCase()));
  }

  private haltTrading(reason: string, context?: any) {
    this.tradingHalted = true;
    this.circuitBreakerTrippedAtMs = Date.now();
    const cooldownMinutes = (this.circuitBreakerCooldownMs / 1000 / 60).toFixed(1);
    logger.error(
      {
        reason,
        consecutiveFailures: this.consecutiveOrderFailures,
        maxFailures: this.maxConsecutiveFailures,
        autoResetInMinutes: cooldownMinutes,
        ...(context ? { context } : {}),
      },
      `CIRCUIT BREAKER TRIPPED: Trading halted. Will auto-reset in ${cooldownMinutes} minutes.`
    );
  }

  private resetCircuitBreakerIfCooledDown() {
    if (!this.tradingHalted) return;

    const nowMs = Date.now();
    const elapsed = nowMs - this.circuitBreakerTrippedAtMs;

    if (elapsed >= this.circuitBreakerCooldownMs) {
      this.tradingHalted = false;
      this.consecutiveOrderFailures = 0;
      this.circuitBreakerTrippedAtMs = 0;
      const elapsedMinutes = (elapsed / 1000 / 60).toFixed(1);
      logger.warn(
        {
          elapsedMinutes,
          cooldownMinutes: (this.circuitBreakerCooldownMs / 1000 / 60).toFixed(1),
        },
        'CIRCUIT BREAKER RESET: Trading resumed after cooldown period.'
      );
    }
  }

  async executeSignal(signal: CopySignal) {
    if (!this.enableTrading) {
      logger.warn('Trading disabled (ENABLE_TRADING=false or paper mode)');
      return;
    }

    // Check if circuit breaker should auto-reset after cooldown
    this.resetCircuitBreakerIfCooledDown();

    if (this.tradingHalted) {
      const elapsed = Date.now() - this.circuitBreakerTrippedAtMs;
      const remainingMs = this.circuitBreakerCooldownMs - elapsed;
      const remainingMinutes = Math.max(0, remainingMs / 1000 / 60).toFixed(1);
      logger.error(
        {
          trader: signal.trader,
          market: signal.market,
          assetId: signal.assetId,
          remainingMinutes,
        },
        `Trading halted (circuit breaker). Auto-reset in ${remainingMinutes} minutes.`
      );
      return;
    }

    if (!this.marketAllowed(signal)) {
      logger.warn({ market: signal.market, assetId: signal.assetId }, 'market not allowed (allow/deny list)');
      return;
    }

    // Never attempt to SELL unless we believe we have an open position for this asset.
    // When mirroring raw TRADE events, we can see trader SELLs for assets we never entered.
    if (String(signal.side).toUpperCase() === 'SELL') {
      const key = String(signal.assetId).toLowerCase();
      const pos = this.openPositions.get(key);
      if (!pos || pos.notionalUsdc <= 0) {
        logger.warn({ trader: signal.trader, market: signal.market, assetId: signal.assetId }, 'skipping SELL: no open position for this asset');
        return;
      }
    }

    this.resetDailyIfNeeded(Date.now());

    // Anti-overtrading: allow at most N BUYs per asset (default 1). This allows buying different
    // assets in the same market, but prevents multiple entries in the same asset.
    // Only allow an additional BUY when it is sufficiently separated by time and/or price.
    if (String(signal.side).toUpperCase() === 'BUY') {
      const key = String(signal.assetId).toLowerCase();
      const pos = this.openPositions.get(key);
      if (pos && pos.notionalUsdc > 0) {
        if (pos.buysCount >= this.maxBuysPerAsset) {
          logger.warn(
            { trader: signal.trader, market: signal.market, assetId: signal.assetId, buysCount: pos.buysCount, maxBuysPerAsset: this.maxBuysPerAsset },
            'skipping BUY: max buys per asset reached'
          );
          return;
        }

        const nowMs = Date.now();
        const sinceMs = nowMs - (pos.lastBuyAtMs || pos.openedAtMs);
        if (this.buyCooldownMs > 0 && sinceMs < this.buyCooldownMs) {
          logger.warn(
            { trader: signal.trader, market: signal.market, assetId: signal.assetId, sinceMs, buyCooldownMs: this.buyCooldownMs },
            'skipping BUY: cooldown'
          );
          return;
        }

        const p = Number(signal.price);
        if (this.buyMinPriceDeltaAbs > 0 && Number.isFinite(p) && Number.isFinite(pos.lastBuyPrice)) {
          const d = Math.abs(p - pos.lastBuyPrice);
          if (d < this.buyMinPriceDeltaAbs) {
            logger.warn(
              { trader: signal.trader, market: signal.market, assetId: signal.assetId, delta: d, buyMinPriceDeltaAbs: this.buyMinPriceDeltaAbs },
              'skipping BUY: price too similar to last buy'
            );
            return;
          }
        }
      }
    }

    this.resetDailyIfNeeded();

    const rawNotional = signal.notionalUsdc ?? this.fixedUsdcPerTrade;
    const notional = Math.min(rawNotional, this.maxUsdcPerTrade);

    if (notional <= 0) return;

    const dailyLimit = await getDailyLimit(this.dayKey);
    const currentDailyNotional = dailyLimit?.notional_usdc ? Number(dailyLimit.notional_usdc) : 0;
    const currentDailyPnl = dailyLimit?.realized_pnl_usdc ? Number(dailyLimit.realized_pnl_usdc) : 0;

    if (currentDailyPnl <= -Math.abs(this.maxDailyLossUsdc)) {
      logger.error(
        {
          dayKey: this.dayKey,
          dailyRealizedPnlUsdc: currentDailyPnl,
          maxDailyLossUsdc: this.maxDailyLossUsdc,
        },
        'daily loss limit reached (blocking new orders)'
      );
      return;
    }

    if (this.maxDailyNotionalUsdc > 0 && currentDailyNotional + notional > this.maxDailyNotionalUsdc) {
      logger.error(
        {
          dayKey: this.dayKey,
          dailyNotionalUsdc: currentDailyNotional,
          attempted: notional,
          maxDailyNotionalUsdc: this.maxDailyNotionalUsdc,
        },
        'daily notional cap reached (blocking new orders)'
      );
      return;
    }

    const price = signal.price;
    if (!price || price <= 0) {
      throw new Error('Signal missing price; cannot size shares safely');
    }

    // Orderbook / spread safety: avoid illiquid markets that will eat us in spread.
    // We also use this to discover tick_size / neg_risk dynamically instead of hardcoding.
    let tickSizeStr: string | undefined;
    let negRisk: boolean | undefined;
    let bestBid: number | undefined;
    let bestAsk: number | undefined;
    let midFromBook: number | undefined;

    if (this.maxSpreadAbs > 0 || this.maxSpreadBps > 0) {
      try {
        const book: any = await (this.client as any).getOrderBook?.(signal.assetId);
        tickSizeStr = String(book?.tick_size ?? '0.01');
        negRisk = Boolean(book?.neg_risk ?? false);

        const bids = Array.isArray(book?.bids) ? book.bids : [];
        const asks = Array.isArray(book?.asks) ? book.asks : [];
        bestBid = bids.length ? Math.max(...bids.map((b: any) => Number(b.price)).filter((n: number) => Number.isFinite(n))) : NaN;
        bestAsk = asks.length ? Math.min(...asks.map((a: any) => Number(a.price)).filter((n: number) => Number.isFinite(n))) : NaN;

        if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk) || (bestBid as number) <= 0 || (bestAsk as number) <= 0) {
          logger.warn({ assetId: signal.assetId }, 'skipping: empty/invalid orderbook');
          return;
        }

        const spread = (bestAsk as number) - (bestBid as number);
        midFromBook = ((bestAsk as number) + (bestBid as number)) / 2;
        const spreadBps = (midFromBook as number) > 0 ? (spread / (midFromBook as number)) * 10_000 : Infinity;

        if (this.maxSpreadAbs > 0 && spread > this.maxSpreadAbs) {
          logger.warn({ assetId: signal.assetId, bestBid, bestAsk, spread, maxSpreadAbs: this.maxSpreadAbs }, 'skipping: spread too wide');
          return;
        }
        if (this.maxSpreadBps > 0 && spreadBps > this.maxSpreadBps) {
          logger.warn(
            { assetId: signal.assetId, bestBid, bestAsk, spread, spreadBps, maxSpreadBps: this.maxSpreadBps },
            'skipping: spread too wide (bps)'
          );
          return;
        }
      } catch (e) {
        logger.debug({ err: e }, 'orderbook/spread check failed; continuing');
      }
    }

    // --- Low ROI protection: short-term only + fee validation ---
    const LOW_ROI_THRESHOLD_PERCENT = Number(process.env.LOW_ROI_THRESHOLD_PERCENT ?? '10');
    const MAX_HOURS_TO_RESOLUTION_LOW_ROI = Number(process.env.MAX_HOURS_TO_RESOLUTION_LOW_ROI ?? '48');
    const ALLOW_LOW_ROI_WITH_FEES = process.env.ALLOW_LOW_ROI_WITH_FEES === 'true';

    let isLowRoi = false;
    let roiPercent: number | null = null;

    if (signal.side === 'BUY' && price > 0 && price < 1) {
      roiPercent = ((1.0 - price) / price) * 100;
      isLowRoi = roiPercent < LOW_ROI_THRESHOLD_PERCENT;
    }

    if (isLowRoi && signal.market) {
      logger.info(
        {
          assetId: signal.assetId,
          conditionId: signal.market,
          price,
          roiPercent: roiPercent?.toFixed(2),
          threshold: LOW_ROI_THRESHOLD_PERCENT,
        },
        'LOW ROI order detected, applying additional validations'
      );

      const metadata = await fetchMarketMetadata(signal.market);
      const hoursUntilResolution = metadata?.endDate ? calculateHoursUntilResolution(metadata.endDate) : null;

      if (!metadata || hoursUntilResolution === null) {
        logger.warn(
          {
            assetId: signal.assetId,
            conditionId: signal.market,
            reason: 'missing_market_metadata',
          },
          'SKIPPING low ROI order: unable to fetch market metadata'
        );
        return;
      }

      if (hoursUntilResolution > MAX_HOURS_TO_RESOLUTION_LOW_ROI) {
        logger.warn(
          {
            assetId: signal.assetId,
            conditionId: signal.market,
            hoursUntilResolution: hoursUntilResolution.toFixed(1),
            maxHours: MAX_HOURS_TO_RESOLUTION_LOW_ROI,
            reason: 'resolution_too_far',
          },
          'SKIPPING low ROI order: market resolves too far in the future'
        );
        return;
      }

      const isFeeFree = negRisk === true || metadata.negRisk === true;

      if (!isFeeFree && !ALLOW_LOW_ROI_WITH_FEES) {
        logger.warn(
          {
            assetId: signal.assetId,
            conditionId: signal.market,
            negRisk,
            metadataNegRisk: metadata.negRisk,
            reason: 'fees_would_erode_profit',
          },
          'SKIPPING low ROI order: market has taker fees and maker-only execution not guaranteed'
        );
        return;
      }

      logger.info(
        {
          assetId: signal.assetId,
          conditionId: signal.market,
          roiPercent: roiPercent?.toFixed(2),
          hoursUntilResolution: hoursUntilResolution.toFixed(1),
          isFeeFree,
          negRisk,
        },
        'LOW ROI order passed validations, proceeding with execution'
      );
    }

    // Price-move safety: compare observed signal price vs current midpoint.
    if (this.maxPriceMove > 0) {
      try {
        const mid: any = await (this.client as any).getMidpoint?.(signal.assetId);
        const midpoint = Number(mid?.midpoint ?? mid?.price ?? mid);
        if (Number.isFinite(midpoint) && midpoint > 0) {
          const move = Math.abs(midpoint - price);
          if (move > this.maxPriceMove) {
            logger.warn({ assetId: signal.assetId, price, midpoint, move }, 'skipping: price moved too far');
            return;
          }
        }
      } catch (e) {
        logger.debug({ err: e }, 'midpoint check failed; continuing');
      }
    }

    // --- Hybrid execution (range vs momentum) ---
    const execStyle = String(process.env.COPY_EXEC_STYLE ?? 'hybrid').toLowerCase();
    const momentumTriggerAbs = Number(process.env.COPY_MOMENTUM_TRIGGER_ABS ?? '0.02');

    // If we have book info, we can choose a better limit price than the trader's print.
    let desiredPrice = price;
    let useMakerOnly = false;

    const haveBook = Number.isFinite(bestBid as any) && Number.isFinite(bestAsk as any) && Number.isFinite(midFromBook as any);

    // Low ROI orders with fees: force maker-only execution to avoid taker fees
    if (isLowRoi && !ALLOW_LOW_ROI_WITH_FEES && haveBook) {
      const bb = bestBid as number;
      const ba = bestAsk as number;

      // Post at maker prices (join the book, don't cross)
      desiredPrice = signal.side === 'BUY' ? bb : ba;
      useMakerOnly = true;

      logger.info(
        {
          assetId: signal.assetId,
          side: signal.side,
          traderPrice: price,
          makerPrice: desiredPrice,
          bestBid: bb,
          bestAsk: ba,
          roiPercent: roiPercent?.toFixed(2),
        },
        'LOW ROI: using maker-only execution to avoid taker fees'
      );
    } else if (execStyle === 'hybrid' && haveBook) {
      const bb = bestBid as number;
      const ba = bestAsk as number;
      const mid = midFromBook as number;

      const isExitLike = signal.side === 'SELL' || signal.trader === 'risk-manager' || signal.trader === 'trader-exit-reconciler';

      if (isExitLike) {
        // Exits: prioritize getting out (hit bid for sells; for buys, cross to ask).
        desiredPrice = signal.side === 'SELL' ? bb : ba;
      } else {
        // Entries: default to range/pullback (post near bid). Only chase if trader print is far from mid.
        const chase = Math.abs(price - mid) >= momentumTriggerAbs;
        desiredPrice = chase ? (signal.side === 'BUY' ? ba : bb) : (signal.side === 'BUY' ? bb : ba);
      }

      logger.info(
        {
          assetId: signal.assetId,
          traderPrice: price,
          desiredPrice,
          bestBid: bb,
          bestAsk: ba,
          mid,
          momentumTriggerAbs,
          side: signal.side,
        },
        'hybrid execution price selected'
      );
    }

    let shares = notional / desiredPrice;
    let adjustedNotional = notional;

    // Minimum shares validation (exchange requirement, typically 5 shares)
    const minSharesPerOrder = Number(process.env.MIN_SHARES_PER_ORDER ?? '5');
    if (shares < minSharesPerOrder) {
      // Calculate minimum notional needed to reach minimum shares
      const minNotional = minSharesPerOrder * desiredPrice;

      // Check if we can adjust notional to meet minimum without violating limits
      const canAdjust = minNotional <= this.maxUsdcPerTrade;

      if (!canAdjust) {
        logger.warn(
          {
            assetId: signal.assetId,
            desiredPrice,
            calculatedShares: shares,
            minSharesPerOrder,
            originalNotional: notional,
            minNotionalNeeded: minNotional,
            maxUsdcPerTrade: this.maxUsdcPerTrade,
          },
          'SKIPPING: Order too small (shares < minimum). Increase MAX_MY_USDC_PER_SIGNAL or maxUsdcPerTrade.'
        );
        return;
      }

      // Re-check daily notional limit with adjusted value
      const dailyLimit = await getDailyLimit(this.dayKey);
      const currentDailyNotional = dailyLimit?.notional_usdc ? Number(dailyLimit.notional_usdc) : 0;

      if (this.maxDailyNotionalUsdc > 0 && currentDailyNotional + minNotional > this.maxDailyNotionalUsdc) {
        logger.warn(
          {
            assetId: signal.assetId,
            desiredPrice,
            calculatedShares: shares,
            minSharesPerOrder,
            originalNotional: notional,
            minNotionalNeeded: minNotional,
            currentDailyNotional,
            maxDailyNotionalUsdc: this.maxDailyNotionalUsdc,
          },
          'SKIPPING: Adjusting to minimum shares would exceed daily notional limit'
        );
        return;
      }

      // Adjust notional to meet minimum shares requirement
      adjustedNotional = minNotional;
      shares = minSharesPerOrder;

      logger.info(
        {
          assetId: signal.assetId,
          originalNotional: notional,
          adjustedNotional,
          originalShares: notional / desiredPrice,
          adjustedShares: shares,
          minSharesPerOrder,
        },
        'Adjusted notional to meet minimum shares requirement'
      );
    }

    // Open-notional guard (approximate): only count BUY notional towards open exposure.
    // Track positions by assetId to allow multiple positions in different assets of the same market.
    const assetKey = String(signal.assetId).toLowerCase();
    const marketKey = String(signal.market ?? signal.assetId).toLowerCase();
    const open = this.openNotionalByMarket.get(assetKey) ?? 0;

    const activeMarkets = [...this.openNotionalByMarket.values()].filter((v) => v > 0).length;
    if (signal.side === 'BUY' && open <= 0 && activeMarkets >= this.maxActiveMarkets) {
      logger.warn(
        { market: signal.market, assetId: signal.assetId, activeMarkets, maxActiveMarkets: this.maxActiveMarkets },
        'skipping: maxActiveMarkets exceeded (too many markets already open)'
      );
      return;
    }

    if (signal.side === 'BUY' && open + adjustedNotional > this.maxOpenUsdcPerMarket) {
      logger.warn(
        { market: signal.market, assetId: signal.assetId, openUsdc: open, attempted: adjustedNotional, max: this.maxOpenUsdcPerMarket },
        'skipping: maxOpenUsdcPerMarket exceeded'
      );
      return;
    }

    logger.info(
      {
        trader: signal.trader,
        market: signal.market,
        assetId: signal.assetId,
        side: signal.side,
        price,
        notional: adjustedNotional,
        shares,
        minSharesPerOrder,
      },
      'placing order'
    );

    // Prefer dynamic tick_size/neg_risk from orderbook; fall back to defaults.
    const tickSize = Number(tickSizeStr ?? '0.01');
    const negRisk2 = negRisk ?? false;

    const clampToTick = (p: number) => {
      const clamped = Math.min(1 - tickSize, Math.max(tickSize, p));
      // round to nearest tick
      return Math.round(clamped / tickSize) * tickSize;
    };

    const safePrice = clampToTick(desiredPrice);

    let order: any;
    try {
      // createAndPostOrder expects tokenID, price, size (shares), side.
      // For low ROI orders with fees, use postOnly to ensure maker execution
      order = await this.client.createAndPostOrder(
        {
          tokenID: signal.assetId,
          // If marketable=true, prefer aggressive pricing by using price as-is for now.
          // (True market orders aren't supported; marketable mode should be implemented using book crossing.)
          price: safePrice,
          size: shares,
          side: signal.side,
        } as any,
        { tickSize: tickSize.toString() as any, negRisk: negRisk2 } as any,
        'GTC' as any,
        false,
        useMakerOnly
      );
    } catch (err) {
      this.consecutiveOrderFailures += 1;
      const errMsg = String(err).toLowerCase();
      const isCritical = errMsg.includes('invalid signature') || errMsg.includes('unauthorized') || errMsg.includes('forbidden');

      logger.error(
        {
          err,
          assetId: signal.assetId,
          safePrice,
          shares,
          failureProgress: `${this.consecutiveOrderFailures}/${this.maxConsecutiveFailures}`,
          isCritical,
        },
        `Order failure ${this.consecutiveOrderFailures}/${this.maxConsecutiveFailures}: createAndPostOrder threw`
      );

      if (isCritical) {
        this.haltTrading('critical order error (invalid signature or auth)', { error: String(err) });
      } else if (this.consecutiveOrderFailures >= this.maxConsecutiveFailures) {
        this.haltTrading('too many consecutive order failures (throws)', { maxConsecutiveFailures: this.maxConsecutiveFailures });
      }
      return;
    }

    // Update simple counters only on success.
    if (order?.error) {
      this.consecutiveOrderFailures += 1;
      const errMsg = String(order?.error ?? '').toLowerCase();
      const isCritical = errMsg.includes('invalid signature') || errMsg.includes('unauthorized') || errMsg.includes('forbidden');

      logger.error(
        {
          order,
          failureProgress: `${this.consecutiveOrderFailures}/${this.maxConsecutiveFailures}`,
          isCritical,
        },
        `Order failure ${this.consecutiveOrderFailures}/${this.maxConsecutiveFailures}: order rejected`
      );

      if (isCritical) {
        this.haltTrading('critical order error (invalid signature or auth)', { error: order.error });
      } else if (this.consecutiveOrderFailures >= this.maxConsecutiveFailures) {
        this.haltTrading('too many consecutive order failures', { maxConsecutiveFailures: this.maxConsecutiveFailures });
      }

      return;
    }

    this.consecutiveOrderFailures = 0;

    const dedupeKey = `${signal.trader}:${signal.market}:${signal.assetId}:${signal.side}:${Date.now()}`;
    const executedSignal: ExecutedSignal = {
      dedupe_key: dedupeKey,
      trader: signal.trader,
      market: signal.market,
      asset_id: signal.assetId,
      side: signal.side,
      notional_usdc: adjustedNotional,
      shares,
      price: safePrice,
      order_id: order?.orderID || order?.id,
      tx_hash: order?.transactionHash,
      executed_at: new Date().toISOString(),
      detected_at: signal.detectedAt ? new Date(signal.detectedAt).toISOString() : new Date().toISOString(),
    };

    await recordSignalExecution(executedSignal);
    await incrementDailyNotional(this.dayKey, adjustedNotional);

    this.dailyNotionalUsdc += adjustedNotional;
    if (signal.side === 'BUY') {
      this.openNotionalByMarket.set(assetKey, open + adjustedNotional);

      const nowMs = Date.now();
      let cur = this.openPositions.get(assetKey);
      if (!cur) {
        const dbPos = await getOpenPosition(assetKey);
        if (dbPos) {
          cur = this.dbToOpenPosition(dbPos);
        }
      }
      if (!cur) {
        const newPosition: OpenPosition = {
          marketKey: marketKey,
          assetId: signal.assetId,
          outcome: signal.outcome,
          notionalUsdc: open + adjustedNotional,
          shares,
          entryPrice: safePrice,
          bestPrice: safePrice,
          openedAtMs: nowMs,
          buysCount: 1,
          lastBuyAtMs: nowMs,
          lastBuyPrice: Number(signal.price ?? safePrice),
        };
        this.openPositions.set(assetKey, newPosition);

        await upsertOpenPosition({
          market_key: marketKey,
          asset_id: signal.assetId,
          outcome: signal.outcome,
          notional_usdc: open + adjustedNotional,
          shares,
          entry_price: safePrice,
          best_price: safePrice,
          opened_at: new Date(nowMs).toISOString(),
          buys_count: 1,
          last_buy_at: new Date(nowMs).toISOString(),
          last_buy_price: Number(signal.price ?? safePrice),
        });
      } else {
        const prevNotional = Math.max(0, cur.notionalUsdc);
        const newNotional = open + adjustedNotional;
        const avgEntry = newNotional > 0 ? (cur.entryPrice * prevNotional + safePrice * adjustedNotional) / newNotional : safePrice;
        const updatedPosition: OpenPosition = {
          marketKey: marketKey,
          assetId: signal.assetId,
          outcome: signal.outcome ?? cur.outcome,
          notionalUsdc: newNotional,
          shares: Math.max(0, cur.shares + shares),
          entryPrice: avgEntry,
          bestPrice: Math.max(cur.bestPrice, safePrice),
          openedAtMs: cur.openedAtMs,
          buysCount: cur.buysCount + 1,
          lastBuyAtMs: nowMs,
          lastBuyPrice: Number(signal.price ?? safePrice),
        };
        this.openPositions.set(assetKey, updatedPosition);

        await upsertOpenPosition({
          market_key: marketKey,
          asset_id: signal.assetId,
          outcome: signal.outcome ?? cur.outcome,
          notional_usdc: newNotional,
          shares: Math.max(0, cur.shares + shares),
          entry_price: avgEntry,
          best_price: Math.max(cur.bestPrice, safePrice),
          opened_at: new Date(cur.openedAtMs).toISOString(),
          buys_count: cur.buysCount + 1,
          last_buy_at: new Date(nowMs).toISOString(),
          last_buy_price: Number(signal.price ?? safePrice),
        });
      }
    } else {
      let cur = this.openPositions.get(assetKey);
      if (!cur) {
        const dbPos = await getOpenPosition(assetKey);
        if (dbPos) {
          cur = this.dbToOpenPosition(dbPos);
        }
      }
      if (cur && cur.shares > 0) {
        const sharesSold = Math.min(cur.shares, shares);
        const realized = (safePrice - cur.entryPrice) * sharesSold;
        this.dailyRealizedPnlUsdc += realized;

        await updateDailyPnl(this.dayKey, realized);

        logger.warn(
          {
            dayKey: this.dayKey,
            assetKey: assetKey,
            marketKey: marketKey,
            entryPrice: cur.entryPrice,
            exitPrice: safePrice,
            sharesSold,
            realizedPnlUsdcDelta: realized,
            dailyRealizedPnlUsdc: this.dailyRealizedPnlUsdc,
            estimated: true,
          },
          'daily realized pnl updated (estimated)'
        );
      }

      const remaining = Math.max(0, open - adjustedNotional);
      this.openNotionalByMarket.set(assetKey, remaining);
      if (remaining <= 0) {
        this.openPositions.delete(assetKey);
        await deleteOpenPosition(assetKey);
      } else {
        if (cur) {
          const remainingShares = Math.max(0, cur.shares - shares);
          const updatedPosition: OpenPosition = { ...cur, notionalUsdc: remaining, shares: remainingShares };
          this.openPositions.set(assetKey, updatedPosition);

          await upsertOpenPosition({
            market_key: marketKey,
            asset_id: cur.assetId,
            outcome: cur.outcome,
            notional_usdc: remaining,
            shares: remainingShares,
            entry_price: cur.entryPrice,
            best_price: cur.bestPrice,
            opened_at: new Date(cur.openedAtMs).toISOString(),
            buys_count: cur.buysCount,
            last_buy_at: cur.lastBuyAtMs ? new Date(cur.lastBuyAtMs).toISOString() : undefined,
            last_buy_price: cur.lastBuyPrice,
          });
        }
      }
    }

    logger.info({ order, dailyNotionalUsdc: this.dailyNotionalUsdc, dailyRealizedPnlUsdc: this.dailyRealizedPnlUsdc, dayKey: this.dayKey }, 'order posted');
  }
}
