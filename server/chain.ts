import { ethers } from 'ethers';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const BASE_MAINNET_CHAIN_ID = 8453;
const BASE_SEPOLIA_CHAIN_ID = 84532;

const BASE_MAINNET_IDENTITY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';
const BASE_MAINNET_REPUTATION = '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63';
const BASE_SEPOLIA_IDENTITY = '0x8004A818BFB912233c491871b3d84c89A494BD9e';
const BASE_SEPOLIA_REPUTATION = '0x8004B663056A597Dffe9eCcC1965A193B7388713';

// Chain configuration — Base defaults to Sepolia for test deployments.
const DEFAULT_CHAIN_RPC = 'https://sepolia.base.org';
export const CHAIN_RPC = process.env.CHAIN_RPC || process.env.MONAD_RPC || DEFAULT_CHAIN_RPC;
export const BASE_CHAIN_ID = parseInt(
  process.env.CHAIN_ID || process.env.MONAD_CHAIN_ID || String(BASE_SEPOLIA_CHAIN_ID),
  10
);

function defaultIdentityRegistryByChain(chainId: number): string {
  if (chainId === BASE_MAINNET_CHAIN_ID) return BASE_MAINNET_IDENTITY;
  if (chainId === BASE_SEPOLIA_CHAIN_ID) return BASE_SEPOLIA_IDENTITY;
  return BASE_SEPOLIA_IDENTITY;
}

function defaultReputationRegistryByChain(chainId: number): string {
  if (chainId === BASE_MAINNET_CHAIN_ID) return BASE_MAINNET_REPUTATION;
  if (chainId === BASE_SEPOLIA_CHAIN_ID) return BASE_SEPOLIA_REPUTATION;
  return BASE_SEPOLIA_REPUTATION;
}

const IDENTITY_REGISTRY_ADDRESS =
  process.env.IDENTITY_REGISTRY || defaultIdentityRegistryByChain(BASE_CHAIN_ID);
const REPUTATION_REGISTRY_ADDRESS =
  process.env.REPUTATION_REGISTRY || defaultReputationRegistryByChain(BASE_CHAIN_ID);
const VALIDATION_REGISTRY_ADDRESS = process.env.VALIDATION_REGISTRY || '';

const GUILD_REGISTRY_ADDRESS = process.env.GUILD_REGISTRY || '';
const BUILDER_CREDITS_ADDRESS = process.env.BUILDER_CREDITS || '';
const DIRECTIVE_REGISTRY_ADDRESS = process.env.DIRECTIVE_REGISTRY || '';
const RELAYER_PK = process.env.RELAYER_PK || '';

// Sniper certification target contract
let SNIPE_TARGET_ADDRESS = process.env.SNIPE_TARGET_ADDRESS || '';

const identityAbi = JSON.parse(
  readFileSync(join(__dirname, 'abis', 'IdentityRegistry.json'), 'utf-8')
);
const reputationAbi = JSON.parse(
  readFileSync(join(__dirname, 'abis', 'ReputationRegistry.json'), 'utf-8')
);
const validationAbi = JSON.parse(
  readFileSync(join(__dirname, 'abis', 'ValidationRegistry.json'), 'utf-8')
);

const guildRegistryAbi = [
  'function createGuild(string name,address lieutenant,uint256 captainAgentTokenId,uint256 lieutenantAgentTokenId) returns (uint256)',
  'function isInGuild(uint256 guildId,address account) view returns (bool)',
  'function isInAnyGuild(address account) view returns (bool)',
  'function setBonusHook(address hook)',
];
const builderCreditsAbi = [
  'function registerAgent(address account)',
  'function consumeCredits(address account,uint256 amount)',
  'function setGuildRegistry(address registry)',
  'function setGuildEventSource(address source)',
  'function setRegistrar(address registrar,bool enabled)',
  'function setSpender(address spender,bool enabled)',
];
const directiveRegistryAbi = [
  'function submitSoloDirective(uint256 proposerAgentTokenId,string objective,uint16 agentsNeeded,int32 x,int32 z,uint32 hoursDuration) returns (uint256)',
  'function submitGuildDirective(uint256 guildId,uint256 proposerAgentTokenId,string objective,uint16 agentsNeeded,int32 x,int32 z,uint32 hoursDuration) returns (uint256)',
  'function vote(uint256 directiveId,uint256 voterAgentTokenId,bool support)',
  'function setGuildRegistry(address registry)',
];

