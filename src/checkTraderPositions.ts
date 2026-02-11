import { logger } from './lib/logger.js';

const DATA_API_BASE = 'https://data-api.polymarket.com';
const CLOB_API_BASE = 'https://clob.polymarket.com';

interface Trade {
  conditionId: string;
  asset: string;
  outcome: string;
  side: string;
  type: string;
  price: number;
  size: number;
  timestamp: number;
  title?: string;
}

interface Position {
  conditionId: string;
  assetId: string;
  outcome: string;
  netShares: number;
  avgEntryPrice: number;
  costBasis: number;
  currentPrice: number;
  marketValue: number;
  unrealizedPnL: number;
  question?: string;
}

async function fetchTraderTrades(wallet: string): Promise<Trade[]> {
  try {
    logger.info({ wallet }, 'Fetching trader trades...');
    const response = await fetch(`${DATA_API_BASE}/activity?user=${wallet}&limit=2000`);

    if (!response.ok) {
      logger.error({ status: response.status }, 'Failed to fetch trades');
      return [];
    }

    const data = await response.json();

    if (!Array.isArray(data)) {
      logger.error('Invalid response format');
      return [];
    }

    return data
      .filter((t: any) => t.type === 'TRADE')
      .map((t: any) => ({
        conditionId: t.conditionId || '',
        asset: t.asset || '',
        outcome: t.outcome || '',
        side: String(t.side || '').toUpperCase(),
        type: t.type || '',
        price: Number(t.price || 0),
        size: Number(t.size || 0),
        timestamp: t.timestamp || Date.now() / 1000,
        title: t.title || t.slug || '',
      }));
  } catch (error) {
    logger.error({ error }, 'Error fetching trades');
    return [];
  }
}

async function fetchCurrentPrice(tokenId: string): Promise<number | null> {
  try {
    const response = await fetch(`${CLOB_API_BASE}/book?token_id=${tokenId}`);

    if (!response.ok) {
      return null;
    }

    const book: any = await response.json();

    if (!book.bids?.length || !book.asks?.length) {
      return null;
    }

    const bestBid = Math.max(...book.bids.map((b: any) => Number(b.price)));
    const bestAsk = Math.min(...book.asks.map((a: any) => Number(a.price)));

    return (bestBid + bestAsk) / 2;
  } catch (error) {
    return null;
  }
}

async function fetchMarketQuestion(marketId: string): Promise<string | undefined> {
  try {
    const response = await fetch(`https://gamma-api.polymarket.com/markets/${marketId}`);
    if (!response.ok) return undefined;
    const data: any = await response.json();
    return data.question || data.title;
  } catch {
    return undefined;
  }
}

type PositionData = {
  netShares: number;
  costBasis: number;
  assetId: string;
  outcome: string;
  conditionId: string;
  title: string;
};

function calculateOpenPositions(trades: Trade[]): Map<string, PositionData> {
  const positions = new Map<string, PositionData>();

  for (const trade of trades) {
    const key = `${trade.conditionId}:${trade.asset}`;
    const existing = positions.get(key) || {
      netShares: 0,
      costBasis: 0,
      assetId: trade.asset,
      outcome: trade.outcome,
      conditionId: trade.conditionId,
      title: trade.title || ''
    };

    if (trade.side === 'BUY') {
      existing.netShares += trade.size;
      existing.costBasis += trade.price * trade.size;
    } else if (trade.side === 'SELL') {
      existing.netShares -= trade.size;
      existing.costBasis -= trade.price * trade.size;
    }

    positions.set(key, existing);
  }

  const openPositions = new Map<string, PositionData>();
  for (const [key, pos] of positions.entries()) {
    if (Math.abs(pos.netShares) > 0.01) {
      openPositions.set(key, pos);
    }
  }

  return openPositions;
}

