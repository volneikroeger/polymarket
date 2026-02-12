# Bot Restart Instructions

## Configuration Changes Applied

The following parameters were adjusted to enable order execution:

| Parameter | Old Value | New Value | Impact |
|-----------|-----------|-----------|--------|
| MAX_SPREAD_ABS | 0.01 | 0.05 | Allows wider spreads |
| LOW_ROI_THRESHOLD_PERCENT | 10 | 0 | Disables ROI validation |
| COPY_RATIO | 0.001 | 0.01 | 10x larger positions |
| MAX_MY_USDC_PER_SIGNAL | 1 | 5 | Higher max per trade |
| maxUsdcPerTrade | 1 | 5 | Allows adjustments |

## How to Restart

### If using PM2:
```bash
pm2 restart copy-bot
```

### If running directly:
```bash
# Stop current process (Ctrl+C)
# Then restart:
npm run copy-traders
```

### If using systemd service:
```bash
sudo systemctl restart polymarket-bot
```

## What to Look For After Restart

### 1. Successful Order Execution
Look for logs like:
```
"msg":"Order created successfully"
"msg":"Position opened"
```

### 2. Wider Spread Acceptance
Previously rejected orders should now execute:
```
"spread":0.02  # Previously blocked at 0.01
```

### 3. Larger Position Sizes
Orders should be 10x larger:
```
"finalNotionalUsdc":10  # Previously 1
```

### 4. No ROI Validation Failures
No more:
```
"msg":"SKIPPING low ROI order: unable to fetch market metadata"
```

## Estimated Trading Activity

With 4 traders monitored:
- **Expected signals per hour**: 5-10
- **Expected executions per hour**: 2-5 (after filtering)
- **Estimated capital deployed per day**: $20-50
- **BUY orders only initially** (SELL requires open positions first)

## Capital Requirements

With new settings:
- Minimum balance: $50 USDC
- Recommended balance: $100-200 USDC
- Each position: $1-5 USDC
- Max simultaneous positions: 10

## Monitoring Commands

### Check bot status:
```bash
pm2 status copy-bot
pm2 logs copy-bot --lines 50
```

### Check recent database activity:
```sql
-- Recent executed signals
SELECT * FROM executed_signals
ORDER BY created_at DESC
LIMIT 10;

-- Open positions
SELECT * FROM open_positions
ORDER BY created_at DESC;
```

## Troubleshooting

### If still no orders execute:
1. Check ENABLE_TRADING=true in .env
2. Verify sufficient USDC balance
3. Check circuit breaker hasn't tripped
4. Verify traders are actively trading

### If orders too large:
Reduce COPY_RATIO in .env:
```env
COPY_RATIO=0.005  # Half the current size
```

### If execution quality poor:
Reduce spread tolerance:
```env
MAX_SPREAD_ABS=0.03  # Stricter than 0.05
```
