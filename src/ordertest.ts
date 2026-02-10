import 'dotenv/config';
import { ClobClient } from '@polymarket/clob-client';
import { Wallet } from 'ethers';

type DataApiActivityItem = {
  timestamp: number;
  type: string;
  usdcSize?: number;
  price?: number;
  asset: string;
  side?: 'BUY' | 'SELL';
  title?: string;
  slug?: string;
  outcome?: string;
  transactionHash?: string;
};

const DATA_API_BASE = process.env.DATA_API_BASE ?? 'https://data-api.polymarket.com';

async function fetchJson<T>(url: string): Promise<T> {
  const resp = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText} for ${url}`);
  return (await resp.json()) as T;
}

function n(v: any): number {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

function roundToTick(p: number, tick: number) {
  const clamped = Math.min(1 - tick, Math.max(tick, p));
  return Math.round(clamped / tick) * tick;
}

async function main() {
  const host = process.env.CLOB_HOST ?? 'https://clob.polymarket.com';
  const chainId = Number(process.env.CHAIN_ID ?? '137');

  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) throw new Error('Missing PRIVATE_KEY');

  const signatureType = Number(process.env.SIGNATURE_TYPE ?? '0');
  const funder = process.env.FUNDER && process.env.FUNDER.trim() ? process.env.FUNDER.trim() : undefined;
  const useServerTime = process.env.USE_SERVER_TIME === 'true';

  const signer = new Wallet(privateKey);

  const trader = (process.env.ORDERTEST_TRADER ?? '0x2005d16a84ceefa912d4e380cd32e7ff827875ea').toLowerCase();
  const shares = n(process.env.ORDERTEST_SHARES ?? '5');
  const postOnly = process.env.ORDERTEST_POST_ONLY !== 'false';
  const dryRun = process.env.ORDERTEST_DRY_RUN === 'true';

  console.log('ordertest config', { trader, signer: signer.address, signatureType, funder, shares, postOnly, dryRun });

  // Fetch most recent trade from Data API
  const activityUrl = `${DATA_API_BASE}/activity?user=${encodeURIComponent(trader)}&limit=5`;
  const activity = await fetchJson<DataApiActivityItem[]>(activityUrl);
  const trades = activity.filter((i) => String(i.type).toUpperCase() === 'TRADE');
  if (trades.length === 0) throw new Error('no trades found');
  trades.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
  const last = trades[0];

  const tokenId = String(last.asset);

  console.log('last trade', {
    ts: last.timestamp,
    tx: last.transactionHash,
    tokenId,
    side: last.side,
    price: last.price,
    usdcSize: last.usdcSize,
    title: last.title,
    outcome: last.outcome,
  });

  // Build CLOB client (derive creds if needed)
  let creds: any;
  if (process.env.POLY_API_KEY && process.env.POLY_API_SECRET && process.env.POLY_API_PASSPHRASE) {
    creds = { key: process.env.POLY_API_KEY, secret: process.env.POLY_API_SECRET, passphrase: process.env.POLY_API_PASSPHRASE };
  }

  const base = new ClobClient(host, chainId, signer, creds, signatureType as any, funder, undefined, useServerTime);
  if (!creds) {
    const derived: any = await base.createOrDeriveApiKey();
    if (!derived?.key) throw new Error(`failed to derive creds: ${derived?.error ?? 'unknown'}`);
    creds = derived;
  }
  const client = new ClobClient(host, chainId, signer, creds, signatureType as any, funder, undefined, useServerTime);

  const tickSizeStr: string = await client.getTickSize(tokenId);
  const tickSize = n(tickSizeStr);
  const negRisk: boolean = await client.getNegRisk(tokenId);
  const book: any = await client.getOrderBook(tokenId);
  const bestBid = n(book?.bids?.[0]?.price);
  const bestAsk = n(book?.asks?.[0]?.price);

  // Choose a maker price inside the spread (or at best bid/ask) so postOnly won't reject.
  const side: 'BUY' | 'SELL' = 'BUY';
  let price: number;
  if (side === 'BUY') {
    price = bestBid || n(last.price) || 0.5;
  } else {
    price = bestAsk || n(last.price) || 0.5;
  }
  price = roundToTick(price, tickSize || 0.01);

  console.log('order params', { tokenId, side, shares, price, tickSize: tickSizeStr, negRisk, bestBid, bestAsk });

  if (dryRun) {
    console.log('DRY_RUN: not posting');
    return;
  }

  const res: any = await client.createAndPostOrder(
    {
      tokenID: tokenId,
      price,
      size: shares,
      side,
    } as any,
    { tickSize: tickSizeStr, negRisk } as any,
    'GTC' as any,
    false,
    postOnly
  );

  console.log('order result:', res);
}

main().catch((e) => {
  console.error('ordertest fatal', e);
  process.exit(1);
});
