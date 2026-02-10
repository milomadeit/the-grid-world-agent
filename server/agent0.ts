/**
 * Agent0 SDK integration for MonWorld
 * Read-only: agent lookup, reputation, and discovery via the ERC-8004 subgraph
 */
import { SDK, type AgentSummary } from 'agent0-sdk';

const MONAD_CHAIN_ID = 143;
const MONAD_RPC = 'https://rpc.monad.xyz';

let sdk: SDK | null = null;

export function initAgent0(): void {
  try {
    sdk = new SDK({
      chainId: MONAD_CHAIN_ID,
      rpcUrl: MONAD_RPC,
      // Read-only mode — no signer needed for lookups
    });
    console.log('[Agent0] SDK initialized (read-only, chain 143)');
  } catch (error) {
    console.error('[Agent0] Failed to initialize SDK:', error);
  }
}

export function isAgent0Ready(): boolean {
  return sdk !== null;
}

/**
 * Look up agent metadata from the ERC-8004 subgraph.
 * Returns name, description, image, endpoints, OASF taxonomies, etc.
 */
export async function lookupAgent(agentId: string): Promise<AgentSummary | null> {
  if (!sdk) return null;
  try {
    return await sdk.getAgent(agentId);
  } catch (error) {
    console.error(`[Agent0] lookupAgent(${agentId}) failed:`, error);
    return null;
  }
}

/**
 * Get reputation summary for an agent (count + average score).
 * Optionally filter by tag1/tag2.
 */
export async function getAgentReputation(
  agentId: string,
  tag1?: string,
  tag2?: string
): Promise<{ count: number; averageValue: number }> {
  if (!sdk) return { count: 0, averageValue: 0 };
  try {
    return await sdk.getReputationSummary(agentId, tag1, tag2);
  } catch (error) {
    console.error(`[Agent0] getAgentReputation(${agentId}) failed:`, error);
    return { count: 0, averageValue: 0 };
  }
}

/**
 * Search for agents with optional filters.
 */
export async function searchAgents(
  filters?: { name?: string; owners?: string[]; active?: boolean }
): Promise<AgentSummary[]> {
  if (!sdk) return [];
  try {
    return await sdk.searchAgents(filters);
  } catch (error) {
    console.error('[Agent0] searchAgents failed:', error);
    return [];
  }
}

/**
 * Check if a wallet address owns a specific agent.
 */
export async function isAgentOwner(agentId: string, walletAddress: string): Promise<boolean> {
  if (!sdk) return false;
  try {
    return await sdk.isAgentOwner(agentId, walletAddress as `0x${string}`);
  } catch (error) {
    console.error(`[Agent0] isAgentOwner(${agentId}, ${walletAddress}) failed:`, error);
    return false;
  }
}
