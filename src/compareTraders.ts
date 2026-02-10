import dotenv from 'dotenv';
dotenv.config();

const DATA_API_BASE = process.env.DATA_API_BASE ?? 'https://data-api.polymarket.com';

interface Position {
  cashPnl: string;
  percentPnl: string;
  totalBought: string;
  title: string;
  outcome: string;
}

interface TraderStats {
  wallet: string;
  totalPositions: number;
  winningPositions: number;
  losingPositions: number;
  winRate: number;
  totalPnl: number;
  totalInvested: number;
  roi: number;
  avgPositionSize: number;
  biggestWin: number;
  biggestLoss: number;
}

async function fetchJson<T>(url: string): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const resp = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: ctrl.signal
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.json() as T;
  } finally {
    clearTimeout(t);
  }
}

async function analyzeTrader(wallet: string): Promise<TraderStats> {
  const url = `${DATA_API_BASE}/positions?user=${wallet.toLowerCase()}`;
  const positions = await fetchJson<Position[]>(url);

  const wins = positions.filter(p => parseFloat(p.cashPnl) > 0);
  const losses = positions.filter(p => parseFloat(p.cashPnl) < 0);

  const totalPnl = positions.reduce((sum, p) => sum + parseFloat(p.cashPnl), 0);
  const totalInvested = positions.reduce((sum, p) => sum + parseFloat(p.totalBought), 0);
  const avgPositionSize = totalInvested / positions.length;

  const sortedPnl = positions.map(p => parseFloat(p.cashPnl)).sort((a, b) => b - a);
  const biggestWin = sortedPnl[0] || 0;
  const biggestLoss = sortedPnl[sortedPnl.length - 1] || 0;

  return {
    wallet,
    totalPositions: positions.length,
    winningPositions: wins.length,
    losingPositions: losses.length,
    winRate: (wins.length / positions.length) * 100,
    totalPnl,
    totalInvested,
    roi: (totalPnl / totalInvested) * 100,
    avgPositionSize,
    biggestWin,
    biggestLoss,
  };
}

