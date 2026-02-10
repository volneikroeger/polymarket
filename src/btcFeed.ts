type PricePoint = { price: number; tsMs: number; source: string };

async function fetchJson<T>(url: string, timeoutMs = 10_000): Promise<T> {
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

export async function getBtcSpotUsd(): Promise<PricePoint> {
  const pref = (process.env.BTC_FEED ?? 'coinbase,kraken,coingecko').split(',').map((s) => s.trim()).filter(Boolean);
  const tries = pref.length ? pref : ['coinbase', 'kraken', 'coingecko'];

  let lastErr: any;
  for (const src of tries) {
    try {
      if (src === 'coinbase') {
        // Coinbase public spot
        const j = await fetchJson<any>('https://api.coinbase.com/v2/prices/BTC-USD/spot', 10_000);
        const p = Number(j?.data?.amount);
        if (!Number.isFinite(p) || p <= 0) throw new Error('invalid price');
        return { price: p, tsMs: Date.now(), source: 'coinbase' };
      }
      if (src === 'kraken') {
        const j = await fetchJson<any>('https://api.kraken.com/0/public/Ticker?pair=XBTUSD', 10_000);
        const firstKey = j?.result ? Object.keys(j.result)[0] : null;
        const p = Number(firstKey ? j.result[firstKey]?.c?.[0] : NaN);
        if (!Number.isFinite(p) || p <= 0) throw new Error('invalid price');
        return { price: p, tsMs: Date.now(), source: 'kraken' };
      }
      if (src === 'coingecko') {
        const j = await fetchJson<any>(
          'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd',
          12_000
        );
        const p = Number(j?.bitcoin?.usd);
        if (!Number.isFinite(p) || p <= 0) throw new Error('invalid price');
        return { price: p, tsMs: Date.now(), source: 'coingecko' };
      }
      throw new Error(`unknown feed ${src}`);
    } catch (e) {
      lastErr = e;
    }
  }

  throw lastErr ?? new Error('failed to fetch BTC spot');
}
