import { ethers } from 'ethers';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env.local') });

const BASE_MAINNET_RPC = 'https://mainnet.base.org';
const IDENTITY_REGISTRY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';
const MECHAIS_NFT = '0xd8CB22b6BD051F350e2E81041a61A54fe23144d7';

const ABI = [
	'function balanceOf(address owner) external view returns (uint256)',
	'function tokenOfOwnerByIndex(address owner, uint256 index) external view returns (uint256)',
	'function ownerOf(uint256 tokenId) external view returns (address)'
];

async function main() {
	const provider = new ethers.JsonRpcProvider(BASE_MAINNET_RPC);
	const oracleWallet = process.env.ORACLE_WALLET || '0xc0a7D7b0867b004d71E4230d719f35d7a71D5E43';

	console.log(`Checking Oracle Wallet: ${oracleWallet}`);

	const identity = new ethers.Contract(IDENTITY_REGISTRY, ABI, provider);
	const mechais = new ethers.Contract(MECHAIS_NFT, ABI, provider);

	// 1. Check Identity Registry
	try {
		const bal = await identity.balanceOf(oracleWallet);
		console.log(`Identity Registry Balance: ${bal}`);
		if (bal > 0n) {
			// IdentityRegistry might not support Enumerable, so we try tokenOfOwnerByIndex just in case
			try {
				const id = await identity.tokenOfOwnerByIndex(oracleWallet, 0);
				console.log(`Agent ID (Enumerable): ${id}`);
			} catch {
				console.log(`Identity Registry doesn't support Enumerable. Checking ID 2385...`);
				try {
					const owner = await identity.ownerOf(2385);
					console.log(`Owner of 2385: ${owner} (Matches: ${owner.toLowerCase() === oracleWallet.toLowerCase()})`);
				} catch (e) { console.log(`Error checking 2385: ${e.message}`); }
			}
		}
	} catch (e) { console.log(`Identity Error: ${e.message}`); }

	// 2. Check MECHAIS NFT
	try {
		const bal = await mechais.balanceOf(oracleWallet);
		console.log(`MECHAIS NFT Balance: ${bal}`);
	} catch (e) { console.log(`MECHAIS Error: ${e.message}`); }
}

main().catch(console.error);
