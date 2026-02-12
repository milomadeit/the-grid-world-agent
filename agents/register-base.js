/**
 * ERC-8004 Agent Registration Script for Base Networks
 * Registers Agent Smith on Base Mainnet and Base Sepolia Identity Registries
 *
 * Usage: 
 *   node agents/register-base.js --network sepolia
 *   node agents/register-base.js --network mainnet
 *   node agents/register-base.js --network both
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { ethers } from 'ethers';
import fs from 'fs';

// Load from root .env
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });
// Also try .env.local if root .env doesn't have it
dotenv.config({ path: path.join(__dirname, '..', '.env.local') });

// Configuration
const NETWORKS = {
	mainnet: {
		name: 'Base Mainnet',
		rpc: 'https://mainnet.base.org',
		chainId: 8453,
		identityRegistry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
		symbol: 'ETH'
	},
	sepolia: {
		name: 'Base Sepolia',
		rpc: 'https://sepolia.base.org',
		chainId: 84532,
		identityRegistry: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
		symbol: 'ETH'
	}
};

// Minimal ABI for registration based on server/abis/IdentityRegistry.json
const IDENTITY_REGISTRY_ABI = [
	'function register() external returns (uint256)',
	'function register(string calldata agentURI) external returns (uint256)',
	'function ownerOf(uint256 tokenId) external view returns (address)',
	'function getAgentWallet(uint256 agentId) external view returns (address)',
	'function balanceOf(address owner) external view returns (uint256)',
	'event Registered(uint256 indexed agentId, string agentURI, address indexed owner)'
];

async function checkExistingAgents(contract, walletAddress) {
	try {
		const balance = await contract.balanceOf(walletAddress);
		if (balance > 0n) {
			console.log(`  Wallet already owns ${balance} agent(s) on this network.`);
			return true;
		}
	} catch (e) {
		console.log(`  Warning: Could not check balance: ${e.message}`);
	}
	return false;
}

async function runRegistration(networkKey) {
	const config = NETWORKS[networkKey];
	if (!config) {
		console.error(`Error: Unknown network ${networkKey}`);
		return;
	}

	console.log(`\n=== Registering on ${config.name} ===`);

	const privateKey = process.env.AGENT_SMITH_PK;
	if (!privateKey) {
		console.error('  ERROR: AGENT_SMITH_PK not found in environment');
		return;
	}

	const provider = new ethers.JsonRpcProvider(config.rpc);
	const wallet = new ethers.Wallet(privateKey, provider);
	console.log(`  Wallet: ${wallet.address}`);

	// Check connection and balance
	try {
		const balance = await provider.getBalance(wallet.address);
		console.log(`  Balance: ${ethers.formatEther(balance)} ${config.symbol}`);

		if (balance === 0n) {
			console.warn(`  WARNING: No funds for gas. Please fund ${wallet.address} on ${config.name}`);
			// Continue check to see if already registered
		}
	} catch (error) {
		console.error(`  ERROR: Could not connect to RPC: ${error.message}`);
		return;
	}

	const contract = new ethers.Contract(config.identityRegistry, IDENTITY_REGISTRY_ABI, wallet);

	// Check if already registered
	const alreadyRegistered = await checkExistingAgents(contract, wallet.address);
	if (alreadyRegistered) {
		console.log(`  Skipping registration.`);
		return;
	}

	if ((await provider.getBalance(wallet.address)) === 0n) {
		console.error(`  ABORTING: Insufficient funds for transaction.`);
		return;
	}

	// Register
	console.log(`  Submitting registration...`);
	try {
		const agentURI = 'ipfs://The Grid-agent-smith-base';
		const tx = await contract['register(string)'](agentURI);
		console.log(`  Tx hash: ${tx.hash}`);
		console.log(`  Waiting for confirmation...`);

		const receipt = await tx.wait();
		console.log(`  Confirmed in block ${receipt.blockNumber}`);

		// Parse Registered event
		const registeredLog = receipt.logs.find(log => {
			try {
				const parsed = contract.interface.parseLog(log);
				return parsed.name === 'Registered';
			} catch (e) { return false; }
		});

		if (registeredLog) {
			const parsed = contract.interface.parseLog(registeredLog);
			const agentId = parsed.args.agentId.toString();
			console.log(`  ✓ Successfully registered! Agent ID: ${agentId}`);
		} else {
			console.log(`  ✓ Registration confirmed, but could not find Registered event in logs.`);
		}

	} catch (error) {
		console.error(`  ERROR: Registration failed: ${error.message}`);
		if (error.data) console.error(`  Error data: ${error.data}`);
	}
}

async function main() {
	const args = process.argv.slice(2);
	let network = 'both';

	if (args.includes('--network')) {
		network = args[args.indexOf('--network') + 1];
	}

	console.log('╔════════════════════════════════════════╗');
	console.log('║  Agent Smith Registration (Base)       ║');
	console.log('╚════════════════════════════════════════╝');

	if (network === 'both' || network === 'sepolia') {
		await runRegistration('sepolia');
	}

	if (network === 'both' || network === 'mainnet') {
		await runRegistration('mainnet');
	}
}

main().catch(console.error);
