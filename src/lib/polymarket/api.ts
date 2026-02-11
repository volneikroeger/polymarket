import { logger } from '../logger.js';

const POLYMARKET_API_BASE = 'https://gamma-api.polymarket.com';
const DATA_API_BASE = 'https://data-api.polymarket.com';
const CLOB_API_BASE = 'https://clob.polymarket.com';

export interface PolymarketMarket {
  id: string;
  question: string;
  description?: string;
  outcomes: string[];
  outcomePrices: string[];
  volume: string;
  active: boolean;
  closed: boolean;
  endDate?: string;
  createdAt?: string;
  category?: string;
  tokens: Array<{
    tokenId: string;
    outcome: string;
    price: string;
  }>;
}

export interface OrderBook {
  market: string;
  asset_id: string;
  bids: Array<{ price: string; size: string }>;
  asks: Array<{ price: string; size: string }>;
  timestamp: number;
}

export interface TraderData {
  wallet: string;
  totalVolume: number;
  totalTrades: number;
  markets: Array<{
    marketId: string;
    outcome: string;
    pnl: number;
    volume: number;
  }>;
  closedPositions?: {
    totalPnl: number;
    totalInvested: number;
    winningPositions: number;
    losingPositions: number;
    totalClosedPositions: number;
  };
}

export async function fetchActiveMarkets(): Promise<PolymarketMarket[]> {
  try {
    const response = await fetch(`${POLYMARKET_API_BASE}/markets?active=true&closed=false&limit=100`);

    if (!response.ok) {
      logger.error({ status: response.status }, 'Failed to fetch active markets');
      return [];
    }

    const data = await response.json();
    return Array.isArray(data) ? data : [];
  } catch (error) {
    logger.error({ error }, 'Error fetching active markets');
    return [];
  }
}

export async function fetchMarketByConditionId(conditionId: string): Promise<PolymarketMarket | null> {
  try {
    const response = await fetch(`${POLYMARKET_API_BASE}/markets/${conditionId}`);

    if (!response.ok) {
      logger.error({ status: response.status, conditionId }, 'Failed to fetch market');
      return null;
    }

    const data = await response.json();
    return data as PolymarketMarket;
  } catch (error) {
    logger.error({ error, conditionId }, 'Error fetching market');
    return null;
  }
}

export async function fetchOrderBook(tokenId: string): Promise<OrderBook | null> {
  try {
    const response = await fetch(`${CLOB_API_BASE}/book?token_id=${tokenId}`);

    if (!response.ok) {
      logger.error({ status: response.status, tokenId }, 'Failed to fetch order book');
      return null;
    }

    const data = await response.json();
    return data as OrderBook;
  } catch (error) {
    logger.error({ error, tokenId }, 'Error fetching order book');
    return null;
  }
}

export async function fetchClosedPositions(wallet: string): Promise<{
  totalPnl: number;
  totalInvested: number;
  winningPositions: number;
  losingPositions: number;
  totalClosedPositions: number;
} | null> {
  try {
    const response = await fetch(`${DATA_API_BASE}/positions?user=${wallet.toLowerCase()}`);

    if (!response.ok) {
      logger.error({ status: response.status, wallet }, 'Failed to fetch closed positions');
      return null;
    }

    const positions = await response.json();

    if (!Array.isArray(positions) || positions.length === 0) {
      return null;
    }

    let totalPnl = 0;
    let totalInvested = 0;
    let winningPositions = 0;
    let losingPositions = 0;

    for (const pos of positions) {
      const pnl = Number(pos.cashPnl || 0);
      const invested = Number(pos.totalBought || 0);

      totalPnl += pnl;
      totalInvested += invested;

      if (pnl > 0) winningPositions++;
      else if (pnl < 0) losingPositions++;
    }

    return {
      totalPnl,
      totalInvested,
      winningPositions,
      losingPositions,
      totalClosedPositions: positions.length,
    };
  } catch (error) {
    logger.error({ error, wallet }, 'Error fetching closed positions');
    return null;
  }
}

