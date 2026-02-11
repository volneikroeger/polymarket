import { logger } from './lib/logger.js';

const DATA_API_BASE = 'https://data-api.polymarket.com';

async function main() {
  const traderWallet = '0x2e4c9c7275d0f5d02e1787e7f59d98ad985b28dd';

  logger.info({ wallet: traderWallet }, 'Fetching trader trades...');
  const response = await fetch(`${DATA_API_BASE}/activity?user=${traderWallet}&limit=20`);

  if (!response.ok) {
    logger.error({ status: response.status }, 'Failed to fetch trades');
    return;
  }

  const data: any = await response.json();

  console.log('\n=== RAW API DATA (First 5 trades) ===\n');
  console.log(JSON.stringify(data.slice(0, 5), null, 2));

  console.log('\n=== FIELD ANALYSIS ===\n');
  if (data.length > 0) {
    const firstTrade = data[0];
    console.log('Fields in first trade:');
    console.log(Object.keys(firstTrade).join(', '));
  }
}

main().catch(console.error);
