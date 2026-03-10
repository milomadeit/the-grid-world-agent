import { BASE_CHAIN_ID, getOnChainReputation, lookupAgentIdentity, lookupAgentOnChain } from './chain.js';

const BASE_MAINNET_CHAIN_ID = 8453;
const DEFAULT_BASE_SUBGRAPH_ID = '43s9hQRurMGjuYnC1r2ZwS6xSQktbFyXMPMqGKUFJojb';

const graphApiKey = process.env.GRAPH_API_KEY || '';
const configuredSubgraphUrl = process.env.SUBGRAPH_URL || '';
const subgraphId = process.env.SUBGRAPH_ID || (BASE_CHAIN_ID === BASE_MAINNET_CHAIN_ID ? DEFAULT_BASE_SUBGRAPH_ID : '');

function getSubgraphUrl(): string | null {
  if (configuredSubgraphUrl) return configuredSubgraphUrl;
  if (!graphApiKey || !subgraphId) return null;
  return `https://gateway.thegraph.com/api/${graphApiKey}/subgraphs/id/${subgraphId}`;
}

export interface ExternalAgentRecord {
  id: string;
  owner: string;
  agentWallet: string;
  tokenURI?: string;
  registeredAt?: number;
  metadata?: {
    name?: string;
    description?: string;
    image?: string;
  };
  source: 'subgraph' | 'onchain';
}

interface GraphIdentityRecord {
  tokenId?: string;
  id?: string;
  owner?: string;
  agentWallet?: string;
  tokenURI?: string;
  createdAt?: string;
  registeredAt?: string;
}

async function postGraphQL<T>(query: string, variables: Record<string, unknown>): Promise<T | null> {
  const subgraphUrl = getSubgraphUrl();
  if (!subgraphUrl) return null;

  try {
    const response = await fetch(subgraphUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(7000),
    });
    if (!response.ok) return null;
    const json = await response.json() as { data?: T; errors?: unknown[] };
    if (json.errors?.length) return null;
    return json.data || null;
  } catch {
    return null;
  }
}

export async function queryAgent(agentId: string): Promise<ExternalAgentRecord | null> {
  const subgraphData = await postGraphQL<{
    identities?: GraphIdentityRecord[];
    agents?: GraphIdentityRecord[];
  }>(
    `
      query AgentLookup($agentId: String!) {
        identities: identityRegistrations(where: { tokenId: $agentId }, first: 1) {
          tokenId
          owner
          agentWallet
          tokenURI
          createdAt
        }
        agents: agents(where: { tokenId: $agentId }, first: 1) {
          tokenId
          owner
          agentWallet
          tokenURI
          registeredAt
        }
      }
    `,
    { agentId }
  );

  const rec = subgraphData?.identities?.[0] || subgraphData?.agents?.[0];
  if (rec?.owner) {
    return {
      id: rec.tokenId || rec.id || agentId,
      owner: rec.owner,
      agentWallet: rec.agentWallet || '0x0000000000000000000000000000000000000000',
      tokenURI: rec.tokenURI,
      registeredAt: Number(rec.createdAt || rec.registeredAt || 0) || undefined,
      source: 'subgraph',
    };
  }

  const identity = await lookupAgentIdentity(agentId);
  if (!identity) return null;

  return {
    id: agentId,
    owner: identity.owner,
    agentWallet: identity.agentWallet,
    tokenURI: identity.tokenURI,
    source: 'onchain',
  };
}

export async function queryAgentReputation(agentId: string): Promise<{
  count: number;
  summaryValue: number;
  summaryValueDecimals: number;
} | null> {
  return getOnChainReputation(agentId);
}

export async function queryAgentsByCapability(_tag: string): Promise<ExternalAgentRecord[]> {
  // Discovery by capability is subgraph-dependent and optional for now.
  return [];
}

export async function enrichAgentMetadata(agentId: string): Promise<{
  name?: string;
  description?: string;
  image?: string;
}> {
  return (await lookupAgentOnChain(agentId)) || {};
}