async function main() {
  const traderWallet = '0x2e4c9c7275d0f5d02e1787e7f59d98ad985b28dd';

  logger.info('=== CHECKING TRADER OPEN POSITIONS ===');
  logger.info({ wallet: traderWallet }, 'Target trader');

  const trades = await fetchTraderTrades(traderWallet);
  logger.info({ totalTrades: trades.length }, 'Fetched trader trades');

  if (trades.length === 0) {
    logger.warn('No trades found for this wallet');
    return;
  }

  const openPositions = calculateOpenPositions(trades);
  logger.info({ openPositionsCount: openPositions.size }, 'Calculated open positions');

  if (openPositions.size === 0) {
    logger.info('No open positions found - all positions are closed');
    return;
  }

  const positions: Position[] = [];
  let totalUnrealizedPnL = 0;
  let totalMarketValue = 0;
  let totalCostBasis = 0;

  for (const [key, pos] of openPositions.entries()) {
    logger.info({
      key,
      conditionId: pos.conditionId,
      assetId: pos.assetId,
      netShares: pos.netShares,
      costBasis: pos.costBasis,
      title: pos.title
    }, 'Processing position');

    const currentPrice = await fetchCurrentPrice(pos.assetId);

    if (currentPrice === null) {
      logger.warn({ assetId: pos.assetId, conditionId: pos.conditionId }, 'Could not fetch current price - skipping position');
      continue;
    }

    const avgEntryPrice = pos.costBasis / pos.netShares;
    const marketValue = pos.netShares * currentPrice;
    const unrealizedPnL = marketValue - pos.costBasis;

    const question = await fetchMarketQuestion(pos.conditionId);

    positions.push({
      conditionId: pos.conditionId,
      assetId: pos.assetId,
      outcome: pos.outcome,
      netShares: pos.netShares,
      avgEntryPrice,
      costBasis: pos.costBasis,
      currentPrice,
      marketValue,
      unrealizedPnL,
      question: question || pos.title,
    });

    totalUnrealizedPnL += unrealizedPnL;
    totalMarketValue += marketValue;
    totalCostBasis += pos.costBasis;

    await new Promise(resolve => setTimeout(resolve, 100));
  }

  positions.sort((a, b) => a.unrealizedPnL - b.unrealizedPnL);

  console.log('\n=== OPEN POSITIONS REPORT ===\n');
  console.log(`Trader: ${traderWallet}`);
  console.log(`Total Open Positions: ${positions.length}`);
  console.log(`Total Cost Basis: $${totalCostBasis.toFixed(2)}`);
  console.log(`Total Market Value: $${totalMarketValue.toFixed(2)}`);
  console.log(`Total Unrealized P&L: $${totalUnrealizedPnL.toFixed(2)}`);
  console.log(`Unrealized Return: ${((totalUnrealizedPnL / totalCostBasis) * 100).toFixed(2)}%`);
  console.log('\n--- POSITIONS (Worst to Best) ---\n');

  for (const pos of positions) {
    const pnlSign = pos.unrealizedPnL >= 0 ? '+' : '';
    const returnPct = ((pos.unrealizedPnL / pos.costBasis) * 100).toFixed(2);

    console.log(`Market: ${pos.question || pos.conditionId}`);
    console.log(`  Outcome: ${pos.outcome}`);
    console.log(`  Shares: ${pos.netShares.toFixed(2)}`);
    console.log(`  Entry Price: $${pos.avgEntryPrice.toFixed(4)}`);
    console.log(`  Current Price: $${pos.currentPrice.toFixed(4)}`);
    console.log(`  Cost Basis: $${pos.costBasis.toFixed(2)}`);
    console.log(`  Market Value: $${pos.marketValue.toFixed(2)}`);
    console.log(`  Unrealized P&L: ${pnlSign}$${pos.unrealizedPnL.toFixed(2)} (${pnlSign}${returnPct}%)`);
    console.log('');
  }

  const losingPositions = positions.filter(p => p.unrealizedPnL < 0);
  const winningPositions = positions.filter(p => p.unrealizedPnL >= 0);

  console.log('=== SUMMARY ===');
  console.log(`Winning Positions: ${winningPositions.length} (Total: +$${winningPositions.reduce((sum, p) => sum + p.unrealizedPnL, 0).toFixed(2)})`);
  console.log(`Losing Positions: ${losingPositions.length} (Total: -$${Math.abs(losingPositions.reduce((sum, p) => sum + p.unrealizedPnL, 0)).toFixed(2)})`);
  console.log(`\nNET UNREALIZED P&L: $${totalUnrealizedPnL.toFixed(2)}`);
}

main().catch(console.error);
