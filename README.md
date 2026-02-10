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

## Status

- Executor: scaffolded using `@polymarket/clob-client`
- Signal source: **NOT IMPLEMENTED** (placeholder)

Next: implement a real signal source (subgraph/on-chain) and convert detected changes into `CopySignal`s.
# polymarket
# polymarket
