import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import { logger } from './logger.js';

const ConfigSchema = z.object({
  traders: z.array(z.string().min(2)),
  copy: z.object({
    fixedUsdcPerTrade: z.number().positive(),
    marketable: z.boolean().default(false),
  }),
  risk: z.object({
    maxUsdcPerTrade: z.number().positive().default(25),
    maxOpenUsdcPerMarket: z.number().positive().default(50), // Updated default to 50

    // Max DAILY LOSS (realized PnL) in USDC. Enforcement is in executor.
    maxDailyLossUsdc: z.number().positive().default(5),

    // Optional cap for daily notional (USDC). 0 disables.
    maxDailyNotionalUsdc: z.number().nonnegative().default(0),

    maxActiveMarkets: z.number().int().positive().default(10),
    maxPriceMove: z.number().nonnegative().default(0.01),
    allowMarkets: z.array(z.string()).default([]),
    denyMarkets: z.array(z.string()).default([]),
  }),
  runtime: z.object({
    paper: z.boolean().default(true),
    pollIntervalMs: z.number().int().positive().default(1500),
  }),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

export async function loadConfig(): Promise<AppConfig> {
  // Use CONFIG_PATH from env if set, otherwise default to config.yml in exec dir.
  // Example: export CONFIG_PATH=/path/to/my/config.yml
  const configPath = process.env.CONFIG_PATH ?? path.resolve(process.cwd(), 'config.yml');

  let raw: string;
  try {
    raw = await fs.readFile(configPath, 'utf8');
  } catch (e: any) {
    logger.warn({ configPath, error: e.message }, 'Config file not found. Falling back to example config.');
    // Fall back to example if user hasn's created config.yml yet.
    raw = await fs.readFile(path.resolve(process.cwd(), 'config.example.yml'), 'utf8');
  }

  const data = YAML.parse(raw);
  return ConfigSchema.parse(data);
}
