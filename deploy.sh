#!/bin/bash
set -e

echo "=== Polymarket Bot Deployment Script ==="
echo ""

# Get the directory where the script is located
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

# Step 1: Pull latest code
echo "[1/7] Pulling latest code from git..."
git pull origin main

# Step 2: Check .env file
echo "[2/7] Checking .env configuration..."
if [ ! -f .env ]; then
    echo "ERROR: .env file not found!"
    echo "Please create .env file with required variables:"
    echo "  - VITE_SUPABASE_URL"
    echo "  - VITE_SUPABASE_ANON_KEY"
    echo "  - POLYMARKET_* variables"
    exit 1
fi

# Verify .env has correct permissions
chmod 600 .env
echo "  ✓ .env permissions set to 600"

# Step 3: Install dependencies
echo "[3/7] Installing dependencies..."
npm install

# Step 4: Build TypeScript
echo "[4/7] Building TypeScript..."
npm run build

# Verify build was successful
if [ ! -f dist/index.js ]; then
    echo "ERROR: Build failed! dist/index.js not found"
    exit 1
fi
echo "  ✓ Build successful"

# Step 5: Install systemd service
echo "[5/7] Installing systemd service..."

# Update WorkingDirectory in service file to match current directory
sed "s|WorkingDirectory=.*|WorkingDirectory=$SCRIPT_DIR|g" polymarket-bot.service > /tmp/polymarket-bot.service

# Copy service file
cp /tmp/polymarket-bot.service /etc/systemd/system/polymarket-bot.service
chmod 644 /etc/systemd/system/polymarket-bot.service
echo "  ✓ Service file installed"

# Step 6: Enable and restart service
echo "[6/7] Enabling and starting service..."
systemctl daemon-reload
systemctl enable polymarket-bot
systemctl restart polymarket-bot
echo "  ✓ Service restarted"

# Step 7: Check status
echo "[7/7] Checking service status..."
sleep 2
systemctl status polymarket-bot --no-pager -l

echo ""
echo "=== Deployment Complete ==="
echo ""
echo "Useful commands:"
echo "  View logs:        journalctl -u polymarket-bot -f"
echo "  Check status:     systemctl status polymarket-bot"
echo "  Restart service:  systemctl restart polymarket-bot"
echo "  Stop service:     systemctl stop polymarket-bot"
echo ""
