# How to Find Profitable Traders to Copy

## RN1 Clarification

You're right to question my analysis! The $4M you saw is likely:
- **Total trading volume** (all-time) - not profit
- Or **unrealized gains** if some positions resolved favorably

The key issue with RN1:
- Has made 999 BUY trades but only 1 SELL
- Holds positions to binary resolution ($1.00 or $0.00)
- Current open positions show -$1.4M unrealized losses
- May have had wins in the past, but current strategy is risky

## How to Find Good Traders

### Method 1: Use Polymarket's Built-in Tools

**Polymarket Profile Pages**:
1. Go to https://polymarket.com
2. Click on any market
3. Look at the "Order Book" or recent trades
4. Click on trader usernames to see their profiles
5. Look for:
   - Net profit > $10,000
   - Win rate > 55%
   - 100+ closed positions
   - Active in markets you understand

### Method 2: Analyze Via API

```bash
# Get trades from a popular market
curl "https://data-api.polymarket.com/trades?conditionId=MARKET_ID&limit=200"

# Find wallets with frequent activity
# Then check each wallet's positions:
curl "https://data-api.polymarket.com/positions?user=WALLET_ADDRESS"
```

**What to Look For**:
```json
{
  "cashPnl": 15234.56,        // Positive = winning
  "percentPnl": 45.2,          // Return percentage
  "realizedPnl": 12500.00,     // Already closed profit
  "totalBought": 50000.00      // Total invested
}
```

### Method 3: Look for Specific Patterns

## Characteristics of Profitable Traders

### ✅ Good Signs:

1. **Win Rate: 55-70%**
   - Sports: 55-60% is excellent
   - Crypto: 60-70% is very good
   - Politics: 65-75% can be achieved

2. **Position Sizing**
   - Consistent sizes ($100-5000)
   - Not all-in on every trade
   - Scales up winners, cuts losers

3. **Market Selection**
   - Trades 50+ different markets
   - Diversifies across categories
   - Focuses on markets they understand

4. **Exit Strategy**
   - Closes positions before resolution (takes profits)
   - Ratio of BUY to SELL should be near 1:1
   - Doesn't hold losing positions forever

5. **Risk Management**
   - No single position > 20% of portfolio
   - Stops trading after big losses
   - Doesn't chase losses with bigger bets

### ❌ Red Flags (Like RN1):

1. **Win Rate < 40%**
   - Math doesn't work long-term
   - Need 50%+ to break even with fees

2. **Position Sizing Issues**
   - Huge positions ($20k-60k)
   - All-in mentality
   - Martingale/doubling down

3. **Poor Market Selection**
   - Only trades underdogs
   - Only one category (sports gambling)
   - Chases extreme longshots

4. **No Exit Strategy**
   - Never sells
   - Holds everything to resolution
   - 999 buys : 1 sell ratio

5. **No Risk Management**
   - Ignores losses
   - Keeps trading after -$50k days
   - No position limits

## Recommended Trader Types

### For $90 Bankroll:

**Type 1: Conservative Sports Traders**
- Win rate: 60-65%
- Avg position: $500-2000
- Markets: Mainstream sports (NFL, NBA, Soccer)
- Your copy size: $2-5 per trade
- Expected: +3-7% monthly

**Type 2: Crypto Range Traders** (Be Careful)
- Win rate: 55-60%
- Avg position: $100-500
- Markets: BTC/ETH 15-min ranges
- Your copy size: $1-3 per trade
- Expected: +5-10% monthly (high variance)

**Type 3: Political Event Traders**
- Win rate: 65-70%
- Avg position: $1000-5000
- Markets: Elections, policy outcomes
- Your copy size: $3-8 per trade
- Expected: +4-8% monthly

## Example Search Process

### Step 1: Find Active Markets

```bash
# Check what's currently popular
curl "https://data-api.polymarket.com/markets" | grep -i "volume"
```

### Step 2: Get Recent Traders

```bash
# Get traders from high-volume market
curl "https://data-api.polymarket.com/trades?slug=MARKET_SLUG&limit=100"
```

### Step 3: Analyze Each Trader

