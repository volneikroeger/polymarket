import 'dotenv/config';
import { logger } from './lib/logger.js';
import { loadHighConfidenceConfig } from './lib/highConfidenceConfig.js';
import { HighConfidenceScanner } from './lib/scanners/highConfidenceScanner.js';
import { HighConfidenceRiskManager } from './lib/risk/highConfidenceRiskManager.js';
import { PolymarketExecutor } from './lib/polymarket/executor.js';
import {
  upsertHighConfidencePosition,
  recordHighConfidenceTrade,
  getAllHighConfidencePositions,
} from './lib/highConfidenceDatabase.js';
import type { CopySignal } from './lib/signals/types.js';

async function main() {
  logger.info('Starting High-Confidence Trading Bot');

  const configPath = process.env.HIGH_CONFIDENCE_CONFIG || 'high-confidence-config.yml';
  const config = loadHighConfidenceConfig(configPath);

  logger.info({ config }, 'Configuration loaded');

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

  logger.info({ paperMode: config.execution.paper }, 'Executor initialized');

  const scanner = new HighConfidenceScanner(config);
  const riskManager = new HighConfidenceRiskManager(config, executor);

  async function scanAndExecute() {
    try {
      logger.info('Starting market scan cycle');

      const positions = await getAllHighConfidencePositions('open');
      const activePositionCount = positions.length;

      if (activePositionCount >= config.risk.maxActivePositions) {
        logger.warn(
          { activePositions: activePositionCount, maxActivePositions: config.risk.maxActivePositions },
          'Max active positions reached, skipping scan'
        );
        return;
      }

      const scoredMarkets = await scanner.scanMarkets();

      if (scoredMarkets.length === 0) {
        logger.info('No markets meet the high-confidence criteria');
        return;
      }

      const availableSlots = config.risk.maxActivePositions - activePositionCount;
      const marketsToEnter = scoredMarkets.slice(0, availableSlots);

      for (const market of marketsToEnter) {
        logger.info({
          question: market.market.question,
          outcome: market.outcome,
          probability: (market.probability * 100).toFixed(1) + '%',
          score: market.score.toFixed(2),
          reason: market.reason,
        }, 'Entering high-confidence position');

        const notional = config.risk.maxUsdcPerTrade;
        const shares = notional / market.price;

        const entrySignal: CopySignal = {
          trader: 'high-confidence-scanner',
          market: market.market.question || market.tokenId,
          assetId: market.tokenId,
          outcome: market.outcome,
          side: 'BUY',
          price: market.price,
          notionalUsdc: notional,
          detectedAt: Date.now(),
        };

        try {
          await executor.executeSignal(entrySignal);

          const stopLossPrice = market.price * (1 - config.risk.stopLossPercent / 100);

          await upsertHighConfidencePosition({
            market_key: (market.market.question || market.tokenId).toLowerCase(),
            asset_id: market.tokenId,
            outcome: market.outcome,
            entry_odds: market.probability,
            current_odds: market.probability,
            best_odds: market.probability,
            worst_odds: market.probability,
            entry_price: market.price,
            current_price: market.price,
            stop_loss_price: stopLossPrice,
            notional_usdc: notional,
            shares: shares,
            entry_time: new Date().toISOString(),
            last_check_time: new Date().toISOString(),
            status: 'open',
          });

          await recordHighConfidenceTrade({
            market_key: (market.market.question || market.tokenId).toLowerCase(),
            action: 'buy',
            odds_at_trade: market.probability,
            price: market.price,
            shares: shares,
            notional_usdc: notional,
            reason: market.reason,
            timestamp: new Date().toISOString(),
          });

          logger.info({ market: market.market.question, outcome: market.outcome }, 'Position opened successfully');
        } catch (error) {
          logger.error({ error, market: market.market.question }, 'Failed to open position');
        }
      }
    } catch (error) {
      logger.error({ error }, 'Error in scan and execute cycle');
    }
  }

  async function monitorAndManage() {
    try {
      logger.info('Starting risk monitoring cycle');
      const decisions = await riskManager.monitorPositions();

      if (decisions.length > 0) {
        logger.info({ count: decisions.length, decisions }, 'Exit decisions made');
      }
    } catch (error) {
      logger.error({ error }, 'Error in monitoring cycle');
    }
  }

  await scanAndExecute();
  setInterval(scanAndExecute, config.scanner.scanIntervalMs);

  await monitorAndManage();
  setInterval(monitorAndManage, config.risk.monitorIntervalMs);

  logger.info('High-Confidence Bot running');

  process.on('SIGINT', () => {
    logger.info('Shutting down gracefully');
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    logger.info('Shutting down gracefully');
    process.exit(0);
  });
}

main().catch((error) => {
  logger.error({ error }, 'Fatal error in main');
  process.exit(1);
});
