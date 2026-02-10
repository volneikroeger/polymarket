import 'dotenv/config';
import { ClobClient } from '@polymarket/clob-client';
import { Wallet } from 'ethers';

async function main() {
  const host = process.env.CLOB_HOST ?? 'https://clob.polymarket.com';
  const chainId = Number(process.env.CHAIN_ID ?? '137');

  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) throw new Error('Missing PRIVATE_KEY');

  const signatureType = Number(process.env.SIGNATURE_TYPE ?? '0');
  const funder = process.env.FUNDER && process.env.FUNDER.trim() ? process.env.FUNDER.trim() : undefined;
  const useServerTime = process.env.USE_SERVER_TIME === 'true';

  const signer = new Wallet(privateKey);

  console.log('--- probe ---');
  console.log('signer address:', signer.address);
  console.log('signatureType:', signatureType);
  console.log('funder:', funder ?? '(none)');

  const base = new ClobClient(host, chainId, signer, undefined, signatureType as any, funder, undefined, useServerTime);
  const derived: any = await base.createOrDeriveApiKey();
  if (!derived?.key || !derived?.secret || !derived?.passphrase) {
    console.log('derive failed:', derived);
    return;
  }
  console.log('derived L2 key ok (redacted)');

  const authed = new ClobClient(host, chainId, signer, derived, signatureType as any, funder, undefined, useServerTime);

  const apiKeys: any = await authed.getApiKeys();
  console.log('getApiKeys:', apiKeys?.error ? apiKeys : 'ok');

  // Check collateral balance/allowance for this API key (wallet is implied by auth + signature_type)
  const bal: any = await (authed as any).getBalanceAllowance?.({ asset_type: 'COLLATERAL' });
  console.log('getBalanceAllowance (COLLATERAL):', bal);
}

main().catch((e) => {
  console.error('probe fatal:', e);
  process.exit(1);
});
