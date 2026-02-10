import { ethers } from 'ethers';

const provider = new ethers.JsonRpcProvider('https://mainnet.base.org');
const registry = new ethers.Contract('0x8004A169FB4a3325136EB29fA0ceB6D2e539a432', ['function balanceOf(address) view returns (uint256)'], provider);
const wallet = '0x12C3eC0AEbA72Cc521dD9864d6d26686Fc1E811C';

async function main() {
	const b = await registry.balanceOf(wallet);
	console.log('Registry Balance:', b.toString());
}

main();
