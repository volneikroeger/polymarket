import { logger } from './lib/logger.js';
import { fetchTraderData } from './lib/polymarket/api.js';

interface TraderPosition {
  marketId: string;
  outcome: string;
  size: number;
  avgPrice: number;
  currentValue: number;
  unrealizedPnl: number;
}

interface OpenPositionStats {
  totalOpen: number;
  zeroPositions: number;
  negativePositions: number;
  positivePositions: number;
  avgSize: number;
  totalUnrealized: number;
}

interface DetailedTraderAnalysis {
  wallet: string;
  totalTrades: number;
  totalVolume: number;
  realizedPnl: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  profitFactor: number;
  openPositions: OpenPositionStats;
  suspiciousFlags: string[];
  recommendation: 'GOOD' | 'SUSPICIOUS' | 'BAD';
}

async function fetchOpenPositions(wallet: string): Promise<TraderPosition[]> {
  try {
    // Fetch from Polymarket positions API
    const response = await fetch(
      `https://data-api.polymarket.com/positions?user=${wallet}`
    );

    if (!response.ok) {
      logger.warn({ wallet, status: response.status }, 'Failed to fetch open positions');
      return [];
    }

    const data = await response.json();

    if (!Array.isArray(data)) {
      return [];
    }

    return data
      .filter((pos: any) => Math.abs(Number(pos.size || 0)) > 0.01)
      .map((pos: any) => ({
        marketId: pos.market || pos.marketId || '',
        outcome: pos.outcome || '',
        size: Number(pos.size || 0),
        avgPrice: Number(pos.averagePrice || pos.price || 0),
        currentValue: Number(pos.value || 0),
        unrealizedPnl: Number(pos.unrealizedPnl || pos.pnl || 0),
      }));
  } catch (error) {
    logger.error({ error, wallet }, 'Error fetching open positions');
    return [];
  }
}

async function analyzeTraderDetailed(wallet: string): Promise<DetailedTraderAnalysis | null> {
  logger.info({ wallet }, 'Starting detailed analysis');

  // Fetch historical trades
  const traderData = await fetchTraderData(wallet, 2000);
  if (!traderData || traderData.totalTrades === 0) {
    logger.warn({ wallet }, 'No trade data available');
    return null;
  }

  // Fetch open positions
  const openPositions = await fetchOpenPositions(wallet);

  // Calculate realized PnL from closed positions
  const realizedPnl = traderData.markets.reduce((sum, m) => sum + m.pnl, 0);

  // Separate wins and losses
  const wins = traderData.markets.filter(m => m.pnl > 0);
  const losses = traderData.markets.filter(m => m.pnl < 0);

  const totalWins = wins.reduce((sum, m) => sum + m.pnl, 0);
  const totalLosses = Math.abs(losses.reduce((sum, m) => sum + m.pnl, 0));

  const winRate = traderData.markets.length > 0
    ? wins.length / traderData.markets.length
    : 0;

  const avgWin = wins.length > 0 ? totalWins / wins.length : 0;
  const avgLoss = losses.length > 0 ? totalLosses / losses.length : 0;
  const profitFactor = totalLosses > 0 ? totalWins / totalLosses : totalWins > 0 ? Infinity : 0;

  // Analyze open positions
  const zeroPositions = openPositions.filter(p => Math.abs(p.size) < 0.1).length;
  const negativePositions = openPositions.filter(p => p.unrealizedPnl < -1).length;
  const positivePositions = openPositions.filter(p => p.unrealizedPnl > 1).length;
  const totalUnrealized = openPositions.reduce((sum, p) => sum + p.unrealizedPnl, 0);
  const avgPositionSize = openPositions.length > 0
    ? openPositions.reduce((sum, p) => sum + Math.abs(p.size * p.avgPrice), 0) / openPositions.length
    : 0;

  const openPositionStats: OpenPositionStats = {
    totalOpen: openPositions.length,
    zeroPositions,
    negativePositions,
    positivePositions,
    avgSize: avgPositionSize,
    totalUnrealized,
  };

  // Detect suspicious behavior
  const suspiciousFlags: string[] = [];

  // Flag 1: Too many zero/near-zero positions (not closing losses)
  const zeroPositionRatio = openPositions.length > 0
    ? zeroPositions / openPositions.length
    : 0;

  if (zeroPositions > 5 && zeroPositionRatio > 0.3) {
    suspiciousFlags.push(`HIGH_ZERO_POSITIONS: ${zeroPositions} positions near zero (${(zeroPositionRatio * 100).toFixed(1)}%)`);
  }

  // Flag 2: Many negative open positions (avoiding realized losses)
  const negativePositionRatio = openPositions.length > 0
    ? negativePositions / openPositions.length
    : 0;

  if (negativePositions > 3 && negativePositionRatio > 0.4) {
    suspiciousFlags.push(`MANY_NEGATIVE_POSITIONS: ${negativePositions} losing positions (${(negativePositionRatio * 100).toFixed(1)}%)`);
  }

  // Flag 3: High winrate but large negative unrealized PnL
  if (winRate > 0.65 && totalUnrealized < -50) {
    suspiciousFlags.push(`HIDDEN_LOSSES: ${winRate.toFixed(2)} winrate but $${totalUnrealized.toFixed(2)} unrealized loss`);
  }

  // Flag 4: Too many open positions relative to trade count
  const openToTradeRatio = traderData.totalTrades > 0
    ? openPositions.length / traderData.totalTrades
    : 0;

  if (openPositions.length > 10 && openToTradeRatio > 0.3) {
    suspiciousFlags.push(`TOO_MANY_OPEN: ${openPositions.length} open positions (${(openToTradeRatio * 100).toFixed(1)}% of total trades)`);
  }

  // Flag 5: Profit factor looks good but unrealized PnL is deeply negative
  if (profitFactor > 1.5 && totalUnrealized < -100) {
    suspiciousFlags.push(`INFLATED_METRICS: Profit factor ${profitFactor.toFixed(2)} but $${totalUnrealized.toFixed(2)} hidden in open positions`);
  }

  // Determine recommendation
  let recommendation: 'GOOD' | 'SUSPICIOUS' | 'BAD' = 'GOOD';

  if (suspiciousFlags.length >= 3) {
    recommendation = 'BAD';
  } else if (suspiciousFlags.length >= 1) {
    recommendation = 'SUSPICIOUS';
  } else if (winRate < 0.5 || profitFactor < 1.0 || realizedPnl < 0) {
    recommendation = 'BAD';
  }

  return {
    wallet,
    totalTrades: traderData.totalTrades,
    totalVolume: traderData.totalVolume,
    realizedPnl,
    winRate,
    avgWin,
    avgLoss,
    profitFactor,
    openPositions: openPositionStats,
    suspiciousFlags,
    recommendation,
  };
}

