/**
 * Derive wallet addresses from private keys
 * Run: node agents/derive-wallets.js
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { ethers } from 'ethers';

// Load from root .env.local
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env.local') });

console.log('╔════════════════════════════════════════╗');
console.log('║  Wallet Address Derivation             ║');
console.log('╚════════════════════════════════════════╝\n');

const keys = [
  { name: 'Agent Smith', envVar: 'AGENT_SMITH_PK' },
  { name: 'Oracle', envVar: 'ORACLE_PK' }
];

for (const { name, envVar } of keys) {
  const pk = process.env[envVar];

  if (!pk) {
    console.log(`${name}:`);
    console.log(`  ERROR: ${envVar} not set in .env.local\n`);
    continue;
  }

  try {
    const wallet = new ethers.Wallet(pk);
    console.log(`${name}:`);
    console.log(`  Address: ${wallet.address}`);
    console.log(`  Env var for config: ${name === 'Agent Smith' ? 'AGENT_SMITH_WALLET' : 'ORACLE_WALLET'}=${wallet.address}\n`);
  } catch (e) {
    console.log(`${name}:`);
    console.log(`  ERROR: Invalid private key format\n`);
  }
}

console.log('Add these wallet addresses to your .env.local');
console.log('Then fund them with MON on Monad Mainnet (Chain 143)');
