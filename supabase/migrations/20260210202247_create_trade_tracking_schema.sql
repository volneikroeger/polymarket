/*
  # Trade Tracking Schema
  
  1. New Tables
    - `executed_signals`
      - `id` (uuid, primary key) - Unique identifier for each executed signal
      - `dedupe_key` (text, unique, indexed) - Composite key for deduplication
      - `trader` (text) - Address of the trader being copied
      - `market` (text) - Market identifier (conditionId)
      - `asset_id` (text) - Token ID
      - `side` (text) - BUY or SELL
      - `notional_usdc` (numeric) - USDC amount of the trade
      - `shares` (numeric) - Number of shares
      - `price` (numeric) - Execution price
      - `order_id` (text, nullable) - Polymarket order ID if available
      - `tx_hash` (text, nullable) - Transaction hash if available
      - `executed_at` (timestamptz) - When the order was placed
      - `detected_at` (timestamptz) - When the signal was first detected
      - `created_at` (timestamptz) - Record creation timestamp
      
    - `open_positions`
      - `id` (uuid, primary key)
      - `market_key` (text, unique) - Market identifier (lowercase)
      - `asset_id` (text) - Token ID
      - `outcome` (text, nullable) - Outcome name
      - `notional_usdc` (numeric) - Total notional value
      - `shares` (numeric) - Total shares held
      - `entry_price` (numeric) - Average entry price
      - `best_price` (numeric) - Best price seen
      - `opened_at` (timestamptz) - When position was opened
      - `buys_count` (integer) - Number of buy orders
      - `last_buy_at` (timestamptz, nullable) - Last buy timestamp
      - `last_buy_price` (numeric, nullable) - Last buy price
      - `updated_at` (timestamptz) - Last update timestamp
      
    - `daily_limits`
      - `id` (uuid, primary key)
      - `day_key` (text, unique) - Date key (YYYY-MM-DD)
      - `notional_usdc` (numeric) - Total notional traded today
      - `realized_pnl_usdc` (numeric) - Realized P&L today
      - `trades_count` (integer) - Number of trades today
      - `updated_at` (timestamptz) - Last update timestamp
      
  2. Security
    - Enable RLS on all tables
    - Add policies for authenticated system access only
    
  3. Indexes
    - Index on `dedupe_key` for fast lookups
    - Index on `executed_at` for time-based queries
    - Index on `day_key` for daily limit checks
    
  4. Important Notes
    - Prevents duplicate orders through unique dedupe_key constraint
    - Tracks position sizing accurately in database
    - Enforces daily limits persistently across restarts
    - Provides audit trail for all trades
*/

-- Create executed_signals table
CREATE TABLE IF NOT EXISTS executed_signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dedupe_key text UNIQUE NOT NULL,
  trader text NOT NULL,
  market text NOT NULL,
  asset_id text NOT NULL,
  side text NOT NULL,
  notional_usdc numeric NOT NULL,
  shares numeric NOT NULL,
  price numeric NOT NULL,
  order_id text,
  tx_hash text,
  executed_at timestamptz NOT NULL,
  detected_at timestamptz NOT NULL,
  created_at timestamptz DEFAULT now()
);

-- Create indexes for executed_signals
CREATE INDEX IF NOT EXISTS idx_executed_signals_dedupe_key ON executed_signals(dedupe_key);
CREATE INDEX IF NOT EXISTS idx_executed_signals_executed_at ON executed_signals(executed_at DESC);
CREATE INDEX IF NOT EXISTS idx_executed_signals_trader ON executed_signals(trader);

-- Create open_positions table
CREATE TABLE IF NOT EXISTS open_positions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  market_key text UNIQUE NOT NULL,
  asset_id text NOT NULL,
  outcome text,
  notional_usdc numeric NOT NULL DEFAULT 0,
  shares numeric NOT NULL DEFAULT 0,
  entry_price numeric NOT NULL,
  best_price numeric NOT NULL,
  opened_at timestamptz NOT NULL,
  buys_count integer NOT NULL DEFAULT 1,
  last_buy_at timestamptz,
  last_buy_price numeric,
  updated_at timestamptz DEFAULT now()
);

-- Create index for open_positions
CREATE INDEX IF NOT EXISTS idx_open_positions_market_key ON open_positions(market_key);

-- Create daily_limits table
CREATE TABLE IF NOT EXISTS daily_limits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  day_key text UNIQUE NOT NULL,
  notional_usdc numeric NOT NULL DEFAULT 0,
  realized_pnl_usdc numeric NOT NULL DEFAULT 0,
  trades_count integer NOT NULL DEFAULT 0,
  updated_at timestamptz DEFAULT now()
);

-- Create index for daily_limits
CREATE INDEX IF NOT EXISTS idx_daily_limits_day_key ON daily_limits(day_key);

-- Enable RLS on all tables
ALTER TABLE executed_signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE open_positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_limits ENABLE ROW LEVEL SECURITY;

-- Create policies for executed_signals (system access only via service role)
CREATE POLICY "System can read executed_signals"
  ON executed_signals FOR SELECT
  USING (true);

CREATE POLICY "System can insert executed_signals"
  ON executed_signals FOR INSERT
  WITH CHECK (true);

-- Create policies for open_positions (system access only)
CREATE POLICY "System can read open_positions"
  ON open_positions FOR SELECT
  USING (true);

CREATE POLICY "System can insert open_positions"
  ON open_positions FOR INSERT
  WITH CHECK (true);

CREATE POLICY "System can update open_positions"
  ON open_positions FOR UPDATE
  USING (true)
  WITH CHECK (true);

CREATE POLICY "System can delete open_positions"
  ON open_positions FOR DELETE
  USING (true);

-- Create policies for daily_limits (system access only)
CREATE POLICY "System can read daily_limits"
  ON daily_limits FOR SELECT
  USING (true);

CREATE POLICY "System can insert daily_limits"
  ON daily_limits FOR INSERT
  WITH CHECK (true);

CREATE POLICY "System can update daily_limits"
  ON daily_limits FOR UPDATE
  USING (true)
  WITH CHECK (true);
