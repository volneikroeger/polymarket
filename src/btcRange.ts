import 'dotenv/config';
import { ClobClient } from '@polymarket/clob-client';
import { Wallet } from 'ethers';
import { logger } from './lib/logger.js';

type CoinGeckoResp = {
  bitcoin: { usd: number };
};

async function fetchJson<T>(url: string, timeoutMs = 15_000): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
    return (await resp.json()) as T;
  } finally {
    clearTimeout(t);
  }
}

async function getBtcSpotUsd(): Promise<number> {
  const url = 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd';
  const j = await fetchJson<CoinGeckoResp>(url, 15_000);
  const p = Number(j?.bitcoin?.usd);
  if (!Number.isFinite(p) || p <= 0) throw new Error('failed to fetch BTC spot');
  return p;
}

function parseBtcStrike(question: string): { kind: 'ABOVE' | 'BELOW'; strike: number } | null {
  const q = question.toLowerCase();
  const above =
    q.includes(' above ') ||
    q.includes(' over ') ||
    q.includes(' at least ') ||
    q.includes(' reach ') ||
    q.includes(' hit ') ||
    q.includes(' trade above ') ||
    q.includes(' >= ');
  const below = q.includes(' below ') || q.includes(' under ') || q.includes(' trade below ') || q.includes(' <= ');
  const kind = above ? 'ABOVE' : below ? 'BELOW' : null;
  if (!kind) return null;

  // Find a $ number like $95,000 or 95000.
  const m = question.match(/\$\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{3,6})/);
  if (!m) return null;
  const strike = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(strike) || strike <= 0) return null;
  return { kind, strike };
}

function pickOutcomeToken(tokens: any[], outcome: string): string | null {
  const t = (tokens || []).find((x) => String(x?.outcome).toLowerCase() === outcome.toLowerCase());
  const tokenId = t?.token_id;
  return tokenId ? String(tokenId) : null;
}

async function main() {
  const host = process.env.CLOB_HOST ?? 'https://clob.polymarket.com';
  const chainId = Number(process.env.CHAIN_ID ?? '137');

  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) throw new Error('Missing PRIVATE_KEY');

  const signatureType = Number(process.env.SIGNATURE_TYPE ?? '1');
  const funder = process.env.FUNDER && process.env.FUNDER.trim() ? process.env.FUNDER.trim() : undefined;

  const signer = new Wallet(privateKey);
  const client = new ClobClient(host, chainId as any, signer, undefined, signatureType as any, funder, undefined, true);

  const pollMs = Number(process.env.BTC_RANGE_POLL_MS ?? '60000');
  const maxMarkets = Number(process.env.BTC_RANGE_MAX_MARKETS ?? '20');

  logger.warn({ pollMs, maxMarkets }, 'starting BTC range scanner (paper by default; does not trade yet)');

  while (true) {
    try {
      const btc = await getBtcSpotUsd();

      // Pull multiple pages of markets and filter.
      const maxPages = Number(process.env.BTC_RANGE_MAX_PAGES ?? '30');
      let cursor: string | undefined = undefined;
      const markets: any[] = [];
      for (let page = 0; page < maxPages; page++) {
        const resp: any = await client.getMarkets(cursor);
        const data: any[] = resp?.data ?? [];
        markets.push(...data);
        cursor = resp?.next_cursor;
        if (!cursor) break;
      }

      const isBtcQuestion = (q: string) => {
        const s = q.toLowerCase();
        return s.includes('btc') || s.includes('bitcoin');
      };
      const hasCryptoTag = (tags: any) => Array.isArray(tags) && tags.some((t) => String(t).toLowerCase().includes('crypto'));

      const nowMs = Date.now();
      const candidates = markets
        .filter((m) => m?.accepting_orders)
        .filter((m) => m?.active)
        .filter((m) => !m?.closed)
        .filter((m) => !m?.archived)
        .filter((m) => {
          const end = String(m?.end_date_iso ?? '');
          const endMs = end ? Date.parse(end) : NaN;
          return !Number.isFinite(endMs) || endMs > nowMs; // if missing/unparseable, keep; else require future
        })
        .filter((m) => typeof m?.question === 'string')
        .filter((m) => isBtcQuestion(String(m.question)) || hasCryptoTag(m.tags))
        .map((m) => {
          const parsed = parseBtcStrike(String(m.question));
          return { m, parsed };
        })
        .filter((x) => x.parsed)
        .slice(0, maxMarkets);

      const rows = [] as any[];
      for (const c of candidates) {
        const m = c.m;
        const { kind, strike } = c.parsed as any;

        // Heuristic “low risk”: only consider strikes within 10% of spot.
        const distPct = Math.abs(btc - strike) / btc;

        // Suggested side based on moneyness only (not momentum):
        // - If BTC already below strike, suggest NO for ABOVE markets.
        // - If BTC already above strike, suggest NO for BELOW markets.
        let suggestedOutcome: 'Yes' | 'No' | null = null;
        if (kind === 'ABOVE') suggestedOutcome = btc >= strike ? 'Yes' : 'No';
        if (kind === 'BELOW') suggestedOutcome = btc <= strike ? 'Yes' : 'No';

        const tokenYes = pickOutcomeToken(m.tokens, 'Yes');
        const tokenNo = pickOutcomeToken(m.tokens, 'No');

        rows.push({
          question: m.question,
          end: m.end_date_iso,
          kind,
          strike,
          btc,
          distPct: Number(distPct.toFixed(4)),
          suggestedOutcome,
          tokenYes,
          tokenNo,
          conditionId: m.condition_id,
          slug: m.market_slug,
        });
      }

      logger.info({ btc, found: rows.length, rows: rows.slice(0, 8) }, 'btc-range scan');
    } catch (err) {
      logger.warn({ err }, 'btc-range scan error');
    }

    await new Promise((r) => setTimeout(r, pollMs));
  }
}

main().catch((err) => {
  logger.error({ err }, 'fatal');
  process.exit(1);
});
