/**
 * Agent Smith MECHAIS NFT Mint Script (Base Mainnet)
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { ethers } from 'ethers';
import crypto from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env.local') });

const BASE_MAINNET = {
	name: 'Base Mainnet',
	rpc: 'https://mainnet.base.org',
	chainId: 8453
};

const MECHAIS_API = 'https://mechais.vercel.app/api';
const MECHAIS_MINT_GATE = '0x521279912BFdd04E79212e84d22f2aE3687a9db5';
const AGENT_ID = 2342; // Agent Smith's ID on Mainnet

const MINT_GATE_ABI = [
	'function mint(uint256 agentId, uint256 deadline, bytes calldata authSig) external'
];

async function main() {
	console.log('╔════════════════════════════════════════════════╗');
	console.log('║  Agent Smith MECHAIS NFT Mint (Mainnet)        ║');
	console.log('╚════════════════════════════════════════════════╝');

	const pk = process.env.AGENT_SMITH_PK;
	if (!pk) {
		console.error('ERROR: AGENT_SMITH_PK not found');
		process.exit(1);
	}

	const provider = new ethers.JsonRpcProvider(BASE_MAINNET.rpc);
	const wallet = new ethers.Wallet(pk, provider);
	const minterAddress = wallet.address;

	console.log(`\nWallet: ${minterAddress}`);
	console.log(`Agent ID: ${AGENT_ID}`);

	// 1. Check status
	console.log(`\nChecking status...`);
	const statusRes = await fetch(`${MECHAIS_API}/status`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ chainId: BASE_MAINNET.chainId, agentId: AGENT_ID })
	});
	const status = await statusRes.json();

	if (!status.registered) {
		console.error(`ERROR: Agent ${AGENT_ID} not registered`);
		process.exit(1);
	}
	if (status.alreadyMinted) {
		console.log(`Already minted!`);
		process.exit(0);
	}

	// 2. Request challenge
	console.log(`Requesting challenge...`);
	const challengeRes = await fetch(`${MECHAIS_API}/challenge`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ chainId: BASE_MAINNET.chainId, agentId: AGENT_ID, minter: minterAddress })
	});
	const challenge = await challengeRes.json();
	console.log('Challenge Response:', challenge);

	if (challenge.error) {
		console.error('API Error:', challenge.error);
		process.exit(1);
	}

	// 3. Solve PoW
	const { salt, difficulty } = challenge;
	const diff = Number(difficulty) || 4; // Fallback to 4 if undefined
	console.log(`Solving PoW (salt: ${salt}, difficulty: ${diff})...`);
	const target = '0'.repeat(diff);
	let nonce = 0;
	while (true) {
		const hash = crypto.createHash('sha256').update(String(salt) + nonce).digest('hex');
		if (hash.startsWith(target)) break;
		nonce++;
	}
	console.log(`Solved! Nonce: ${nonce}`);

	// 4. Get Intent
	console.log(`Getting authorization...`);
	const intentRes = await fetch(`${MECHAIS_API}/mint-intent`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			chainId: BASE_MAINNET.chainId,
			agentId: AGENT_ID,
			minter: minterAddress,
			challengeId: challenge.challengeId,
			answer: String(nonce)
		})
	});
	const intent = await intentRes.json();

	// 5. Mint
	console.log(`Submitting mint...`);
	const mintGate = new ethers.Contract(MECHAIS_MINT_GATE, MINT_GATE_ABI, wallet);
	const tx = await mintGate.mint(intent.agentId, intent.deadline, intent.authSig);
	console.log(`Tx: ${tx.hash}`);
	const receipt = await tx.wait();
	console.log(`✓ Minted in block ${receipt.blockNumber}`);
}

main().catch(console.error);
