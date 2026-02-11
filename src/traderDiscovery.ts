import 'dotenv/config';
import { logger } from './lib/logger.js';
import { loadHighConfidenceConfig } from './lib/highConfidenceConfig.js';
import { TraderAnalyzer } from './lib/traders/traderAnalyzer.js';
import { TraderRanking } from './lib/traders/traderRanking.js';
import { searchTopTradersByVolume } from './lib/polymarket/api.js';
import {
  upsertDiscoveredTrader,
  recordTraderPerformanceHistory,
  getAllDiscoveredTraders,
} from './lib/highConfidenceDatabase.js';

async function main() {
  logger.info('Starting Trader Discovery');

  const configPath = process.env.HIGH_CONFIDENCE_CONFIG || 'high-confidence-config.yml';
  const config = loadHighConfidenceConfig(configPath);

  logger.info({ config: config.traderDiscovery }, 'Configuration loaded');

  const analyzer = new TraderAnalyzer();
  const ranking = new TraderRanking(config);

  logger.info('Fetching top traders from leaderboard');
  const topWallets = await searchTopTradersByVolume(100);

  if (topWallets.length === 0) {
    logger.warn('No traders found on leaderboard');
    return;
  }

  logger.info({ count: topWallets.length }, 'Found traders to analyze');

  const analyses = await analyzer.analyzeBatch(topWallets);

  logger.info({ analyzed: analyses.size }, 'Analysis complete, filtering by minimums');

  const qualified: typeof analyses = new Map();

  for (const [wallet, analysis] of analyses) {
    const meetsMinimums = analyzer.filterByMinimums(
      analysis,
      config.traderDiscovery.minWinRate,
      config.traderDiscovery.minROI,
      config.traderDiscovery.minTrades,
      config.traderDiscovery.minAvgPositionSize
    );

    if (meetsMinimums) {
      qualified.set(wallet, analysis);
    }
  }

  logger.info({ qualified: qualified.size, total: analyses.size }, 'Filtering complete');

  for (const [wallet, analysis] of qualified) {
    const rankScore = ranking.calculateRankScore(analysis);
    const trend = ranking.determinePerformanceTrend(analysis);
    const specialization = ranking.determineSpecialization(analysis);

    const isRecommended = analysis.winRate >= 0.55 && analysis.roi >= 0 && analysis.totalTrades >= 50;

    await upsertDiscoveredTrader({
      wallet,
      discovery_date: new Date().toISOString(),
      win_rate: analysis.winRate,
      roi: analysis.roi,
      total_trades: analysis.totalTrades,
      total_volume: analysis.totalVolume,
      avg_position_size: analysis.avgPositionSize,
      categories: analysis.categories,
      rank_score: rankScore,
      last_analyzed: new Date().toISOString(),
      is_recommended: isRecommended,
      performance_trend: trend,
      specialization,
    });

    await recordTraderPerformanceHistory({
      trader_wallet: wallet,
      snapshot_date: new Date().toISOString(),
      win_rate: analysis.winRate,
      roi: analysis.roi,
      total_trades: analysis.totalTrades,
      total_volume: analysis.totalVolume,
      period: 'all_time',
    });

    logger.info({
      wallet: wallet.substring(0, 10) + '...',
      winRate: (analysis.winRate * 100).toFixed(1) + '%',
      roi: analysis.roi.toFixed(1) + '%',
      trades: analysis.totalTrades,
      rankScore: rankScore.toFixed(2),
      recommended: isRecommended,
    }, 'Trader saved');
  }

  logger.info('Getting top recommended traders');
  const topTraders = await ranking.getTopTraders(config.traderDiscovery.topN);

  logger.info({ count: topTraders.length }, 'Top Recommended Traders:');

  for (let i = 0; i < topTraders.length; i++) {
    const trader = topTraders[i];
    logger.info({
      rank: i + 1,
      wallet: trader.wallet.substring(0, 10) + '...',
      winRate: (Number(trader.win_rate) * 100).toFixed(1) + '%',
      roi: Number(trader.roi).toFixed(1) + '%',
      trades: trader.total_trades,
      volume: Number(trader.total_volume).toFixed(0),
      rankScore: Number(trader.rank_score).toFixed(2),
      specialization: trader.specialization || 'N/A',
    }, `#${i + 1} Trader`);
  }

  logger.info('Trader discovery complete');
}

main().catch((error) => {
  logger.error({ error }, 'Fatal error in trader discovery');
  process.exit(1);
});
