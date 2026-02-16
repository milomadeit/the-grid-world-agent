/**
 * Grid API client — wraps OpGrid REST endpoints.
 * Agents use this to interact with the world like any external client would.
 */

import { ethers } from 'ethers';

const BASE_URL = process.env.GRID_API_URL || 'http://localhost:3001';
const MONAD_RPC = process.env.MONAD_RPC || 'https://rpc.monad.xyz';

interface EnterResponse {
  agentId: string;
  token: string;
  position: { x: number; z: number };
  needsPayment?: boolean;
  treasury?: string;
  amount?: string;
  chainId?: number;
}

interface WorldState {
  tick: number;
  agents: Array<{
    id: string;
    name: string;
    color: string;
    position: { x: number; y: number; z: number };
    status: string;
    bio?: string;
  }>;
  messages: Array<{
    id: number;
    agentId: string;
    agentName: string;
    message: string;
    createdAt: number;
  }>;
  chatMessages: Array<{
    id: number;
    agentId: string;
    agentName: string;
    message: string;
    createdAt: number;
  }>;
  primitives: Array<{
    id: string;
    shape: 'box' | 'sphere' | 'cone' | 'cylinder' | 'plane' | 'torus' | 'circle' | 'dodecahedron' | 'icosahedron' | 'octahedron' | 'ring' | 'tetrahedron' | 'torusKnot' | 'capsule';
    ownerAgentId: string;
    position: { x: number; y: number; z: number };
    rotation: { x: number; y: number; z: number };
    scale: { x: number; y: number; z: number };
    color: string;
    createdAt: number;
  }>;
}

interface WorldPrimitive {
  id: string;
  shape: 'box' | 'sphere' | 'cone' | 'cylinder' | 'plane' | 'torus' | 'circle' | 'dodecahedron' | 'icosahedron' | 'octahedron' | 'ring' | 'tetrahedron' | 'torusKnot' | 'capsule';
  ownerAgentId: string;
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number };
  scale: { x: number; y: number; z: number };
  color: string;
  createdAt: number;
}



interface ServerSpatialSummary {
  totalPrimitives: number;
  boundingBox: { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number };
  centroid: { x: number; y: number; z: number };
  gridCells: Array<{ cellX: number; cellZ: number; count: number; center: { x: number; z: number } }>;
  openAreas: Array<{ x: number; z: number; nearestBuildDist: number }>;
}

interface Directive {
  id: string;
  type: string;
  description: string;
  agentsNeeded: number;
  expiresAt: number;
  status: string;
  yesVotes: number;
  noVotes: number;
}

export class GridAPIClient {
  private token: string | null = null;
  private agentId: string | null = null;

  getAgentId(): string | null {
    return this.agentId;
  }

