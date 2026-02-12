# Copy Trading Bot Configuration Fixes

## Problem Analysis

The bot was detecting trade signals from monitored traders but not executing any orders due to 4 main blocking conditions:

### 1. Spread Too Wide (~40% of signals blocked)
- **Issue**: MAX_SPREAD_ABS was set to $0.01, but many markets had spreads of $0.02
- **Example**: Market with bestBid=0.45, bestAsk=0.47 (spread=0.02) was rejected

### 2. SELL Without Open Position (~30% of signals blocked)
- **Issue**: Bot tried to copy SELL orders but had no positions in those markets
- **Cause**: Bot started monitoring after traders already had open positions

### 3. Low ROI + Missing Market Metadata (~20% of signals blocked)
- **Issue**: Orders with ROI < 10% required additional validation
- **Problem**: API returned 422 errors when fetching market metadata

### 4. Shares Below Minimum (~10% of signals blocked)
- **Issue**: MIN_SHARES_PER_ORDER=5 but many orders generated only 1-2 shares
- **Cause**: COPY_RATIO too small (0.001) and MAX_USDC_PER_TRADE too low (1)

## Configuration Changes

### 1. Increased Spread Tolerance
```env
MAX_SPREAD_ABS=0.05  # Changed from 0.01 to 0.05
```
**Impact**: Allows trading in less liquid markets with wider spreads

### 2. Disabled Low ROI Validation
```env
LOW_ROI_THRESHOLD_PERCENT=0  # Changed from 10 to 0
```
**Impact**: Removes metadata validation for low ROI trades, allowing execution even when metadata API fails

### 3. Increased Copy Ratio (10x)
```env
COPY_RATIO=0.01  # Changed from 0.001 to 0.01
```
**Impact**: Generates 10x larger positions, ensuring orders meet minimum share requirements

### 4. Increased Maximum per Signal
```env
MAX_MY_USDC_PER_SIGNAL=5  # Changed from 1 to 5
```
**Impact**: Allows larger orders to meet minimum share requirements

### 5. Increased Maximum per Trade
```yaml
# high-confidence-config.yml
maxUsdcPerTrade: 5  # Changed from 1 to 5
```
**Impact**: Permits automatic notional adjustments to meet MIN_SHARES_PER_ORDER

## Expected Results

With these changes, the bot should now:

1. **Execute BUY orders** in markets that previously had spread rejections
2. **Skip SELL orders** gracefully (expected behavior until positions are established)
3. **Execute low ROI orders** without metadata validation failures
4. **Generate larger positions** that meet minimum share requirements

## Monitoring Recommendations

After restarting the bot, monitor for:

1. **Successful order execution** - Look for order creation logs
2. **Position tracking** - Verify positions are recorded in open_positions table
3. **Spread impact** - Check if wider spreads affect execution quality
4. **Position sizes** - Ensure orders are appropriately sized (not too large)

## Risk Considerations

### Increased Risk
- Wider spreads may result in worse execution prices
- Larger position sizes (10x) mean more capital per trade
- No low ROI validation means accepting thin-margin trades

### Risk Mitigation Still Active
- Circuit breaker: halts after 20 consecutive failures
- Daily loss limit: maxDailyLossUsdc still enforced
- Daily notional cap: maxDailyNotionalUsdc still enforced
- Stop-loss: COPY_STOP_LOSS_ABS=0.03 still active

## Reverting Changes

If you need to revert to more conservative settings:

```env
# More conservative settings
MAX_SPREAD_ABS=0.02
LOW_ROI_THRESHOLD_PERCENT=5
COPY_RATIO=0.005
MAX_MY_USDC_PER_SIGNAL=2
```

```yaml
maxUsdcPerTrade: 2
```

## Next Steps

1. **Restart the bot** to apply the new configuration
2. **Monitor logs** for successful order execution
3. **Check database** for recorded positions in `executed_signals` table
4. **Adjust gradually** if needed based on actual trading behavior
