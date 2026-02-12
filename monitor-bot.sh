#!/bin/bash

# Copy Trading Bot Monitor
# Displays real-time status, recent activity, and health metrics

set -e

BOT_NAME="polymarket-copytrader"
LOG_FILE="./logs/pm2-combined.log"
ERROR_LOG="./logs/pm2-error.log"

echo "=================================================="
echo "  COPY TRADING BOT MONITOR"
echo "=================================================="
echo ""

# Check if PM2 is installed
if ! command -v pm2 &> /dev/null; then
    echo "❌ ERROR: PM2 is not installed"
    echo "Install with: npm install -g pm2"
    exit 1
fi

# Check PM2 status
echo "📊 PM2 Status:"
echo "-----------------------------------"
pm2 list | grep -E "($BOT_NAME|name)" || echo "Bot not found in PM2"
echo ""

# Check process details
echo "📋 Process Details:"
echo "-----------------------------------"
pm2 info $BOT_NAME 2>/dev/null || echo "Bot is not running"
echo ""

# Memory and CPU usage
echo "💻 Resource Usage:"
echo "-----------------------------------"
if pm2 list | grep -q $BOT_NAME; then
    pm2 describe $BOT_NAME | grep -E "(memory|cpu)" || true
fi
echo ""

# Check last 10 log entries
echo "📝 Recent Activity (last 10 entries):"
echo "-----------------------------------"
if [ -f "$LOG_FILE" ]; then
    tail -n 10 "$LOG_FILE"
else
    echo "Log file not found: $LOG_FILE"
fi
echo ""

# Check for recent errors
echo "⚠️  Recent Errors (last 5):"
echo "-----------------------------------"
if [ -f "$ERROR_LOG" ]; then
    ERROR_COUNT=$(wc -l < "$ERROR_LOG" 2>/dev/null || echo "0")
    if [ "$ERROR_COUNT" -gt 0 ]; then
        echo "Total errors in log: $ERROR_COUNT"
        tail -n 5 "$ERROR_LOG"
    else
        echo "✅ No errors found"
    fi
else
    echo "Error log not found: $ERROR_LOG"
fi
echo ""

# Check database connectivity (if probe script exists)
echo "🗄️  Database Connectivity:"
echo "-----------------------------------"
if [ -f "dist/probe.js" ]; then
    timeout 5 node dist/probe.js 2>&1 | head -n 3 || echo "❌ Database check failed"
else
    echo "⚠️  Probe script not built. Run: npm run build"
fi
echo ""

# Check recent signals (requires database access)
echo "🎯 Recent Copy Signals (if database is accessible):"
echo "-----------------------------------"
echo "Run this SQL query in Supabase to view recent signals:"
echo "SELECT trader, market, side, notional_usdc, executed_at"
echo "FROM executed_signals"
echo "ORDER BY executed_at DESC"
echo "LIMIT 5;"
echo ""

# Check for stuck positions
echo "📈 Open Positions Check:"
echo "-----------------------------------"
echo "Run this SQL query in Supabase to view open positions:"
echo "SELECT market_key, asset_id, notional_usdc, shares, entry_price, opened_at"
echo "FROM open_positions"
echo "WHERE shares > 0;"
echo ""

# Health status summary
echo "=================================================="
echo "  HEALTH STATUS SUMMARY"
echo "=================================================="

BOT_RUNNING=$(pm2 list | grep -q $BOT_NAME && echo "true" || echo "false")
if [ "$BOT_RUNNING" = "true" ]; then
    BOT_STATUS=$(pm2 list | grep $BOT_NAME | awk '{print $10}')
    if [ "$BOT_STATUS" = "online" ]; then
        echo "✅ Bot Status: RUNNING"
    else
        echo "⚠️  Bot Status: $BOT_STATUS"
    fi

    # Check uptime
    UPTIME=$(pm2 list | grep $BOT_NAME | awk '{print $12}')
    echo "⏱️  Uptime: $UPTIME"

    # Check restart count
    RESTARTS=$(pm2 list | grep $BOT_NAME | awk '{print $8}')
    if [ "$RESTARTS" -gt 5 ]; then
        echo "⚠️  Restarts: $RESTARTS (High - investigate!)"
    else
        echo "✅ Restarts: $RESTARTS"
    fi
else
    echo "❌ Bot Status: NOT RUNNING"
    echo ""
    echo "Start the bot with: pm2 start ecosystem.config.cjs"
fi

echo ""
echo "=================================================="
echo "  Quick Actions:"
echo "=================================================="
echo "View logs:       pm2 logs $BOT_NAME"
echo "Restart bot:     pm2 restart $BOT_NAME"
echo "Stop bot:        pm2 stop $BOT_NAME"
echo "Check DB:        npm run probe"
echo "Full report:     ./health-check.sh"
echo ""
