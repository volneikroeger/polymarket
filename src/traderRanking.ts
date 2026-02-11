import 'dotenv/config';
import { logger } from './lib/logger.js';
import { loadHighConfidenceConfig } from './lib/highConfidenceConfig.js';
import { TraderRanking } from './lib/traders/traderRanking.js';
import { getAllDiscoveredTraders } from './lib/highConfidenceDatabase.js';

async function main() {
  logger.info('Starting Trader Ranking');

  const configPath = process.env.HIGH_CONFIDENCE_CONFIG || 'high-confidence-config.yml';
  const config = loadHighConfidenceConfig(configPath);

  const ranking = new TraderRanking(config);

  const filters = {
    isRecommended: process.env.FILTER_RECOMMENDED === 'true' ? true : undefined,
    minWinRate: process.env.MIN_WIN_RATE ? Number(process.env.MIN_WIN_RATE) : undefined,
    minROI: process.env.MIN_ROI ? Number(process.env.MIN_ROI) : undefined,
    minTrades: process.env.MIN_TRADES ? Number(process.env.MIN_TRADES) : undefined,
  };

  logger.info({ filters }, 'Fetching discovered traders');

  const traders = await getAllDiscoveredTraders(filters);

  if (traders.length === 0) {
    logger.warn('No traders found. Run trader discovery first.');
    return;
  }

  logger.info({ count: traders.length }, 'Found discovered traders');

  const limit = process.env.LIMIT ? Number(process.env.LIMIT) : 20;
  const topTraders = await ranking.getTopTraders(limit);

  logger.info({ count: topTraders.length }, `Top ${limit} Traders (Ranked by Score):`);
  logger.info('');

  for (let i = 0; i < topTraders.length; i++) {
    const trader = topTraders[i];

    logger.info({
      rank: i + 1,
      wallet: trader.wallet,
      winRate: (Number(trader.win_rate) * 100).toFixed(2) + '%',
      roi: Number(trader.roi).toFixed(2) + '%',
      totalTrades: trader.total_trades,
      totalVolume: '$' + Number(trader.total_volume).toFixed(0),
      avgPositionSize: '$' + Number(trader.avg_position_size).toFixed(0),
      rankScore: Number(trader.rank_score).toFixed(2),
      trend: trader.performance_trend,
      specialization: trader.specialization || 'N/A',
      recommended: trader.is_recommended ? 'YES' : 'NO',
    }, `Rank #${i + 1}`);

    if (trader.scoreBreakdown) {
      logger.info({
        winRateScore: trader.scoreBreakdown.winRateScore.toFixed(2),
        roiScore: trader.scoreBreakdown.roiScore.toFixed(2),
        tradesScore: trader.scoreBreakdown.tradesScore.toFixed(2),
        consistencyScore: trader.scoreBreakdown.consistencyScore.toFixed(2),
        positionSizeScore: trader.scoreBreakdown.positionSizeScore.toFixed(2),
        recencyScore: trader.scoreBreakdown.recencyScore.toFixed(2),
      }, '  Score Breakdown');
    }

    logger.info('');
  }

  logger.info('Summary Statistics:');
  logger.info({
    totalTraders: traders.length,
    recommended: traders.filter(t => t.is_recommended).length,
    avgWinRate: (traders.reduce((sum, t) => sum + Number(t.win_rate), 0) / traders.length * 100).toFixed(2) + '%',
    avgROI: (traders.reduce((sum, t) => sum + Number(t.roi), 0) / traders.length).toFixed(2) + '%',
    avgTrades: Math.round(traders.reduce((sum, t) => sum + t.total_trades, 0) / traders.length),
  }, 'Overall Statistics');
}

main().catch((error) => {
  logger.error({ error }, 'Fatal error in trader ranking');
  process.exit(1);
});
