# polymarket-copytrader

Fast-ish copy trading scaffold for Polymarket (CLOB).

## Important limitation (copying other wallets)

Polymarket's **authenticated** websocket `USER` channel only emits events for **your own API key**.
The public `MARKET` channel does **not** include trader identity.

That means: **you cannot reliably copy another wallet's order placements immediately at placement-time** using only the public CLOB websockets.

What we *can* do without private access:

- Mirror **trader position / trade history changes** as soon as they are observable via indexed/on-chain sources (subgraph / on-chain events). This is usually **seconds** latency, not milliseconds.

If you have access to a private feed / shared API keys (rare), we can upgrade to true “copy at placement”.

## Setup

```bash
cd polymarket-copytrader
cp .env.example .env
cp config.example.yml config.yml
npm run dev
```

### Env

- `PRIVATE_KEY` (required)
- `SIGNATURE_TYPE` and `FUNDER` depend on how your Polymarket account wallet is set up
- `ENABLE_TRADING=false` by default

## Features

### High-Confidence Market Scanner (Strategy A)

Automatically discovers and trades high-probability markets (75-95% odds) with intelligent stop-loss management:

- Real-time market scanning with configurable filters
- Multi-level dynamic stop-loss (alert, partial exit, full exit)
- Take-profit and trailing stop mechanisms
- Risk management with daily limits and position sizing
- Paper trading mode for testing

```bash
npm run high-confidence
```

See [docs/HIGH_CONFIDENCE_TRADING.md](docs/HIGH_CONFIDENCE_TRADING.md) for full documentation.

### Trader Discovery & Ranking (Strategies B & C)

Discover, analyze, and rank top Polymarket traders for copy trading:

- Automated discovery of top traders from leaderboard
- Comprehensive performance analysis (win rate, ROI, consistency)
- Smart ranking system with weighted metrics
- Historical performance tracking
- Filtering and recommendation system

```bash
# Discover new traders
npm run discover-traders

# View ranked traders
npm run rank-traders

# Compare specific traders
npm run compare-traders 0xWALLET1 0xWALLET2
```

### Other Tools

- `npm run arb-scanner` - Find arbitrage opportunities
- `npm run pnl-report` - Generate P&L reports
- `npm run quant-bot` - Run quantitative trading bot

## Status

- Executor: scaffolded using `@polymarket/clob-client`
- High-Confidence Scanner: **IMPLEMENTED**
- Trader Discovery: **IMPLEMENTED**
- Copy Trading: requires signal source implementation
