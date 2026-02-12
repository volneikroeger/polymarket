import 'dotenv/config';
import { logger } from './lib/logger.js';
import { loadCopyTradingConfig } from './lib/copyTradingConfig.js';
import { TraderPositionMirror } from './lib/signals/traderPositionMirror.js';
import { PolymarketExecutor } from './lib/polymarket/executor.js';
import type { CopySignal } from './lib/signals/types.js';

async function main() {
  logger.info('Starting Trader Copy Bot');

  const configPath = process.env.COPY_TRADING_CONFIG || 'high-confidence-config.yml';
  const config = loadCopyTradingConfig(configPath);

  if (!config.traders || config.traders.length === 0) {
    logger.error('No traders configured. Add traders to high-confidence-config.yml');
    process.exit(1);
  }

  logger.info({ traders: config.traders, count: config.traders.length }, 'Configuration loaded');

  const executor = await PolymarketExecutor.createFromEnv({
    enableTrading: !config.execution.paper,
    fixedUsdcPerTrade: config.risk.maxUsdcPerTrade,
    maxPriceMove: config.execution.maxPriceMove,
    marketable: config.execution.marketable,
    maxUsdcPerTrade: config.risk.maxUsdcPerTrade,
    maxActiveMarkets: config.risk.maxActivePositions,
    maxDailyLossUsdc: config.risk.maxDailyLossUsdc,
    maxDailyNotionalUsdc: config.risk.maxDailyNotionalUsdc,
  });

  logger.info({
    paperMode: config.execution.paper,
    maxUsdcPerTrade: config.risk.maxUsdcPerTrade,
    maxActivePositions: config.risk.maxActivePositions
  }, 'Executor initialized');

  const mirror = new TraderPositionMirror({
    traders: config.traders,
    pollIntervalMs: 30_000,
  });

  mirror.onSignal(async (signal: CopySignal) => {
    try {
      logger.info({
        trader: signal.trader,
        market: signal.market,
        side: signal.side,
        notionalUsdc: signal.notionalUsdc,
        price: signal.price,
      }, 'Received copy signal');

      await executor.executeSignal(signal);

      logger.info({
        trader: signal.trader,
        market: signal.market,
        side: signal.side,
      }, 'Signal executed successfully');
    } catch (error) {
      logger.error({ error, signal }, 'Failed to execute copy signal');
    }
  });

  await mirror.start();

  logger.info('Trader Copy Bot running - monitoring traders for position changes');

  if (process.send) {
    process.send('ready');
  }

  process.on('SIGINT', () => {
    logger.info('Shutting down gracefully');
    mirror.stop();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    logger.info('Shutting down gracefully');
    mirror.stop();
    process.exit(0);
  });
}

main().catch((error) => {
  logger.error({ error }, 'Fatal error in main');
  process.exit(1);
});