async function main() {
  const tradersToAnalyze = [
    '0x2e4c9c7275d0f5d02e1787e7f59d98ad985b28dd', // Trader #1
    '0x1f0789e20e82d8dba1ad50bc31d8570d1593def9', // Trader #10
    '0x2889302c60ecf4d95dac84d24596a5bce3e4e941', // Trader #6
    '0xD3D1bdA5A128aE61e2a8ba2F1B3Ac9D091f0e54D', // RN1
    '0x3e283f3c6feeeba7b4f5e4cc73b9e29be7c96f60', // gopfan2
  ];

  logger.info({ count: tradersToAnalyze.length }, 'Starting deep analysis of traders');

  const results: DetailedTraderAnalysis[] = [];

  for (const wallet of tradersToAnalyze) {
    const analysis = await analyzeTraderDetailed(wallet);
    if (analysis) {
      results.push(analysis);
    }
    // Rate limiting
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  // Sort by recommendation (GOOD first, then SUSPICIOUS, then BAD)
  results.sort((a, b) => {
    const order = { GOOD: 0, SUSPICIOUS: 1, BAD: 2 };
    return order[a.recommendation] - order[b.recommendation];
  });

  // Print detailed report
  console.log('\n' + '='.repeat(100));
  console.log('DETAILED TRADER ANALYSIS REPORT');
  console.log('='.repeat(100) + '\n');

  for (const analysis of results) {
    const emoji = analysis.recommendation === 'GOOD' ? '✅' :
                  analysis.recommendation === 'SUSPICIOUS' ? '⚠️' : '❌';

    console.log(`${emoji} ${analysis.recommendation}: ${analysis.wallet}`);
    console.log('-'.repeat(100));
    console.log(`Total Trades:      ${analysis.totalTrades}`);
    console.log(`Total Volume:      $${analysis.totalVolume.toFixed(2)}`);
    console.log(`Realized PnL:      $${analysis.realizedPnl.toFixed(2)}`);
    console.log(`Win Rate:          ${(analysis.winRate * 100).toFixed(2)}%`);
    console.log(`Avg Win:           $${analysis.avgWin.toFixed(2)}`);
    console.log(`Avg Loss:          $${analysis.avgLoss.toFixed(2)}`);
    console.log(`Profit Factor:     ${analysis.profitFactor === Infinity ? 'Infinity' : analysis.profitFactor.toFixed(2)}`);
    console.log('');
    console.log('Open Positions:');
    console.log(`  Total:           ${analysis.openPositions.totalOpen}`);
    console.log(`  Zero/Near-Zero:  ${analysis.openPositions.zeroPositions}`);
    console.log(`  Negative:        ${analysis.openPositions.negativePositions}`);
    console.log(`  Positive:        ${analysis.openPositions.positivePositions}`);
    console.log(`  Avg Size:        $${analysis.openPositions.avgSize.toFixed(2)}`);
    console.log(`  Total Unrealized: $${analysis.openPositions.totalUnrealized.toFixed(2)}`);
    console.log('');

    if (analysis.suspiciousFlags.length > 0) {
      console.log('🚨 SUSPICIOUS FLAGS:');
      analysis.suspiciousFlags.forEach(flag => {
        console.log(`   - ${flag}`);
      });
      console.log('');
    }

    console.log('='.repeat(100) + '\n');
  }

  // Summary
  const good = results.filter(r => r.recommendation === 'GOOD').length;
  const suspicious = results.filter(r => r.recommendation === 'SUSPICIOUS').length;
  const bad = results.filter(r => r.recommendation === 'BAD').length;

  console.log('\nSUMMARY:');
  console.log(`✅ GOOD:        ${good}`);
  console.log(`⚠️  SUSPICIOUS: ${suspicious}`);
  console.log(`❌ BAD:         ${bad}`);
  console.log('');

  // Recommendations
  console.log('RECOMMENDATIONS:');
  const goodTraders = results.filter(r => r.recommendation === 'GOOD');
  if (goodTraders.length > 0) {
    console.log('✅ Safe to copy:');
    goodTraders.forEach(t => console.log(`   ${t.wallet}`));
  } else {
    console.log('❌ No safe traders found!');
  }
}

main().catch(error => {
  logger.error({ error }, 'Analysis failed');
  process.exit(1);
});
