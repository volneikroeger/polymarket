/*
  # High-Confidence Trading and Trader Discovery Schema

  ## Overview
  This migration creates tables for:
  - High-confidence position tracking with odds monitoring
  - High-confidence trade history with exit reasons
  - Trader discovery and ranking system
  - Multi-trader comparison data

  ## New Tables

  ### `high_confidence_positions`
  Tracks open positions from high-confidence scanner with real-time odds monitoring
  - `id` (uuid, primary key)
  - `market_key` (text, unique, indexed)
  - `asset_id` (text, indexed)
  - `outcome` (text)
  - `entry_odds` (numeric) - Odds when position was opened
  - `current_odds` (numeric) - Latest odds
  - `best_odds` (numeric) - Best odds achieved
  - `worst_odds` (numeric) - Worst odds seen
  - `entry_price` (numeric) - Entry price
  - `current_price` (numeric) - Latest price
  - `stop_loss_price` (numeric) - Calculated stop-loss trigger price
  - `notional_usdc` (numeric) - Total notional value
  - `shares` (numeric) - Number of shares
  - `entry_time` (timestamptz) - When position was opened
  - `last_check_time` (timestamptz) - Last odds check
  - `status` (text) - open, partial_exit, closed
  - `exit_reason` (text) - stop_loss, take_profit, manual, resolution

  ### `high_confidence_trades`
  Historical record of all high-confidence trades (entries and exits)
  - `id` (uuid, primary key)
  - `position_id` (uuid, foreign key) - References high_confidence_positions
  - `market_key` (text, indexed)
  - `action` (text) - buy, partial_sell, full_sell
  - `odds_at_trade` (numeric) - Odds at time of trade
  - `price` (numeric) - Execution price
  - `shares` (numeric) - Number of shares traded
  - `notional_usdc` (numeric) - Notional value
  - `reason` (text) - Entry reason or exit trigger
  - `timestamp` (timestamptz) - Trade execution time

  ### `discovered_traders`
  Discovered and analyzed traders from the Polymarket platform
  - `id` (uuid, primary key)
  - `wallet` (text, unique, indexed) - Trader wallet address
  - `discovery_date` (timestamptz) - When trader was discovered
  - `win_rate` (numeric) - Win rate percentage
  - `roi` (numeric) - Return on investment percentage
  - `total_trades` (integer) - Total number of trades
  - `total_volume` (numeric) - Total volume traded in USDC
  - `avg_position_size` (numeric) - Average position size
  - `categories` (jsonb) - Market categories and performance
  - `rank_score` (numeric) - Overall ranking score
  - `last_analyzed` (timestamptz) - Last analysis timestamp
  - `is_recommended` (boolean) - Whether trader is recommended for copying
  - `performance_trend` (text) - improving, stable, declining
  - `specialization` (text) - Primary category specialization

  ### `trader_performance_history`
  Historical performance snapshots of discovered traders
  - `id` (uuid, primary key)
  - `trader_wallet` (text, indexed) - References discovered_traders
  - `snapshot_date` (timestamptz) - Date of snapshot
  - `win_rate` (numeric)
  - `roi` (numeric)
  - `total_trades` (integer)
  - `total_volume` (numeric)
  - `period` (text) - 7d, 30d, 90d, all_time

  ## Security
  - Enable RLS on all tables
  - Add policies for authenticated users to manage their own data
  - Add policies for reading discovered trader data (public information)

  ## Indexes
  - Index on market_key for fast position lookups
  - Index on wallet for fast trader lookups
  - Index on status for filtering active positions
  - Index on timestamp fields for time-based queries
*/

-- Create high_confidence_positions table
CREATE TABLE IF NOT EXISTS high_confidence_positions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  market_key text UNIQUE NOT NULL,
  asset_id text NOT NULL,
  outcome text,
  entry_odds numeric NOT NULL,
  current_odds numeric NOT NULL,
  best_odds numeric NOT NULL,
  worst_odds numeric NOT NULL,
  entry_price numeric NOT NULL,
  current_price numeric NOT NULL,
  stop_loss_price numeric NOT NULL,
  notional_usdc numeric NOT NULL,
  shares numeric NOT NULL,
  entry_time timestamptz NOT NULL DEFAULT now(),
  last_check_time timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'open',
  exit_reason text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_hc_positions_market_key ON high_confidence_positions(market_key);
CREATE INDEX IF NOT EXISTS idx_hc_positions_asset_id ON high_confidence_positions(asset_id);
CREATE INDEX IF NOT EXISTS idx_hc_positions_status ON high_confidence_positions(status);
CREATE INDEX IF NOT EXISTS idx_hc_positions_entry_time ON high_confidence_positions(entry_time);

