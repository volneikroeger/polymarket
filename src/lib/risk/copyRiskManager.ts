import { logger } from '../logger.js';
import type { PolymarketExecutor } from '../polymarket/executor.js';

type Params = {
  executor: PolymarketExecutor;
  pollMs: number;
  stopLossAbs: number; // token price move against entry
  trailAbs: number; // trailing stop distance from best
  maxHoldMs: number;
  maxSpreadAbsOnExit?: number; // optional looser spread for exits
};

export class CopyRiskManager {
  private timer?: NodeJS.Timeout;

  constructor(private readonly params: Params) {}

  start() {
    const { pollMs, stopLossAbs, trailAbs, maxHoldMs } = this.params;
    logger.warn({ pollMs, stopLossAbs, trailAbs, maxHoldMs }, 'starting CopyRiskManager');

    this.timer = setInterval(() => {
      void this.tick();
    }, pollMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick() {
    const ex = this.params.executor;
    const positions = ex.getOpenPositions();
    if (positions.length === 0) return;

    for (const p of positions) {
      try {
        const mid = await ex.getMidpoint(p.assetId);
        if (!mid) continue;

        // update best
        ex.updateBestPrice(p.marketKey, mid);

        const ageMs = Date.now() - p.openedAtMs;
        const moveFromEntry = mid - p.entryPrice;
        const moveFromBest = mid - Math.max(p.entryPrice, p.bestPrice);

        const hitStop = moveFromEntry <= -this.params.stopLossAbs;
        const hitTrail = this.params.trailAbs > 0 && (p.bestPrice - mid) >= this.params.trailAbs && p.bestPrice > p.entryPrice;
        const hitTime = ageMs >= this.params.maxHoldMs;

        if (!(hitStop || hitTrail || hitTime)) continue;

        const reason = hitStop ? 'stop-loss' : hitTrail ? 'trailing-stop' : 'time-stop';
        logger.error(
          {
            marketKey: p.marketKey,
            assetId: p.assetId,
            entry: p.entryPrice,
            best: p.bestPrice,
            mid,
            notionalUsdc: p.notionalUsdc,
            ageMs,
            reason,
          },
          'RISK EXIT: requesting SELL'
        );

        await ex.executeSignal({
          trader: 'risk-manager',
          market: p.marketKey,
          assetId: p.assetId,
          outcome: p.outcome,
          side: 'SELL',
          notionalUsdc: p.notionalUsdc,
          price: mid,
          detectedAt: Date.now(),
        } as any);
      } catch (err) {
        logger.warn({ err, marketKey: p.marketKey, assetId: p.assetId }, 'CopyRiskManager tick error');
      }
    }
  }
}