let provider: ethers.JsonRpcProvider | null = null;
let relayer: ethers.Wallet | null = null;
let identityRegistry: ethers.Contract | null = null;
let reputationRegistry: ethers.Contract | null = null;
let validationRegistry: ethers.Contract | null = null;
let guildRegistry: ethers.Contract | null = null;
let builderCredits: ethers.Contract | null = null;
let directiveRegistry: ethers.Contract | null = null;

function chainLabel(chainId: number): string {
  if (chainId === BASE_MAINNET_CHAIN_ID) return 'Base Mainnet';
  if (chainId === BASE_SEPOLIA_CHAIN_ID) return 'Base Sepolia';
  return `Chain ${chainId}`;
}

export function initChain(): void {
  try {
    provider = new ethers.JsonRpcProvider(CHAIN_RPC, BASE_CHAIN_ID);
    identityRegistry = new ethers.Contract(IDENTITY_REGISTRY_ADDRESS, identityAbi, provider);

    if (RELAYER_PK) {
      const pk = RELAYER_PK.startsWith('0x') ? RELAYER_PK : `0x${RELAYER_PK}`;
      relayer = new ethers.Wallet(pk, provider);
    }

    const signerOrProvider = relayer || provider;
    reputationRegistry = new ethers.Contract(REPUTATION_REGISTRY_ADDRESS, reputationAbi, signerOrProvider);
    if (VALIDATION_REGISTRY_ADDRESS) {
      validationRegistry = new ethers.Contract(VALIDATION_REGISTRY_ADDRESS, validationAbi, signerOrProvider);
    }
    if (GUILD_REGISTRY_ADDRESS) {
      guildRegistry = new ethers.Contract(GUILD_REGISTRY_ADDRESS, guildRegistryAbi, signerOrProvider);
    }
    if (BUILDER_CREDITS_ADDRESS) {
      builderCredits = new ethers.Contract(BUILDER_CREDITS_ADDRESS, builderCreditsAbi, signerOrProvider);
    }
    if (DIRECTIVE_REGISTRY_ADDRESS) {
      directiveRegistry = new ethers.Contract(DIRECTIVE_REGISTRY_ADDRESS, directiveRegistryAbi, signerOrProvider);
    }

    console.log(`[Chain] Connected to ${chainLabel(BASE_CHAIN_ID)} (read${relayer ? '/write' : '-only'})`);
    console.log(`[Chain] IdentityRegistry: ${IDENTITY_REGISTRY_ADDRESS}`);
    console.log(`[Chain] ReputationRegistry: ${REPUTATION_REGISTRY_ADDRESS}`);
    if (validationRegistry) console.log(`[Chain] ValidationRegistry: ${VALIDATION_REGISTRY_ADDRESS}`);

    if (guildRegistry) console.log(`[Chain] GuildRegistry: ${GUILD_REGISTRY_ADDRESS}`);
    if (builderCredits) console.log(`[Chain] BuilderCredits: ${BUILDER_CREDITS_ADDRESS}`);
    if (directiveRegistry) console.log(`[Chain] DirectiveRegistry: ${DIRECTIVE_REGISTRY_ADDRESS}`);
  } catch (error) {
    console.error('[Chain] Failed to initialize provider:', error);
  }
}

export function isChainInitialized(): boolean {
  return provider !== null;
}

export function getIdentityRegistryAddress(): string {
  return IDENTITY_REGISTRY_ADDRESS;
}

export function getReputationRegistryAddress(): string {
  return REPUTATION_REGISTRY_ADDRESS;
}

export function getValidationRegistryAddress(): string {
  return VALIDATION_REGISTRY_ADDRESS;
}

export function getChainProvider(): ethers.JsonRpcProvider | null {
  return provider;
}

export function getRelayerWallet(): ethers.Wallet | null {
  return relayer;
}