```bash
# Check wallet's full history
WALLET="0xABCDEF..."
curl "https://data-api.polymarket.com/positions?user=$WALLET"

# Calculate:
# - Total P&L
# - Win rate
# - Average position size
# - Market diversity
```

### Step 4: Verify on Polymarket UI

Go to: `https://polymarket.com/@username`

Check:
- Volume traded (should be $50k-500k)
- Biggest win (reasonable size)
- Predictions (should be 50-200+)
- Profile consistency

## Sample Good Traders (Hypothetical)

Since I can't access live leaderboards, here's what to look for:

**Trader Profile Example**:
```
Name: "Consistent-Carl"
Wallet: 0xABC123...
Volume Traded: $250,000
Net P&L: +$18,500 (7.4% ROI)
Win Rate: 62%
Markets: 145 different markets
Avg Position: $1,500
Categories: Sports (60%), Crypto (30%), Politics (10%)

Why Good:
- Positive ROI over large sample
- Reasonable win rate
- Diversified
- Position sizing makes sense
```

**vs Bad Trader (Like RN1)**:
```
Name: "RN1"
Wallet: 0x2005d1...
Volume Traded: $4,000,000 (misleading - includes losses)
Net P&L: -$1,387,830 (or uncertain)
Win Rate: 2% on open positions
Markets: 265 different markets
Avg Position: $40,000 (way too big)
Categories: Sports (95%), Esports (5%)

Why Bad:
- Massive unrealized losses
- Extremely low win rate
- Position sizes are reckless
- Betting on extreme underdogs
- No sell discipline (999:1 buy:sell ratio)
```

## Creating Your Watchlist

### Step 1: Find 5-10 Candidate Traders

Start with markets you understand:
- If you know soccer → Find soccer traders
- If you know crypto → Find crypto traders
- If you know US politics → Find political traders

### Step 2: Paper Trade for 2 Weeks

Add them to your config in **paper mode**:

```yaml
traders:
  - "0xCANDIDATE1"
  - "0xCANDIDATE2"
  - "0xCANDIDATE3"

runtime:
  paper: true  # VERY IMPORTANT
```

Watch their trades without risking money.

### Step 3: Calculate Paper Performance

After 2 weeks:
```bash
# Check how you would have done
npm run pnl-report
```

### Step 4: Go Live With Winners

Only copy traders who:
- Made profit in paper trading
- Had win rate > 50%
- Position sizes you can afford (your $90 can copy $5k positions at 2% = $2.50/trade)

## Tools to Help

### 1. Trader Scanner Script

```bash
# Run this to scan for active profitable traders
npm run scan-traders  # (you'd need to create this)
```

### 2. Paper Trading Mode

```bash
# Always paper trade first!
CONFIG_PATH=config-test.yml npm run dev
```

### 3. PnL Reports

```bash
# Check your performance
npm run pnl-report
```

## Red Flags When Paper Trading

Even if a trader looked good initially, STOP copying if:

1. **3 consecutive losses** in your paper trading
2. **Position size suddenly increases 5x+**
3. **Switches to completely different markets** (soccer → crypto)
4. **Win rate drops below 45%** in your sample
5. **Makes trades you don't understand at all**

## Recommended Starting Configuration

```yaml
traders:
  - "WALLET_1"  # Main trader (60% confident)
  - "WALLET_2"  # Secondary trader (50% confident)

copy:
  fixedUsdcPerTrade: 3  # $3 per trade

risk:
  maxUsdcPerTrade: 5         # Never more than $5
  maxOpenUsdcPerMarket: 8    # Max $8 in one market
  maxDailyLossUsdc: 10       # Stop after -$10/day
  maxActiveMarkets: 5        # Max 5 open positions
  maxDailyNotionalUsdc: 30   # Max $30 traded per day

runtime:
  paper: true  # Start in paper mode!
  pollIntervalMs: 2000
```

## Next Steps

1. **Enable paper mode** and test RN1 vs other traders
2. **Monitor for 1 week** minimum
3. **Compare results** using PnL reports
4. **Go live** only with proven winners
5. **Start with $20-30** of your $90, keep rest in reserve

Would you like me to help set up a paper trading configuration to test multiple traders simultaneously?
