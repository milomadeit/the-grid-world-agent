import { ethers } from 'ethers';

const RPC_URL = process.env.MONAD_RPC || 'https://rpc.monad.xyz';
const CHAIN_ID = parseInt(process.env.MONAD_CHAIN_ID || '143', 10);
const DIRECTIVE_REGISTRY_ADDRESS = process.env.DIRECTIVE_REGISTRY || '';
const DIRECTIVE_RELAYER_PK = process.env.DIRECTIVE_RELAYER_PK || '';

const DIRECTIVE_ABI = [
  'event DirectiveSubmitted(uint256 indexed directiveId, uint8 indexed kind, uint256 indexed guildId, address proposer, uint256 proposerAgentTokenId, string objective, uint16 agentsNeeded, int32 x, int32 z, uint64 expiresAt)',
  'event DirectiveVoted(uint256 indexed directiveId, address indexed voter, uint256 voterAgentTokenId, bool support, uint32 yesVotes, uint32 noVotes)',
  'event DirectiveActivated(uint256 indexed directiveId, uint32 yesVotes, uint16 threshold)',
  'function totalDirectives() view returns (uint256)',
  'function directiveInfo(uint256 directiveId) view returns ((uint256 id,uint8 kind,uint256 guildId,address proposer,uint256 proposerAgentTokenId,string objective,uint16 agentsNeeded,int32 x,int32 z,uint64 createdAt,uint64 expiresAt,uint8 status,uint32 yesVotes,uint32 noVotes))',
  'function getAllDirectiveData(uint256 offset,uint256 limit) view returns ((uint256 id,uint8 kind,uint256 guildId,address proposer,uint256 proposerAgentTokenId,string objective,uint16 agentsNeeded,int32 x,int32 z,uint64 createdAt,uint64 expiresAt,uint8 status,uint32 yesVotes,uint32 noVotes)[] page,uint256 totalCount)',
  'function submitSoloDirective(uint256 proposerAgentTokenId,string objective,uint16 agentsNeeded,int32 x,int32 z,uint32 hoursDuration) returns (uint256)',
  'function submitGuildDirective(uint256 guildId,uint256 proposerAgentTokenId,string objective,uint16 agentsNeeded,int32 x,int32 z,uint32 hoursDuration) returns (uint256)',
  'function vote(uint256 directiveId,uint256 voterAgentTokenId,bool support)',
] as const;

export type OnchainDirectiveKind = 'solo' | 'guild';
export type OnchainDirectiveStatus = 'open' | 'active' | 'completed' | 'expired' | 'cancelled';

export interface OnchainDirective {
  id: number;
  kind: OnchainDirectiveKind;
  guildId: number;
  proposer: string;
  proposerAgentTokenId: string;
  objective: string;
  agentsNeeded: number;
  x: number;
  z: number;
  createdAt: number;
  expiresAt: number;
  status: OnchainDirectiveStatus;
  yesVotes: number;
  noVotes: number;
}

export interface OnchainTxResult {
  txHash: string;
  blockNumber: number;
  directiveId?: number;
}

let provider: ethers.JsonRpcProvider | null = null;
let readContract: ethers.Contract | null = null;
let writeContract: ethers.Contract | null = null;
let iface: ethers.Interface | null = null;

function mapKind(kind: number): OnchainDirectiveKind {
  return kind === 1 ? 'guild' : 'solo';
}

function mapStatus(status: number): OnchainDirectiveStatus {
  if (status === 1) return 'active';
  if (status === 2) return 'completed';
  if (status === 3) return 'expired';
  if (status === 4) return 'cancelled';
  return 'open';
}

function toNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  return Number(value ?? 0);
}

function toDirective(raw: any): OnchainDirective {
  return {
    id: toNumber(raw.id),
    kind: mapKind(toNumber(raw.kind)),
    guildId: toNumber(raw.guildId),
    proposer: String(raw.proposer),
    proposerAgentTokenId: String(raw.proposerAgentTokenId),
    objective: String(raw.objective),
    agentsNeeded: toNumber(raw.agentsNeeded),
    x: toNumber(raw.x),
    z: toNumber(raw.z),
    createdAt: toNumber(raw.createdAt) * 1000,
    expiresAt: toNumber(raw.expiresAt) * 1000,
    status: mapStatus(toNumber(raw.status)),
    yesVotes: toNumber(raw.yesVotes),
    noVotes: toNumber(raw.noVotes),
  };
}

