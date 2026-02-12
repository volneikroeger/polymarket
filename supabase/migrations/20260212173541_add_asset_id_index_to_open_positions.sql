/*
  # Add asset_id index to open_positions

  1. Changes
    - Add index on `asset_id` column in `open_positions` table

  2. Rationale
    - Positions are now tracked by asset_id instead of market_key
    - This allows multiple positions in different assets of the same market
    - Index improves query performance when looking up positions by asset_id

  3. Important Notes
    - This change enables the bot to buy multiple different outcomes in the same market
    - While preventing multiple entries in the same asset (outcome)
    - Backward compatible with existing data
*/

-- Add index on asset_id for fast lookups
CREATE INDEX IF NOT EXISTS idx_open_positions_asset_id ON open_positions(asset_id);
