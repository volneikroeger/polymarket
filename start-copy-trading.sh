#!/bin/bash

# Copy Trading Bot - Quick Start Script
# This script performs all necessary steps to deploy the bot

set -e

echo "=================================================="
echo "  COPY TRADING BOT - QUICK START"
echo "=================================================="
echo ""

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Step 1: Check prerequisites
echo "Step 1: Checking prerequisites..."
echo "-----------------------------------"

if ! command -v node &> /dev/null; then
    echo -e "${RED}❌ Node.js is not installed${NC}"
    exit 1
fi
echo -e "${GREEN}✅ Node.js installed:${NC} $(node --version)"

if ! command -v npm &> /dev/null; then
    echo -e "${RED}❌ npm is not installed${NC}"
    exit 1
fi
echo -e "${GREEN}✅ npm installed:${NC} $(npm --version)"

if ! command -v pm2 &> /dev/null; then
    echo -e "${YELLOW}⚠️  PM2 not installed. Installing globally...${NC}"
    npm install -g pm2
fi
echo -e "${GREEN}✅ PM2 installed:${NC} $(pm2 --version)"

echo ""

# Step 2: Check environment variables
echo "Step 2: Checking environment variables..."
echo "-----------------------------------"

if [ ! -f .env ]; then
    echo -e "${RED}❌ .env file not found${NC}"
    echo "Please create .env file with required variables"
    exit 1
fi
echo -e "${GREEN}✅ .env file found${NC}"

# Check critical env vars
if ! grep -q "PRIVATE_KEY=" .env; then
    echo -e "${RED}❌ PRIVATE_KEY not set in .env${NC}"
    exit 1
fi
echo -e "${GREEN}✅ PRIVATE_KEY configured${NC}"

if ! grep -q "VITE_SUPABASE_URL=" .env; then
    echo -e "${RED}❌ VITE_SUPABASE_URL not set in .env${NC}"
    exit 1
fi
echo -e "${GREEN}✅ VITE_SUPABASE_URL configured${NC}"

echo ""

# Step 3: Check configuration
echo "Step 3: Checking configuration..."
echo "-----------------------------------"

if [ ! -f high-confidence-config.yml ]; then
    echo -e "${RED}❌ high-confidence-config.yml not found${NC}"
    exit 1
fi
echo -e "${GREEN}✅ high-confidence-config.yml found${NC}"

# Count configured traders
TRADER_COUNT=$(grep -c "0x" high-confidence-config.yml | tail -1)
echo -e "${GREEN}✅ Configured traders: $TRADER_COUNT${NC}"

echo ""

# Step 4: Install dependencies
echo "Step 4: Installing dependencies..."
echo "-----------------------------------"
npm install
echo -e "${GREEN}✅ Dependencies installed${NC}"
echo ""

# Step 5: Build project
echo "Step 5: Building project..."
echo "-----------------------------------"
npm run build
echo -e "${GREEN}✅ Project built successfully${NC}"
echo ""

# Step 6: Create logs directory
echo "Step 6: Creating logs directory..."
echo "-----------------------------------"
mkdir -p logs
echo -e "${GREEN}✅ Logs directory ready${NC}"
echo ""

# Step 7: Stop any existing instance
echo "Step 7: Checking for existing bot instance..."
echo "-----------------------------------"
if pm2 list | grep -q "polymarket-copytrader"; then
    echo -e "${YELLOW}⚠️  Existing instance found. Stopping...${NC}"
    pm2 stop polymarket-copytrader
    pm2 delete polymarket-copytrader
    echo -e "${GREEN}✅ Existing instance stopped${NC}"
else
    echo -e "${GREEN}✅ No existing instance found${NC}"
fi
echo ""

# Step 8: Start bot
echo "Step 8: Starting Copy Trading Bot..."
echo "-----------------------------------"
pm2 start ecosystem.config.cjs
echo -e "${GREEN}✅ Bot started successfully${NC}"
echo ""

# Step 9: Configure auto-start
echo "Step 9: Configuring auto-start on reboot..."
echo "-----------------------------------"
pm2 save
echo -e "${GREEN}✅ Configuration saved${NC}"
echo ""
echo -e "${YELLOW}⚠️  Run the following command to enable auto-start:${NC}"
pm2 startup
echo ""

# Step 10: Verify bot is running
echo "Step 10: Verifying bot status..."
echo "-----------------------------------"
sleep 2
pm2 status polymarket-copytrader
echo ""

# Final summary
echo "=================================================="
echo "  DEPLOYMENT COMPLETE!"
echo "=================================================="
echo ""
echo -e "${GREEN}✅ Copy Trading Bot is now running${NC}"
echo ""
echo "Next steps:"
echo "  1. Monitor logs:     pm2 logs polymarket-copytrader"
echo "  2. Check status:     ./monitor-bot.sh"
echo "  3. View dashboard:   pm2 monit"
echo ""
echo "Configured Traders:"
grep -A 1 "0x" high-confidence-config.yml | grep "0x" | sed 's/^[ \t-]*/  - /'
echo ""
echo "Risk Settings:"
echo "  - Max per trade: \$5 USDC"
echo "  - Max positions: 5"
echo "  - Stop loss: 20%"
echo "  - Daily loss cap: \$50"
echo "  - Paper trading: DISABLED (LIVE TRADING)"
echo ""
echo -e "${YELLOW}⚠️  IMPORTANT: Monitor the bot closely for the first 24 hours${NC}"
echo ""
echo "For detailed documentation, see: COPY_TRADING_DEPLOYMENT.md"
echo ""
