# Copy Trading Bot - Deployment Guide

## Overview

This guide covers deploying the Copy Trading Bot that monitors and replicates trades from 4 high-performance traders on Polymarket.

## Configured Traders

The bot copies trades from these 4 traders (configured in `high-confidence-config.yml`):

1. **0xa3e9a711841e655def080044768452b60f4263d0**
   - Win Rate: 91.5%
   - ROI: 20.13%
   - Performance: Excellent

2. **0x095dcfb123a4bc035ee6b0d624bab0cc964352cf**
   - Win Rate: 77%
   - ROI: 2.35%
   - Volume: $2M+

3. **0x6d3c5bd13984b2de47c3a88ddc455309aab3d294**
   - Win Rate: 76%
   - ROI: 0.17%
   - Performance: Consistent

4. **0x0c0e270cf879583d6a0142fc817e05b768d0434e**
   - Win Rate: 92%
   - ROI: 0.01%
   - Volume: $19M+

## Risk Parameters

Current configuration in `high-confidence-config.yml`:

- **Max USDC per Trade**: $5
- **Max Active Positions**: 5
- **Stop Loss**: 20% odds drop
- **Partial Stop**: 15% odds drop (exits 50%)
- **Take Profit**: 10% odds increase
- **Trailing Stop**: 5% from best price
- **Max Daily Loss**: $50
- **Max Daily Volume**: $100
- **Paper Trading**: DISABLED (live trading)
- **Poll Interval**: 30 seconds

## Prerequisites

### System Requirements
- Node.js 18+ installed
- PM2 installed globally: `npm install -g pm2`
- Sufficient USDC balance in trading wallet
- Stable internet connection

### Environment Variables

Ensure `.env` file contains:
```bash
PRIVATE_KEY=<your_wallet_private_key>
CLOB_HOST=https://clob.polymarket.com
CHAIN_ID=137
SIGNATURE_TYPE=1
FUNDER=<your_funder_address>
USE_SERVER_TIME=true

# Supabase (for trade tracking)
VITE_SUPABASE_URL=<your_supabase_url>
VITE_SUPABASE_ANON_KEY=<your_supabase_key>
```

## Deployment Steps

### 1. Install Dependencies

```bash
npm install
```

### 2. Build Project

```bash
npm run build
```

This compiles TypeScript to JavaScript in the `dist/` directory.

### 3. Create Logs Directory

```bash
mkdir -p logs
```

### 4. Verify Configuration

Review `high-confidence-config.yml` to ensure:
- All 4 traders are listed
- Risk parameters match your risk tolerance
- `execution.paper` is set to `false` for live trading

### 5. Start Bot with PM2

```bash
pm2 start ecosystem.config.cjs
```

This starts the bot as a background process managed by PM2.

### 6. Verify Bot is Running

```bash
pm2 status
```

You should see:
```
┌────┬─────────────────────────┬─────────┬─────────┬──────────┐
│ id │ name                    │ status  │ restart │ uptime   │
├────┼─────────────────────────┼─────────┼─────────┼──────────┤
│ 0  │ polymarket-copytrader   │ online  │ 0       │ 2s       │
└────┴─────────────────────────┴─────────┴─────────┴──────────┘
```

### 7. Monitor Logs in Real-Time

```bash
pm2 logs polymarket-copytrader
```

Expected log output:
```
Starting Trader Copy Bot
Configuration loaded - traders: 4
Executor initialized - paperMode: false, maxUsdcPerTrade: 5, maxActivePositions: 5
TraderPositionMirror starting (data-api activity)
Trader Copy Bot running - monitoring traders for position changes
```

### 8. Enable Auto-Start on Server Reboot

```bash
pm2 startup
pm2 save
```

Follow the instructions provided by `pm2 startup` to enable auto-start.

## Monitoring

### View Bot Status

```bash
pm2 status polymarket-copytrader
```

### View Real-Time Logs

```bash
pm2 logs polymarket-copytrader --lines 50
```

### View Log Files Directly

```bash
# Combined logs
tail -f logs/pm2-combined.log

# Error logs only
tail -f logs/pm2-error.log

# Output logs only
tail -f logs/pm2-out.log
```

### Check Database Activity

Query Supabase to see executed signals:

```sql
SELECT * FROM executed_signals ORDER BY created_at DESC LIMIT 10;
```

### Check Open Positions

```sql
SELECT * FROM open_positions WHERE shares > 0;
```

## Management Commands

### Stop Bot

```bash
pm2 stop polymarket-copytrader
```

### Restart Bot

```bash
pm2 restart polymarket-copytrader
```

### Delete Bot from PM2

```bash
pm2 delete polymarket-copytrader
```

### View Resource Usage

```bash
pm2 monit
```

## Troubleshooting

### Bot Not Starting

