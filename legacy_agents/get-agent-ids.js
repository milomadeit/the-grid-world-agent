/**
 * Query Agent IDs from transaction receipts
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { ethers } from 'ethers';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env.local') });

const MONAD_RPC = 'https://rpc.monad.xyz';
const IDENTITY_REGISTRY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';

// ERC721 Transfer event + Registered event
const ABI = [
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
  'event Registered(uint256 indexed agentId, address indexed owner)'
];

const provider = new ethers.JsonRpcProvider(MONAD_RPC, { chainId: 143, name: 'monad' });
const contract = new ethers.Contract(IDENTITY_REGISTRY, ABI, provider);

// Transaction hashes from registration
const TX_AGENT_SMITH = '0x27e8134e340c51bf2fd67ab25277dd463005e4167e2e3403eea001457878ceac';
const TX_ORACLE = '0xa22d557c28f738541caea2f28eb04ee2df542f3e92207721a986004e79130b81';

async function getAgentIdFromTx(name, txHash) {
  try {
    const receipt = await provider.getTransactionReceipt(txHash);
    if (!receipt) {
      console.log(`${name}: Transaction not found`);
      return;
    }

    // Parse logs for Transfer or Registered events
    for (const log of receipt.logs) {
      try {
        const parsed = contract.interface.parseLog(log);
        if (parsed) {
          if (parsed.name === 'Transfer') {
            const tokenId = parsed.args.tokenId.toString();
            console.log(`${name} Agent ID: ${tokenId}`);
            return tokenId;
          }
          if (parsed.name === 'Registered') {
            const agentId = parsed.args.agentId.toString();
            console.log(`${name} Agent ID: ${agentId}`);
            return agentId;
          }
        }
      } catch (e) {
        // Not our event, skip
      }
    }

    // Fallback: check raw logs for tokenId (usually 3rd topic in Transfer)
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() === IDENTITY_REGISTRY.toLowerCase() && log.topics.length >= 4) {
        // Transfer event: topics[3] is tokenId
        const tokenId = BigInt(log.topics[3]).toString();
        console.log(`${name} Agent ID (from raw log): ${tokenId}`);
        return tokenId;
      }
    }

    console.log(`${name}: Could not find Agent ID in logs`);
  } catch (e) {
    console.log(`${name} error: ${e.message}`);
  }
}

console.log('Extracting Agent IDs from registration transactions...\n');
const agentSmithId = await getAgentIdFromTx('Agent Smith', TX_AGENT_SMITH);
const oracleId = await getAgentIdFromTx('Oracle', TX_ORACLE);

console.log('\n═══════════════════════════════════════');
console.log('ADD TO YOUR .env.local:');
console.log('═══════════════════════════════════════');
console.log(`AGENT_SMITH_WALLET=0x25b993D1c494b5Ce6612085f406F2A2E2063134B`);
console.log(`AGENT_SMITH_ID=${agentSmithId || 'CHECK_EXPLORER'}`);
console.log(`ORACLE_WALLET=0xc0a7D7b0867b004d71E4230d719f35d7a71D5E43`);
console.log(`ORACLE_ID=${oracleId || 'CHECK_EXPLORER'}`);
