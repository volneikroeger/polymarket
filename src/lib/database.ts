import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { logger } from './logger.js';

let supabaseClient: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient {
  if (!supabaseClient) {
    const supabaseUrl = process.env.VITE_SUPABASE_URL;
    const supabaseKey = process.env.VITE_SUPABASE_ANON_KEY;

    if (!supabaseUrl || !supabaseKey) {
      throw new Error('Missing Supabase configuration in environment variables');
    }

    supabaseClient = createClient(supabaseUrl, supabaseKey);
    logger.info('Supabase client initialized');
  }

  return supabaseClient;
}

export interface ExecutedSignal {
  id?: string;
  dedupe_key: string;
  trader: string;
  market: string;
  asset_id: string;
  side: string;
  notional_usdc: number;
  shares: number;
  price: number;
  order_id?: string;
  tx_hash?: string;
  executed_at: string;
  detected_at: string;
  created_at?: string;
}

export interface OpenPosition {
  id?: string;
  market_key: string;
  asset_id: string;
  outcome?: string;
  notional_usdc: number;
  shares: number;
  entry_price: number;
  best_price: number;
  opened_at: string;
  buys_count: number;
  last_buy_at?: string;
  last_buy_price?: number;
  updated_at?: string;
}

export interface DailyLimit {
  id?: string;
  day_key: string;
  notional_usdc: number;
  realized_pnl_usdc: number;
  trades_count: number;
  updated_at?: string;
}

export async function checkSignalExecuted(dedupeKey: string): Promise<boolean> {
  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from('executed_signals')
    .select('id')
    .eq('dedupe_key', dedupeKey)
    .maybeSingle();

  if (error) {
    logger.error({ error, dedupeKey }, 'Error checking signal execution');
    return false;
  }

  return data !== null;
}

export async function recordSignalExecution(signal: ExecutedSignal): Promise<boolean> {
  const supabase = getSupabaseClient();

  const { error } = await supabase
    .from('executed_signals')
    .insert(signal);

  if (error) {
    if (error.code === '23505') {
      logger.warn({ dedupeKey: signal.dedupe_key }, 'Signal already executed (duplicate)');
      return false;
    }
    logger.error({ error, signal }, 'Error recording signal execution');
    return false;
  }

  return true;
}

export async function getOpenPosition(marketKey: string): Promise<OpenPosition | null> {
  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from('open_positions')
    .select('*')
    .eq('market_key', marketKey.toLowerCase())
    .maybeSingle();

  if (error) {
    logger.error({ error, marketKey }, 'Error fetching open position');
    return null;
  }

  return data;
}

export async function getAllOpenPositions(): Promise<OpenPosition[]> {
  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from('open_positions')
    .select('*')
    .order('opened_at', { ascending: false });

  if (error) {
    logger.error({ error }, 'Error fetching all open positions');
    return [];
  }

  return data || [];
}

export async function upsertOpenPosition(position: OpenPosition): Promise<boolean> {
  const supabase = getSupabaseClient();

  const { error } = await supabase
    .from('open_positions')
    .upsert(
      {
        ...position,
        market_key: position.market_key.toLowerCase(),
        updated_at: new Date().toISOString()
      },
      { onConflict: 'market_key' }
    );

  if (error) {
    logger.error({ error, position }, 'Error upserting open position');
    return false;
  }

  return true;
}

export async function deleteOpenPosition(marketKey: string): Promise<boolean> {
  const supabase = getSupabaseClient();

  const { error } = await supabase
    .from('open_positions')
    .delete()
    .eq('market_key', marketKey.toLowerCase());

  if (error) {
    logger.error({ error, marketKey }, 'Error deleting open position');
    return false;
  }

  return true;
}

export async function getDailyLimit(dayKey: string): Promise<DailyLimit | null> {
  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from('daily_limits')
    .select('*')
    .eq('day_key', dayKey)
    .maybeSingle();

  if (error) {
    logger.error({ error, dayKey }, 'Error fetching daily limit');
    return null;
  }

  return data;
}

export async function upsertDailyLimit(limit: DailyLimit): Promise<boolean> {
  const supabase = getSupabaseClient();

  const { error } = await supabase
    .from('daily_limits')
    .upsert(
      {
        ...limit,
        updated_at: new Date().toISOString()
      },
      { onConflict: 'day_key' }
    );

  if (error) {
    logger.error({ error, limit }, 'Error upserting daily limit');
    return false;
  }

  return true;
}

export async function incrementDailyNotional(dayKey: string, notionalDelta: number): Promise<boolean> {
  const supabase = getSupabaseClient();

  const existing = await getDailyLimit(dayKey);

  if (existing) {
    return upsertDailyLimit({
      ...existing,
      notional_usdc: existing.notional_usdc + notionalDelta,
      trades_count: existing.trades_count + 1,
    });
  } else {
    return upsertDailyLimit({
      day_key: dayKey,
      notional_usdc: notionalDelta,
      realized_pnl_usdc: 0,
      trades_count: 1,
    });
  }
}

export async function updateDailyPnl(dayKey: string, pnlDelta: number): Promise<boolean> {
  const supabase = getSupabaseClient();

  const existing = await getDailyLimit(dayKey);

  if (existing) {
    return upsertDailyLimit({
      ...existing,
      realized_pnl_usdc: existing.realized_pnl_usdc + pnlDelta,
    });
  } else {
    return upsertDailyLimit({
      day_key: dayKey,
      notional_usdc: 0,
      realized_pnl_usdc: pnlDelta,
      trades_count: 0,
    });
  }
}

export interface SizingDecision {
  id?: string;
  created_at?: string;
  asset_id: string;
  market?: string;
  trader?: string;
  side: string;
  desired_price: number;
  raw_notional: number;
  ideal_notional: number;
  adjusted_notional?: number;
  shares: number;
  min_shares_per_order: number;
  decision: 'ideal' | 'adjusted_to_min_shares' | 'skipped_exceeds_cap' | 'skipped_daily_limit';
  reason?: string;
  max_usdc_per_trade: number;
  min_usdc_per_trade: number;
  executed_signal_id?: string;
}

export async function recordSizingDecision(decision: SizingDecision): Promise<boolean> {
  const supabase = getSupabaseClient();

  const { error } = await supabase
    .from('sizing_decisions')
    .insert(decision);

  if (error) {
    logger.error({ error, decision }, 'Error recording sizing decision');
    return false;
  }

  return true;
}

export async function cleanupOldSignals(daysToKeep: number = 7): Promise<number> {
  const supabase = getSupabaseClient();
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

  const { error, count } = await supabase
    .from('executed_signals')
    .delete()
    .lt('executed_at', cutoffDate.toISOString());

  if (error) {
    logger.error({ error }, 'Error cleaning up old signals');
    return 0;
  }

  logger.info({ deletedCount: count, daysToKeep }, 'Cleaned up old executed signals');
  return count || 0;
}
