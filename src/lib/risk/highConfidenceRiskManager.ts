import { logger } from '../logger.js';
import type { HighConfidenceConfig } from '../highConfidenceConfig.js';
import type { CopySignal } from '../signals/types.js';
import type { PolymarketExecutor } from '../polymarket/executor.js';
import {
  getAllHighConfidencePositions,
  updateHighConfidenceOdds,
  closeHighConfidencePosition,
  recordHighConfidenceTrade,
  type HighConfidencePosition,
} from '../highConfidenceDatabase.js';
import { fetchOrderBook, calculateMidPrice } from '../polymarket/api.js';

export interface ExitDecision {
  marketKey: string;
  exitType: 'stop_loss' | 'partial_stop' | 'take_profit' | 'trailing_stop';
  exitPercent: number;
  reason: string;
  currentOdds: number;
  entryOdds: number;
  oddsChangePercent: number;
}

export class HighConfidenceRiskManager {
  constructor(
    private readonly config: HighConfidenceConfig,
    private readonly executor: PolymarketExecutor
  ) {}

  async monitorPositions(): Promise<ExitDecision[]> {
    const positions = await getAllHighConfidencePositions('open');

    if (positions.length === 0) {
      return [];
    }

    logger.info({ count: positions.length }, 'Monitoring high-confidence positions');

    const decisions: ExitDecision[] = [];

    for (const position of positions) {
      const decision = await this.evaluatePosition(position);
      if (decision) {
        decisions.push(decision);
        await this.executeExit(position, decision);
      }
    }

    return decisions;
  }

  private async evaluatePosition(position: HighConfidencePosition): Promise<ExitDecision | null> {
    const orderBook = await fetchOrderBook(position.asset_id);
    if (!orderBook) {
      logger.warn({ marketKey: position.market_key }, 'Failed to fetch order book for position');
      return null;
    }

    const currentPrice = calculateMidPrice(orderBook);
    if (!currentPrice) {
      logger.warn({ marketKey: position.market_key }, 'Failed to calculate mid price for position');
      return null;
    }

    const currentOdds = currentPrice;

    await updateHighConfidenceOdds(position.market_key, currentOdds, currentPrice);

    const entryOdds = position.entry_odds;
    const oddsChangePercent = ((currentOdds - entryOdds) / entryOdds) * 100;
    const oddsDropPercent = -oddsChangePercent;

    logger.debug({
      marketKey: position.market_key,
      entryOdds,
      currentOdds,
      oddsChangePercent: oddsChangePercent.toFixed(2),
    }, 'Position odds update');

    if (oddsDropPercent >= this.config.risk.stopLossPercent) {
      return {
        marketKey: position.market_key,
        exitType: 'stop_loss',
        exitPercent: 100,
        reason: `Stop-loss triggered: odds dropped ${oddsDropPercent.toFixed(1)}%`,
        currentOdds,
        entryOdds,
        oddsChangePercent,
      };
    }

    if (oddsDropPercent >= this.config.risk.partialStopPercent) {
      return {
        marketKey: position.market_key,
        exitType: 'partial_stop',
        exitPercent: 50,
        reason: `Partial stop-loss: odds dropped ${oddsDropPercent.toFixed(1)}%`,
        currentOdds,
        entryOdds,
        oddsChangePercent,
      };
    }

    if (oddsChangePercent >= this.config.risk.takeProfitPercent) {
      return {
        marketKey: position.market_key,
        exitType: 'take_profit',
        exitPercent: 100,
        reason: `Take-profit triggered: odds increased ${oddsChangePercent.toFixed(1)}%`,
        currentOdds,
        entryOdds,
        oddsChangePercent,
      };
    }

    if (position.best_odds > entryOdds) {
      const dropFromBest = ((position.best_odds - currentOdds) / position.best_odds) * 100;
      if (dropFromBest >= this.config.risk.trailingStopPercent) {
        return {
          marketKey: position.market_key,
          exitType: 'trailing_stop',
          exitPercent: 100,
          reason: `Trailing stop: odds dropped ${dropFromBest.toFixed(1)}% from best`,
          currentOdds,
          entryOdds,
          oddsChangePercent,
        };
      }
    }

    if (oddsDropPercent >= this.config.risk.alertThresholdPercent) {
      logger.warn({
        marketKey: position.market_key,
        entryOdds,
        currentOdds,
        oddsDropPercent: oddsDropPercent.toFixed(1),
      }, 'Alert: position odds declining');
    }

    return null;
  }

  private async executeExit(position: HighConfidencePosition, decision: ExitDecision): Promise<void> {
    logger.warn({
      marketKey: position.market_key,
      exitType: decision.exitType,
      exitPercent: decision.exitPercent,
      reason: decision.reason,
    }, 'Executing exit');

    const sharesToSell = position.shares * (decision.exitPercent / 100);

    const exitSignal: CopySignal = {
      trader: 'high-confidence-risk-manager',
      market: position.market_key,
      assetId: position.asset_id,
      outcome: position.outcome,
      side: 'SELL',
      price: decision.currentOdds,
      notionalUsdc: sharesToSell * decision.currentOdds,
      detectedAt: Date.now(),
    };

    try {
      await this.executor.executeSignal(exitSignal);

      await recordHighConfidenceTrade({
        position_id: position.id,
        market_key: position.market_key,
        action: decision.exitPercent === 100 ? 'full_sell' : 'partial_sell',
        odds_at_trade: decision.currentOdds,
        price: decision.currentOdds,
        shares: sharesToSell,
        notional_usdc: sharesToSell * decision.currentOdds,
        reason: decision.reason,
        timestamp: new Date().toISOString(),
      });

      if (decision.exitPercent === 100) {
        const exitReasonMap: Record<string, 'stop_loss' | 'take_profit' | 'manual' | 'resolution'> = {
          'stop_loss': 'stop_loss',
          'partial_stop': 'stop_loss',
          'take_profit': 'take_profit',
          'trailing_stop': 'stop_loss',
        };
        await closeHighConfidencePosition(position.market_key, exitReasonMap[decision.exitType]);
      }

      logger.info({ marketKey: position.market_key, decision }, 'Exit executed successfully');
    } catch (error) {
      logger.error({ error, marketKey: position.market_key, decision }, 'Failed to execute exit');
    }
  }

  async checkDailyLimits(): Promise<boolean> {
    return true;
  }
}
