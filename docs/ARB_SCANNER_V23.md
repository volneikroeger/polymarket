# Arb Scanner V2.3 / V2.3.1

## Rollout safety (hard)

- Default config: `paper=true`, `dryRun=true`, `liveArmed=false`
- If `paper=false` but `liveArmed!=true` → process exits with code **3**.

## Risk engine (V2.3.1)

Key idea: **do not depend on new CLOB endpoints**.

- Exposure is tracked from:
  - `openOrders` we can see via `getOpenOrders()` (LIVE only)
  - plus **filled exposure not yet offset** that the bot observed via `pollFilled()`
- PnL is **estimated** using limit price as proxy unless we have an explicit fill price.

State is persisted as JSON at `risk.statePath` (default `/var/lib/polymarket-arb-scanner/state.json`).

### Events

- `risk.state.load` / `risk.state.save`
- `risk.reject` for any risk gate
- `risk.halt` for hard halts (daily loss, infra kill switches, exposure)

All risk logs include a snapshot of exposure/PnL counters.
