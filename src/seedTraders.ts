import 'dotenv/config';
import { logger } from './lib/logger.js';
import { upsertDiscoveredTrader } from './lib/highConfidenceDatabase.js';

const sampleTraders = [
  {
    wallet: '0x2005d16a84ceefa912d4e380cd32e7ff827875ea',
    win_rate: 0.68,
    roi: 15.3,
    total_trades: 145,
    total_volume: 28500,
    avg_position_size: 196.5,
    specialization: 'sports',
    performance_trend: 'stable' as const,
  },
  {
    wallet: '0x742d35cc6634c0532925a3b844bc9e7595f0beb2',
    win_rate: 0.72,
    roi: 22.1,
    total_trades: 89,
    total_volume: 15200,
    avg_position_size: 170.8,
    specialization: 'crypto',
    performance_trend: 'improving' as const,
  },
  {
    wallet: '0x8c3fa50473065f1d90f186ca8ba1aa76aee409bb',
    win_rate: 0.58,
    roi: 8.4,
    total_trades: 213,
    total_volume: 42300,
    avg_position_size: 198.6,
    specialization: 'politics',
    performance_trend: 'stable' as const,
  },
  {
    wallet: '0x1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b',
    win_rate: 0.75,
    roi: 28.7,
    total_trades: 67,
    total_volume: 9800,
    avg_position_size: 146.3,
    specialization: 'sports',
    performance_trend: 'improving' as const,
  },
  {
    wallet: '0x9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f0e',
    win_rate: 0.52,
    roi: 3.2,
    total_trades: 178,
    total_volume: 31200,
    avg_position_size: 175.3,
    specialization: 'crypto',
    performance_trend: 'declining' as const,
  },
  {
    wallet: '0xa1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
    win_rate: 0.64,
    roi: 12.8,
    total_trades: 156,
    total_volume: 25600,
    avg_position_size: 164.1,
    specialization: 'politics',
    performance_trend: 'stable' as const,
  },
  {
    wallet: '0xb3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2',
    win_rate: 0.61,
    roi: 9.7,
    total_trades: 124,
    total_volume: 18900,
    avg_position_size: 152.4,
    specialization: 'sports',
    performance_trend: 'stable' as const,
  },
  {
    wallet: '0xc5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4',
    win_rate: 0.56,
    roi: 5.9,
    total_trades: 201,
    total_volume: 35400,
    avg_position_size: 176.1,
    specialization: 'crypto',
    performance_trend: 'stable' as const,
  },
  {
    wallet: '0xd7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6',
    win_rate: 0.48,
    roi: -2.1,
    total_trades: 93,
    total_volume: 14200,
    avg_position_size: 152.7,
    specialization: 'politics',
    performance_trend: 'declining' as const,
  },
  {
    wallet: '0xe9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8',
    win_rate: 0.70,
    roi: 18.5,
    total_trades: 112,
    total_volume: 19800,
    avg_position_size: 176.8,
    specialization: 'sports',
    performance_trend: 'improving' as const,
  },
];

async function main() {
  logger.info('Seeding traders database with sample data');

  for (const trader of sampleTraders) {
    const rankScore =
      trader.win_rate * 30 +
      (trader.roi / 50) * 25 +
      Math.min(trader.total_trades / 200, 1) * 15 +
      0.7 * 15 +
      Math.min(trader.avg_position_size / 200, 1) * 10 +
      1.0 * 5;

    const isRecommended = trader.win_rate >= 0.60 && trader.roi >= 5.0 && trader.total_trades >= 60;

    await upsertDiscoveredTrader({
      wallet: trader.wallet,
      discovery_date: new Date().toISOString(),
      win_rate: trader.win_rate,
      roi: trader.roi,
      total_trades: trader.total_trades,
      total_volume: trader.total_volume,
      avg_position_size: trader.avg_position_size,
      categories: { [trader.specialization]: { trades: trader.total_trades, winRate: trader.win_rate } },
      rank_score: rankScore,
      last_analyzed: new Date().toISOString(),
      is_recommended: isRecommended,
      performance_trend: trader.performance_trend,
      specialization: trader.specialization,
    });

    logger.info({
      wallet: trader.wallet.substring(0, 10) + '...',
      winRate: (trader.win_rate * 100).toFixed(1) + '%',
      roi: trader.roi.toFixed(1) + '%',
      rankScore: rankScore.toFixed(2),
      recommended: isRecommended,
    }, 'Trader seeded');
  }

  logger.info({ count: sampleTraders.length }, 'Database seeded successfully');
}

main().catch((error) => {
  logger.error({ error }, 'Fatal error seeding traders');
  process.exit(1);
});
