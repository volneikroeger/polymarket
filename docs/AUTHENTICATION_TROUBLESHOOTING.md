# Polymarket Authentication Troubleshooting Guide

This guide helps you resolve "Could not create api key" errors when connecting to Polymarket's CLOB API.

## Understanding the Error

The error `"Could not create api key"` typically means:
- Your wallet is not properly configured in Polymarket
- The SIGNATURE_TYPE and FUNDER configuration don't match your Polymarket setup
- Your wallet hasn't been used on Polymarket before

## Quick Fix: Try EOA Mode First

The simplest solution is to use **EOA (Externally Owned Account)** mode:

1. Edit your `.env` file
2. Change `SIGNATURE_TYPE=1` to `SIGNATURE_TYPE=0`
3. Comment out or remove the `FUNDER` line:
   ```bash
   SIGNATURE_TYPE=0
   # FUNDER=0xd9d712fd23e174ec269f4a9527493e89af8e4fba
   ```
4. Restart the bot

## Understanding Signature Types

### SIGNATURE_TYPE=0 (EOA) - Recommended
- **Use when:** You control a wallet directly (MetaMask, hardware wallet, etc.)
- **Setup:** No FUNDER needed
- **Best for:** Most users, simplest configuration

### SIGNATURE_TYPE=1 (POLY_PROXY)
- **Use when:** Your wallet is registered as a proxy for another address
- **Setup:** Requires FUNDER address
- **Best for:** Advanced users with Polymarket proxy setup
- **Note:** Requires wallet-funder relationship to be registered in Polymarket

### SIGNATURE_TYPE=2 (GNOSIS_SAFE)
- **Use when:** Trading through a Gnosis Safe multisig
- **Setup:** Requires FUNDER address
- **Best for:** Organizations/teams

## Detailed Troubleshooting Steps

### Step 1: Verify Your Wallet

Check that your `PRIVATE_KEY` is correct:
- Must start with `0x`
- Must be 66 characters long (including `0x`)
- Must correspond to a wallet you control

To see which wallet address your private key corresponds to, check the bot logs on startup. You'll see:
```
polymarket executor signer config {"signer":"0x...","signatureType":"EOA",...}
```

### Step 2: Check Polymarket Registration

Your wallet must be used on Polymarket before API authentication works:

1. Visit [polymarket.com](https://polymarket.com)
2. Connect with the wallet address shown in your bot logs
3. Make at least one small trade to register the wallet
4. Try the bot again

### Step 3: Use Existing API Credentials

If you already have Polymarket API credentials:

1. Log into [polymarket.com](https://polymarket.com)
2. Go to Settings → API Keys
3. Create or export your API credentials
4. Add them to `.env`:
   ```bash
   POLY_API_KEY=your-key-here
   POLY_API_SECRET=your-secret-here
   POLY_API_PASSPHRASE=your-passphrase-here
   ```
5. Restart the bot

This skips the derivation process entirely.

### Step 4: Enable Automatic Fallback

The bot can automatically try EOA mode if POLY_PROXY fails:

Add to `.env`:
```bash
ALLOW_AUTH_FALLBACK=true
```

This will:
1. Try POLY_PROXY first (if SIGNATURE_TYPE=1)
2. Automatically fallback to EOA mode if it fails
3. Log which method worked

### Step 5: Increase Retry Attempts

If you're experiencing temporary network issues:

Add to `.env`:
```bash
API_KEY_DERIVE_MAX_RETRIES=5
API_KEY_DERIVE_RETRY_DELAY_MS=3000
```

This increases retries from 3 to 5 and adds more delay between attempts.

## Common Error Messages

### "Could not create api key"
**Cause:** Wallet not registered or POLY_PROXY misconfiguration
**Fix:** Try EOA mode (SIGNATURE_TYPE=0) or use existing API credentials

### "Invalid signature"
**Cause:** Wrong SIGNATURE_TYPE for your setup
**Fix:** Switch to SIGNATURE_TYPE=0 (EOA mode)

### "Timeout deriving API key after 30s"
**Cause:** Network issues or Polymarket API slowness
**Fix:** Increase retries or use existing API credentials

### "Invalid PRIVATE_KEY format"
**Cause:** Private key doesn't start with "0x" or wrong length
**Fix:** Check your private key format

### "SIGNATURE_TYPE=1 requires FUNDER address"
**Cause:** Using POLY_PROXY without FUNDER
**Fix:** Add FUNDER or switch to SIGNATURE_TYPE=0

## Recommended Configuration

For most users, this is the simplest working configuration:

```bash
# Your wallet private key
PRIVATE_KEY=0x...

# Use EOA mode (simplest)
SIGNATURE_TYPE=0

# Don't set FUNDER for EOA mode
# FUNDER=...

# Optional: Enable fallback if you want to try POLY_PROXY first
ALLOW_AUTH_FALLBACK=true

# Optional: Use server time to avoid clock skew issues
USE_SERVER_TIME=true
```

## Advanced: Fixing POLY_PROXY Setup

If you specifically need POLY_PROXY mode (SIGNATURE_TYPE=1):

1. Your wallet must be registered as a proxy for the FUNDER address in Polymarket
2. This typically requires:
   - Going through Polymarket's web interface setup
   - Using their proxy registration process
   - Verifying the wallet-funder relationship

If you're not sure, **use EOA mode (SIGNATURE_TYPE=0)** instead.

## Still Having Issues?

Check the bot logs for detailed error messages:
```bash
pm2 logs copy-bot
```

Look for lines containing:
- `polymarket executor signer config` - Shows your wallet address
- `Attempting to derive API key` - Shows retry attempts
- `CLOB Client request error` - Shows detailed API errors

If authentication continues to fail after trying all steps above, you may need to:
1. Create a new wallet on Polymarket's web interface
2. Export the API credentials from there
3. Use those credentials directly in your .env file
