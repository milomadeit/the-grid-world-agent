import { ethers } from 'ethers';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Chain configuration — Monad Mainnet (Chain ID 143)
const RPC_URL = process.env.MONAD_RPC || 'https://rpc.monad.xyz';
const CHAIN_ID = parseInt(process.env.MONAD_CHAIN_ID || '143', 10);

const IDENTITY_REGISTRY_ADDRESS = process.env.IDENTITY_REGISTRY || '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';
const REPUTATION_REGISTRY_ADDRESS = process.env.REPUTATION_REGISTRY || '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63';

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
    console.log(`[Chain] Connected to ${CHAIN_ID === 143 ? 'Monad Mainnet' : 'Chain ' + CHAIN_ID} (read-only)`);
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

// --- Entry Fee Configuration ---

export const TREASURY_ADDRESS = '0xb09D74ACF784a5D59Bbb3dBfD504Ce970bFB7BC6';
export const ENTRY_FEE_MON = '1'; // 1 MON
export const MONAD_CHAIN_ID = CHAIN_ID;

/**
 * Verify that a transaction hash represents a valid entry fee payment.
 * Checks: tx.from matches expected wallet, tx.to matches treasury,
 * tx.value >= 1 MON, and tx is confirmed.
 */
export async function verifyEntryFeePayment(
  txHash: string,
  expectedFromAddress: string
): Promise<{ valid: boolean; reason?: string }> {
  if (!provider) {
    return { valid: false, reason: 'Chain not initialized' };
  }

  try {
    const [tx, receipt] = await Promise.all([
      provider.getTransaction(txHash),
      provider.getTransactionReceipt(txHash),
    ]);

    if (!tx) {
      return { valid: false, reason: 'Transaction not found' };
    }

    if (!receipt) {
      return { valid: false, reason: 'Transaction not yet confirmed' };
    }

    if (receipt.status !== 1) {
      return { valid: false, reason: 'Transaction failed (reverted)' };
    }

    // Check sender matches the authenticating wallet
    if (tx.from.toLowerCase() !== expectedFromAddress.toLowerCase()) {
      return { valid: false, reason: `Transaction sender (${tx.from}) does not match wallet (${expectedFromAddress})` };
    }

    // Check recipient is the treasury
    if (!tx.to || tx.to.toLowerCase() !== TREASURY_ADDRESS.toLowerCase()) {
      return { valid: false, reason: `Transaction recipient is not the treasury` };
    }

    // Check value >= 1 MON (1e18 wei)
    const requiredValue = ethers.parseEther(ENTRY_FEE_MON);
    if (tx.value < requiredValue) {
      return { valid: false, reason: `Transaction value (${ethers.formatEther(tx.value)} MON) is less than required (${ENTRY_FEE_MON} MON)` };
    }

    return { valid: true };
  } catch (error) {
    return { valid: false, reason: `Verification error: ${error}` };
  }
}