export async function fetchTraderData(wallet: string, limit: number = 2000): Promise<TraderData | null> {
  try {
    const [activityResponse, closedPositions] = await Promise.all([
      fetch(`${DATA_API_BASE}/activity?user=${wallet}&limit=${limit}`),
      fetchClosedPositions(wallet),
    ]);

    if (!activityResponse.ok) {
      logger.error({ status: activityResponse.status, wallet }, 'Failed to fetch trader activity');
      return null;
    }

    const activity = await activityResponse.json();

    if (!Array.isArray(activity) || activity.length === 0) {
      return null;
    }

    const marketPnl = new Map<string, { pnl: number; volume: number; outcome: string; shares: number }>();
    let totalVolume = 0;

    for (const record of activity) {
      const type = record.type || 'TRADE';

      if (type !== 'TRADE') continue;

      const marketId = record.market || record.marketId;
      const side = String(record.side || '').toUpperCase();
      const price = Number(record.price || 0);
      const size = Number(record.size || 0);
      const notional = price * size;

      totalVolume += notional;

      const key = `${marketId}:${record.outcome || record.asset_id}`;
      const existing = marketPnl.get(key) || { pnl: 0, volume: 0, outcome: record.outcome || '', shares: 0 };

      if (side === 'BUY') {
        existing.pnl -= notional;
        existing.shares += size;
      } else if (side === 'SELL') {
        existing.pnl += notional;
        existing.shares -= size;
      }

      existing.volume += notional;
      marketPnl.set(key, existing);
    }

    const openPositions = Array.from(marketPnl.entries()).filter(([_, data]) => Math.abs(data.shares) > 0.01);

    const markets = Array.from(marketPnl.entries()).map(([key, data]) => ({
      marketId: key.split(':')[0],
      outcome: data.outcome,
      pnl: data.pnl,
      volume: data.volume,
    }));

    return {
      wallet,
      totalVolume,
      totalTrades: activity.filter((a: any) => a.type === 'TRADE').length,
      markets,
      closedPositions: closedPositions || undefined,
    };
  } catch (error) {
    logger.error({ error, wallet }, 'Error fetching trader data');
    return null;
  }
}

export async function searchTopTradersByVolume(limit: number = 100): Promise<string[]> {
  try {
    const allWallets: string[] = [];
    const batchSize = 50;
    const maxBatches = Math.ceil(limit / batchSize);

    logger.info({ requestedLimit: limit, batches: maxBatches }, 'Fetching traders from leaderboard');

    for (let batch = 0; batch < maxBatches; batch++) {
      const offset = batch * batchSize;
      const currentLimit = Math.min(batchSize, limit - allWallets.length);

      const response = await fetch(`${DATA_API_BASE}/v1/leaderboard?period=all&limit=${currentLimit}&offset=${offset}`);

      if (!response.ok) {
        logger.error({ status: response.status, batch, offset }, 'Failed to fetch leaderboard batch');
        break;
      }

      const data = await response.json();

      if (!Array.isArray(data) || data.length === 0) {
        logger.info({ batch, offset }, 'No more traders available');
        break;
      }

      const wallets = data.map((entry: any) => entry.proxyWallet || entry.wallet || entry.address).filter(Boolean);
      allWallets.push(...wallets);

      logger.info({ batch: batch + 1, fetchedInBatch: wallets.length, totalFetched: allWallets.length }, 'Leaderboard batch fetched');

      if (wallets.length < batchSize) {
        logger.info('Received fewer traders than requested, end of leaderboard reached');
        break;
      }

      if (allWallets.length >= limit) {
        break;
      }

      await new Promise(resolve => setTimeout(resolve, 100));
    }

    logger.info({ totalTraders: allWallets.length }, 'Leaderboard fetch complete');

    return allWallets.slice(0, limit);
  } catch (error) {
    logger.error({ error }, 'Error fetching top traders');
    return [];
  }
}

export function calculateBidAskSpread(orderBook: OrderBook): number {
  if (!orderBook.bids.length || !orderBook.asks.length) {
    return Infinity;
  }

  const bestBid = Math.max(...orderBook.bids.map(b => Number(b.price)));
  const bestAsk = Math.min(...orderBook.asks.map(a => Number(a.price)));

  if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk) || bestBid <= 0 || bestAsk <= 0) {
    return Infinity;
  }

  return bestAsk - bestBid;
}

export function calculateMidPrice(orderBook: OrderBook): number | null {
  if (!orderBook.bids.length || !orderBook.asks.length) {
    return null;
  }

  const bestBid = Math.max(...orderBook.bids.map(b => Number(b.price)));
  const bestAsk = Math.min(...orderBook.asks.map(a => Number(a.price)));

  if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk) || bestBid <= 0 || bestAsk <= 0) {
    return null;
  }

  return (bestBid + bestAsk) / 2;
}