function printStats(stats: TraderStats) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`Trader: ${stats.wallet}`);
  console.log(`${'='.repeat(70)}`);
  console.log(`Total Positions:     ${stats.totalPositions}`);
  console.log(`Winning Positions:   ${stats.winningPositions} (${stats.winRate.toFixed(1)}%)`);
  console.log(`Losing Positions:    ${stats.losingPositions}`);
  console.log(`\nFinancials:`);
  console.log(`Total Invested:      $${stats.totalInvested.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
  console.log(`Total P&L:           $${stats.totalPnl.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
  console.log(`ROI:                 ${stats.roi.toFixed(2)}%`);
  console.log(`Avg Position Size:   $${stats.avgPositionSize.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
  console.log(`\nBest/Worst:`);
  console.log(`Biggest Win:         $${stats.biggestWin.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
  console.log(`Biggest Loss:        $${stats.biggestLoss.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

  // Assessment
  console.log(`\n${'─'.repeat(70)}`);
  console.log(`Assessment:`);

  const assessments: string[] = [];

  if (stats.winRate >= 60) assessments.push('✅ Excellent win rate (60%+)');
  else if (stats.winRate >= 50) assessments.push('✅ Good win rate (50-60%)');
  else if (stats.winRate >= 40) assessments.push('⚠️  Marginal win rate (40-50%)');
  else assessments.push('❌ Poor win rate (<40%)');

  if (stats.roi > 10) assessments.push('✅ Strong ROI (>10%)');
  else if (stats.roi > 0) assessments.push('✅ Positive ROI');
  else if (stats.roi > -10) assessments.push('⚠️  Small loss (<-10%)');
  else assessments.push('❌ Significant losses (>-10%)');

  if (stats.avgPositionSize < 100) assessments.push('✅ Small position sizing (safer)');
  else if (stats.avgPositionSize < 1000) assessments.push('✅ Reasonable position sizing');
  else if (stats.avgPositionSize < 5000) assessments.push('⚠️  Large position sizing');
  else assessments.push('❌ Very large positions (high risk)');

  if (stats.totalPositions >= 100) assessments.push('✅ Large sample size (100+)');
  else if (stats.totalPositions >= 50) assessments.push('✅ Good sample size (50+)');
  else if (stats.totalPositions >= 20) assessments.push('⚠️  Small sample size (20-50)');
  else assessments.push('⚠️  Very small sample (<20)');

  assessments.forEach(a => console.log(`  ${a}`));

  // Recommendation
  console.log(`\n${'─'.repeat(70)}`);
  if (stats.winRate >= 55 && stats.roi > 0 && stats.totalPositions >= 50) {
    console.log(`✅ RECOMMENDED for copying`);
    const scaleFactor = 90 / stats.avgPositionSize;
    const suggestedSize = Math.min(5, Math.max(0.5, stats.avgPositionSize * scaleFactor * 0.05));
    console.log(`   Suggested position size: $${suggestedSize.toFixed(2)} per trade`);
  } else if (stats.winRate >= 45 && stats.roi > -5) {
    console.log(`⚠️  MAYBE - Paper trade first for 2 weeks`);
  } else {
    console.log(`❌ NOT RECOMMENDED - Find better traders`);
  }
  console.log(`${'='.repeat(70)}\n`);
}

async function main() {
  const wallets = process.argv.slice(2);

  if (wallets.length === 0) {
    console.log('Usage: tsx src/compareTraders.ts <wallet1> [wallet2] [wallet3] ...');
    console.log('\nExample:');
    console.log('  tsx src/compareTraders.ts 0x2005d16a84ceefa912d4e380cd32e7ff827875ea');
    console.log('\nCompare multiple traders:');
    console.log('  tsx src/compareTraders.ts 0xABC... 0xDEF... 0x123...');
    process.exit(1);
  }

  console.log(`\n🔍 Analyzing ${wallets.length} trader(s)...\n`);

  const allStats: TraderStats[] = [];

  for (const wallet of wallets) {
    try {
      const stats = await analyzeTrader(wallet);
      allStats.push(stats);
      printStats(stats);

      // Rate limit
      await new Promise(resolve => setTimeout(resolve, 1000));
    } catch (error) {
      console.error(`\n❌ Error analyzing ${wallet}:`, error);
    }
  }

  // Comparison summary
  if (allStats.length > 1) {
    console.log(`\n${'='.repeat(70)}`);
    console.log(`COMPARISON SUMMARY`);
    console.log(`${'='.repeat(70)}`);
    console.log(`\n${'Metric'.padEnd(25)} ${allStats.map((_, i) => `Trader ${i + 1}`.padStart(15)).join(' ')}`);
    console.log(`${'-'.repeat(25)} ${allStats.map(() => '-'.repeat(15)).join(' ')}`);

    console.log(`${'Win Rate'.padEnd(25)} ${allStats.map(s => `${s.winRate.toFixed(1)}%`.padStart(15)).join(' ')}`);
    console.log(`${'ROI'.padEnd(25)} ${allStats.map(s => `${s.roi.toFixed(1)}%`.padStart(15)).join(' ')}`);
    console.log(`${'Total P&L'.padEnd(25)} ${allStats.map(s => `$${s.totalPnl.toFixed(0)}`.padStart(15)).join(' ')}`);
    console.log(`${'Positions'.padEnd(25)} ${allStats.map(s => `${s.totalPositions}`.padStart(15)).join(' ')}`);
    console.log(`${'Avg Position'.padEnd(25)} ${allStats.map(s => `$${s.avgPositionSize.toFixed(0)}`.padStart(15)).join(' ')}`);

    const bestByWinRate = allStats.reduce((best, s) => s.winRate > best.winRate ? s : best);
    const bestByROI = allStats.reduce((best, s) => s.roi > best.roi ? s : best);

    console.log(`\n🏆 Best Win Rate: ${bestByWinRate.wallet.slice(0, 10)}... (${bestByWinRate.winRate.toFixed(1)}%)`);
    console.log(`🏆 Best ROI: ${bestByROI.wallet.slice(0, 10)}... (${bestByROI.roi.toFixed(1)}%)`);
    console.log(`${'='.repeat(70)}\n`);
  }
}

main().catch(console.error);
