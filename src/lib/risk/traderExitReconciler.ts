import { logger } from '../logger.js';
import type { PolymarketExecutor } from '../polymarket/executor.js';

const DATA_API_BASE = process.env.DATA_API_BASE ?? 'https://data-api.polymarket.com';

type PositionItem = {
  conditionId?: string;
  size?: number;
  asset?: string;
  outcome?: string;
  // many other fields exist; we only need conditionId/size
};

async function fetchJson<T>(url: string, timeoutMs = Number(process.env.FETCH_TIMEOUT_MS ?? '15000')): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { headers: { Accept: 'application/json' }, signal: ctrl.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
    return (await resp.json()) as T;
  } finally {
    clearTimeout(t);
  }
}

export class TraderExitReconciler {
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly params: {
      trader: string; // one trader for now
      pollMs: number;
      executor: PolymarketExecutor;
    }
  ) {}

  start() {
    logger.warn({ trader: this.params.trader, pollMs: this.params.pollMs, dataApiBase: DATA_API_BASE }, 'starting TraderExitReconciler');
    this.timer = setInterval(() => {
      void this.tick();
    }, this.params.pollMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick() {
    const ex = this.params.executor;
    const trader = this.params.trader.toLowerCase();

    const open = ex.getOpenPositions();
    if (open.length === 0) return;

    // Fetch current trader positions snapshot.
    let items: PositionItem[] = [];
    try {
      const url = `${DATA_API_BASE}/positions?user=${encodeURIComponent(trader)}`;
      items = await fetchJson<PositionItem[]>(url);
    } catch (err) {
      logger.warn({ err }, 'TraderExitReconciler fetch positions failed');
      return;
    }

    const activeConditions = new Set(
      items
        .filter((p) => Number(p.size ?? 0) !== 0)
        .map((p) => String(p.conditionId ?? '').toLowerCase())
        .filter((s) => s.length > 0)
    );

    // If we have a position in a condition the trader no longer holds -> exit.
    for (const p of open) {
      if (!p.marketKey || p.marketKey.length < 6) continue;
      if (activeConditions.has(p.marketKey.toLowerCase())) continue;

      logger.error(
        {
          trader,
          marketKey: p.marketKey,
          assetId: p.assetId,
          notionalUsdc: p.notionalUsdc,
        },
        'TRADER EXIT detected: requesting SELL'
      );

      const mid = await ex.getMidpoint(p.assetId);
      if (!mid) continue;

      await ex.executeSignal({
        trader: 'trader-exit-reconciler',
        market: p.marketKey,
        assetId: p.assetId,
        outcome: p.outcome,
        side: 'SELL',
        notionalUsdc: p.notionalUsdc,
        price: mid,
        detectedAt: Date.now(),
      } as any);
    }
  }
}
