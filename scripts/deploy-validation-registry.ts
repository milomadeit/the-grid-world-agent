import 'dotenv/config';
import { readFileSync } from 'fs';
import { join } from 'path';
import { ethers } from 'ethers';

type NetworkKey = 'base-sepolia' | 'base';

interface DeployNetwork {
  chainId: number;
  rpcUrl: string;
  defaultIdentityRegistry: string;
}

const NETWORKS: Record<NetworkKey, DeployNetwork> = {
  'base-sepolia': {
    chainId: 84532,
    rpcUrl: process.env.BASE_SEPOLIA_RPC || process.env.CHAIN_RPC || 'https://sepolia.base.org',
    defaultIdentityRegistry: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
  },
  base: {
    chainId: 8453,
    rpcUrl: process.env.BASE_MAINNET_RPC || process.env.CHAIN_RPC || 'https://mainnet.base.org',
    defaultIdentityRegistry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
  },
};

function getArg(name: string): string | undefined {
  const prefix = `${name}=`;
  return process.argv.slice(2).find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function getNetwork(): NetworkKey {
  const arg = (getArg('--network') || 'base-sepolia').trim().toLowerCase();
  if (arg === 'base') return 'base';
  return 'base-sepolia';
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

async function main(): Promise<void> {
  const networkKey = getNetwork();
  const network = NETWORKS[networkKey];

  const relayerPkRaw = requireEnv('RELAYER_PK');
  const relayerPk = relayerPkRaw.startsWith('0x') ? relayerPkRaw : `0x${relayerPkRaw}`;

  const validationBytecodeRaw = requireEnv('VALIDATION_REGISTRY_BYTECODE');
  const validationBytecode = validationBytecodeRaw.startsWith('0x')
    ? validationBytecodeRaw
    : `0x${validationBytecodeRaw}`;

  const identityRegistry =
    getArg('--identity') ||
    process.env.IDENTITY_REGISTRY ||
    network.defaultIdentityRegistry;

  const validationAbi = JSON.parse(
    readFileSync(join(process.cwd(), 'server', 'abis', 'ValidationRegistry.json'), 'utf-8'),
  );

  const provider = new ethers.JsonRpcProvider(network.rpcUrl, network.chainId);
  const wallet = new ethers.Wallet(relayerPk, provider);
  const nonce = await wallet.getNonce();

  console.log(`[Deploy] Network: ${networkKey} (chainId=${network.chainId})`);
  console.log(`[Deploy] Deployer: ${wallet.address}`);
  console.log(`[Deploy] IdentityRegistry: ${identityRegistry}`);
  console.log(`[Deploy] Starting nonce: ${nonce}`);

  const factory = new ethers.ContractFactory(validationAbi, validationBytecode, wallet);
  const contract = await factory.deploy();
  const deployReceipt = await contract.deploymentTransaction()?.wait();
  const deployedAddress = await contract.getAddress();

  console.log(`[Deploy] ValidationRegistry deployed: ${deployedAddress}`);
  if (deployReceipt?.hash) {
    console.log(`[Deploy] Deployment tx: ${deployReceipt.hash}`);
  }

  const initCalldata = new ethers.Interface(validationAbi).encodeFunctionData('initialize', [identityRegistry]);
  const initTx = await wallet.sendTransaction({
    to: deployedAddress,
    data: initCalldata,
  });
  const initReceipt = await initTx.wait();
  console.log(`[Deploy] initialize() tx: ${initReceipt?.hash || initTx.hash}`);
  console.log('[Deploy] Complete.');
}

main().catch((error) => {
  console.error('[Deploy] Failed:', error);
  process.exit(1);
});
