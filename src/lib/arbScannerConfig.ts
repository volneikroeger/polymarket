import { z } from 'zod';

// V2.3 schema with defaults + strict validation.

const pct0to5 = z.number().min(0).max(0.05);
const ms100to10k = z.number().int().min(100).max(10_000);

export const ArbScannerV23Schema = z
  .object({
    runtime: z.object({
      paper: z.boolean().default(true),
      liveArmed: z.boolean().default(false),
      dryRun: z.boolean().default(true),
      // Optional Telegram alerts
      telegramEnabled: z.boolean().default(false),
    }),

    refresh: z.object({
      universeRefreshMs: z.number().int().min(1_000).max(60 * 60 * 1000).default(600_000),
      monitorPollMs: z.number().int().min(200).max(60_000).default(1_000),
      maxMarketsMonitored: z.number().int().min(1).max(500).default(60),
    }),

    filter: z.object({
      maxDisplayedSum: z.number().min(0).max(2).default(1.02),
      maxSpreadAbs: z.number().min(0).max(0.1).default(0.01),
      topN: z.number().int().min(1).max(100).default(15),

      // Liquidity in USDC notional within topN levels (per leg)
      minAskNotionalTopNUsdc: z.number().min(0).max(1_000_000).default(150),
      minBidNotionalTopNUsdc: z.number().min(0).max(1_000_000).default(150),

      minBestAsk: z.number().min(0).max(1).default(0.02),
      maxBestAsk: z.number().min(0).max(1).default(0.98),

      minTradesLast5m: z.number().int().min(0).max(10_000).default(3),
      minVolumeLast1hUsdc: z.number().min(0).max(1_000_000_000).default(200),
      minChurnPerMin: z.number().int().min(0).max(10_000).default(3),
    }),

    arb: z.object({
      legNotionalUsdc: z.number().min(0.1).max(1000).default(2),

      feeBufferAbs: pct0to5.default(0.003),
      slippageBufferAbs: pct0to5.default(0.002),
      safetyMarginUsdc: z.number().min(0).max(1000).default(0.01),

      minProfitUsdc: z.number().min(0).max(1000).default(0.03),
      minRoiPct: z.number().min(0).max(1).default(0.006),

      execBufferAbs: pct0to5.default(0.002),

      // Fine polling during execution (fills)
      pollIntervalMsExec: z.number().int().min(50).max(1000).default(200),

      legFillTimeoutMs: ms100to10k.default(1200),
      leg2TimeoutMs: ms100to10k.default(1500),
      ttlMs: ms100to10k.default(1500),
      revalidateBeforeEachLeg: z.boolean().default(true),

      maxPartialFillPct: z.number().min(0).max(1).default(0.25),
      maxUnwindLossUsdc: z.number().min(0).max(1000).default(0.2),
      maxUnwindLossPct: z.number().min(0).max(1).default(0.025),

      maxConcurrentOpps: z.number().int().min(1).max(10).default(1),

      // optional split
      splitMaxChildren: z.number().int().min(1).max(5).default(1),
    }),

    risk: z.object({
      // Accounting window
      statePath: z.string().min(1).default('/var/lib/polymarket-arb-scanner/state.json'),

      maxDailyNotionalUsdc: z.number().min(0).max(1_000_000).default(25),
      maxDailyLossUsdc: z.number().min(0.01).max(1_000_000).default(2),

      // Exposure
      maxOpenExposureUsdc: z.number().min(0).max(1_000_000).default(10),
      maxExposurePerMarketUsdc: z.number().min(0).max(1_000_000).default(4),
      maxOneLegExposureUsdc: z.number().min(0).max(1_000_000).default(3),

      // Backward-compat / legacy (kept so older YAML doesn't break). Treat as aliases.
      maxPositionPerMarketUsdc: z.number().min(0).max(1_000_000).default(6),
      maxOneLegNotionalUsdc: z.number().min(0).max(1_000_000).default(3),

      // Open orders sanity
      maxOpenOrders: z.number().int().min(0).max(10_000).default(10),

      // Local rate limits
      maxOrdersPerMinute: z.number().int().min(1).max(10_000).default(30),
      maxCancelsPerMinute: z.number().int().min(1).max(10_000).default(60),

      // Failure / unwind controls
      maxConsecutiveFailures: z.number().int().min(1).max(10_000).default(5),
      maxConsecutiveUnwinds: z.number().int().min(0).max(10_000).default(3),

      // Cooldowns
      cooldownPerMarketMs: z.number().int().min(0).max(7 * 24 * 60 * 60 * 1000).default(600_000),
      // Deprecated name (older configs)
      marketCooldownMs: z.number().int().min(0).max(7 * 24 * 60 * 60 * 1000).default(1_800_000),

      // Infra kill switches
      httpErrorsHaltThreshold: z.number().int().min(1).max(10_000).default(5),
      haltDurationMs: z.number().int().min(1_000).max(7 * 24 * 60 * 60 * 1000).default(600_000),

      latencyMaxMs: z.number().int().min(50).max(60_000).default(1500),
      latencyMaxBreachesToHalt: z.number().int().min(1).max(10_000).default(5),

      feedStaleMs: z.number().int().min(200).max(60_000).default(5000),

      // Legacy name (kept for compatibility)
      maxHttpErrorsInRow: z.number().int().min(1).max(10_000).default(5),
      maxOrderbookLatencyMs: z.number().int().min(50).max(60_000).default(1500),

      cooldownAfterHaltMs: z.number().int().min(0).max(7 * 24 * 60 * 60 * 1000).default(300_000),
    }),
  })
  .strict();

export type ArbScannerV23Config = z.infer<typeof ArbScannerV23Schema>;