export function isBaseSepolia(): boolean {
  return BASE_CHAIN_ID === BASE_SEPOLIA_CHAIN_ID;
}

/**
 * Verify that a wallet address owns or is the agentWallet for a given agentId.
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
  const owner: string = await identityRegistry.ownerOf(tokenId);
  const ownerLower = owner.toLowerCase();
  const agentWallet: string = await identityRegistry.getAgentWallet(tokenId);
  const agentWalletLower = agentWallet.toLowerCase();

  const verified =
    normalizedWallet === ownerLower ||
    (agentWalletLower !== ethers.ZeroAddress.toLowerCase() && normalizedWallet === agentWalletLower);

  return { verified, owner, agentWallet };
}

/**
 * Fetch identity details for an ERC-8004 agent from the IdentityRegistry.
 */
export async function lookupAgentIdentity(
  agentId: string
): Promise<{ owner: string; agentWallet: string; tokenURI: string } | null> {
  if (!identityRegistry) return null;
  try {
    const tokenId = BigInt(agentId);
    const [owner, agentWallet, tokenURI] = await Promise.all([
      identityRegistry.ownerOf(tokenId),
      identityRegistry.getAgentWallet(tokenId),
      identityRegistry.tokenURI(tokenId),
    ]);
    return { owner, agentWallet, tokenURI };
  } catch {
    return null;
  }
}

/**
 * Get on-chain reputation summary for an agent.
 */