1. Check logs: `pm2 logs polymarket-copytrader --err`
2. Verify `.env` file has correct credentials
3. Ensure Supabase connection is working
4. Check wallet has USDC balance

### No Trades Detected

1. Verify traders are active: Check their activity on Polymarket
2. Check Data API connectivity: `curl https://data-api.polymarket.com/activity?user=0xa3e9a711841e655def080044768452b60f4263d0&limit=10`
3. Review filter settings in `high-confidence-config.yml`
4. Check logs for detection messages

### Orders Failing

1. Verify USDC balance is sufficient
2. Check wallet approval on Polymarket
3. Review risk limits (daily loss, daily volume)
4. Check network connectivity to Polymarket CLOB
5. Verify private key and funder address

### High Memory Usage

If bot exceeds 500MB (PM2 auto-restart threshold):

1. Check for memory leaks in logs
2. Restart bot: `pm2 restart polymarket-copytrader`
3. Consider reducing poll frequency
4. Monitor with: `pm2 monit`

### Database Connection Issues

1. Verify Supabase credentials in `.env`
2. Check RLS policies are configured correctly
3. Test connection: `npm run probe`

## Health Check Script

Use the included health check script:

```bash
./health-check.sh
```

This verifies:
- Bot process is running
- Database connection is working
- Recent activity is detected
- No critical errors in logs

## Performance Tuning

### Adjust Copy Ratio

Modify sizing in `.env`:

```bash
# Option 1: Direct ratio (copy 0.01% of detected trade)
COPY_RATIO=0.0001

# Option 2: Portfolio-based (auto-calculates ratio)
MY_PORTFOLIO_USDC=100
TRADER_PORTFOLIO_USDC=1000000
```

### Adjust Poll Interval

In `src/traderCopyBot.ts`, line 40:

```typescript
pollIntervalMs: 30_000, // 30 seconds (default)
```

Increase to 60_000 (1 minute) to reduce API calls.

### Adjust Risk Limits

Modify `high-confidence-config.yml`:

- Increase `maxUsdcPerTrade` for larger positions
- Increase `maxActivePositions` for more concurrent trades
- Adjust stop-loss thresholds based on volatility
- Modify daily limits based on capital

## Security Best Practices

1. **Never commit `.env` file** - contains private keys
2. **Use secure server** - ensure SSH access is properly configured
3. **Monitor wallet balance** - set up alerts for low balance
4. **Review trades regularly** - audit database for unexpected activity
5. **Rotate keys periodically** - generate new wallet keys if compromised
6. **Limit server access** - use firewall rules and IP whitelisting
7. **Backup database** - regular Supabase backups

## Support & Maintenance

### Regular Maintenance Tasks

- **Daily**: Check bot is running and executing trades
- **Weekly**: Review performance and adjust risk parameters
- **Monthly**: Analyze trader performance, consider updating trader list
- **Quarterly**: Review and optimize configuration

### Updating Trader List

To add/remove traders, edit `high-confidence-config.yml`:

```yaml
traders:
  - "0xNewTraderAddress1"
  - "0xNewTraderAddress2"
```

Then restart:
```bash
pm2 restart polymarket-copytrader
```

### Upgrading Code

```bash
# Stop bot
pm2 stop polymarket-copytrader

# Pull latest code
git pull

# Rebuild
npm install
npm run build

# Restart
pm2 restart polymarket-copytrader
```

## Emergency Shutdown

If you need to immediately stop all trading:

```bash
# Stop the bot
pm2 stop polymarket-copytrader

# Optional: Flatten all positions
npm run flatten
```

## Success Indicators

Your bot is working correctly when you see:

1. **Process Status**: `pm2 status` shows "online"
2. **Log Activity**: Regular detection messages every 30 seconds
3. **Database Records**: New entries in `executed_signals` table
4. **Position Tracking**: `open_positions` table reflects active trades
5. **No Errors**: Log files show info/warn level only, no errors

## Configuration Summary

```yaml
Scanner: Monitors 4 high-performance traders
Poll Interval: 30 seconds
Position Size: $5 USDC per trade
Max Positions: 5 concurrent
Risk Management: Stop-loss, trailing stop, take-profit
Daily Limits: $50 loss cap, $100 volume cap
Execution: Live trading (paper mode disabled)
Database: Supabase for tracking and deduplication
Process Manager: PM2 with auto-restart
Logs: ./logs/ directory with rotation
```

## Next Steps

After deployment:

1. Monitor for 24 hours to ensure stability
2. Review trade execution accuracy
3. Adjust risk parameters based on initial performance
4. Set up alerting for critical issues
5. Document any custom modifications

---

**Deployment Date**: [Fill in deployment date]
**Deployed By**: [Fill in deployer name]
**Server**: [Fill in server details]
**Wallet Address**: [Fill in wallet address (not private key!)]