-- Create high_confidence_trades table
CREATE TABLE IF NOT EXISTS high_confidence_trades (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  position_id uuid REFERENCES high_confidence_positions(id) ON DELETE CASCADE,
  market_key text NOT NULL,
  action text NOT NULL,
  odds_at_trade numeric NOT NULL,
  price numeric NOT NULL,
  shares numeric NOT NULL,
  notional_usdc numeric NOT NULL,
  reason text,
  timestamp timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_hc_trades_position_id ON high_confidence_trades(position_id);
CREATE INDEX IF NOT EXISTS idx_hc_trades_market_key ON high_confidence_trades(market_key);
CREATE INDEX IF NOT EXISTS idx_hc_trades_timestamp ON high_confidence_trades(timestamp);
CREATE INDEX IF NOT EXISTS idx_hc_trades_action ON high_confidence_trades(action);

-- Create discovered_traders table
CREATE TABLE IF NOT EXISTS discovered_traders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet text UNIQUE NOT NULL,
  discovery_date timestamptz NOT NULL DEFAULT now(),
  win_rate numeric NOT NULL,
  roi numeric NOT NULL,
  total_trades integer NOT NULL,
  total_volume numeric NOT NULL DEFAULT 0,
  avg_position_size numeric NOT NULL DEFAULT 0,
  categories jsonb DEFAULT '{}',
  rank_score numeric NOT NULL DEFAULT 0,
  last_analyzed timestamptz NOT NULL DEFAULT now(),
  is_recommended boolean NOT NULL DEFAULT false,
  performance_trend text DEFAULT 'stable',
  specialization text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_discovered_traders_wallet ON discovered_traders(wallet);
CREATE INDEX IF NOT EXISTS idx_discovered_traders_rank_score ON discovered_traders(rank_score DESC);
CREATE INDEX IF NOT EXISTS idx_discovered_traders_is_recommended ON discovered_traders(is_recommended);
CREATE INDEX IF NOT EXISTS idx_discovered_traders_win_rate ON discovered_traders(win_rate DESC);
CREATE INDEX IF NOT EXISTS idx_discovered_traders_roi ON discovered_traders(roi DESC);

-- Create trader_performance_history table
CREATE TABLE IF NOT EXISTS trader_performance_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trader_wallet text NOT NULL,
  snapshot_date timestamptz NOT NULL DEFAULT now(),
  win_rate numeric NOT NULL,
  roi numeric NOT NULL,
  total_trades integer NOT NULL,
  total_volume numeric NOT NULL DEFAULT 0,
  period text NOT NULL,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_trader_history_wallet ON trader_performance_history(trader_wallet);
CREATE INDEX IF NOT EXISTS idx_trader_history_snapshot_date ON trader_performance_history(snapshot_date);
CREATE INDEX IF NOT EXISTS idx_trader_history_period ON trader_performance_history(period);

-- Enable RLS on all tables
ALTER TABLE high_confidence_positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE high_confidence_trades ENABLE ROW LEVEL SECURITY;
ALTER TABLE discovered_traders ENABLE ROW LEVEL SECURITY;
ALTER TABLE trader_performance_history ENABLE ROW LEVEL SECURITY;

-- Policies for high_confidence_positions
CREATE POLICY "Authenticated users can view high confidence positions"
  ON high_confidence_positions FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can insert high confidence positions"
  ON high_confidence_positions FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Authenticated users can update high confidence positions"
  ON high_confidence_positions FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Authenticated users can delete high confidence positions"
  ON high_confidence_positions FOR DELETE
  TO authenticated
  USING (true);

-- Policies for high_confidence_trades
CREATE POLICY "Authenticated users can view high confidence trades"
  ON high_confidence_trades FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can insert high confidence trades"
  ON high_confidence_trades FOR INSERT
  TO authenticated
  WITH CHECK (true);

-- Policies for discovered_traders (public read, authenticated write)
CREATE POLICY "Anyone can view discovered traders"
  ON discovered_traders FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can insert discovered traders"
  ON discovered_traders FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Authenticated users can update discovered traders"
  ON discovered_traders FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Authenticated users can delete discovered traders"
  ON discovered_traders FOR DELETE
  TO authenticated
  USING (true);

-- Policies for trader_performance_history
CREATE POLICY "Anyone can view trader performance history"
  ON trader_performance_history FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can insert trader performance history"
  ON trader_performance_history FOR INSERT
  TO authenticated
  WITH CHECK (true);