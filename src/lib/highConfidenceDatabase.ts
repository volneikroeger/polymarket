import { getSupabaseClient } from './database.js';
import { logger } from './logger.js';

export interface HighConfidencePosition {
  id?: string;
  market_key: string;
  asset_id: string;
  outcome?: string;
  entry_odds: number;
  current_odds: number;
  best_odds: number;
  worst_odds: number;
  entry_price: number;
  current_price: number;
  stop_loss_price: number;
  notional_usdc: number;
  shares: number;
  entry_time: string;
  last_check_time: string;
  status: 'open' | 'partial_exit' | 'closed';
  exit_reason?: 'stop_loss' | 'take_profit' | 'manual' | 'resolution';
  created_at?: string;
  updated_at?: string;
}

export interface HighConfidenceTrade {
  id?: string;
  position_id?: string;
  market_key: string;
  action: 'buy' | 'partial_sell' | 'full_sell';
  odds_at_trade: number;
  price: number;
  shares: number;
  notional_usdc: number;
  reason?: string;
  timestamp: string;
  created_at?: string;
}

export interface DiscoveredTrader {
  id?: string;
  wallet: string;
  discovery_date: string;
  win_rate: number;
  roi: number;
  total_trades: number;
  total_volume: number;
  avg_position_size: number;
  categories: Record<string, any>;
  rank_score: number;
  last_analyzed: string;
  is_recommended: boolean;
  performance_trend: 'improving' | 'stable' | 'declining';
  specialization?: string;
  created_at?: string;
  updated_at?: string;
}

export interface TraderPerformanceHistory {
  id?: string;
  trader_wallet: string;
  snapshot_date: string;
  win_rate: number;
  roi: number;
  total_trades: number;
  total_volume: number;
  period: '7d' | '30d' | '90d' | 'all_time';
  created_at?: string;
}

export async function getHighConfidencePosition(marketKey: string): Promise<HighConfidencePosition | null> {
  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from('high_confidence_positions')
    .select('*')
    .eq('market_key', marketKey.toLowerCase())
    .maybeSingle();

  if (error) {
    logger.error({ error, marketKey }, 'Error fetching high confidence position');
    return null;
  }

  return data;
}

export async function getAllHighConfidencePositions(status?: string): Promise<HighConfidencePosition[]> {
  const supabase = getSupabaseClient();

  let query = supabase
    .from('high_confidence_positions')
    .select('*')
    .order('entry_time', { ascending: false });

  if (status) {
    query = query.eq('status', status);
  }

  const { data, error } = await query;

  if (error) {
    logger.error({ error }, 'Error fetching all high confidence positions');
    return [];
  }

  return data || [];
}

export async function upsertHighConfidencePosition(position: HighConfidencePosition): Promise<boolean> {
  const supabase = getSupabaseClient();

  const { error } = await supabase
    .from('high_confidence_positions')
    .upsert(
      {
        ...position,
        market_key: position.market_key.toLowerCase(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'market_key' }
    );

  if (error) {
    logger.error({ error, position }, 'Error upserting high confidence position');
    return false;
  }

  return true;
}

export async function updateHighConfidenceOdds(
  marketKey: string,
  currentOdds: number,
  currentPrice: number
): Promise<boolean> {
  const supabase = getSupabaseClient();

  const position = await getHighConfidencePosition(marketKey);
  if (!position) return false;

  const bestOdds = Math.max(position.best_odds, currentOdds);
  const worstOdds = Math.min(position.worst_odds, currentOdds);

  const { error } = await supabase
    .from('high_confidence_positions')
    .update({
      current_odds: currentOdds,
      current_price: currentPrice,
      best_odds: bestOdds,
      worst_odds: worstOdds,
      last_check_time: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('market_key', marketKey.toLowerCase());

  if (error) {
    logger.error({ error, marketKey }, 'Error updating high confidence odds');
    return false;
  }

  return true;
}

export async function closeHighConfidencePosition(
  marketKey: string,
  exitReason: 'stop_loss' | 'take_profit' | 'manual' | 'resolution'
): Promise<boolean> {
  const supabase = getSupabaseClient();

  const { error } = await supabase
    .from('high_confidence_positions')
    .update({
      status: 'closed',
      exit_reason: exitReason,
      updated_at: new Date().toISOString(),
    })
    .eq('market_key', marketKey.toLowerCase());

  if (error) {
    logger.error({ error, marketKey, exitReason }, 'Error closing high confidence position');
    return false;
  }

  return true;
}

export async function recordHighConfidenceTrade(trade: HighConfidenceTrade): Promise<boolean> {
  const supabase = getSupabaseClient();

  const { error } = await supabase
    .from('high_confidence_trades')
    .insert({
      ...trade,
      market_key: trade.market_key.toLowerCase(),
    });

  if (error) {
    logger.error({ error, trade }, 'Error recording high confidence trade');
    return false;
  }

  return true;
}

export async function getDiscoveredTrader(wallet: string): Promise<DiscoveredTrader | null> {
  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from('discovered_traders')
    .select('*')
    .eq('wallet', wallet.toLowerCase())
    .maybeSingle();

  if (error) {
    logger.error({ error, wallet }, 'Error fetching discovered trader');
    return null;
  }

  return data;
}

export async function getAllDiscoveredTraders(filters?: {
  isRecommended?: boolean;
  minWinRate?: number;
  minROI?: number;
  minTrades?: number;
}): Promise<DiscoveredTrader[]> {
  const supabase = getSupabaseClient();

  let query = supabase
    .from('discovered_traders')
    .select('*')
    .order('rank_score', { ascending: false });

  if (filters?.isRecommended !== undefined) {
    query = query.eq('is_recommended', filters.isRecommended);
  }

  if (filters?.minWinRate !== undefined) {
    query = query.gte('win_rate', filters.minWinRate);
  }

  if (filters?.minROI !== undefined) {
    query = query.gte('roi', filters.minROI);
  }

  if (filters?.minTrades !== undefined) {
    query = query.gte('total_trades', filters.minTrades);
  }

  const { data, error } = await query;

  if (error) {
    logger.error({ error }, 'Error fetching discovered traders');
    return [];
  }

  return data || [];
}

export async function upsertDiscoveredTrader(trader: DiscoveredTrader): Promise<boolean> {
  const supabase = getSupabaseClient();

  const { error } = await supabase
    .from('discovered_traders')
    .upsert(
      {
        ...trader,
        wallet: trader.wallet.toLowerCase(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'wallet' }
    );

  if (error) {
    logger.error({ error, trader }, 'Error upserting discovered trader');
    return false;
  }

  return true;
}

export async function recordTraderPerformanceHistory(history: TraderPerformanceHistory): Promise<boolean> {
  const supabase = getSupabaseClient();

  const { error } = await supabase
    .from('trader_performance_history')
    .insert({
      ...history,
      trader_wallet: history.trader_wallet.toLowerCase(),
    });

  if (error) {
    logger.error({ error, history }, 'Error recording trader performance history');
    return false;
  }

  return true;
}

export async function getTraderPerformanceHistory(
  wallet: string,
  period?: string
): Promise<TraderPerformanceHistory[]> {
  const supabase = getSupabaseClient();

  let query = supabase
    .from('trader_performance_history')
    .select('*')
    .eq('trader_wallet', wallet.toLowerCase())
    .order('snapshot_date', { ascending: false });

  if (period) {
    query = query.eq('period', period);
  }

  const { data, error } = await query;

  if (error) {
    logger.error({ error, wallet }, 'Error fetching trader performance history');
    return [];
  }

  return data || [];
}