function parseDirectiveIdFromReceipt(receipt: ethers.TransactionReceipt): number | undefined {
  if (!iface) return undefined;
  for (const log of receipt.logs) {
    try {
      const parsed = iface.parseLog(log);
      if (parsed && parsed.name === 'DirectiveSubmitted') {
        return toNumber(parsed.args.directiveId);
      }
    } catch {
      // Ignore logs from other contracts.
    }
  }
  return undefined;
}

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function initDirectiveChain(): void {
  if (!DIRECTIVE_REGISTRY_ADDRESS) {
    console.log('[DirectiveChain] DIRECTIVE_REGISTRY not configured. Onchain directive endpoints disabled.');
    return;
  }

  try {
    provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID);
    readContract = new ethers.Contract(DIRECTIVE_REGISTRY_ADDRESS, DIRECTIVE_ABI, provider);
    iface = new ethers.Interface(DIRECTIVE_ABI);

    if (DIRECTIVE_RELAYER_PK) {
      const wallet = new ethers.Wallet(DIRECTIVE_RELAYER_PK, provider);
      writeContract = new ethers.Contract(DIRECTIVE_REGISTRY_ADDRESS, DIRECTIVE_ABI, wallet);
      console.log('[DirectiveChain] Write mode enabled (relayer configured).');
    } else {
      writeContract = null;
      console.log('[DirectiveChain] Read-only mode enabled (no DIRECTIVE_RELAYER_PK).');
    }

    console.log(`[DirectiveChain] Connected to contract ${DIRECTIVE_REGISTRY_ADDRESS} on chain ${CHAIN_ID}`);
  } catch (error) {
    console.error('[DirectiveChain] Failed to initialize:', error);
    provider = null;
    readContract = null;
    writeContract = null;
    iface = null;
  }
}

export function isDirectiveChainEnabled(): boolean {
  return readContract !== null;
}

export function isDirectiveWriteEnabled(): boolean {
  return writeContract !== null;
}

export async function getOnchainDirective(
  directiveId: number
): Promise<OnchainDirective> {
  if (!readContract) {
    throw new Error('Onchain directive contract not configured');
  }
  const raw = await readContract.directiveInfo(BigInt(directiveId));
  return toDirective(raw);
}

export async function getOnchainDirectivesPage(
  offset: number,
  limit: number
): Promise<{ directives: OnchainDirective[]; totalCount: number }> {
  if (!readContract) {
    throw new Error('Onchain directive contract not configured');
  }
  const [page, totalCount] = await readContract.getAllDirectiveData(BigInt(offset), BigInt(limit));
  return {
    directives: Array.isArray(page) ? page.map(toDirective) : [],
    totalCount: toNumber(totalCount),
  };
}

export async function submitOnchainSoloDirective(args: {
  proposerAgentTokenId: string;
  objective: string;
  agentsNeeded: number;
  x: number;
  z: number;
  hoursDuration: number;
}): Promise<OnchainTxResult> {
  if (!writeContract) {
    throw new Error('Onchain directive write mode disabled (missing DIRECTIVE_RELAYER_PK)');
  }
  try {
    const tx = await writeContract.submitSoloDirective(
      BigInt(args.proposerAgentTokenId),
      args.objective,
      args.agentsNeeded,
      args.x,
      args.z,
      args.hoursDuration
    );
    const mined = await tx.wait();
    if (!mined) {
      throw new Error('Directive tx not mined');
    }
    return {
      txHash: tx.hash,
      blockNumber: toNumber(mined.blockNumber),
      directiveId: parseDirectiveIdFromReceipt(mined),
    };
  } catch (error) {
    throw new Error(`submitOnchainSoloDirective failed: ${extractErrorMessage(error)}`);
  }
}

export async function submitOnchainGuildDirective(args: {
  guildId: number;
  proposerAgentTokenId: string;
  objective: string;
  agentsNeeded: number;
  x: number;
  z: number;
  hoursDuration: number;
}): Promise<OnchainTxResult> {
  if (!writeContract) {
    throw new Error('Onchain directive write mode disabled (missing DIRECTIVE_RELAYER_PK)');
  }
  try {
    const tx = await writeContract.submitGuildDirective(
      args.guildId,
      BigInt(args.proposerAgentTokenId),
      args.objective,
      args.agentsNeeded,
      args.x,
      args.z,
      args.hoursDuration
    );
    const mined = await tx.wait();
    if (!mined) {
      throw new Error('Directive tx not mined');
    }
    return {
      txHash: tx.hash,
      blockNumber: toNumber(mined.blockNumber),
      directiveId: parseDirectiveIdFromReceipt(mined),
    };
  } catch (error) {
    throw new Error(`submitOnchainGuildDirective failed: ${extractErrorMessage(error)}`);
  }
}

export async function voteOnchainDirective(args: {
  directiveId: number;
  voterAgentTokenId: string;
  support: boolean;
}): Promise<OnchainTxResult> {
  if (!writeContract) {
    throw new Error('Onchain directive write mode disabled (missing DIRECTIVE_RELAYER_PK)');
  }
  try {
    const tx = await writeContract.vote(
      args.directiveId,
      BigInt(args.voterAgentTokenId),
      args.support
    );
    const mined = await tx.wait();
    if (!mined) {
      throw new Error('Directive vote tx not mined');
    }
    return {
      txHash: tx.hash,
      blockNumber: toNumber(mined.blockNumber),
      directiveId: args.directiveId,
    };
  } catch (error) {
    throw new Error(`voteOnchainDirective failed: ${extractErrorMessage(error)}`);
  }
}
