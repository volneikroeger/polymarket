import 'dotenv/config';
import { logger } from './lib/logger.js';

const DATA_API_BASE = process.env.DATA_API_BASE ?? 'https://data-api.polymarket.com';
const USER = process.env.PNL_USER;
const USERS = process.env.PNL_USERS;

type TradeItem = {
  timestamp?: number;
  transactionHash?: string;
  type?: string;
  price?: number;
  side?: 'BUY' | 'SELL';
  asset?: string; // token id
  size?: number; // shares
  usdcSize?: number; // notional
  title?: string;
  slug?: string;
  conditionId?: string;
  outcome?: string;
};

type Lot = { shares: number; costUsdc: number };

async function fetchJson<T>(url: string, timeoutMs = Number(process.env.FETCH_TIMEOUT_MS ?? '15000')): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { headers: { Accept: 'application/json' }, signal: ctrl.signal });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`HTTP ${resp.status} ${resp.statusText} :: ${text.slice(0, 200)}`);
    }
    return (await resp.json()) as T;
  } finally {
    clearTimeout(t);
  }
}

function isTrade(x: any): x is TradeItem {
  // Data API sometimes returns trades without an explicit `type` field on /trades.
  // Accept either explicit TRADE type, or the presence of core trade fields.
  const t = String(x?.type ?? '').toUpperCase();
  if (t === 'TRADE') return true;
  const side = String(x?.side ?? '').toUpperCase();
  return (side === 'BUY' || side === 'SELL') && (x?.asset || x?.tokenId) && (x?.price || x?.usdcSize);
}

async function calcForUser(user: string) {
  const limit = Number(process.env.PNL_TRADE_LIMIT ?? '500');
  const url = `${DATA_API_BASE}/trades?user=${encodeURIComponent(user)}&limit=${limit}`;

  const items = await fetchJson<TradeItem[]>(url);
  const trades = items.filter(isTrade);
  trades.sort((a, b) => Number(a.timestamp ?? 0) - Number(b.timestamp ?? 0));

  // FIFO lots per token
  const lotsByToken = new Map<string, Lot[]>();

  let realizedPnl = 0;
  let realizedWins = 0;
  let realizedLosses = 0;

  for (const t of trades) {
    const tokenId = String(t.asset ?? '');
    if (!tokenId) continue;
    const side = (t.side ?? 'BUY').toUpperCase() as 'BUY' | 'SELL';

    const shares = Number(t.size ?? 0);
    const price = Number(t.price ?? 0);
    let notional = Number(t.usdcSize ?? 0);

    if (!Number.isFinite(shares) || shares <= 0) continue;
    if (!Number.isFinite(price) || price <= 0) continue;

    if (!Number.isFinite(notional) || notional <= 0) {
      notional = shares * price;
    }

    const lots = lotsByToken.get(tokenId) ?? [];

    if (side === 'BUY') {
      lots.push({ shares, costUsdc: notional });
      lotsByToken.set(tokenId, lots);
      continue;
    }

    // SELL: match against FIFO
    let remaining = shares;
    let proceeds = notional;
    let costMatched = 0;

    while (remaining > 0 && lots.length > 0) {
      const lot = lots[0];
      const take = Math.min(remaining, lot.shares);
      const frac = take / lot.shares;
      costMatched += lot.costUsdc * frac;

      lot.shares -= take;
      lot.costUsdc -= lot.costUsdc * frac;
      remaining -= take;
      if (lot.shares <= 1e-9) lots.shift();
    }

    // If we sold more shares than we had lots for, ignore the unmatched part (could be data inconsistency).
    if (remaining > 0) {
      const soldFrac = (shares - remaining) / shares;
      proceeds = proceeds * soldFrac;
    }

    const pnl = proceeds - costMatched;
    realizedPnl += pnl;
    if (pnl >= 0) realizedWins += 1;
    else realizedLosses += 1;

    lotsByToken.set(tokenId, lots);
  }

  const openTokens = [...lotsByToken.entries()].filter(([, ls]) => ls.length > 0).length;

  return {
    user,
    realizedPnlUsdc: Number(realizedPnl.toFixed(4)),
    realizedTrades: realizedWins + realizedLosses,
    wins: realizedWins,
    losses: realizedLosses,
    openTokens,
    fetched: trades.length,
  };
}

async function main() {
  const users = (USERS ?? USER ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (users.length === 0) throw new Error('Missing PNL_USER or PNL_USERS env (wallet address list)');

  const results = [];
  for (const u of users) {
    try {
      results.push(await calcForUser(u));
    } catch (err) {
      results.push({ user: u, error: String(err) });
    }
  }

  logger.warn({ results }, 'PnL report (FIFO, approximate; excludes fees)');

  // Also print JSON to stdout for automation.
  console.log(JSON.stringify({ results }));
}

main().catch((err) => {
  logger.error({ err }, 'fatal');
  process.exit(1);
});
