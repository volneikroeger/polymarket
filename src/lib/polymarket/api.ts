import { logger } from '../logger.js';

const POLYMARKET_API_BASE = 'https://gamma-api.polymarket.com';
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

export async function fetchTraderData(wallet: string): Promise<TraderData | null> {
  try {
    const response = await fetch(`${POLYMARKET_API_BASE}/trades?wallet=${wallet}&limit=1000`);

    if (!response.ok) {
      logger.error({ status: response.status, wallet }, 'Failed to fetch trader data');
      return null;
    }

    const trades = await response.json();

    if (!Array.isArray(trades) || trades.length === 0) {
      return null;
    }

    const marketPnl = new Map<string, { pnl: number; volume: number; outcome: string }>();
    let totalVolume = 0;

    for (const trade of trades) {
      const marketId = trade.market || trade.marketId;
      const side = String(trade.side || '').toUpperCase();
      const price = Number(trade.price || 0);
      const size = Number(trade.size || 0);
      const notional = price * size;

      totalVolume += notional;

      const key = `${marketId}:${trade.outcome || trade.asset_id}`;
      const existing = marketPnl.get(key) || { pnl: 0, volume: 0, outcome: trade.outcome || '' };

      if (side === 'BUY') {
        existing.pnl -= notional;
      } else if (side === 'SELL') {
        existing.pnl += notional;
      }

      existing.volume += notional;
      marketPnl.set(key, existing);
    }

    const markets = Array.from(marketPnl.entries()).map(([key, data]) => ({
      marketId: key.split(':')[0],
      outcome: data.outcome,
      pnl: data.pnl,
      volume: data.volume,
    }));

    return {
      wallet,
      totalVolume,
      totalTrades: trades.length,
      markets,
    };
  } catch (error) {
    logger.error({ error, wallet }, 'Error fetching trader data');
    return null;
  }
}

export async function searchTopTradersByVolume(limit: number = 100): Promise<string[]> {
  try {
    const response = await fetch(`${POLYMARKET_API_BASE}/leaderboard?period=all&limit=${limit}`);

    if (!response.ok) {
      logger.error({ status: response.status }, 'Failed to fetch leaderboard');
      return [];
    }

    const data = await response.json();

    if (!Array.isArray(data)) {
      return [];
    }

    return data.map((entry: any) => entry.wallet || entry.address).filter(Boolean);
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
