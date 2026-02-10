import fs from 'node:fs/promises';
import path from 'node:path';

export type RiskState = {
  version: 'v2.3.1';
  tz: string;

  dayKey: string; // YYYY-MM-DD in tz
  dayStartMsUtc: number;

  // Accounting
  realizedPnlUsdc: number;
  realizedTrades: number;
  dailyNotionalUsdc: number;

  // Exposure: filled (still open / not offset) per marketKey (conditionId)
  filledExposureByMarketUsdc: Record<string, number>;

  // Derived exposure snapshots (filled + active orders). Persisted for audit only.
  exposureByMarketUsdc: Record<string, number>;
  exposureTotalUsdc: number;

  // Orders we believe are still open (best-effort; used for exposure tracking)
  openOrdersById: Record<
    string,
    {
      orderId: string;
      marketKey: string | null;
      tokenId: string;
      side: 'BUY' | 'SELL';
      price: number;
      // remainingSize is best-effort (from getOpenOrders / getOrder)
      remainingSize: number;
    }
  >;

  // Unwind / cooldown tracking
  consecutiveUnwinds: number;
  marketCooldownUntilMs: Record<string, number>; // marketKey -> epoch ms

  // Infra health
  httpErrorsInRow: number;
  latencyBreachesInRow: number;

  // Halt
  haltedUntilMs: number;
  haltReason: string | null;

  // Telemetry
  lastSaveMs: number;
  lastBookUpdateMsByToken: Record<string, number>; // tokenId -> last update ms
};

export const DEFAULT_TZ = 'America/Sao_Paulo';

export function makeDayKey(tz: string, atMsUtc: number): string {
  const d = new Date(atMsUtc);
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  // en-CA yields YYYY-MM-DD
  return fmt.format(d);
}

export function newRiskState(nowMsUtc: number, tz = DEFAULT_TZ): RiskState {
  return {
    version: 'v2.3.1',
    tz,

    dayKey: makeDayKey(tz, nowMsUtc),
    dayStartMsUtc: nowMsUtc,

    realizedPnlUsdc: 0,
    realizedTrades: 0,
    dailyNotionalUsdc: 0,

    filledExposureByMarketUsdc: {},

    exposureByMarketUsdc: {},
    exposureTotalUsdc: 0,

    openOrdersById: {},

    consecutiveUnwinds: 0,
    marketCooldownUntilMs: {},

    httpErrorsInRow: 0,
    latencyBreachesInRow: 0,

    haltedUntilMs: 0,
    haltReason: null,

    lastSaveMs: 0,
    lastBookUpdateMsByToken: {},
  };
}

export async function loadRiskState(statePath: string, nowMsUtc: number, tz = DEFAULT_TZ): Promise<RiskState> {
  try {
    const raw = JSON.parse(await fs.readFile(statePath, 'utf8'));
    if (!raw || typeof raw !== 'object') return newRiskState(nowMsUtc, tz);

    // tolerate partial files
    const st: RiskState = {
      ...newRiskState(nowMsUtc, tz),
      ...raw,
      version: 'v2.3.1',
      tz,
    };

    // rollover if day changed
    const dk = makeDayKey(tz, nowMsUtc);
    if (st.dayKey !== dk) {
      return newRiskState(nowMsUtc, tz);
    }

    return st;
  } catch {
    return newRiskState(nowMsUtc, tz);
  }
}

export async function saveRiskState(statePath: string, st: RiskState): Promise<void> {
  const dir = path.dirname(statePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${statePath}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(st, null, 2));
  await fs.rename(tmp, statePath);
}
