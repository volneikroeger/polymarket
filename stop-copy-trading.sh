#!/bin/bash

# Copy Trading Bot - Emergency Stop Script
# Use this to immediately stop the bot

set -e

BOT_NAME="polymarket-copytrader"

echo "=================================================="
echo "  EMERGENCY STOP - COPY TRADING BOT"
echo "=================================================="
echo ""

# Check if PM2 is installed
if ! command -v pm2 &> /dev/null; then
    echo "❌ ERROR: PM2 is not installed"
    exit 1
fi

# Check if bot is running
if ! pm2 list | grep -q $BOT_NAME; then
    echo "ℹ️  Bot is not running"
    exit 0
fi

echo "Stopping Copy Trading Bot..."
echo ""

# Stop the bot
pm2 stop $BOT_NAME

echo "✅ Bot stopped successfully"
echo ""

# Show status
pm2 status $BOT_NAME

echo ""
echo "=================================================="
echo "  Bot Status: STOPPED"
echo "=================================================="
echo ""
echo "The bot has been stopped and will NOT trade."
echo ""
echo "Options:"
echo "  1. Review logs:       pm2 logs $BOT_NAME --lines 50"
echo "  2. Restart bot:       pm2 restart $BOT_NAME"
echo "  3. Start fresh:       ./start-copy-trading.sh"
echo "  4. Remove from PM2:   pm2 delete $BOT_NAME"
echo ""
echo "To flatten all open positions:"
echo "  npm run flatten"
echo ""
