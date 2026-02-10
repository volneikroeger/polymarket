import 'dotenv/config';
import { loadConfig } from './lib/config.js';
import { logger } from './lib/logger.js';
import { PolymarketExecutor } from './lib/polymarket/executor.js';
import { TraderPositionMirror } from './lib/signals/traderPositionMirror.js';
import { CopyRiskManager } from './lib/risk/copyRiskManager.js';
import { TraderExitReconciler } from './lib/risk/traderExitReconciler.js';

async function main() {
  const config = await loadConfig();
  logger.info({ config: { ...config, secrets: 'redacted' } }, 'config loaded');

  const executor = await PolymarketExecutor.createFromEnv({
    enableTrading: process.env.ENABLE_TRADING === 'true' && !config.runtime.paper,
    fixedUsdcPerTrade: config.copy.fixedUsdcPerTrade,
    maxPriceMove: config.risk.maxPriceMove,
    marketable: config.copy.marketable,
    allowMarkets: config.risk.allowMarkets,
    denyMarkets: config.risk.denyMarkets,
    maxUsdcPerTrade: config.risk.maxUsdcPerTrade,
    maxOpenUsdcPerMarket: config.risk.maxOpenUsdcPerMarket,
    maxActiveMarkets: config.risk.maxActiveMarkets,
    maxDailyLossUsdc: config.risk.maxDailyLossUsdc,
    maxDailyNotionalUsdc: config.risk.maxDailyNotionalUsdc,
  });

  if (process.env.TEST_SIGNAL_ON_START === 'true') {
    // Smoke-test the executor wiring without relying on the (scaffold) signal source.
    const testSignal = {
      trader: 'test',
      market: 'test-market',
      assetId: '0',
      side: 'BUY',
      price: 0.5,
      notionalUsdc: config.copy.fixedUsdcPerTrade,
    } as any;

    logger.warn({ testSignal }, 'TEST_SIGNAL_ON_START enabled: emitting a synthetic signal');
    try {
      await executor.executeSignal(testSignal);
    } catch (err) {
      logger.error({ err }, 'synthetic signal execution failed');
    }
  }

  // v1 signal source: position mirroring via subgraph / on-chain indexed data.
  // NOTE: This is NOT truly “immediate order placement” mirroring, because Polymarket
  // does not publicly expose other users' order placements by wallet via CLOB websockets.
  // We can mirror once we observe a trader's position change.
  const mirror = new TraderPositionMirror({
    traders: config.traders,
    pollIntervalMs: config.runtime.pollIntervalMs,
  });

  // Risk manager: cut bad positions even if trader hasn't exited yet.
  const riskMgr = new CopyRiskManager({
    executor,
    pollMs: Number(process.env.COPY_RISK_POLL_MS ?? '30000'),
    stopLossAbs: Number(process.env.COPY_STOP_LOSS_ABS ?? '0.03'),
    trailAbs: Number(process.env.COPY_TRAIL_ABS ?? '0'), // disabled by default; let gains run and exit with trader
    maxHoldMs: Number(process.env.COPY_MAX_HOLD_MS ?? String(12 * 60 * 60 * 1000)),
    maxConsecutiveOrderFailures: Number(process.env.MAX_CONSECUTIVE_ORDER_FAILURES ?? '3'),
  });
  riskMgr.start();

  // Reconcile exits: when trader no longer holds the conditionId, close our position.
  // (Uses the same conditionId as signal.market.)
  const primaryTrader = (config.traders?.[0] ?? '').toLowerCase();
  if (primaryTrader) {
    const exitRec = new TraderExitReconciler({
      trader: primaryTrader,
      pollMs: Number(process.env.COPY_EXIT_RECONCILE_POLL_MS ?? '60000'),
      executor,
    });
    exitRec.start();
  }

  mirror.onSignal(async (signal) => {
    logger.info({ signal }, 'copy signal');
    if (config.runtime.paper) {
      logger.warn('paper mode: not placing orders');
      return;
    }
    await executor.executeSignal(signal);
  });

  await mirror.start();
}

main().catch((err) => {
  logger.error({ err }, 'fatal');
  process.exit(1);
});
