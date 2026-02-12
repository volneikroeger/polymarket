# Polymarket Authentication Fix - Summary

## Changes Made

### 1. Enhanced Environment Variable Validation
- Added format validation for `PRIVATE_KEY` (must be 66 chars, start with `0x`)
- Added format validation for `FUNDER` (must be 42 chars, start with `0x`)
- Added requirement checks for FUNDER when using POLY_PROXY or GNOSIS_SAFE modes
- All validation errors now include helpful messages explaining the format requirements

**Location:** `src/lib/polymarket/executor.ts:169-203`

### 2. Improved Diagnostic Logging
- Added detailed wallet configuration logging on startup
- Shows signer address, signature type (with human-readable names), and funder address
- Logs explicit warning for POLY_PROXY mode about wallet registration requirements
- Added success/failure logging for each retry attempt

**Location:** `src/lib/polymarket/executor.ts:194-233`

### 3. Retry Logic with Exponential Backoff
- Implemented configurable retry mechanism (default: 3 attempts)
- Uses exponential backoff between retries (2s, 4s, 8s by default)
- Configurable via environment variables:
  - `API_KEY_DERIVE_MAX_RETRIES` (default: 3)
  - `API_KEY_DERIVE_RETRY_DELAY_MS` (default: 2000)
- Logs each attempt with attempt number and delay time

**Location:** `src/lib/polymarket/executor.ts:236-287`

### 4. Automatic Authentication Fallback
- If POLY_PROXY (SIGNATURE_TYPE=1) fails, automatically tries EOA mode (SIGNATURE_TYPE=0)
- Only activates when `ALLOW_AUTH_FALLBACK=true` in `.env`
- Logs which authentication method succeeded
- Suggests updating .env to use working method permanently

**Location:** `src/lib/polymarket/executor.ts:294-328`

### 5. Comprehensive Error Messages
- All authentication failures now include detailed troubleshooting steps:
  1. Check wallet is registered as proxy for FUNDER (if using POLY_PROXY)
  2. Try EOA mode instead (SIGNATURE_TYPE=0)
  3. Export and use existing API credentials from Polymarket
  4. Verify wallet has been used on Polymarket before
  5. Verify PRIVATE_KEY corresponds to correct wallet
  6. Enable automatic fallback to EOA mode
- Shows actual wallet address and funder in error messages for easy verification

**Location:** `src/lib/polymarket/executor.ts:330-340`

### 6. Updated .env Configuration
- Added helpful comments explaining each signature type
- Added new configuration options:
  - `ALLOW_AUTH_FALLBACK=true` (enables automatic fallback)
  - `API_KEY_DERIVE_MAX_RETRIES=3` (retry attempts)
  - `API_KEY_DERIVE_RETRY_DELAY_MS=2000` (retry delay)
- Improved documentation for existing options
- Set `ALLOW_AUTH_FALLBACK=true` by default to help users

**Location:** `.env:8-40`

### 7. Created Troubleshooting Documentation
- Comprehensive guide explaining authentication errors
- Step-by-step fixes for common issues
- Explanation of different signature types
- Recommended configurations for different use cases
- Common error messages and their solutions

**Location:** `docs/AUTHENTICATION_TROUBLESHOOTING.md`

## How to Use the Fixes

### Quick Fix (Recommended)
1. The fallback is now enabled by default (`ALLOW_AUTH_FALLBACK=true`)
2. Restart your bot: `pm2 restart copy-bot`
3. The bot will automatically try POLY_PROXY first, then fallback to EOA mode if it fails
4. Check logs: `pm2 logs copy-bot` to see which method worked

### If That Doesn't Work
1. Manually switch to EOA mode:
   ```bash
   # In .env file:
   SIGNATURE_TYPE=0
   # Comment out FUNDER:
   # FUNDER=0xd9d712fd23e174ec269f4a9527493e89af8e4fba
   ```
2. Restart: `pm2 restart copy-bot`

### Using Existing API Credentials (Best for Production)
1. Log into polymarket.com
2. Go to Settings → API Keys
3. Create/export your credentials
4. Add to `.env`:
   ```bash
   POLY_API_KEY=your-key
   POLY_API_SECRET=your-secret
   POLY_API_PASSPHRASE=your-passphrase
   ```
5. Restart: `pm2 restart copy-bot`

## What the Logs Will Show

### Success Path
```
[INFO] polymarket executor signer config {"signer":"0x...","signatureType":"POLY_PROXY","funder":"0x..."}
[INFO] Using POLY_PROXY authentication. Ensure your wallet is registered...
[INFO] Attempting to derive API key (attempt 1/3)...
[INFO] Successfully derived Polymarket API creds
[INFO] Derived Polymarket API creds (stored only in memory)...
```

### Fallback Path
```
[INFO] polymarket executor signer config {"signer":"0x...","signatureType":"POLY_PROXY","funder":"0x..."}
[INFO] Using POLY_PROXY authentication. Ensure your wallet is registered...
[INFO] Attempting to derive API key (attempt 1/3)...
[WARN] API key derivation failed (attempt 1/3)
[INFO] Attempting to derive API key (attempt 2/3)...
[WARN] API key derivation failed (attempt 2/3)
[INFO] Attempting to derive API key (attempt 3/3)...
[WARN] API key derivation failed (attempt 3/3)
[WARN] POLY_PROXY authentication failed. Attempting fallback to EOA mode...
[WARN] SUCCESS: Fallback to EOA mode worked! Consider updating your .env to use SIGNATURE_TYPE=0 permanently.
```

### Failure Path (with troubleshooting)
```
[ERROR] Failed to derive Polymarket API creds after 3 attempts: Could not create api key

Troubleshooting steps:
1. If using SIGNATURE_TYPE=1 (POLY_PROXY), ensure your wallet (0x...) is registered as a proxy for FUNDER (0x...) in Polymarket
2. Try using SIGNATURE_TYPE=0 (EOA) instead by setting SIGNATURE_TYPE=0 and removing FUNDER from .env
3. Visit Polymarket's web interface and export your API credentials, then set POLY_API_KEY, POLY_API_SECRET, and POLY_API_PASSPHRASE in .env
4. Check if your wallet has been used on Polymarket before (may need to make at least one trade via web interface)
5. Verify your PRIVATE_KEY corresponds to a wallet you control and have used on Polymarket
6. Enable automatic fallback to EOA mode by setting ALLOW_AUTH_FALLBACK=true in .env
```

## Testing

Build completed successfully:
```bash
npm run build
✓ No errors
```

## Next Steps

1. **Restart your bot:**
   ```bash
   pm2 restart copy-bot
   ```

2. **Watch the logs:**
   ```bash
   pm2 logs copy-bot --lines 50
   ```

3. **Look for:**
   - `polymarket executor signer config` - Shows your wallet setup
   - `Successfully derived Polymarket API creds` - Authentication worked
   - `SUCCESS: Fallback to EOA mode worked` - Fallback succeeded
   - Any ERROR messages with troubleshooting steps

4. **If it works with fallback:**
   - Update your .env to use `SIGNATURE_TYPE=0` permanently
   - Comment out the `FUNDER` line
   - This will skip the fallback process and authenticate directly

5. **For production:**
   - Consider exporting your API credentials from Polymarket
   - Add them to .env as POLY_API_KEY, POLY_API_SECRET, POLY_API_PASSPHRASE
   - This is more stable and avoids re-deriving credentials on every restart

## Additional Resources

- Full troubleshooting guide: `docs/AUTHENTICATION_TROUBLESHOOTING.md`
- Polymarket API docs: https://docs.polymarket.com
