#!/bin/bash

# Copy Trading Bot Health Check (PM2 Version)

BOT_NAME="polymarket-copytrader"
ERROR_LOG="./logs/pm2-error.log"

echo "=== Copy Trading Bot Health Check ==="
echo ""

# Check if PM2 is installed
if ! command -v pm2 &> /dev/null; then
    echo "✗ PM2 is not installed"
    exit 1
fi

# Check if service is running
echo "[1/6] Checking service status..."
if pm2 list | grep -q "$BOT_NAME.*online"; then
    echo "  ✓ Service is running"
    SERVICE_STATUS=0
else
    echo "  ✗ Service is NOT running"
    SERVICE_STATUS=1
fi

# Check memory usage
echo ""
echo "[2/6] Checking memory usage..."
if [ $SERVICE_STATUS -eq 0 ]; then
    MEM_MB=$(pm2 list | grep $BOT_NAME | awk '{print $11}' | sed 's/mb//')
    if [ -n "$MEM_MB" ]; then
        echo "  Memory usage: ${MEM_MB} MB"
        if [ "$MEM_MB" -gt 400 ]; then
            echo "  ⚠ Warning: High memory usage (> 400MB, will restart at 500MB)"
        else
            echo "  ✓ Memory usage normal"
        fi
    else
        echo "  ✗ Cannot check memory"
    fi
else
    echo "  ✗ Cannot check memory - process not found"
fi

# Check restart count
echo ""
echo "[3/6] Checking restart count..."
if [ $SERVICE_STATUS -eq 0 ]; then
    RESTARTS=$(pm2 list | grep $BOT_NAME | awk '{print $8}')
    echo "  Restarts: $RESTARTS"
    if [ "$RESTARTS" -gt 5 ]; then
        echo "  ⚠ Warning: High restart count (> 5)"
    else
        echo "  ✓ Restart count normal"
    fi
fi

# Check recent logs for errors
echo ""
echo "[4/6] Checking recent logs for errors..."
if [ -f "$ERROR_LOG" ]; then
    ERROR_COUNT=$(tail -100 "$ERROR_LOG" | grep -i "error" | wc -l)
    if [ $ERROR_COUNT -eq 0 ]; then
        echo "  ✓ No errors in last 100 log lines"
    else
        echo "  ⚠ Found $ERROR_COUNT error(s) in last 100 lines"
        echo ""
        echo "Recent errors:"
        tail -100 "$ERROR_LOG" | grep -i "error" | tail -n 3
    fi
else
    echo "  ✓ No error log found (good sign)"
fi

# Check uptime
echo ""
echo "[5/6] Checking service uptime..."
if [ $SERVICE_STATUS -eq 0 ]; then
    UPTIME=$(pm2 list | grep $BOT_NAME | awk '{print $12}')
    echo "  Uptime: $UPTIME"

    # Parse uptime to check if it's too short (frequent restarts)
    if [[ "$UPTIME" =~ ^[0-9]+s$ ]]; then
        SECONDS=$(echo $UPTIME | sed 's/s//')
        if [ "$SECONDS" -lt 60 ]; then
            echo "  ⚠ Warning: Recently restarted (< 1 minute)"
        fi
    fi
else
    echo "  ✗ Cannot determine uptime"
fi

# Check database connectivity (if probe exists)
echo ""
echo "[6/6] Checking database connectivity..."
if [ -f "dist/probe.js" ]; then
    if timeout 5 node dist/probe.js > /dev/null 2>&1; then
        echo "  ✓ Database connection OK"
    else
        echo "  ✗ Database connection failed"
    fi
else
    echo "  ⚠ Probe script not built (run: npm run build)"
fi

echo ""
echo "=== Summary ==="
if [ $SERVICE_STATUS -eq 0 ]; then
    echo "Status: HEALTHY ✓"
    echo ""
    echo "Quick commands:"
    echo "  - View logs:    pm2 logs $BOT_NAME"
    echo "  - Restart:      pm2 restart $BOT_NAME"
    echo "  - Monitor:      ./monitor-bot.sh"
    exit 0
else
    echo "Status: UNHEALTHY ✗"
    echo ""
    echo "Action required:"
    echo "  - Start bot:    ./start-copy-trading.sh"
    echo "  - Check logs:   pm2 logs $BOT_NAME --err"
    exit 1
fi
