# High-Confidence Trading & Trader Discovery

This system implements two complementary trading strategies:

## Strategy A: High-Confidence Market Scanner

Automatically finds and trades high-probability markets (75-95% confidence) with dynamic stop-loss management.

### Features

- **Intelligent Market Scanning**: Identifies markets with high probability of success based on:
  - Probability range (75-95%)
  - High liquidity (minimum volume)
  - Tight spreads
  - Time to resolution
  - Market category preferences

- **Dynamic Stop-Loss Management**: Protects capital with multi-level exits:
  - **Alert Level** (10% odds drop): Warning logged
  - **Partial Exit** (15% odds drop): Sells 50% of position
  - **Full Stop-Loss** (20% odds drop): Exits 100% of position
  - **Take-Profit** (10% odds increase): Exits at profit
  - **Trailing Stop** (5% drop from best): Locks in gains

- **Risk Management**:
  - Maximum positions limit
  - Daily loss limits
  - Position sizing controls
  - Spread and liquidity filters

### Configuration

Edit `high-confidence-config.yml`:

```yaml
scanner:
  minProbability: 0.75        # Minimum 75% confidence
  maxProbability: 0.95        # Maximum 95% confidence
  minVolume24h: 10000         # Minimum $10k daily volume
  maxSpreadPercent: 5         # Maximum 5% spread
  maxTimeToResolutionHours: 24
  categories:
    - sports
    - crypto
    - politics
  scanIntervalMs: 60000       # Scan every 60 seconds
  minMarketAgeHours: 2        # Avoid new unstable markets

risk:
  maxUsdcPerTrade: 5          # $5 per trade
  maxActivePositions: 5       # Max 5 positions
  stopLossPercent: 20         # Exit if odds drop 20%
  partialStopPercent: 15      # Exit 50% if odds drop 15%
  alertThresholdPercent: 10   # Alert if odds drop 10%
  takeProfitPercent: 10       # Exit if odds increase 10%
  trailingStopPercent: 5      # Exit if drops 5% from best
  monitorIntervalMs: 30000    # Check every 30 seconds
  maxDailyLossUsdc: 50        # Max $50 daily loss
  maxDailyNotionalUsdc: 100   # Max $100 daily volume

execution:
  paper: true                 # Paper trading mode
  marketable: false           # Use limit orders
  maxPriceMove: 0.05          # Max 5% price movement tolerance
```

### Usage

#### Run High-Confidence Bot

```bash
npm run high-confidence
```

The bot will:
1. Scan markets every 60 seconds
2. Enter positions meeting high-confidence criteria
3. Monitor positions every 30 seconds
4. Execute dynamic stop-loss/take-profit exits automatically

#### Enable Live Trading

Set `execution.paper: false` in config and ensure proper API credentials in `.env`:

```env
PRIVATE_KEY=your_private_key
POLY_API_KEY=your_api_key
POLY_API_SECRET=your_api_secret
POLY_API_PASSPHRASE=your_passphrase
```

## Strategy B & C: Trader Discovery & Ranking

Automatically discovers, analyzes, and ranks top traders for copy trading.

### Features

- **Automated Discovery**: Finds top traders from Polymarket leaderboard
- **Comprehensive Analysis**: Evaluates each trader on:
  - Win rate
  - ROI (Return on Investment)
  - Total trades (statistical significance)
  - Average position size
  - Consistency over time
  - Category specialization

- **Smart Ranking**: Composite score based on weighted metrics:
  - Win Rate (30%)
  - ROI (25%)
  - Total Trades (15%)
  - Consistency (15%)
  - Position Size (10%)
  - Recency (5%)

- **Filtering**: Customizable minimum thresholds for all metrics

### Configuration

Edit `high-confidence-config.yml`:

```yaml
traderDiscovery:
  minWinRate: 0.55           # Minimum 55% win rate
  minROI: 0.0                # Minimum 0% ROI (break-even)
  minTrades: 50              # Minimum 50 trades
  minAvgPositionSize: 5      # Minimum $5 avg position
  maxParallelAnalysis: 10    # Analyze 10 traders at once
  cacheHours: 24             # Cache data for 24 hours
  topN: 10                   # Return top 10 traders

ranking:
  winRateWeight: 30
  roiWeight: 25
  totalTradesWeight: 15
  consistencyWeight: 15
  positionSizeWeight: 10
  recencyWeight: 5
```

### Usage

#### Discover New Traders

```bash
npm run discover-traders
```

This will:
1. Fetch top 100 traders from Polymarket leaderboard
2. Analyze each trader's performance
3. Filter by minimum requirements
4. Calculate rank scores
5. Save to database
6. Display top 10 recommended traders

#### View Ranked Traders

