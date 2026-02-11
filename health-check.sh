#!/bin/bash

echo "=== Polymarket Bot Health Check ==="
echo ""

# Check if service is running
echo "[1/4] Checking service status..."
if systemctl is-active --quiet polymarket-bot; then
    echo "  ✓ Service is running"
    SERVICE_STATUS=0
else
    echo "  ✗ Service is NOT running"
    SERVICE_STATUS=1
fi

# Check memory usage
echo ""
echo "[2/4] Checking memory usage..."
PID=$(systemctl show -p MainPID --value polymarket-bot)
if [ "$PID" != "0" ] && [ -n "$PID" ]; then
    MEM_KB=$(ps -o rss= -p $PID)
    MEM_MB=$((MEM_KB / 1024))
    echo "  Memory usage: ${MEM_MB} MB"

    if [ $MEM_MB -gt 1000 ]; then
        echo "  ⚠ Warning: High memory usage (> 1GB)"
    else
        echo "  ✓ Memory usage normal"
    fi
else
    echo "  ✗ Cannot check memory - process not found"
fi

# Check recent logs for errors
echo ""
echo "[3/4] Checking recent logs for errors..."
ERROR_COUNT=$(journalctl -u polymarket-bot --since "5 minutes ago" --no-pager | grep -i "error" | wc -l)
if [ $ERROR_COUNT -eq 0 ]; then
    echo "  ✓ No errors in last 5 minutes"
else
    echo "  ⚠ Found $ERROR_COUNT error(s) in last 5 minutes"
    echo ""
    echo "Recent errors:"
    journalctl -u polymarket-bot --since "5 minutes ago" --no-pager | grep -i "error" | tail -n 5
fi

# Check uptime
echo ""
echo "[4/4] Checking service uptime..."
UPTIME=$(systemctl show -p ActiveEnterTimestamp --value polymarket-bot)
if [ -n "$UPTIME" ]; then
    echo "  Service started: $UPTIME"
else
    echo "  ✗ Cannot determine uptime"
fi

echo ""
echo "=== Summary ==="
if [ $SERVICE_STATUS -eq 0 ]; then
    echo "Status: HEALTHY"
    exit 0
else
    echo "Status: UNHEALTHY"
    exit 1
fi