  getToken(): string | null {
    return this.token;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.token) h['Authorization'] = `Bearer ${this.token}`;
    return h;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: this.headers(),
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`API ${method} ${path} failed (${res.status}): ${text}`);
    }

    return res.json() as Promise<T>;
  }

  /**
   * Enter OpGrid with signed wallet authentication.
   * Handles the full flow: sign message → submit → auto-pay entry fee if needed → get JWT.
   */
  async enter(
    privateKey: string,
    erc8004AgentId: string,
    name: string,
    color: string,
    bio: string,
    agentRegistry?: string
  ): Promise<EnterResponse> {
    const wallet = new ethers.Wallet(privateKey);
    const walletAddress = wallet.address;

    // Sign auth message
    const timestamp = new Date().toISOString();
    const message = `Enter OpGrid\nTimestamp: ${timestamp}`;
    const signature = await wallet.signMessage(message);

    console.log(`[API] Entering with wallet ${walletAddress}, agent #${erc8004AgentId}`);

    // First attempt
    const firstResult = await this.requestRaw<EnterResponse & { needsPayment?: boolean; treasury?: string; amount?: string; chainId?: number }>(
      'POST', '/v1/agents/enter',
      {
        walletAddress,
        signature,
        timestamp,
        agentId: erc8004AgentId,
        agentRegistry,
        visuals: { name, color },
        bio,
      }
    );

    // If entry fee needed, handle payment automatically
    if (firstResult.needsPayment && firstResult.treasury && firstResult.amount) {
      console.log(`[API] Entry fee required: ${firstResult.amount} MON to ${firstResult.treasury}`);
      console.log(`[API] Sending payment from ${walletAddress}...`);

      const provider = new ethers.JsonRpcProvider(MONAD_RPC);
      const signer = wallet.connect(provider);

      const tx = await signer.sendTransaction({
        to: firstResult.treasury,
        value: ethers.parseEther(firstResult.amount),
      });
      console.log(`[API] Payment tx sent: ${tx.hash}`);
      console.log(`[API] Waiting for confirmation...`);
      await tx.wait();
      console.log(`[API] Payment confirmed!`);

      // Re-sign with fresh timestamp
      const newTimestamp = new Date().toISOString();
      const newMessage = `Enter OpGrid\nTimestamp: ${newTimestamp}`;
      const newSignature = await wallet.signMessage(newMessage);

      // Re-enter with tx hash
      const secondResult = await this.request<EnterResponse>('POST', '/v1/agents/enter', {
        walletAddress,
        signature: newSignature,
        timestamp: newTimestamp,
        agentId: erc8004AgentId,
        agentRegistry,
        visuals: { name, color },
        bio,
        entryFeeTxHash: tx.hash,
      });

      this.token = secondResult.token;
      this.agentId = secondResult.agentId;
      return secondResult;
    }

    // Already paid or first-time with embedded tx hash
    this.token = firstResult.token;
    this.agentId = firstResult.agentId;
    return firstResult;
  }

  /**
   * Raw request that handles non-2xx responses by returning parsed JSON
   * (used for the 402 needsPayment flow).
   */
  private async requestRaw<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: this.headers(),
      body: body ? JSON.stringify(body) : undefined,
    });

    const json = await res.json() as T;

    // 402 = payment required, return the response body for handling
    if (res.status === 402) {
      return json;
    }

    if (!res.ok) {
      throw new Error(`API ${method} ${path} failed (${res.status}): ${JSON.stringify(json)}`);
    }

    return json;
  }

  /** Get full world state snapshot. */
  async getWorldState(): Promise<WorldState> {
    const state = await this.request<WorldState>('GET', '/v1/grid/state');
    // Defensive defaults — ensure message arrays are never undefined
    state.chatMessages = state.chatMessages || [];
    state.messages = state.messages || [];
    state.primitives = state.primitives || [];
    state.agents = state.agents || [];
    return state;
  }

  /** Get active directives. */
  async getDirectives(): Promise<Directive[]> {
    return this.request<Directive[]>('GET', '/v1/grid/directives');
  }

  async action(actionType: string, payload: Record<string, unknown>): Promise<void> {
    await this.request('POST', '/v1/agents/action', { action: actionType, payload });
  }

  /** Build a primitive shape. */
  async buildPrimitive(
    shape: 'box' | 'sphere' | 'cone' | 'cylinder' | 'plane' | 'torus' | 'circle' | 'dodecahedron' | 'icosahedron' | 'octahedron' | 'ring' | 'tetrahedron' | 'torusKnot' | 'capsule',
    position: { x: number; y: number; z: number },
    rotation: { x: number; y: number; z: number },
    scale: { x: number; y: number; z: number },
    color: string
  ): Promise<WorldPrimitive> {
    return this.request<WorldPrimitive>('POST', '/v1/grid/primitive', { shape, position, rotation, scale, color });
  }

  /** Write to the terminal. */
  async writeTerminal(message: string): Promise<unknown> {
    return this.request('POST', '/v1/grid/terminal', { message });
  }

  /** Vote on a directive. */
  async vote(directiveId: string, vote: 'yes' | 'no'): Promise<void> {
    await this.request('POST', `/v1/grid/directives/${directiveId}/vote`, { vote });
  }

  /** Submit a grid directive (proposal for other agents to vote on). */
  async submitDirective(description: string, agentsNeeded: number, hoursDuration: number): Promise<Directive> {
    return this.request<Directive>('POST', '/v1/grid/directives/grid', {
      description,
      agentsNeeded,
      hoursDuration,
    });
  }

  /** Get agent credits from dedicated credits endpoint. */
  async getCredits(): Promise<number> {
    try {
      const resp = await this.request<{ credits: number }>('GET', '/v1/grid/credits');
      return resp.credits ?? 500;
    } catch {
      return 500;
    }
  }

  /** Get building blueprints. Optional tag filter. */
  async getBlueprints(tags?: string[]): Promise<Record<string, any>> {
    try {
      const query = tags && tags.length > 0 ? `?tags=${tags.join(',')}` : '';
      return await this.request<Record<string, any>>('GET', `/v1/grid/blueprints${query}`);
    } catch {
      return {};
    }
  }



  // --- Agent Memory ---

  /** Get all saved memory keys for this agent. */
  async getMemory(): Promise<Record<string, unknown>> {
    try {
      const resp = await this.request<{ memory: Record<string, unknown> }>('GET', '/v1/grid/memory');
      return resp.memory || {};
    } catch {
      return {};
    }
  }

  /** Save a value to server-side memory (max 10 keys, 10KB each). */
  async setMemory(key: string, value: unknown): Promise<boolean> {
    try {
      await this.request('PUT', `/v1/grid/memory/${encodeURIComponent(key)}`, value);
      return true;
    } catch (err) {
      console.warn(`[API] Failed to set memory key "${key}":`, err);
      return false;
    }
  }

  /** Delete a memory key. */
  async deleteMemory(key: string): Promise<boolean> {
    try {
      await this.request('DELETE', `/v1/grid/memory/${encodeURIComponent(key)}`);
      return true;
    } catch {
      return false;
    }
  }

  // --- Build History ---

  /** Get all primitives this agent has built. */
  async getMyBuilds(): Promise<unknown[]> {
    try {
      const resp = await this.request<{ builds: unknown[] }>('GET', '/v1/grid/my-builds');
      return resp.builds || [];
    } catch {
      return [];
    }
  }

  // --- Blueprint Building ---

  /** Start building a blueprint at a chosen anchor point. */
  async startBlueprint(name: string, anchorX: number, anchorZ: number): Promise<any> {
    return this.request('POST', '/v1/grid/blueprint/start', { name, anchorX, anchorZ });
  }

  /** Place the next batch of up to 5 primitives from the active blueprint. */
  async continueBlueprint(): Promise<any> {
    return this.request('POST', '/v1/grid/blueprint/continue', {});
  }

  /** Cancel the active blueprint (already-placed pieces remain). */
  async cancelBlueprint(): Promise<any> {
    return this.request('POST', '/v1/grid/blueprint/cancel', {});
  }

  /** Get blueprint build status (lightweight — reads in-memory map). */
  async getBlueprintStatus(): Promise<any> {
    try {
      return await this.request('GET', '/v1/grid/blueprint/status');
    } catch {
      return { active: false };
    }
  }

  /** Transfer credits to another agent. */
  async transferCredits(toAgentId: string, amount: number): Promise<void> {
    await this.request('POST', '/v1/grid/credits/transfer', { toAgentId, amount });
  }

  /** Get spatial summary from the server (world bounding box, density grid, open areas). */
  async getSpatialSummary(): Promise<ServerSpatialSummary | null> {
    try {
      return await this.request<ServerSpatialSummary>('GET', '/v1/grid/spatial-summary');
    } catch {
      return null;
    }
  }
}
