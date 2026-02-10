export type CopySignal = {
  trader: string; // wallet address being mirrored
  market: string; // condition id
  assetId: string; // token id
  outcome?: string;
  side: 'BUY' | 'SELL';
  // desired notional in USDC; executor converts to size shares depending on price
  notionalUsdc: number;
  // optional reference price observed
  price?: number;
  // timestamp ms when detected
  detectedAt: number;
};
