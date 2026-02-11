import { readFileSync } from 'fs';
import { parse } from 'yaml';
import { z } from 'zod';

const HighConfidenceConfigSchema = z.object({
  scanner: z.object({
    minProbability: z.number().min(0).max(1),
    maxProbability: z.number().min(0).max(1),
    minVolume24h: z.number().min(0),
    maxSpreadPercent: z.number().min(0),
    maxTimeToResolutionHours: z.number().min(0),
    categories: z.array(z.string()),
    scanIntervalMs: z.number().min(1000),
    minMarketAgeHours: z.number().min(0),
  }),
  risk: z.object({
    maxUsdcPerTrade: z.number().min(0),
    maxActivePositions: z.number().min(1),
    stopLossPercent: z.number().min(0),
    partialStopPercent: z.number().min(0),
    alertThresholdPercent: z.number().min(0),
    takeProfitPercent: z.number().min(0),
    trailingStopPercent: z.number().min(0),
    monitorIntervalMs: z.number().min(1000),
    maxDailyLossUsdc: z.number().min(0),
    maxDailyNotionalUsdc: z.number().min(0),
  }),
  execution: z.object({
    paper: z.boolean(),
    marketable: z.boolean(),
    maxPriceMove: z.number().min(0),
  }),
  scoring: z.object({
    probabilityWeight: z.number().min(0),
    volumeWeight: z.number().min(0),
    spreadWeight: z.number().min(0),
    timeWeight: z.number().min(0),
    momentumWeight: z.number().min(0),
  }),
  traderDiscovery: z.object({
    minWinRate: z.number().min(0).max(1),
    minROI: z.number(),
    minTrades: z.number().min(1),
    minAvgPositionSize: z.number().min(0),
    maxParallelAnalysis: z.number().min(1),
    cacheHours: z.number().min(0),
    topN: z.number().min(1),
    leaderboardLimit: z.number().min(1).default(1000),
    tradesPerTrader: z.number().min(1).default(2000),
  }),
  ranking: z.object({
    winRateWeight: z.number().min(0),
    roiWeight: z.number().min(0),
    totalTradesWeight: z.number().min(0),
    consistencyWeight: z.number().min(0),
    positionSizeWeight: z.number().min(0),
    recencyWeight: z.number().min(0),
  }),
  traders: z.array(z.string()).optional().default([]),
});

export type HighConfidenceConfig = z.infer<typeof HighConfidenceConfigSchema>;

export function loadHighConfidenceConfig(path: string = 'high-confidence-config.yml'): HighConfidenceConfig {
  const raw = readFileSync(path, 'utf-8');
  const parsed = parse(raw);
  return HighConfidenceConfigSchema.parse(parsed);
}
