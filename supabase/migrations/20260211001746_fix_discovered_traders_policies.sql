/*
  # Fix discovered_traders RLS policies

  1. Changes
    - Drop existing restrictive policies
    - Add new policies that allow public read and anon insert/update
    - Discovered traders are public data from Polymarket, so this is appropriate

  2. Security
    - Keep RLS enabled
    - Allow anon role to insert/update (needed for discovery scripts)
    - Allow public read access (trader data is public)
*/

-- Drop existing policies
DROP POLICY IF EXISTS "Anyone can view discovered traders" ON discovered_traders;
DROP POLICY IF EXISTS "Authenticated users can insert discovered traders" ON discovered_traders;
DROP POLICY IF EXISTS "Authenticated users can update discovered traders" ON discovered_traders;
DROP POLICY IF EXISTS "Authenticated users can delete discovered traders" ON discovered_traders;

-- Create new policies allowing anon access
CREATE POLICY "Public can view discovered traders"
  ON discovered_traders FOR SELECT
  USING (true);

CREATE POLICY "Anon can insert discovered traders"
  ON discovered_traders FOR INSERT
  WITH CHECK (true);

CREATE POLICY "Anon can update discovered traders"
  ON discovered_traders FOR UPDATE
  USING (true)
  WITH CHECK (true);

-- Do the same for trader_performance_history
DROP POLICY IF EXISTS "Anyone can view trader performance history" ON trader_performance_history;
DROP POLICY IF EXISTS "Authenticated users can insert trader performance history" ON trader_performance_history;

CREATE POLICY "Public can view trader performance history"
  ON trader_performance_history FOR SELECT
  USING (true);

CREATE POLICY "Anon can insert trader performance history"
  ON trader_performance_history FOR INSERT
  WITH CHECK (true);
