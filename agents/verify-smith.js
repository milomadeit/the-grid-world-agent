import { ethers } from 'ethers';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env.local') });

const BASE_MAINNET_RPC = 'https://mainnet.base.org';
const IDENTITY_REGISTRY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';

const ABI = [
	'function balanceOf(address owner) external view returns (uint256)',
	'function ownerOf(uint256 tokenId) external view returns (address)'
];

async function main() {
	const provider = new ethers.JsonRpcProvider(BASE_MAINNET_RPC);
	const smithWallet = '0x25b993D1c494b5Ce6612085f406F2A2E2063134B';

	console.log(`Checking Smith Wallet: ${smithWallet}`);

	const identity = new ethers.Contract(IDENTITY_REGISTRY, ABI, provider);

	try {
		const bal = await identity.balanceOf(smithWallet);
		console.log(`Balance: ${bal}`);

		// Check ID 2342
		try {
			const owner = await identity.ownerOf(2342);
			console.log(`Owner of 2342: ${owner}`);
			console.log(`Match: ${owner.toLowerCase() === smithWallet.toLowerCase()}`);
		} catch (e) { console.log(`ID 2342 Error: ${e.message}`); }

		// Maybe it's a different ID? Let's check recent registrations if balance > 0
		// But IdentityRegistry doesn't have enumerable. 
	} catch (e) { console.log(`Error: ${e.message}`); }
}

main().catch(console.error);
