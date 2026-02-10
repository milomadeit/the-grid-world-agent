import { ethers } from 'ethers';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Chain configuration
const RPC_URL = process.env.BASE_MAINNET_RPC || 'https://mainnet.base.org';
const CHAIN_ID = parseInt(process.env.BASE_MAINNET_ID || '8453', 10);

const IDENTITY_REGISTRY_ADDRESS = process.env.BASE_IDENTITY_REGISTRY || '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';
const REPUTATION_REGISTRY_ADDRESS = process.env.BASE_REPUTATION_REGISTRY || '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63';

// Load ABIs
const identityAbi = JSON.parse(
  readFileSync(join(__dirname, 'abis', 'IdentityRegistry.json'), 'utf-8')
);
const reputationAbi = JSON.parse(
  readFileSync(join(__dirname, 'abis', 'ReputationRegistry.json'), 'utf-8')
);

// Read-only provider (no private keys on server)
let provider: ethers.JsonRpcProvider | null = null;
let identityRegistry: ethers.Contract | null = null;
let reputationRegistry: ethers.Contract | null = null;

export function initChain(): void {
  try {
    provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID);
    identityRegistry = new ethers.Contract(IDENTITY_REGISTRY_ADDRESS, identityAbi, provider);
    reputationRegistry = new ethers.Contract(REPUTATION_REGISTRY_ADDRESS, reputationAbi, provider);
    console.log(`[Chain] Connected to ${CHAIN_ID === 8453 ? 'Base Mainnet' : 'Chain ' + CHAIN_ID} (read-only)`);
    console.log(`[Chain] IdentityRegistry: ${IDENTITY_REGISTRY_ADDRESS}`);
    console.log(`[Chain] ReputationRegistry: ${REPUTATION_REGISTRY_ADDRESS}`);
  } catch (error) {
    console.error('[Chain] Failed to initialize provider:', error);
  }
}

/**
 * Verify that a wallet address owns or is the agentWallet for a given agentId.
 * Returns { verified, owner, agentWallet } or throws on contract errors.
 */
export async function verifyAgentOwnership(
  agentId: string,
  walletAddress: string
): Promise<{ verified: boolean; owner: string; agentWallet: string }> {
  if (!identityRegistry) {
    throw new Error('Chain not initialized');
  }

  const tokenId = BigInt(agentId);
  const normalizedWallet = walletAddress.toLowerCase();

  // Check if the token exists and get the owner
  const owner: string = await identityRegistry.ownerOf(tokenId);
  const ownerLower = owner.toLowerCase();

  // Check the verified agentWallet
  const agentWallet: string = await identityRegistry.getAgentWallet(tokenId);
  const agentWalletLower = agentWallet.toLowerCase();

  // Wallet matches if it's the owner OR the verified agentWallet
  const verified =
    normalizedWallet === ownerLower ||
    (agentWalletLower !== ethers.ZeroAddress.toLowerCase() && normalizedWallet === agentWalletLower);

  return { verified, owner, agentWallet };
}

/**
 * Get on-chain reputation summary for an agent.
 * Requires clientAddresses to be non-empty per ERC-8004 spec.
 * Pass empty array to get all clients first, then summarize.
 */
export async function getOnChainReputation(
  agentId: string
): Promise<{ count: number; summaryValue: number; summaryValueDecimals: number } | null> {
  if (!reputationRegistry) {
    return null;
  }

  try {
    const tokenId = BigInt(agentId);

    // First get all clients who have given feedback
    const clients: string[] = await reputationRegistry.getClients(tokenId);

    if (clients.length === 0) {
      return { count: 0, summaryValue: 0, summaryValueDecimals: 0 };
    }

    // Get summary across all clients
    const [count, summaryValue, summaryValueDecimals] = await reputationRegistry.getSummary(
      tokenId,
      clients,
      '', // no tag1 filter
      ''  // no tag2 filter
    );

    return {
      count: Number(count),
      summaryValue: Number(summaryValue),
      summaryValueDecimals: Number(summaryValueDecimals)
    };
  } catch (error) {
    console.error(`[Chain] Failed to get reputation for agent ${agentId}:`, error);
    return null;
  }
}

/**
 * Check if a token exists on the IdentityRegistry.
 */
export async function agentExists(agentId: string): Promise<boolean> {
  if (!identityRegistry) {
    throw new Error('Chain not initialized');
  }

  try {
    await identityRegistry.ownerOf(BigInt(agentId));
    return true;
  } catch {
    return false;
  }
}

export function getIdentityRegistryAddress(): string {
  return IDENTITY_REGISTRY_ADDRESS;
}

export function getReputationRegistryAddress(): string {
  return REPUTATION_REGISTRY_ADDRESS;
}

export function isChainInitialized(): boolean {
  return provider !== null;
}
