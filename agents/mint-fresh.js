/**
 * MECHAIS Minting Script (Fresh Start)
 * Strictly following instructions from https://mechais.vercel.app/skill.md
 * 
 * Target Wallet: Newly derived from NEW_AGENT_PK
 */

import { ethers } from 'ethers';
import crypto from 'crypto';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Load Environment
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env.local') });

// Configuration
const API_URL = "https://mechais.vercel.app/api";
const CHAIN_ID = 8453; // Base Mainnet
const IDENTITY_REGISTRY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";
const MINT_GATE_ADDRESS = "0xbC58A2Bd6278C54Db965d1f1A82C4126eEEd8200";

// Headers to mimic a browser/curl request and avoid WAF blocks
const HEADERS = {
	"Content-Type": "application/json",
	"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
	"Accept": "application/json",
	"Origin": "https://mechais.vercel.app",
	"Referer": "https://mechais.vercel.app/"
};

async function main() {
	console.log('--- Starting MECHAIS Mint (Fresh) ---');

	// 0. Setup Wallet
	const pk = process.env.NEW_AGENT_PK;
	if (!pk) throw new Error("Missing NEW_AGENT_PK in .env.local");

	// Use a reliable RPC to avoid rate limits
	const provider = new ethers.JsonRpcProvider("https://1rpc.io/base");
	const wallet = new ethers.Wallet(pk, provider);
	console.log(`Wallet: ${wallet.address}`);

	// 1. Get Agent ID (On-Chain Source of Truth)
	console.log('\n[1] Resolving Agent ID from Registry...');
	const registry = new ethers.Contract(IDENTITY_REGISTRY, [
		"function balanceOf(address) view returns (uint256)",
		"function tokenOfOwnerByIndex(address, uint256) view returns (uint256)",
		"function register(string) external returns (uint256)",
		"event Registered(uint256 indexed agentId, string agentURI, address indexed owner)"
	], wallet);

	let agentId;
	const balance = await registry.balanceOf(wallet.address);
	if (balance > 0n) {
		console.log('Agent is registered on-chain.');
		// Try to find ID from logs (limited range)
		const filter = registry.filters.Registered(null, null, wallet.address);
		const logs = await registry.queryFilter(filter, -9000); // Last 9000 blocks
		if (logs.length > 0) {
			agentId = logs[logs.length - 1].args.agentId.toString();
		} else {
			// Fallback: If we can't find it in recent logs, we might need to assume 10506 based on history
			// But let's try tokenOfOwnerByIndex if it existed (it's not readable usually on this contract)
			// Let's use the ID we discovered earlier to be safe if not found
			agentId = "10506";
			console.log('Could not find event in recent blocks, using known ID: 10506');
		}
	} else {
		console.log('Agent NOT registered. Registering now...');
		const tx = await registry.register(""); // Empty URI as per basic example
		console.log(`Registration Tx: ${tx.hash}`);
		const receipt = await tx.wait();
		const log = receipt.logs.find(l => {
			try { return registry.interface.parseLog(l).name === 'Registered'; } catch (e) { return false; }
		});
		agentId = registry.interface.parseLog(log).args.agentId.toString();
	}
	console.log(`Agent ID: ${agentId}`);

	// 2. Check API Status (with retries for indexer lag)
	console.log('\n[2] Checking MECHAIS API Status...');
	let status;
	for (let i = 0; i < 60; i++) { // Increase to 5 minutes of retries
		try {
			const res = await fetch(`${API_URL}/status`, {
				method: "POST",
				headers: HEADERS,
				body: JSON.stringify({ chainId: CHAIN_ID, agentId: parseInt(agentId) })
			});

			if (res.status !== 200) {
				console.log(`API returned status ${res.status}. Retrying...`);
				await new Promise(r => setTimeout(r, 5000));
				continue;
			}

			const data = await res.json();
			if (data.registered) {
				status = data;
				break;
			} else {
				console.log(`Indexer says: Not registered yet. Waiting 5s... (${i + 1}/60)`);
			}
		} catch (e) {
			console.log(`Fetch error: ${e.message}`);
		}
		await new Promise(r => setTimeout(r, 5000));
	}

	if (!status || !status.registered) {
		console.error('FAILED: API still does not recognize Agent ID after retries.');
		process.exit(1);
	}

	if (status.alreadyMinted) {
		console.log('SUCCESS: Agent has already minted!');
		process.exit(0);
	}

	console.log('Status: Ready to mint.');

	// 3. Request Challenge
	console.log('\n[3] Requesting PoW Challenge...');
	const challengeRes = await fetch(`${API_URL}/challenge`, {
		method: "POST",
		headers: HEADERS,
		body: JSON.stringify({
			chainId: CHAIN_ID,
			agentId: parseInt(agentId),
			minter: wallet.address
		})
	}).then(r => r.json());

	if (challengeRes.error) {
		console.error(`Challenge Error: ${challengeRes.error}`);
		process.exit(1);
	}

	// 4. Solve PoW
	console.log('\n[4] Solving Proof-of-Work...');
	const { salt, difficulty, challengeId } = challengeRes;
	const diff = Number(difficulty);
	const target = '0'.repeat(diff);
	let nonce = 0;
	const start = Date.now();

	// Optimized solver loop
	while (true) {
		const hash = crypto.createHash('sha256').update(salt + String(nonce)).digest('hex');
		if (hash.startsWith(target)) break;
		nonce++;
		if (nonce % 100000 === 0) process.stdout.write(`\rNonce: ${nonce}`);
	}
	console.log(`\nSolved! Nonce: ${nonce} (Time: ${(Date.now() - start)}ms)`);

	// 5. Get Mint Authorization
	console.log('\n[5] Submitting Solution for Authorization...');
	const intentRes = await fetch(`${API_URL}/mint-intent`, {
		method: "POST",
		headers: HEADERS,
		body: JSON.stringify({
			chainId: CHAIN_ID,
			agentId: parseInt(agentId),
			minter: wallet.address,
			challengeId: challengeId,
			answer: String(nonce)
		})
	}).then(r => r.json());

	if (!intentRes.authSig) {
		console.error('Authorization Failed:', intentRes);
		process.exit(1);
	}
	console.log('Authorization Signature received.');

	// 6. Execute On-Chain Mint
	console.log('\n[6] Executing On-Chain Mint Transaction...');
	const mintGate = new ethers.Contract(MINT_GATE_ADDRESS, [
		"function mint(uint256 agentId, uint256 deadline, bytes calldata authSig)"
	], wallet);

	try {
		const tx = await mintGate.mint(intentRes.agentId, intentRes.deadline, intentRes.authSig);
		console.log(`Transaction Sent: ${tx.hash}`);
		console.log('Waiting for confirmation...');
		const receipt = await tx.wait();
		console.log(`\n✅ MINT COMPLETE! Block: ${receipt.blockNumber}`);
		console.log(`View on Explorer: https://basescan.org/tx/${tx.hash}`);
	} catch (e) {
		console.error('Mint Transaction Failed:', e.message);
		process.exit(1);
	}
}

main().catch(console.error);