export async function getOnChainReputation(
  agentId: string
): Promise<{ count: number; summaryValue: number; summaryValueDecimals: number } | null> {
  if (!reputationRegistry) {
    return null;
  }

  try {
    const tokenId = BigInt(agentId);
    const clients: string[] = [...await reputationRegistry.getClients(tokenId)];

    if (clients.length === 0) {
      return { count: 0, summaryValue: 0, summaryValueDecimals: 0 };
    }

    const [count, summaryValue, summaryValueDecimals] = await reputationRegistry.getSummary(
      tokenId,
      clients,
      '',
      ''
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

/**
 * Look up and parse tokenURI metadata.
 */
export async function lookupAgentOnChain(
  agentId: string
): Promise<{ name?: string; description?: string; image?: string } | null> {
  const identity = await lookupAgentIdentity(agentId);
  if (!identity?.tokenURI) return null;

  try {
    const uri = identity.tokenURI;
    let jsonStr: string;

    if (uri.startsWith('data:application/json;base64,')) {
      jsonStr = Buffer.from(uri.split(',')[1], 'base64').toString('utf-8');
    } else if (uri.startsWith('data:application/json,')) {
      jsonStr = decodeURIComponent(uri.split(',')[1]);
    } else {
      const fetchUrl = uri.startsWith('ipfs://')
        ? `https://ipfs.io/ipfs/${uri.slice(7)}`
        : uri;
      const res = await fetch(fetchUrl, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return null;
      jsonStr = await res.text();
    }

    const metadata = JSON.parse(jsonStr);
    return {
      name: metadata.name || undefined,
      description: metadata.description || undefined,
      image: metadata.image || undefined
    };
  } catch (error) {
    console.error(`[Chain] Failed to lookup agent ${agentId} metadata:`, error);
    return null;
  }
}

// --- Entry Fee Configuration ---

export const TREASURY_ADDRESS = process.env.TREASURY_ADDRESS || '0xb09D74ACF784a5D59Bbb3dBfD504Ce970bFB7BC6';
export const ENTRY_FEE_ETH = process.env.ENTRY_FEE_ETH || process.env.ENTRY_FEE_MON || '0.001';

/**
 * Verify a native-ETH fallback entry payment.
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

    if (tx.from.toLowerCase() !== expectedFromAddress.toLowerCase()) {
      return { valid: false, reason: `Transaction sender (${tx.from}) does not match wallet (${expectedFromAddress})` };
    }

    if (!tx.to || tx.to.toLowerCase() !== TREASURY_ADDRESS.toLowerCase()) {
      return { valid: false, reason: 'Transaction recipient is not the treasury' };
    }

    const requiredValue = ethers.parseEther(ENTRY_FEE_ETH);
    if (tx.value < requiredValue) {
      return {
        valid: false,
        reason: `Transaction value (${ethers.formatEther(tx.value)} ETH) is less than required (${ENTRY_FEE_ETH} ETH)`,
      };
    }

    return { valid: true };
  } catch (error) {
    return { valid: false, reason: `Verification error: ${error}` };
  }
}

function requireContractWrite(contract: ethers.Contract | null, label: string): ethers.Contract {
  if (!provider) throw new Error('Chain not initialized');
  if (!contract) throw new Error(`${label} is not configured`);
  if (!relayer) throw new Error(`RELAYER_PK is required to write to ${label}`);
  return contract;
}

function getCertificationTag1(_templateId: string): string {
  return 'certification';
}

function toCertificationRequestHash(runId: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(runId));
}

function toResponseHash(attestationJson: unknown): string {
  return ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(attestationJson)));
}

export async function publishCertificationValidationRequestOnChain(params: {
  runId: string;
  agentTokenId: string;
  requestURI: string;
}): Promise<{ txHash: string; requestHash: string } | null> {
  if (!validationRegistry || !relayer) {
    console.warn('[Chain] Skipping ValidationRegistry request publish (VALIDATION_REGISTRY or RELAYER_PK missing)');
    return null;
  }

  try {
    const c = requireContractWrite(validationRegistry, 'VALIDATION_REGISTRY');
    const requestHash = toCertificationRequestHash(params.runId);
    const tx = await c.validationRequest(relayer.address, BigInt(params.agentTokenId), params.requestURI, requestHash);
    return { txHash: tx.hash, requestHash };
  } catch (error) {
    console.warn('[Chain] Validation request publish failed (continuing locally):', error);
    return null;
  }
}

export async function publishCertificationFeedbackOnChain(params: {
  runId: string;
  agentTokenId: string;
  templateId: string;
  score: number;
  feedbackURI: string;
  attestationJson: unknown;
}): Promise<{ txHash: string } | null> {
  if (!reputationRegistry || !relayer) {
    console.warn('[Chain] Skipping ReputationRegistry publish (REPUTATION_REGISTRY or RELAYER_PK missing)');
    return null;
  }

  try {
    const c = requireContractWrite(reputationRegistry, 'REPUTATION_REGISTRY');
    const feedbackHash = toResponseHash(params.attestationJson);
    // value = score (0-100 quality rating per ERC-8004 best practices)
    const feedbackValue = Math.min(100, Math.max(0, Math.round(params.score)));
    const tx = await c.giveFeedback(
      BigInt(params.agentTokenId),
      BigInt(feedbackValue),
      0,
      getCertificationTag1(params.templateId),
      params.templateId,
      '',
      params.feedbackURI,
      feedbackHash
    );
    return { txHash: tx.hash };
  } catch (error) {
    console.warn('[Chain] Reputation feedback publish failed (continuing locally):', error);
    return null;
  }
}

export async function publishCertificationValidationOnChain(params: {
  runId: string;
  agentTokenId: string;
  templateId: string;
  score: number;
  responseURI: string;
  attestationJson: unknown;
}): Promise<{ txHash: string; requestHash: string; responseHash: string } | null> {
  if (!validationRegistry || !relayer) {
    console.warn('[Chain] Skipping ValidationRegistry publish (VALIDATION_REGISTRY or RELAYER_PK missing)');
    return null;
  }

  try {
    const c = requireContractWrite(validationRegistry, 'VALIDATION_REGISTRY');
    const requestHash = toCertificationRequestHash(params.runId);
    const responseHash = toResponseHash(params.attestationJson);
    const score = Math.min(100, Math.max(0, Math.round(params.score)));

    const tx = await c.validationResponse(
      requestHash,
      score,
      params.responseURI,
      responseHash,
      params.templateId
    );

    return { txHash: tx.hash, requestHash, responseHash };
  } catch (error) {
    console.warn('[Chain] Validation response publish failed (continuing locally):', error);
    return null;
  }
}

export async function syncGuildOnChain(params: {
  name: string;
  lieutenant: string;
  captainAgentTokenId: number;
  lieutenantAgentTokenId: number;
}): Promise<{ txHash: string } | null> {
  if (!guildRegistry) return null;
  const c = requireContractWrite(guildRegistry, 'GUILD_REGISTRY');
  const tx = await c.createGuild(
    params.name,
    params.lieutenant,
    BigInt(params.captainAgentTokenId),
    BigInt(params.lieutenantAgentTokenId)
  );
  return { txHash: tx.hash };
}

export async function syncCreditsOnChain(params: {
  mode: 'register' | 'consume';
  account: string;
  amount?: number;
}): Promise<{ txHash: string } | null> {
  if (!builderCredits) return null;
  const c = requireContractWrite(builderCredits, 'BUILDER_CREDITS');
  if (params.mode === 'register') {
    const tx = await c.registerAgent(params.account);
    return { txHash: tx.hash };
  }
  const tx = await c.consumeCredits(params.account, BigInt(params.amount || 0));
  return { txHash: tx.hash };
}

export async function submitDirectiveOnChain(params: {
  kind: 'solo' | 'guild';
  proposerAgentTokenId: number;
  objective: string;
  agentsNeeded: number;
  x: number;
  z: number;
  hoursDuration: number;
  guildId?: number;
}): Promise<{ txHash: string } | null> {
  if (!directiveRegistry) return null;
  const c = requireContractWrite(directiveRegistry, 'DIRECTIVE_REGISTRY');
  if (params.kind === 'guild') {
    const tx = await c.submitGuildDirective(
      BigInt(params.guildId || 0),
      BigInt(params.proposerAgentTokenId),
      params.objective,
      Number(params.agentsNeeded),
      Math.trunc(params.x),
      Math.trunc(params.z),
      Number(params.hoursDuration)
    );
    return { txHash: tx.hash };
  }
  const tx = await c.submitSoloDirective(
    BigInt(params.proposerAgentTokenId),
    params.objective,
    Number(params.agentsNeeded),
    Math.trunc(params.x),
    Math.trunc(params.z),
    Number(params.hoursDuration)
  );
  return { txHash: tx.hash };
}

// --- Sniper Certification ---

export function getSnipeTargetAddress(): string {
  return SNIPE_TARGET_ADDRESS;
}

/**
 * Activate a sniper target (called by cert flow after random delay).
 * The relayer calls activateTarget(bytes32) on the pre-deployed SnipeTarget contract.
 */
export async function activateSnipeTarget(runId: string): Promise<{ txHash: string; activationBlock: number } | null> {
  if (!SNIPE_TARGET_ADDRESS || !relayer) {
    console.warn('[Chain] Cannot activate snipe target (SNIPE_TARGET_ADDRESS or RELAYER_PK missing)');
    return null;
  }

  const snipeAbi = JSON.parse(
    readFileSync(join(__dirname, 'abis', 'SnipeTarget.json'), 'utf-8')
  );
  const contract = new ethers.Contract(SNIPE_TARGET_ADDRESS, snipeAbi, relayer);

  // Convert runId to bytes32
  const runIdBytes32 = ethers.id(runId);

  const tx = await contract.activateTarget(runIdBytes32);
  const receipt = await tx.wait();

  return {
    txHash: tx.hash,
    activationBlock: receipt.blockNumber,
  };
}

/**
 * Read snipe result from the SnipeTarget contract for a given runId.
 */
export async function readSnipeResult(runId: string): Promise<{
  activationBlock: number;
  sniper: string;
  snipedBlock: number;
} | null> {
  if (!SNIPE_TARGET_ADDRESS || !provider) return null;

  const snipeAbi = JSON.parse(
    readFileSync(join(__dirname, 'abis', 'SnipeTarget.json'), 'utf-8')
  );
  const contract = new ethers.Contract(SNIPE_TARGET_ADDRESS, snipeAbi, provider);

  const runIdBytes32 = ethers.id(runId);

  const [activationBlock, sniper, snipedBlock] = await Promise.all([
    contract.activationBlock(runIdBytes32),
    contract.sniped(runIdBytes32),
    contract.snipedBlock(runIdBytes32),
  ]);

  return {
    activationBlock: Number(activationBlock),
    sniper: sniper,
    snipedBlock: Number(snipedBlock),
  };
}
