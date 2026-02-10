/**
 * ERC-8004 Agent Registration Script
 * Registers both agents (Agent Smith + Oracle) on Monad IdentityRegistry
 *
 * Usage: node agents/register-agents.js
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { ethers } from 'ethers';

// Load from root .env.local
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env.local') });

// Monad Mainnet Configuration
const MONAD_RPC = 'https://rpc.monad.xyz';
const CHAIN_ID = 143;
const IDENTITY_REGISTRY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';

// Minimal ABI for registration
const IDENTITY_REGISTRY_ABI = [
  'function register() external returns (uint256)',
  'function register(string calldata agentURI) external returns (uint256)',
  'function ownerOf(uint256 tokenId) external view returns (address)',
  'function getAgentWallet(uint256 agentId) external view returns (address)',
  'function balanceOf(address owner) external view returns (uint256)',
  'event Registered(uint256 indexed agentId, address indexed owner)'
];

async function getProvider() {
  const provider = new ethers.JsonRpcProvider(MONAD_RPC, {
    chainId: CHAIN_ID,
    name: 'monad'
  });

  // Test connection
  const blockNumber = await provider.getBlockNumber();
  console.log(`Connected to Monad (block ${blockNumber})`);

  return provider;
}

async function checkExistingAgents(contract, wallet) {
  try {
    const balance = await contract.balanceOf(wallet.address);
    if (balance > 0n) {
      console.log(`  Wallet already owns ${balance} agent(s)`);
      return true;
    }
  } catch (e) {
    // Contract might not have balanceOf, continue
  }
  return false;
}

async function registerAgent(name, privateKey, agentURI) {
  console.log(`\n=== Registering ${name} ===`);

  if (!privateKey) {
    console.log(`  ERROR: No private key provided for ${name}`);
    return null;
  }

  const provider = await getProvider();
  const wallet = new ethers.Wallet(privateKey, provider);

  console.log(`  Wallet: ${wallet.address}`);

  // Check balance
  const balance = await provider.getBalance(wallet.address);
  const balanceInMON = ethers.formatEther(balance);
  console.log(`  Balance: ${balanceInMON} MON`);

  if (balance === 0n) {
    console.log(`  ERROR: No MON for gas. Please fund ${wallet.address}`);
    return null;
  }

  // Connect to contract
  const contract = new ethers.Contract(IDENTITY_REGISTRY, IDENTITY_REGISTRY_ABI, wallet);

  // Check if already registered
  const hasAgent = await checkExistingAgents(contract, wallet);
  if (hasAgent) {
    console.log(`  Skipping registration (already has agent)`);
    // Try to find existing agent ID by checking recent events or balance
    return { wallet: wallet.address, status: 'already_registered' };
  }

  // Register
  console.log(`  Submitting registration tx...`);

  try {
    let tx;
    if (agentURI) {
      tx = await contract['register(string)'](agentURI);
    } else {
      tx = await contract['register()']();
    }

    console.log(`  Tx hash: ${tx.hash}`);
    console.log(`  Waiting for confirmation...`);

    const receipt = await tx.wait();
    console.log(`  Confirmed in block ${receipt.blockNumber}`);

    // Parse Registered event to get agentId
    const registeredEvent = receipt.logs
      .map(log => {
        try {
          return contract.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .find(parsed => parsed?.name === 'Registered');

    if (registeredEvent) {
      const agentId = registeredEvent.args.agentId.toString();
      console.log(`  ✓ Agent ID: ${agentId}`);
      return { wallet: wallet.address, agentId, txHash: tx.hash };
    }

    return { wallet: wallet.address, txHash: tx.hash, status: 'registered' };

  } catch (error) {
    console.log(`  ERROR: ${error.message}`);
    return null;
  }
}

async function main() {
  console.log('╔════════════════════════════════════════╗');
  console.log('║  MonWorld Agent Registration Script    ║');
  console.log('║  Monad Mainnet (Chain 143)             ║');
  console.log('╚════════════════════════════════════════╝');

  const results = {};

  // Register Agent Smith (MCP Server Agent)
  const agentSmithPK = process.env.AGENT_SMITH_PK;
  const agentSmithResult = await registerAgent(
    'Agent Smith',
    agentSmithPK,
    'ipfs://monworld-agent-smith'  // Optional metadata URI
  );
  if (agentSmithResult) {
    results.agentSmith = agentSmithResult;
  }

  // Register Oracle (Simple Bot)
  const oraclePK = process.env.ORACLE_PK;
  const oracleResult = await registerAgent(
    'Oracle',
    oraclePK,
    'ipfs://monworld-oracle'
  );
  if (oracleResult) {
    results.oracle = oracleResult;
  }

  // Summary
  console.log('\n═══════════════════════════════════════');
  console.log('REGISTRATION SUMMARY');
  console.log('═══════════════════════════════════════');

  if (results.agentSmith) {
    console.log(`Agent Smith:`);
    console.log(`  Wallet: ${results.agentSmith.wallet}`);
    console.log(`  Agent ID: ${results.agentSmith.agentId || 'Check explorer'}`);
  }

  if (results.oracle) {
    console.log(`Oracle:`);
    console.log(`  Wallet: ${results.oracle.wallet}`);
    console.log(`  Agent ID: ${results.oracle.agentId || 'Check explorer'}`);
  }

  console.log('\nAdd these to your .env.local:');
  if (results.agentSmith?.agentId) {
    console.log(`AGENT_SMITH_ID=${results.agentSmith.agentId}`);
  }
  if (results.oracle?.agentId) {
    console.log(`ORACLE_ID=${results.oracle.agentId}`);
  }
}

main().catch(console.error);
