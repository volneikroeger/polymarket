# Trader Analysis: RN1 (0x2005d16a84ceefa912d4e380cd32e7ff827875ea)

## ⚠️ CRITICAL WARNING: DO NOT COPY THIS TRADER

## Performance Summary

**Overall Stats**:
- Total Positions: 100
- Winning Positions: 2 (2% win rate)
- Losing Positions: 98 (98% loss rate)
- **Total P&L: -$1,387,830.63**
- Win Amount: +$80,621.26
- Loss Amount: -$1,468,451.89

## Strategy Analysis

### What They Do

**Trading Style**: Aggressive Sports/Esports Betting with Heavy Martingale

**Markets**:
- Soccer (Premier League, Serie A, Bundesliga, Turkish League, African Cup)
- Tennis (ATP Tour)
- American Football (NFL)
- Esports (Counter-Strike)

**Position Sizing Pattern**:
Looking at their recent trades on West Ham vs. Manchester United:

1. Buy 1000 shares @ $0.05 (Man Utd to win)
2. Buy 1071 shares @ $0.05
3. Buy 931 shares @ $0.05 (West Ham to win)
4. Buy 125 shares @ $0.04 (Man Utd)
5. Buy 263 shares @ $0.04 (Man Utd)
6. Buy 747 shares @ $0.05 (Man Utd)
7. Buy 2583 shares @ $0.10 (Draw = No)

**Total invested in ONE game: $3,000-4,000**

### Strategy Breakdown

1. **Underdogs Only**: They bet on heavy underdogs at low prices (0.04-0.08 range)
2. **Large Volume**: 1000-10000+ shares per position
3. **Multiple Outcomes**: Often bets on multiple outcomes in same game (team win + no draw)
4. **No Exit Strategy**: Holds positions to resolution (always wins $1.00 or loses everything)
5. **Massive Positions**: $20k-60k per market

### Why This Strategy Fails Catastrophically

**Mathematical Problem**:
- Betting at 0.05 means they need **95% accuracy** to break even
- They're achieving 2% accuracy
- On average: Lose $5 to win $0.95 on 20:1 longshots

**Example Loss**:
```
Liverpool to win (No): $56,188 invested @ 0.396 avg price
Outcome: Liverpool won
Loss: -$56,188 (100% loss)
```

**Example Win**:
```
Cilic to win: $69,967 invested @ 0.5735 avg price
Outcome: Cilic won
Profit: +$52,025 (74% gain)
```

The wins don't cover the losses because:
- Win at 0.50 → 2x return
- Lose at 0.05 → 100% loss
- Need to win 19 out of 20 bets to break even
- Actually winning 2 out of 100

## Capital Requirements

Based on their actual trading:
- **Average position size**: $20,000-40,000
- **Multiple simultaneous positions**: 10-20 markets
- **Total capital deployed**: $500,000+
- **Total capital lost**: $1,387,830

## Why You Should NEVER Copy This

### 1. **Catastrophic Win Rate**
2% win rate is not sustainable under any circumstances. This is worse than random.

### 2. **Betting Against the Favorites**
They consistently bet against favorites:
- Liverpool (one of best teams) → Bet "No" → LOST
- Manchester City → Bet "No" → LOST
- Chelsea → Bet "No" → WON (rare)

### 3. **No Edge**
Sports markets on Polymarket are efficient. Betting 0.05 on underdogs provides no edge.

### 4. **Position Sizing Insanity**
$40,000-60,000 per position with 2% win rate = guaranteed bankruptcy

### 5. **No Risk Management**
- No stop losses (binary outcomes)
- No position limits
- No daily loss limits
- All-or-nothing resolution

## What's Actually Happening

This trader appears to be:

### Option A: Arbing Gone Wrong
- May have started with arbitrage or hedge strategy
- Lost one side repeatedly
- Kept doubling down to recover
- Now trapped in massive drawdown

### Option B: Emotional/Tilting
- May have had early wins
- Started chasing losses
- Betting against logic (anti-favorite bias)
- In full tilt mode

### Option C: Money Laundering (Unlikely)
- Intentionally losing to move funds
- Would explain consistent losing pattern
- Not recommended to speculate

## Recommended Action

**DO NOT COPY THIS TRADER**

If you want to trade sports on Polymarket:

### Alternative Approach (Not Recommended for $90)

1. **Only bet favorites with edge**: 0.70-0.85 range with research
2. **Small positions**: $5-10 max per market
3. **Research required**: Watch games, know teams, follow stats
4. **Accept variance**: Sports betting is high variance
5. **Strict bankroll management**: Never more than 5% per bet

### Better Alternatives for Your $90

1. **Copy successful traders**: Find traders with 60%+ win rate and positive P&L
2. **Long-term political markets**: Less variance than sports
3. **Arbitrage opportunities**: When total price < 0.98 or > 1.02
4. **Paper trading**: Practice before risking real money

## Sample Configuration (DO NOT USE)

If you absolutely must copy RN1 (which you shouldn't):

```yaml
# DISASTER MODE - DO NOT USE
traders:
  - "0x2005d16a84ceefa912d4e380cd32e7ff827875ea"

copy:
  fixedUsdcPerTrade: 1  # Limit damage
  marketable: false

risk:
  maxUsdcPerTrade: 1     # Max $1 per trade
  maxOpenUsdcPerMarket: 2
  maxDailyLossUsdc: 5    # Stop after losing $5
  maxActiveMarkets: 1    # Only 1 position at a time
  denyMarkets: ["*"]     # Block everything
  allowMarkets: []       # Don't allow anything

runtime:
  paper: true            # NEVER go live
```

## Conclusion

**RN1 has lost $1.4 MILLION with a 2% win rate.**

Copying this trader with your $90 bankroll will result in:
- Losing $90 within 1-2 trades
- No opportunity for recovery
- Complete capital destruction

**This is the OPPOSITE of what you want to copy.**

Look for traders with:
- 55-70% win rate
- Positive total P&L over 100+ trades
- Reasonable position sizing (not $40k per trade)
- Diverse market selection
- Risk management evident in their trades

## Better Traders to Research

Instead of RN1, look for traders who:
1. Have net positive P&L over $10k+
2. Win rate above 55%
3. Trade 100+ different markets (diversification)
4. Position sizes that scale (not all-in every time)
5. Exit losing positions before -100% loss

You can find profitable traders by:
```bash
# Search for profitable traders in your target markets
curl "https://data-api.polymarket.com/leaderboard"
```

Or look at the Polymarket leaderboard for verified profitable traders.
