import 'dotenv/config';
import { ClobClient } from '@polymarket/clob-client';
import { Wallet } from 'ethers';
import { logger } from './lib/logger.js';

type DataApiPosition = {
  proxyWallet: string;
  asset: string; // token id
  conditionId: string;
  size: number;
  curPrice?: number;
  avgPrice?: number;
  title?: string;
  slug?: string;
  outcome?: string;
};

const DATA_API_BASE = process.env.DATA_API_BASE ?? 'https://data-api.polymarket.com';

async function fetchJson<T>(url: string, timeoutMs = 15_000): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { headers: { Accept: 'application/json' }, signal: ctrl.signal });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`HTTP ${resp.status} ${resp.statusText} for ${url}${text ? ` :: ${text.slice(0, 200)}` : ''}`);
    }
    return (await resp.json()) as T;
  } finally {
    clearTimeout(t);
  }
}

function n(v: any): number {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

async function main() {
  const host = process.env.CLOB_HOST ?? 'https://clob.polymarket.com';
  const chainId = Number(process.env.CHAIN_ID ?? '137');

  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) throw new Error('Missing PRIVATE_KEY in env');

  const signatureType = Number(process.env.SIGNATURE_TYPE ?? '0');
  const funder = process.env.FUNDER && process.env.FUNDER.trim() ? process.env.FUNDER.trim() : undefined;

  const signer = new Wallet(privateKey);

  const dryRun = process.env.DRY_RUN === 'true';
  const maxPerOrderUsdc = n(process.env.FLATTEN_MAX_USDC_PER_ORDER ?? '5');
  const maxOrders = Number(process.env.FLATTEN_MAX_ORDERS ?? '50');
  const slippage = n(process.env.FLATTEN_MAX_SLIPPAGE ?? '0.03'); // absolute dollars (price)

  // Which wallet to flatten positions for: proxy wallet by default.
  const flattenWallet = (process.env.FLATTEN_WALLET ?? funder ?? signer.address).toLowerCase();

  logger.warn(
    {
      dryRun,
      flattenWallet,
      signer: signer.address,
      signatureType,
      funder,
      maxPerOrderUsdc,
      maxOrders,
      slippage,
    },
    'flatten starting'
  );

  // Derive or use L2 creds.
  let creds: any = undefined;
  if (process.env.POLY_API_KEY && process.env.POLY_API_SECRET && process.env.POLY_API_PASSPHRASE) {
    creds = {
      key: process.env.POLY_API_KEY,
      secret: process.env.POLY_API_SECRET,
      passphrase: process.env.POLY_API_PASSPHRASE,
    };
  }

  const useServerTime = process.env.USE_SERVER_TIME === 'true';
  const client = new ClobClient(host, chainId, signer, creds, signatureType as any, funder, undefined, useServerTime);

  if (!creds) {
    logger.info('deriving L2 creds via L1...');
    const derived: any = await client.createOrDeriveApiKey();
    if (!derived?.key || !derived?.secret || !derived?.passphrase) {
      throw new Error(`failed to derive L2 creds: ${derived?.error ?? 'missing key/secret/passphrase'}`);
    }
    creds = derived;
  }

  const authed = new ClobClient(host, chainId, signer, creds, signatureType as any, funder, undefined, useServerTime);

  const positionsUrl = `${DATA_API_BASE}/positions?user=${encodeURIComponent(flattenWallet)}`;
  const positions = await fetchJson<DataApiPosition[]>(positionsUrl);

  const open = positions
    .map((p) => ({
      tokenId: String(p.asset),
      size: n(p.size),
      label: p.slug ?? p.title ?? p.conditionId,
      outcome: p.outcome,
      refPrice: n(p.curPrice ?? p.avgPrice),
    }))
    .filter((p) => p.size > 0);

  logger.warn({ count: open.length }, 'open positions found');
  if (open.length === 0) return;

  let placed = 0;

  for (const p of open) {
    if (placed >= maxOrders) break;

    // Sell up to maxPerOrderUsdc worth of shares (or full size if smaller).
    // Use orderbook to pick a reasonable limit price.
    const book: any = await authed.getOrderBook(p.tokenId);
    const bestBid = n(book?.bids?.[0]?.price);
    const mid = n((await (authed as any).getMidpoint?.(p.tokenId))?.midpoint);

    const basePrice = bestBid || mid || p.refPrice;
    if (!basePrice || basePrice <= 0) {
      logger.warn({ tokenId: p.tokenId, label: p.label }, 'skipping: cannot determine price');
      continue;
    }

    // For sells: prefer near best bid; but do not go below (mid - slippage) when available.
    const minPrice = mid ? Math.max(0.01, mid - slippage) : Math.max(0.01, basePrice - slippage);
    const price = Math.max(minPrice, bestBid || minPrice);

    // Determine shares to sell.
    const maxSharesByUsdc = maxPerOrderUsdc > 0 ? maxPerOrderUsdc / price : p.size;
    const size = Math.min(p.size, maxSharesByUsdc);

    // Clamp to 2 decimal places (clob-client also rounds, but be explicit)
    const sizeRounded = Math.floor(size * 100) / 100;

    if (sizeRounded <= 0) continue;

    // Use correct tick size / negRisk when possible.
    const tickSize = await authed.getTickSize(p.tokenId).catch(() => '0.01');
    const negRisk = await authed.getNegRisk(p.tokenId).catch(() => false);

    logger.warn(
      {
        tokenId: p.tokenId,
        label: p.label,
        outcome: p.outcome,
        shares: sizeRounded,
        price,
        tickSize,
        negRisk,
        bestBid,
        mid,
      },
      dryRun ? 'DRY_RUN: would place SELL to reduce position' : 'placing SELL to reduce position'
    );

    if (dryRun) {
      placed++;
      continue;
    }

    const res: any = await authed.createAndPostOrder(
      {
        tokenID: p.tokenId,
        price,
        size: sizeRounded,
        side: 'SELL',
      } as any,
      { tickSize, negRisk } as any
    );

    if (res?.error) {
      logger.error({ res }, 'flatten order rejected');
    } else {
      logger.info({ res }, 'flatten order posted');
    }

    placed++;
  }

  logger.warn({ placed }, 'flatten complete');
}

main().catch((err) => {
  logger.error({ err }, 'flatten fatal');
  process.exit(1);
});
