import { readFileSync } from 'fs';
import YAML from 'yaml';
import { z } from 'zod';

const CopyTradingConfigSchema = z.object({
  traders: z.array(z.string()),
  risk: z.object({
    maxUsdcPerTrade: z.number(),
    maxActivePositions: z.number(),
    maxDailyLossUsdc: z.number(),
    maxDailyNotionalUsdc: z.number(),
  }),
  execution: z.object({
    paper: z.boolean(),
    marketable: z.boolean(),
    maxPriceMove: z.number(),
  }),
});

export type CopyTradingConfig = z.infer<typeof CopyTradingConfigSchema>;

export function loadCopyTradingConfig(configPath: string): CopyTradingConfig {
  const fileContents = readFileSync(configPath, 'utf8');
  const data = YAML.parse(fileContents);
  return CopyTradingConfigSchema.parse(data);
}
