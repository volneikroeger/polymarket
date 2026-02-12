/*
  # Add Sizing Metrics Tracking

  1. New Table: sizing_decisions
     - Tracks every sizing decision made by the executor
     - Records ideal vs adjusted notional amounts
     - Captures the reason for each decision (ideal, adjusted_to_min_shares, skipped_exceeds_cap)
     - Links to executed_signals for analysis
  
  2. Purpose
     - Monitor capital efficiency and sizing strategy effectiveness
     - Identify patterns in sizing adjustments
     - Track how often we enter at ideal vs adjusted amounts
     - Analyze skipped orders due to price constraints
  
  3. Security
     - Enable RLS on sizing_decisions table
     - Add policy for authenticated service role access
*/

-- Create sizing_decisions table
CREATE TABLE IF NOT EXISTS sizing_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz DEFAULT now() NOT NULL,
  
  -- Signal reference
  asset_id text NOT NULL,
  market text,
  trader text,
  side text NOT NULL,
  
  -- Pricing
  desired_price numeric NOT NULL,
  
  -- Sizing decision
  raw_notional numeric NOT NULL,
  ideal_notional numeric NOT NULL,
  adjusted_notional numeric,
  shares numeric NOT NULL,
  min_shares_per_order integer NOT NULL DEFAULT 5,
  
  -- Decision metadata
  decision text NOT NULL, -- 'ideal', 'adjusted_to_min_shares', 'skipped_exceeds_cap', 'skipped_daily_limit'
  reason text,
  
  -- Limits at time of decision
  max_usdc_per_trade numeric NOT NULL,
  min_usdc_per_trade numeric NOT NULL,
  
  -- Link to executed signal (null if skipped)
  executed_signal_id uuid
);

-- Add foreign key constraint if executed_signals table exists
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'executed_signals') THEN
    ALTER TABLE sizing_decisions 
    ADD CONSTRAINT fk_sizing_decisions_executed_signal
    FOREIGN KEY (executed_signal_id) 
    REFERENCES executed_signals(id) 
    ON DELETE SET NULL;
  END IF;
END $$;

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_sizing_decisions_created_at ON sizing_decisions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sizing_decisions_decision ON sizing_decisions(decision);
CREATE INDEX IF NOT EXISTS idx_sizing_decisions_asset_id ON sizing_decisions(asset_id);

-- Enable RLS
ALTER TABLE sizing_decisions ENABLE ROW LEVEL SECURITY;

-- Policy: Service role can do everything
CREATE POLICY "Service role can manage sizing decisions"
  ON sizing_decisions
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Policy: Authenticated users can read sizing decisions
CREATE POLICY "Authenticated users can read sizing decisions"
  ON sizing_decisions
  FOR SELECT
  TO authenticated
  USING (true);

-- Create view for sizing metrics summary
CREATE OR REPLACE VIEW sizing_metrics_summary AS
SELECT
  DATE(created_at) as date,
  decision,
  COUNT(*) as count,
  AVG(raw_notional) as avg_raw_notional,
  AVG(ideal_notional) as avg_ideal_notional,
  AVG(adjusted_notional) as avg_adjusted_notional,
  AVG(shares) as avg_shares,
  SUM(CASE WHEN adjusted_notional IS NOT NULL THEN adjusted_notional ELSE ideal_notional END) as total_notional
FROM sizing_decisions
GROUP BY DATE(created_at), decision
ORDER BY date DESC, decision;