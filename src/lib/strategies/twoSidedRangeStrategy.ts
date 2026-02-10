import { logger } from '../logger.js';
import type { PolymarketExecutor } from '../polymarket/executor.js';

interface RangeMarket {
  conditionId: string;
  slug: string;
  upAssetId: string;
  downAssetId: string;
  startTime: number;
  endTime: number;
  crypto: 'BTC' | 'ETH' | 'SOL' | 'XRP';
}

interface Position {
  market: RangeMarket;
  upShares: number;
  downShares: number;
  upAvgPrice: number;
  downAvgPrice: number;
  totalInvested: number;
  entryTime: number;
}

export class TwoSidedRangeStrategy {
  private positions = new Map<string, Position>();
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly params: {
      executor: PolymarketExecutor;
      pollMs: number;
      maxCapitalPerMarket: number;
      targetSpreadPct: number;
      maxAverageDowns: number;
      stopLossPct: number;
    }
  ) {}

  start() {
    logger.warn(
      {
        maxCapitalPerMarket: this.params.maxCapitalPerMarket,
        targetSpreadPct: this.params.targetSpreadPct,
        maxAverageDowns: this.params.maxAverageDowns,
      },
      'Starting TwoSidedRangeStrategy'
    );

    this.timer = setInterval(() => {
      void this.tick();
    }, this.params.pollMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick() {
    await this.scanForOpportunities();
    await this.managePositions();
  }

  private async scanForOpportunities() {
    const markets = await this.findRangeMarkets();

    for (const market of markets) {
      if (this.positions.has(market.conditionId)) continue;

      const upPrice = await this.getPrice(market.upAssetId);
      const downPrice = await this.getPrice(market.downAssetId);

      if (!upPrice || !downPrice) continue;

      const totalPrice = upPrice + downPrice;
      const spreadPct = Math.abs(totalPrice - 1.0) / 1.0;

      if (spreadPct >= this.params.targetSpreadPct) {
        await this.openPosition(market, upPrice, downPrice);
      }
    }
  }

  private async openPosition(market: RangeMarket, upPrice: number, downPrice: number) {
    const capitalPerSide = this.params.maxCapitalPerMarket / 2;

    const upShares = capitalPerSide / upPrice;
    const downShares = capitalPerSide / downPrice;

    logger.warn(
      {
        market: market.slug,
        upPrice,
        downPrice,
        spread: upPrice + downPrice - 1.0,
        upShares,
        downShares,
        totalInvested: this.params.maxCapitalPerMarket,
      },
      'Opening two-sided position'
    );

    await this.params.executor.executeSignal({
      trader: 'two-sided-range',
      market: market.conditionId,
      assetId: market.upAssetId,
      outcome: 'Up',
      side: 'BUY',
      notionalUsdc: capitalPerSide,
      price: upPrice,
      detectedAt: Date.now(),
    } as any);

    await this.params.executor.executeSignal({
      trader: 'two-sided-range',
      market: market.conditionId,
      assetId: market.downAssetId,
      outcome: 'Down',
      side: 'BUY',
      notionalUsdc: capitalPerSide,
      price: downPrice,
      detectedAt: Date.now(),
    } as any);

    this.positions.set(market.conditionId, {
      market,
      upShares,
      downShares,
      upAvgPrice: upPrice,
      downAvgPrice: downPrice,
      totalInvested: this.params.maxCapitalPerMarket,
      entryTime: Date.now(),
    });
  }

  private async managePositions() {
    const now = Date.now();

    for (const [conditionId, pos] of this.positions.entries()) {
      const upPrice = await this.getPrice(pos.market.upAssetId);
      const downPrice = await this.getPrice(pos.market.downAssetId);

      if (!upPrice || !downPrice) continue;

      const currentUpValue = pos.upShares * upPrice;
      const currentDownValue = pos.downShares * downPrice;
      const totalValue = currentUpValue + currentDownValue;
      const pnlPct = (totalValue - pos.totalInvested) / pos.totalInvested;

      if (now >= pos.market.endTime - 60000) {
        logger.warn(
          { market: pos.market.slug, pnlPct, totalValue, invested: pos.totalInvested },
          'Market ending soon - holding to resolution'
        );
        continue;
      }

      if (pnlPct <= -this.params.stopLossPct) {
        logger.error(
          { market: pos.market.slug, pnlPct, totalValue, invested: pos.totalInvested },
          'Stop loss hit - closing both sides'
        );
        await this.closePosition(pos);
        this.positions.delete(conditionId);
        continue;
      }

      const totalPrice = upPrice + downPrice;
      if (totalPrice < 0.95 && pos.upShares < pos.totalInvested / upPrice * this.params.maxAverageDowns) {
        const additionalCapital = this.params.maxCapitalPerMarket * 0.2;
        await this.averageDown(pos, 'up', upPrice, additionalCapital);
      } else if (totalPrice > 1.05 && pos.downShares < pos.totalInvested / downPrice * this.params.maxAverageDowns) {
        const additionalCapital = this.params.maxCapitalPerMarket * 0.2;
        await this.averageDown(pos, 'down', downPrice, additionalCapital);
      }
    }
  }

  private async averageDown(pos: Position, side: 'up' | 'down', price: number, capital: number) {
    const shares = capital / price;

    logger.warn(
      {
        market: pos.market.slug,
        side,
        price,
        additionalShares: shares,
        additionalCapital: capital,
      },
      'Averaging down position'
    );

    const assetId = side === 'up' ? pos.market.upAssetId : pos.market.downAssetId;
    const outcome = side === 'up' ? 'Up' : 'Down';

    await this.params.executor.executeSignal({
      trader: 'two-sided-range',
      market: pos.market.conditionId,
      assetId,
      outcome,
      side: 'BUY',
      notionalUsdc: capital,
      price,
      detectedAt: Date.now(),
    } as any);

    if (side === 'up') {
      const newTotalShares = pos.upShares + shares;
      pos.upAvgPrice = (pos.upAvgPrice * pos.upShares + price * shares) / newTotalShares;
      pos.upShares = newTotalShares;
    } else {
      const newTotalShares = pos.downShares + shares;
      pos.downAvgPrice = (pos.downAvgPrice * pos.downShares + price * shares) / newTotalShares;
      pos.downShares = newTotalShares;
    }

    pos.totalInvested += capital;
  }

  private async closePosition(pos: Position) {
    const upPrice = await this.getPrice(pos.market.upAssetId);
    const downPrice = await this.getPrice(pos.market.downAssetId);

    if (upPrice && pos.upShares > 0) {
      await this.params.executor.executeSignal({
        trader: 'two-sided-range',
        market: pos.market.conditionId,
        assetId: pos.market.upAssetId,
        outcome: 'Up',
        side: 'SELL',
        notionalUsdc: pos.upShares * upPrice,
        price: upPrice,
        detectedAt: Date.now(),
      } as any);
    }

    if (downPrice && pos.downShares > 0) {
      await this.params.executor.executeSignal({
        trader: 'two-sided-range',
        market: pos.market.conditionId,
        assetId: pos.market.downAssetId,
        outcome: 'Down',
        side: 'SELL',
        notionalUsdc: pos.downShares * downPrice,
        price: downPrice,
        detectedAt: Date.now(),
      } as any);
    }
  }

  private async getPrice(assetId: string): Promise<number | null> {
    return await this.params.executor.getMidpoint(assetId);
  }

  private async findRangeMarkets(): Promise<RangeMarket[]> {
    return [];
  }
}
