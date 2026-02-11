import { logger } from '../logger.js';
import type { HighConfidenceConfig } from '../highConfidenceConfig.js';
import type { TraderAnalysis } from './traderAnalyzer.js';
import { getAllDiscoveredTraders, type DiscoveredTrader } from '../highConfidenceDatabase.js';

export interface RankedTrader extends DiscoveredTrader {
  scoreBreakdown: {
    winRateScore: number;
    roiScore: number;
    tradesScore: number;
    consistencyScore: number;
    positionSizeScore: number;
    recencyScore: number;
  };
}

export class TraderRanking {
  constructor(private readonly config: HighConfidenceConfig) {}

  calculateRankScore(analysis: TraderAnalysis): number {
    const weights = this.config.ranking;

    const winRateScore = this.normalizeWinRate(analysis.winRate) * weights.winRateWeight;
    const roiScore = this.normalizeROI(analysis.roi) * weights.roiWeight;
    const tradesScore = this.normalizeTrades(analysis.totalTrades) * weights.totalTradesWeight;
    const consistencyScore = this.calculateConsistency(analysis) * weights.consistencyWeight;
    const positionSizeScore = this.normalizePositionSize(analysis.avgPositionSize) * weights.positionSizeWeight;
    const recencyScore = 1.0 * weights.recencyWeight;

    return winRateScore + roiScore + tradesScore + consistencyScore + positionSizeScore + recencyScore;
  }

  calculateRankScoreWithBreakdown(analysis: TraderAnalysis): {
    totalScore: number;
    breakdown: {
      winRateScore: number;
      roiScore: number;
      tradesScore: number;
      consistencyScore: number;
      positionSizeScore: number;
      recencyScore: number;
    };
  } {
    const weights = this.config.ranking;

    const winRateScore = this.normalizeWinRate(analysis.winRate) * weights.winRateWeight;
    const roiScore = this.normalizeROI(analysis.roi) * weights.roiWeight;
    const tradesScore = this.normalizeTrades(analysis.totalTrades) * weights.totalTradesWeight;
    const consistencyScore = this.calculateConsistency(analysis) * weights.consistencyWeight;
    const positionSizeScore = this.normalizePositionSize(analysis.avgPositionSize) * weights.positionSizeWeight;
    const recencyScore = 1.0 * weights.recencyWeight;

    const totalScore = winRateScore + roiScore + tradesScore + consistencyScore + positionSizeScore + recencyScore;

    return {
      totalScore,
      breakdown: {
        winRateScore,
        roiScore,
        tradesScore,
        consistencyScore,
        positionSizeScore,
        recencyScore,
      },
    };
  }

  private normalizeWinRate(winRate: number): number {
    if (winRate < 0.5) return 0;
    if (winRate >= 0.75) return 1;

    return (winRate - 0.5) / 0.25;
  }

  private normalizeROI(roi: number): number {
    if (roi < 0) return 0;
    if (roi >= 50) return 1;

    return roi / 50;
  }

  private normalizeTrades(trades: number): number {
    const minTrades = this.config.traderDiscovery.minTrades;
    const maxTrades = minTrades * 10;

    if (trades < minTrades) return 0;
    if (trades >= maxTrades) return 1;

    return (trades - minTrades) / (maxTrades - minTrades);
  }

  private calculateConsistency(analysis: TraderAnalysis): number {
    if (analysis.totalTrades === 0) return 0;

    const winLossRatio = analysis.losingTrades > 0
      ? analysis.profitableTrades / analysis.losingTrades
      : 1;

    if (winLossRatio < 0.5) return 0;
    if (winLossRatio >= 2.0) return 1;

    return (winLossRatio - 0.5) / 1.5;
  }

  private normalizePositionSize(avgSize: number): number {
    const minSize = this.config.traderDiscovery.minAvgPositionSize;
    const idealSize = 50;

    if (avgSize < minSize) return 0;
    if (avgSize >= idealSize) return 1;

    return (avgSize - minSize) / (idealSize - minSize);
  }

  async rankDiscoveredTraders(): Promise<RankedTrader[]> {
    const traders = await getAllDiscoveredTraders({ isRecommended: true });

    const ranked: RankedTrader[] = traders.map(trader => {
      const analysis: TraderAnalysis = {
        wallet: trader.wallet,
        winRate: Number(trader.win_rate),
        roi: Number(trader.roi),
        totalTrades: trader.total_trades,
        totalVolume: Number(trader.total_volume),
        avgPositionSize: Number(trader.avg_position_size),
        profitableTrades: Math.round(trader.total_trades * Number(trader.win_rate)),
        losingTrades: Math.round(trader.total_trades * (1 - Number(trader.win_rate))),
        totalPnl: Number(trader.total_volume) * (Number(trader.roi) / 100),
        categories: trader.categories as Record<string, any>,
        recentPerformance: { last7days: 0, last30days: 0 },
      };

      const { totalScore, breakdown } = this.calculateRankScoreWithBreakdown(analysis);

      return {
        ...trader,
        rank_score: totalScore,
        scoreBreakdown: breakdown,
      };
    });

    ranked.sort((a, b) => b.rank_score - a.rank_score);

    logger.info({ count: ranked.length }, 'Traders ranked');

    return ranked;
  }

  async getTopTraders(limit: number = 10): Promise<RankedTrader[]> {
    const ranked = await this.rankDiscoveredTraders();
    return ranked.slice(0, limit);
  }

  determinePerformanceTrend(analysis: TraderAnalysis): 'improving' | 'stable' | 'declining' {
    return 'stable';
  }

  determineSpecialization(analysis: TraderAnalysis): string | undefined {
    const categories = Object.entries(analysis.categories);

    if (categories.length === 0) {
      return undefined;
    }

    const sorted = categories.sort((a, b) => b[1].trades - a[1].trades);

    return sorted[0][0];
  }
}
