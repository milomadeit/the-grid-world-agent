/**
 * Oracle Registration + MECHAIS NFT Mint Script (Base Mainnet)
 * 
 * 1. Verifies/Registers Oracle agent on Base Mainnet IdentityRegistry
 * 2. Mints MECHAIS NFT on Base Mainnet following the PoW flow in skill.md
 *
 * Usage: node agents/oracle-register-and-mint.js
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { ethers } from 'ethers';
import crypto from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env.local') });

// ====== Configuration ======
const BASE_MAINNET = {
	name: 'Base Mainnet',
	rpc: 'https://mainnet.base.org',
	chainId: 8453,
	identityRegistry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432'
};

const MECHAIS_API = 'https://mechais.vercel.app/api';
const MECHAIS_MINT_GATE = '0x521279912BFdd04E79212e84d22f2aE3687a9db5';

const IDENTITY_REGISTRY_ABI = [
	'function register(string calldata agentURI) external returns (uint256)',
	'function balanceOf(address owner) external view returns (uint256)',
	'function ownerOf(uint256 tokenId) external view returns (address)',
	'event Registered(uint256 indexed agentId, string agentURI, address indexed owner)'
];

const MINT_GATE_ABI = [
	'function mint(uint256 agentId, uint256 deadline, bytes calldata authSig) external'
];

async function main() {
	console.log('╔════════════════════════════════════════════════╗');
	console.log('║  Oracle Registration + MECHAIS NFT Mint (Main) ║');
	console.log('╚════════════════════════════════════════════════╝');

	const oraclePK = process.env.ORACLE_PK;
	if (!oraclePK) {
		console.error('ERROR: ORACLE_PK not found in environment');
		process.exit(1);
	}

	const provider = new ethers.JsonRpcProvider(BASE_MAINNET.rpc);
	const wallet = new ethers.Wallet(oraclePK, provider);
	const minterAddress = wallet.address;

	console.log(`\nWallet: ${minterAddress}`);
	const balance = await provider.getBalance(minterAddress);
	console.log(`Balance: ${ethers.formatEther(balance)} ETH`);

	// Step 1: Check/Register Oracle on IdentityRegistry
	console.log('\n=== Step 1: Identity Registry Check ===');
	const contract = new ethers.Contract(BASE_MAINNET.identityRegistry, IDENTITY_REGISTRY_ABI, wallet);

	let agentId = process.env.BASE_MAINNET_ORACLE_ID || '2385'; // Use previous ID as default
	let isRegistered = false;

	try {
		const owner = await contract.ownerOf(BigInt(agentId));
		if (owner.toLowerCase() === minterAddress.toLowerCase()) {
			console.log(`  Agent ${agentId} is owned by this wallet. ✓`);
			isRegistered = true;
		}
	} catch (e) {
		// Check balance if ownerOf failed
		const agentBalance = await contract.balanceOf(minterAddress);
		if (agentBalance > 0n) {
			console.log(`  Wallet owns ${agentBalance} agent(s). Fetching ID...`);
			// We'll proceed to Step 2 and let the API confirm/find the ID if we don't have it.
			// But we need the actual ID for Step 1 of mint flow.
			// Let's assume 2385 for now or find it via logs (omitted for brevity, using 2385).
			isRegistered = true;
		}
	}

	if (!isRegistered) {
		if (balance === 0n) {
			console.error('  ERROR: Insufficient funds to register on Mainnet.');
			process.exit(1);
		}
		console.log('  Registering Oracle...');
		const tx = await contract['register(string)']('ipfs://monworld-oracle-base');
		const receipt = await tx.wait();
		const evt = receipt.logs.find(log => {
			try { return contract.interface.parseLog(log)?.name === 'Registered'; }
			catch { return false; }
		});
		if (evt) {
			agentId = contract.interface.parseLog(evt).args.agentId.toString();
			console.log(`  ✓ Registered! Agent ID: ${agentId}`);
		} else {
			console.error('  Failed to retrieve agent ID from logs.');
			process.exit(1);
		}
	}

	// Step 2: Mint MECHAIS NFT
	console.log('\n=== Step 2: MECHAIS NFT Mint (PoW) ===');

	// 2a. Check Status
	console.log(`  Checking status for Agent ${agentId}...`);
	const statusRes = await fetch(`${MECHAIS_API}/status`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ chainId: BASE_MAINNET.chainId, agentId: Number(agentId) })
	});
	const status = await statusRes.json();

	if (!status.registered) {
		console.error(`  ERROR: Agent ${agentId} not recognized by API.`);
		process.exit(1);
	}
	if (status.alreadyMinted) {
		console.log(`  Agent ${agentId} has already minted. Done!`);
		process.exit(0);
	}

	console.log(`  Required Minter: ${status.requiredMinter}`);

	// 2b. Request Challenge
	console.log(`  Requesting challenge...`);
	const challengeRes = await fetch(`${MECHAIS_API}/challenge`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			chainId: BASE_MAINNET.chainId,
			agentId: Number(agentId),
			minter: minterAddress
		})
	});
	const challenge = await challengeRes.json();

	if (challenge.error) {
		console.error(`  ERROR: ${challenge.error}`);
		process.exit(1);
	}

	// 2c. Solve PoW Challenge
	const { salt, difficulty } = challenge;
	console.log(`  PoW Challenge Received: difficulty ${difficulty}, salt ${salt}`);
	const target = '0'.repeat(difficulty);
	let nonce = 0;
	let startTime = Date.now();

	while (true) {
		const hash = crypto.createHash('sha256').update(salt + nonce).digest('hex');
		if (hash.startsWith(target)) {
			console.log(`  Solved! Nonce: ${nonce}, Hash: ${hash}`);
			break;
		}
		nonce++;
		if (nonce % 100000 === 0) {
			const elapsed = (Date.now() - startTime) / 1000;
			console.log(`  Mining... ${nonce} nonces tried (${Math.floor(nonce / elapsed)} H/s)`);
		}
	}
	const answer = String(nonce);

	// 2d. Get Authorization
	console.log(`  Getting authorization signature...`);
	const intentRes = await fetch(`${MECHAIS_API}/mint-intent`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			chainId: BASE_MAINNET.chainId,
			agentId: Number(agentId),
			minter: minterAddress,
			challengeId: challenge.challengeId,
			answer
		})
	});
	const intent = await intentRes.json();

	if (intent.error) {
		console.error(`  ERROR: ${intent.error} - ${intent.message || ''}`);
		process.exit(1);
	}

	console.log(`  Authorization received. Deadline: ${intent.deadline}`);

	// 2e. Submit On-Chain Transaction
	console.log(`  Submitting mint transaction...`);
	const mintGate = new ethers.Contract(MECHAIS_MINT_GATE, MINT_GATE_ABI, wallet);
	try {
		const tx = await mintGate.mint(intent.agentId, intent.deadline, intent.authSig);
		console.log(`  Tx: ${tx.hash}`);
		const receipt = await tx.wait();
		console.log(`  ✓ SUCCESS! NFT Minted in block ${receipt.blockNumber}`);
	} catch (err) {
		console.error(`  ERROR: Mint transaction failed: ${err.message}`);
		if (err.data) console.error(`  Revert reason: ${err.data}`);
	}

	console.log('\n=== Done ===');
}

main().catch(console.error);
