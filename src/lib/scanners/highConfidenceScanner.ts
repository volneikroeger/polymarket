import { logger } from '../logger.js';
import type { HighConfidenceConfig } from '../highConfidenceConfig.js';
import {
  fetchActiveMarkets,
  fetchOrderBook,
  calculateBidAskSpread,
  calculateMidPrice,
  type PolymarketMarket,
  type OrderBook,
} from '../polymarket/api.js';

export interface ScoredMarket {
  market: PolymarketMarket;
  tokenId: string;
  outcome: string;
  probability: number;
  price: number;
  volume24h: number;
  spreadPercent: number;
  hoursToResolution: number;
  marketAgeHours: number;
  score: number;
  orderBook: OrderBook;
  reason: string;
}

export class HighConfidenceScanner {
  constructor(private readonly config: HighConfidenceConfig) {}

  async scanMarkets(): Promise<ScoredMarket[]> {
    logger.info('Starting high-confidence market scan');

    const markets = await fetchActiveMarkets();
    logger.info({ count: markets.length }, 'Fetched active markets');

    const scoredMarkets: ScoredMarket[] = [];

    for (const market of markets) {
      if (!market.active || market.closed) {
        continue;
      }

      const scored = await this.scoreMarket(market);
      if (scored) {
        scoredMarkets.push(scored);
      }
    }

    scoredMarkets.sort((a, b) => b.score - a.score);

    logger.info({ count: scoredMarkets.length, top: scoredMarkets.slice(0, 5) }, 'Scan complete');

    return scoredMarkets;
  }

  private async scoreMarket(market: PolymarketMarket): Promise<ScoredMarket | null> {
    if (!market.tokens || market.tokens.length === 0) {
      return null;
    }

    const volume = Number(market.volume || 0);
    if (volume < this.config.scanner.minVolume24h) {
      return null;
    }

    if (this.config.scanner.categories.length > 0) {
      const category = (market.category || '').toLowerCase();
      if (!this.config.scanner.categories.some(c => category.includes(c.toLowerCase()))) {
        return null;
      }
    }

    const createdAt = market.createdAt ? new Date(market.createdAt).getTime() : Date.now();
    const marketAgeHours = (Date.now() - createdAt) / (1000 * 60 * 60);
    if (marketAgeHours < this.config.scanner.minMarketAgeHours) {
      return null;
    }

    let bestToken: ScoredMarket | null = null;

    for (const token of market.tokens) {
      const probability = Number(token.price || 0);

      if (probability < this.config.scanner.minProbability || probability > this.config.scanner.maxProbability) {
        continue;
      }

      const orderBook = await fetchOrderBook(token.tokenId);
      if (!orderBook) {
        continue;
      }

      const spread = calculateBidAskSpread(orderBook);
      const midPrice = calculateMidPrice(orderBook);

      if (!midPrice || spread === Infinity) {
        continue;
      }

      const spreadPercent = (spread / midPrice) * 100;
      if (spreadPercent > this.config.scanner.maxSpreadPercent) {
        continue;
      }

      const endDate = market.endDate ? new Date(market.endDate).getTime() : null;
      const hoursToResolution = endDate ? (endDate - Date.now()) / (1000 * 60 * 60) : Infinity;

      if (hoursToResolution > this.config.scanner.maxTimeToResolutionHours && hoursToResolution !== Infinity) {
        continue;
      }

      const score = this.calculateScore({
        probability,
        volume,
        spreadPercent,
        hoursToResolution,
      });

      const scoredMarket: ScoredMarket = {
        market,
        tokenId: token.tokenId,
        outcome: token.outcome,
        probability,
        price: midPrice,
        volume24h: volume,
        spreadPercent,
        hoursToResolution,
        marketAgeHours,
        score,
        orderBook,
        reason: this.generateReason(probability, volume, spreadPercent, hoursToResolution),
      };

      if (!bestToken || score > bestToken.score) {
        bestToken = scoredMarket;
      }
    }

    return bestToken;
  }

  private calculateScore(params: {
    probability: number;
    volume: number;
    spreadPercent: number;
    hoursToResolution: number;
  }): number {
    const { probability, volume, spreadPercent, hoursToResolution } = params;
    const weights = this.config.scoring;

    const probabilityScore = this.normalizeProbability(probability) * weights.probabilityWeight;
    const volumeScore = this.normalizeVolume(volume) * weights.volumeWeight;
    const spreadScore = this.normalizeSpread(spreadPercent) * weights.spreadWeight;
    const timeScore = this.normalizeTime(hoursToResolution) * weights.timeWeight;

    return probabilityScore + volumeScore + spreadScore + timeScore;
  }

  private normalizeProbability(prob: number): number {
    const min = this.config.scanner.minProbability;
    const max = this.config.scanner.maxProbability;
    const optimal = 0.85;

    if (prob < min || prob > max) return 0;

    const distanceFromOptimal = Math.abs(prob - optimal);
    const maxDistance = Math.max(optimal - min, max - optimal);

    return 1 - (distanceFromOptimal / maxDistance);
  }

  private normalizeVolume(volume: number): number {
    const min = this.config.scanner.minVolume24h;
    const max = min * 10;

    if (volume < min) return 0;
    if (volume >= max) return 1;

    return (volume - min) / (max - min);
  }

  private normalizeSpread(spreadPercent: number): number {
    const max = this.config.scanner.maxSpreadPercent;

    if (spreadPercent >= max) return 0;

    return 1 - (spreadPercent / max);
  }

  private normalizeTime(hours: number): number {
    const max = this.config.scanner.maxTimeToResolutionHours;

    if (hours === Infinity) return 0.5;
    if (hours >= max) return 0;

    return 1 - (hours / max);
  }

  private generateReason(
    probability: number,
    volume: number,
    spreadPercent: number,
    hoursToResolution: number
  ): string {
    const reasons: string[] = [];

    if (probability >= 0.80) {
      reasons.push(`Strong ${(probability * 100).toFixed(1)}% probability`);
    } else {
      reasons.push(`${(probability * 100).toFixed(1)}% probability`);
    }

    if (volume >= 50000) {
      reasons.push('High liquidity');
    } else if (volume >= 20000) {
      reasons.push('Good liquidity');
    }

    if (spreadPercent < 1) {
      reasons.push('Tight spread');
    } else if (spreadPercent < 2.5) {
      reasons.push('Acceptable spread');
    }

    if (hoursToResolution !== Infinity && hoursToResolution < 12) {
      reasons.push('Resolves soon');
    } else if (hoursToResolution !== Infinity && hoursToResolution < 24) {
      reasons.push('Resolves within 24h');
    }

    return reasons.join(', ');
  }
}
