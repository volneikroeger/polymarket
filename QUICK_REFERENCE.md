# Copy Trading Bot - Quick Reference

## 🚀 Quick Start

```bash
./start-copy-trading.sh
```

## 🛑 Emergency Stop

```bash
./stop-copy-trading.sh
```

## 📊 Monitoring Commands

### Check Bot Status
```bash
pm2 status polymarket-copytrader
```

### View Live Logs
```bash
pm2 logs polymarket-copytrader
```

### View Last 50 Log Lines
```bash
pm2 logs polymarket-copytrader --lines 50
```

### Monitor Dashboard
```bash
pm2 monit
```

### Custom Monitor Script
```bash
./monitor-bot.sh
```

### Health Check
```bash
./health-check.sh
```

## 🔧 Management Commands

### Restart Bot
```bash
pm2 restart polymarket-copytrader
```

### Stop Bot
```bash
pm2 stop polymarket-copytrader
```

### Start Bot
```bash
pm2 start polymarket-copytrader
```

### Delete Bot from PM2
```bash
pm2 delete polymarket-copytrader
```

### Save PM2 Configuration
```bash
pm2 save
```

## 📈 Trading Commands

### View PnL Report
```bash
npm run pnl-report
```

### Flatten All Positions
```bash
npm run flatten
```

### Run Discovery
```bash
npm run discover-traders
```

### Rank Traders
```bash
npm run rank-traders
```

## 🗄️ Database Queries

### View Recent Signals (Supabase)
```sql
SELECT
  trader,
  market,
  side,
  notional_usdc,
  price,
  executed_at
FROM executed_signals
ORDER BY executed_at DESC
LIMIT 10;
```

### View Open Positions
```sql
SELECT
  market_key,
  asset_id,
  outcome,
  notional_usdc,
  shares,
  entry_price,
  opened_at
FROM open_positions
WHERE shares > 0;
```

### View Daily Limits
```sql
SELECT
  day_key,
  notional_usdc,
  realized_pnl_usdc,
  trades_count,
  updated_at
FROM daily_limits
ORDER BY day_key DESC
LIMIT 7;
```

### Check Discovered Traders
```sql
SELECT
  wallet,
  win_rate,
  roi,
  total_trades,
  rank_score,
  is_recommended,
  last_analyzed
FROM discovered_traders
WHERE is_recommended = true
ORDER BY rank_score DESC;
```

## 🔍 Debugging

### Check Build
```bash
npm run build
```

### Test Database Connection
```bash
npm run probe
```

### Check Process Details
```bash
pm2 describe polymarket-copytrader
```

### View Error Logs Only
```bash
tail -f logs/pm2-error.log
```

### View Combined Logs
```bash
tail -f logs/pm2-combined.log
```

## ⚙️ Configuration Files

### Main Bot Config
```bash
high-confidence-config.yml
```

### Environment Variables
```bash
.env
```

### PM2 Config
```bash
ecosystem.config.cjs
```

### Edit Configuration
```bash
nano high-confidence-config.yml
# After editing, restart:
pm2 restart polymarket-copytrader
```

## 📊 Current Configuration

### Traders Being Copied (4)
1. `0xa3e9a711841e655def080044768452b60f4263d0` - 91.5% WR
2. `0x095dcfb123a4bc035ee6b0d624bab0cc964352cf` - 77% WR
3. `0x6d3c5bd13984b2de47c3a88ddc455309aab3d294` - 76% WR
4. `0x0c0e270cf879583d6a0142fc817e05b768d0434e` - 92% WR

### Risk Parameters
- Max per trade: **$5 USDC**
- Max active positions: **5**
- Stop loss: **20%**
- Partial stop: **15%** (exits 50%)
- Take profit: **10%**
- Trailing stop: **5%**
- Max daily loss: **$50**
- Max daily volume: **$100**
- Poll interval: **30 seconds**

### Execution Settings
- Paper trading: **DISABLED** ⚠️
- Marketable orders: **NO** (limit orders)
- Max price move: **0.05** (5%)

## 🚨 Troubleshooting

### Bot Not Starting
```bash
# Check logs
pm2 logs polymarket-copytrader --err

# Verify environment
cat .env | grep -v "PRIVATE_KEY"

# Test database
npm run probe
```

### No Trades Detected
```bash
# Check trader activity manually
curl "https://data-api.polymarket.com/activity?user=0xa3e9a711841e655def080044768452b60f4263d0&limit=5"

# Review logs for detection
pm2 logs polymarket-copytrader | grep "detected"
```

### Orders Failing
```bash
# Check wallet balance
# Review risk limits
pm2 logs polymarket-copytrader --err | grep "order"
```

### High Restart Count
```bash
# Check memory usage
pm2 describe polymarket-copytrader | grep memory

# Review error logs
tail -50 logs/pm2-error.log
```

## 📞 Emergency Procedures

### Immediate Stop
```bash
pm2 stop polymarket-copytrader
```

### Flatten Positions
```bash
npm run flatten
```

### Review Last Trades
```bash
pm2 logs polymarket-copytrader --lines 100 | grep "signal"
```

### Disable Auto-Restart (if needed)
```bash
pm2 stop polymarket-copytrader
pm2 delete polymarket-copytrader
```

## 📚 Documentation

- **Full Deployment Guide**: `COPY_TRADING_DEPLOYMENT.md`
- **Main README**: `README.md`
- **Trader Analysis**: `docs/RECOMMENDED_TRADERS.md`
- **Strategy Details**: `docs/STRATEGIES.md`

## 🔐 Security Reminders

- ✅ Never commit `.env` file
- ✅ Never share private keys
- ✅ Monitor wallet balance regularly
- ✅ Review trades daily
- ✅ Keep system updated
- ✅ Use secure server with firewall

## 📞 Support Checklist

When reporting issues, provide:

1. PM2 status: `pm2 status`
2. Last 50 logs: `pm2 logs --lines 50`
3. Error logs: `cat logs/pm2-error.log | tail -50`
4. Bot uptime and restart count
5. Recent database activity
6. Configuration file (without private keys)

---

**Quick Start**: `./start-copy-trading.sh`
**Emergency Stop**: `./stop-copy-trading.sh`
**Monitor**: `./monitor-bot.sh`
**Logs**: `pm2 logs polymarket-copytrader`
