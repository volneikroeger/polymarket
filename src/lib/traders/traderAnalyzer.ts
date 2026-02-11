import { logger } from '../logger.js';
import { fetchTraderData, type TraderData } from '../polymarket/api.js';
import type { HighConfidenceConfig } from '../highConfidenceConfig.js';

export interface TraderAnalysis {
  wallet: string;
  winRate: number;
  roi: number;
  totalTrades: number;
  totalVolume: number;
  avgPositionSize: number;
  profitableTrades: number;
  losingTrades: number;
  totalPnl: number;
  categories: Record<string, CategoryPerformance>;
  recentPerformance: {
    last7days: number;
    last30days: number;
  };
}

export interface CategoryPerformance {
  trades: number;
  winRate: number;
  pnl: number;
  volume: number;
}

export class TraderAnalyzer {
  private tradesPerTrader: number;
  private maxParallelAnalysis: number;

  constructor(config: HighConfidenceConfig) {
    this.tradesPerTrader = config.traderDiscovery.tradesPerTrader || 2000;
    this.maxParallelAnalysis = config.traderDiscovery.maxParallelAnalysis || 20;
  }

  async analyzeTrader(wallet: string): Promise<TraderAnalysis | null> {
    logger.info({ wallet }, 'Analyzing trader');

    const traderData = await fetchTraderData(wallet, this.tradesPerTrader);
    if (!traderData) {
      logger.warn({ wallet }, 'Failed to fetch trader data');
      return null;
    }

    if (traderData.totalTrades === 0) {
      logger.warn({ wallet }, 'Trader has no trades');
      return null;
    }

    const totalPnl = traderData.markets.reduce((sum, m) => sum + m.pnl, 0);
    const profitableMarkets = traderData.markets.filter(m => m.pnl > 0).length;
    const losingMarkets = traderData.markets.filter(m => m.pnl < 0).length;
    const totalMarkets = traderData.markets.length;

    const winRate = totalMarkets > 0 ? profitableMarkets / totalMarkets : 0;
    const roi = traderData.totalVolume > 0 ? (totalPnl / traderData.totalVolume) * 100 : 0;
    const avgPositionSize = traderData.totalTrades > 0 ? traderData.totalVolume / traderData.totalTrades : 0;

    const categories: Record<string, CategoryPerformance> = {};

    const analysis: TraderAnalysis = {
      wallet,
      winRate,
      roi,
      totalTrades: traderData.totalTrades,
      totalVolume: traderData.totalVolume,
      avgPositionSize,
      profitableTrades: profitableMarkets,
      losingTrades: losingMarkets,
      totalPnl,
      categories,
      recentPerformance: {
        last7days: 0,
        last30days: 0,
      },
    };

    logger.info({
      wallet,
      winRate: (winRate * 100).toFixed(2) + '%',
      roi: roi.toFixed(2) + '%',
      totalTrades: traderData.totalTrades,
      totalPnl: totalPnl.toFixed(2),
    }, 'Trader analysis complete');

    return analysis;
  }

  async analyzeBatch(wallets: string[]): Promise<Map<string, TraderAnalysis>> {
    logger.info({ count: wallets.length }, 'Analyzing batch of traders');

    const results = new Map<string, TraderAnalysis>();
    const chunkSize = 10;

    for (let i = 0; i < wallets.length; i += chunkSize) {
      const chunk = wallets.slice(i, i + chunkSize);

      const promises = chunk.map(async (wallet) => {
        try {
          const analysis = await this.analyzeTrader(wallet);
          if (analysis) {
            results.set(wallet, analysis);
          }
        } catch (error) {
          logger.error({ error, wallet }, 'Error analyzing trader');
        }
      });

      await Promise.all(promises);

      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    logger.info({ analyzed: results.size, total: wallets.length }, 'Batch analysis complete');

    return results;
  }

  filterByMinimums(
    analysis: TraderAnalysis,
    minWinRate: number,
    minROI: number,
    minTrades: number,
    minAvgPositionSize: number
  ): boolean {
    if (analysis.winRate < minWinRate) return false;
    if (analysis.roi < minROI) return false;
    if (analysis.totalTrades < minTrades) return false;
    if (analysis.avgPositionSize < minAvgPositionSize) return false;

    return true;
  }
}