```bash
npm run rank-traders
```

Display all discovered traders ranked by score.

#### View Top N Traders

```bash
LIMIT=20 npm run rank-traders
```

#### Filter by Criteria

```bash
FILTER_RECOMMENDED=true MIN_WIN_RATE=0.60 npm run rank-traders
```

Available filters:
- `FILTER_RECOMMENDED=true` - Only recommended traders
- `MIN_WIN_RATE=0.60` - Minimum 60% win rate
- `MIN_ROI=5` - Minimum 5% ROI
- `MIN_TRADES=100` - Minimum 100 trades
- `LIMIT=20` - Show top 20 traders

#### Compare Specific Traders

```bash
npm run compare-traders 0x2005d16a84ceefa912d4e380cd32e7ff827875ea 0xANOTHER_WALLET
```

## Database Schema

### High-Confidence Positions

Tracks open positions with real-time odds monitoring:

- `market_key` - Unique market identifier
- `asset_id` - Token ID
- `entry_odds` / `current_odds` / `best_odds` / `worst_odds`
- `stop_loss_price` - Calculated stop-loss trigger
- `status` - open, partial_exit, closed
- `exit_reason` - stop_loss, take_profit, manual, resolution

### High-Confidence Trades

Historical record of all entries and exits:

- `action` - buy, partial_sell, full_sell
- `odds_at_trade` - Odds at execution
- `reason` - Entry/exit reason

### Discovered Traders

Analyzed traders from discovery:

- `wallet` - Trader address
- `win_rate` / `roi` / `total_trades`
- `rank_score` - Composite ranking score
- `is_recommended` - Boolean recommendation flag
- `performance_trend` - improving, stable, declining
- `specialization` - Primary category

### Trader Performance History

Historical snapshots for trend analysis:

- `snapshot_date` - When snapshot was taken
- `period` - 7d, 30d, 90d, all_time

## Paper Trading vs Live Trading

### Paper Trading (Default)

- Set `execution.paper: true` in config
- No real orders placed
- Logs all would-be trades
- Safe for testing and optimization

### Live Trading

- Set `execution.paper: false` in config
- Real orders placed on Polymarket
- Requires funded wallet and API credentials
- USE WITH CAUTION - Start with small amounts

## Risk Warnings

1. **Start Small**: Use small position sizes initially
2. **Test First**: Always paper trade for at least 1 week
3. **Monitor Daily**: Check performance and adjust parameters
4. **Diversify**: Don't rely on a single strategy or trader
5. **Set Limits**: Always use daily loss limits
6. **Market Risk**: High-probability does NOT mean guaranteed profit
7. **API Risk**: Ensure proper error handling and monitoring

## Best Practices

### High-Confidence Trading

1. Start with `maxUsdcPerTrade: 5` or less
2. Keep `maxActivePositions: 5` or lower initially
3. Use tight stop-losses (15-20%) to limit drawdowns
4. Focus on high-volume markets (>$10k daily)
5. Prefer markets resolving within 24 hours
6. Monitor the first week closely and adjust parameters

### Trader Discovery

1. Run discovery weekly to find new traders
2. Look for traders with 100+ trades for better statistics
3. Prefer win rates >55% and positive ROI
4. Check specialization - some traders excel in specific categories
5. Monitor performance history for consistency
6. Diversify by copying 2-3 complementary traders

## Troubleshooting

### No Markets Found

- Lower `minProbability` or raise `maxProbability`
- Increase `maxSpreadPercent`
- Remove category filters
- Check if Polymarket has active markets

### Too Many Exits

- Increase `stopLossPercent` (e.g., 25% instead of 20%)
- Increase `alertThresholdPercent`
- Check if markets are too volatile

### No Traders Found

- Lower `minWinRate` or `minROI`
- Decrease `minTrades`
- Check API connectivity
- Verify Polymarket leaderboard is accessible

### Orders Not Executing

- Check wallet has sufficient USDC balance
- Verify API credentials are correct
- Check CLOB API is accessible
- Review logs for specific error messages

## Examples

### Conservative Settings

```yaml
risk:
  maxUsdcPerTrade: 2
  maxActivePositions: 3
  stopLossPercent: 15
  maxDailyLossUsdc: 20
```

### Aggressive Settings

```yaml
risk:
  maxUsdcPerTrade: 10
  maxActivePositions: 10
  stopLossPercent: 25
  maxDailyLossUsdc: 100
```

### Sports-Only

```yaml
scanner:
  categories:
    - sports
```

### Quick Resolution Only

```yaml
scanner:
  maxTimeToResolutionHours: 6
```

## Support

For issues or questions, check:
- Configuration file for typos
- Logs for error messages
- API connectivity
- Wallet balance and permissions
