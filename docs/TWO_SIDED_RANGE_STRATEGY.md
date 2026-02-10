# Two-Sided Range Trading Strategy

## Overview

This strategy is inspired by trader "distinct-baguette" (0xe00740bce98a594e26861838885ab310ec3b548c) who trades 15-minute crypto price prediction markets on Polymarket.

## Original Strategy (High Risk)

### What They Do

1. **Market Type**: 15-minute "Up or Down" binary markets for BTC, ETH, SOL, XRP
2. **Simultaneous Positions**: Buy BOTH "Up" and "Down" on the same market
3. **Aggressive Averaging**: When losing, buy more shares rapidly (martingale-style)
4. **High Volume**: 20-100+ shares per trade, multiple trades per second
5. **Binary Resolution**: Markets resolve to $1.00 or $0.00

### Example Trade Sequence

Market: ETH 5:45PM-6:00PM
- Buy 93 shares "Down" @ $0.66 = $61.38
- Buy 31 shares "Down" @ $0.69 = $21.39
- Buy 93 shares "Down" @ $0.79 = $73.47
- Buy 48 shares "Up" @ $0.25 = $12.00
- Buy 31 shares "Up" @ $0.52 = $16.12

**Total Invested**: ~$184
**Outcome**: If "Up" wins → Up shares worth $179, Down shares worth $0 = **LOSS**

### Why This is Dangerous

From their actual positions:
- **Position 1**: -$927 loss (-99.18%) on BTC market
- **Position 2**: -$619 loss (-99.31%) on ETH market
- **Position 3**: -$421 loss (-99.10%) on SOL market

**Problems**:
1. Requires **$3,000-5,000+ per market** to sustain averaging
2. Can lose almost 100% on one side
3. Running 5-10 markets simultaneously = **$15k-50k needed**
4. One bad run can wipe out weeks of gains

## Modified Strategy (Capital-Efficient)

### Key Differences for Small Accounts

**DO NOT** copy the original strategy directly. Instead:

1. **Capital Limits**: Max $5-10 per market (not $500-1000)
2. **No Aggressive Averaging**: Max 2 additional buys, not unlimited
3. **Strict Stop Loss**: Exit at -30% total position loss
4. **Market Selection**: Only trade when spread > 5%
5. **Position Limits**: Max 1-2 markets open simultaneously

### When to Enter

Look for markets where:
- `Up Price + Down Price > 1.05` (inefficiency exists)
- Market has at least 30 minutes until resolution
- Combined liquidity > $10,000

### Position Sizing for $90 Bankroll

**Conservative Approach**:
```
Initial Position: $8 per market ($4 Up + $4 Down)
Max Averaging: $3 additional (total $11 per market)
Max Markets: 1 at a time
Reserve: $79 kept safe
Risk per Trade: Max $11 (12% of bankroll)
```

**Aggressive Approach** (NOT RECOMMENDED):
```
Initial Position: $15 per market
Max Averaging: $10 additional (total $25)
Max Markets: 2 at a time
Risk: $50 (56% of bankroll)
```

### Expected Returns

**Realistic Expectations**:
- Win Rate: 40-50% of markets
- Avg Win: +10-20% when price inefficiency corrects
- Avg Loss: -20-30% when stopped out or market resolves wrong
- Net Expected: +2-5% per winning market after losses

**Example with $90 Bankroll**:
- Trade 10 markets at $8 each over a week
- Win 5, lose 5
- Wins: 5 × $1.50 = +$7.50
- Losses: 5 × -$2.00 = -$10.00
- **Net: -$2.50 (-2.8%)**

This shows why the strategy is marginal even when executed well!

## Configuration

To run this strategy safely with limited capital:

```yaml
# two-sided-range-config.yml
strategy:
  type: two-sided-range

  # Capital management
  maxCapitalPerMarket: 8      # $8 max per market
  maxTotalCapital: 16         # $16 total across all markets
  reserveCapital: 70          # Keep $70 in reserve

  # Entry criteria
  targetSpreadPct: 0.05       # Only enter if Up+Down price > 1.05 or < 0.95
  minLiquidity: 10000         # Market must have $10k+ liquidity
  minTimeToResolution: 1800   # 30 minutes minimum

  # Risk management
  maxAverageDowns: 2          # Max 2 additional buys (3 total)
  stopLossPct: 0.30           # Exit at -30% total position
  maxHoldTime: 14400          # Exit after 4 hours max

  # Position limits
  maxPositions: 1             # Only 1 market at a time

  cryptos:
    - BTC
    - ETH
    - SOL
```

## Implementation Notes

**CRITICAL**: This strategy is NOT recommended for your $90 bankroll because:

1. **Insufficient Capital**: Need at least $500-1000 to withstand variance
2. **Low Win Rate**: Even skilled traders struggle to beat 50% win rate
3. **Transaction Costs**: Polymarket fees + gas eat into small profits
4. **Time Intensive**: Requires constant monitoring (every 5-10 minutes)
5. **Emotional Toll**: Watching positions go -90% while averaging is stressful

## Better Alternatives for Small Capital

Instead of this strategy, consider:

1. **Copy Trading**: Follow 1-2 proven traders with smaller position sizes (your current bot)
2. **Single-Sided Bets**: Take directional bets on markets you understand well
3. **Long-Term Markets**: Trade markets that resolve in weeks/months (less volatility)
4. **Arbitrage**: Look for obvious mispricings rather than market making

## Conclusion

The "distinct-baguette" strategy works ONLY with:
- Large capital ($10k+)
- High risk tolerance (can lose $1000+ per day)
- Sophisticated risk management
- Automated execution (can't do manually)

For your situation with ~$90, this strategy will likely:
- Deplete your bankroll in 1-2 bad trades
- Create high stress with multiple losing positions
- Require too much time monitoring

**Recommendation**: Stick with your copy trading bot, optimize it further, and wait until you have $500-1000 before attempting two-sided strategies.
