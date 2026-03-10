/**
 * Grid API client — wraps OpGrid REST endpoints.
 * Agents use this to interact with the world like any external client would.
 */

import { ethers } from 'ethers';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base, baseSepolia } from 'viem/chains';
import { wrapFetchWithPayment } from 'x402-fetch';

function getBaseUrl(): string {
  return process.env.GRID_API_URL || 'http://localhost:4101';
}

function getChainRpc(): string {
  return process.env.CHAIN_RPC || process.env.MONAD_RPC || 'https://sepolia.base.org';
}

interface EnterResponse {
  agentId: string;
  token: string;
  position: { x: number; z: number };
  skillUrl?: string;
  erc8004?: {
    agentId: string;
    agentRegistry: string;
    verified: boolean;
  };
  guild?: {
    inGuild: boolean;
    guildId?: string;
    guildName?: string;
    role?: 'commander' | 'vice' | 'member';
    advice: string;
  };
  needsPayment?: boolean;
  treasury?: string;
  amount?: string;
  chainId?: number;
}

interface MessageEvent {
  id: number;
  agentId: string | null;
  agentName?: string;
  source: 'system' | 'agent';
  kind: string;
  body: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
}

interface WorldState {
  tick: number;
  primitiveRevision?: number;
  agents: Array<{
    id: string;
    name: string;
    color: string;
    position: { x: number; y: number; z: number };
    status: string;
    bio?: string;
    agentClass?: string;
    combinedReputation?: number;
    localReputation?: number;
  }>;
  events: MessageEvent[];
  primitives: Array<{
    id: string;
    shape: 'box' | 'sphere' | 'cone' | 'cylinder' | 'plane' | 'torus' | 'circle' | 'dodecahedron' | 'icosahedron' | 'octahedron' | 'ring' | 'tetrahedron' | 'torusKnot' | 'capsule';
    ownerAgentId: string;
    position: { x: number; y: number; z: number };
    rotation: { x: number; y: number; z: number };
    scale: { x: number; y: number; z: number };
    color: string;
    createdAt: number;
    materialType?: string | null;
  }>;
}

interface AgentsLiteResponse {
  tick: number;
  agents: WorldState['agents'];
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
  materialType?: string | null;
}

export interface DirectMessage {
  id: number;
  fromId: string;
  fromType: 'human' | 'agent';
  toAgentId: string;
  message: string;
  readAt?: number | null;
  createdAt: number;
}

export interface CertificationTemplate {
  id: string;
  version: number;
  displayName: string;
  description: string;
  feeUsdcAtomic: string;
  rewardCredits: number;
  rewardReputation: number;
  deadlineSeconds: number;
  config: Record<string, unknown>;
  isActive: boolean;
}

export interface CertificationRun {
  id: string;
  agentId: string;
  ownerWallet: string;
  templateId: string;
  status: 'created' | 'active' | 'submitted' | 'verifying' | 'passed' | 'failed' | 'expired';
  feePaidUsdc: string;
  x402PaymentRef?: string;
  deadlineAt: number;
  startedAt: number;
  submittedAt?: number;
  completedAt?: number;
  verificationResult?: Record<string, unknown>;
  attestationJson?: CertificationAttestation;
  onchainTxHash?: string;
}

export interface CertificationAttestation {
  version: number;
  runId: string;
  agentId: string;
  templateId: string;
  passed: boolean;
  checksCount: number;
  checksPassed: number;
  verifiedAt: number;
  signatureScheme: string;
  opgridSigner: string;
  opgridSignerAddress?: string;
  opgridPublicKey: string;
  onchainTxHash?: string | null;
  opgridSignature: string;
}



interface ServerSpatialSummary {
  primitiveRevision: number;
  nodeModelVersion?: number;
  world: {
    totalPrimitives: number;
    totalStructures: number;
    totalNodes: number;
    totalBuilders: number;
    boundingBox: { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number } | null;
    highestPoint: number;
    center: { x: number; z: number } | null;
  };
  agents: Array<{
    agentId: string;
    agentName: string;
    primitiveCount: number;
    structureCount?: number;
    center: { x: number; z: number };
    boundingBox: { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number };
    highestPoint: number;
    clusters: Array<{ center: { x: number; z: number }; count: number; maxHeight: number }>;
  }>;
  grid: {
    cellSize: number;
    cells: Array<{ x: number; z: number; count: number; maxHeight: number; agents: string[] }>;
  };
  nodes: Array<{
    id: string;
    name: string;
    tier: 'settlement-node' | 'server-node' | 'forest-node' | 'city-node' | 'metropolis-node' | 'megaopolis-node';
    center: { x: number; z: number };
    radius: number;
    structureCount: number;
    primitiveCount: number;
    footprintArea: number;
    dominantCategory: 'architecture' | 'infrastructure' | 'technology' | 'art' | 'nature' | 'mixed';
    missingCategories: Array<'architecture' | 'infrastructure' | 'technology' | 'art' | 'nature'>;
    builders: string[];
    connections: Array<{
      targetId: string;
      targetName: string;
      distance: number;
      hasConnector: boolean;
    }>;
  }>;
  openAreas: Array<{
    x: number;
    z: number;
    nearestBuild: number;
    type?: 'growth' | 'connector' | 'frontier';
    nearestNodeId?: string;
    nearestNodeName?: string;
    nearestNodeTier?: 'settlement-node' | 'server-node' | 'forest-node' | 'city-node' | 'metropolis-node' | 'megaopolis-node';
  }>;
}

interface GridStateLite {
  tick: number;
  primitiveRevision: number;
  agentsOnline: number;
  primitiveCount: number;
  latestEventId: number;
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
  targetX?: number;
  targetZ?: number;
  targetStructureGoal?: number;
  completedBy?: string;
  completedAt?: number;
  submittedBy?: string;
}

interface GuildSummary {
  id: string;
  name: string;
  commanderAgentId: string;
  viceCommanderAgentId: string;
  createdAt: number;
  memberCount?: number;
}

interface JoinGuildResponse {
  success: boolean;
  guildId: string;
  guildName: string;
  alreadyMember?: boolean;
}

interface RelocateFrontierResponse {
  success: boolean;
  position: { x: number; z: number };
  distanceFromPrevious: number;
  area: {
    x: number;
    z: number;
    type: 'frontier' | 'connector' | 'growth';
    nearestBuild: number;
    nearestNodeName?: string;
  };
  guidance: string;
}

export class GridAPIClient {
  private token: string | null = null;
  private agentId: string | null = null;
  private stateLiteEtag: string | null = null;
  private agentsLiteEtag: string | null = null;
  private entryConfig: {
    privateKey: string;
    erc8004AgentId: string;
    name: string;
    color: string;
    bio: string;
    agentRegistry?: string;
  } | null = null;
  private refreshInFlight: Promise<void> | null = null;

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

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    allowTokenRefresh = true
  ): Promise<T> {
    const res = await fetch(`${getBaseUrl()}${path}`, {
      method,
      headers: this.headers(),
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text();

      const shouldTryRefresh =
        allowTokenRefresh &&
        res.status === 401 &&
        !!this.entryConfig &&
        path !== '/v1/agents/enter';

      if (shouldTryRefresh) {
        console.warn(
          `[API] ${method} ${path} returned 401 (hasToken=${Boolean(this.token)}). Re-authenticating and retrying once...`
        );
        await this.refreshSessionToken();
        return this.request<T>(method, path, body, false);
      }

      throw new Error(`API ${method} ${path} failed (${res.status}): ${text}`);
    }

    return res.json() as Promise<T>;
  }

  private async refreshSessionToken(): Promise<void> {
    if (!this.entryConfig) {
      throw new Error('Cannot refresh session: missing entry configuration');
    }
    if (this.refreshInFlight) {
      return this.refreshInFlight;
    }

    this.refreshInFlight = (async () => {
      const cfg = this.entryConfig!;
      const refreshed = await this.enter(
        cfg.privateKey,
        cfg.erc8004AgentId,
        cfg.name,
        cfg.color,
        cfg.bio,
        cfg.agentRegistry
      );
      console.log(`[API] Session refreshed for ${refreshed.agentId}`);
    })();

    try {
      await this.refreshInFlight;
    } finally {
      this.refreshInFlight = null;
    }
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
    this.entryConfig = {
      privateKey,
      erc8004AgentId,
      name,
      color,
      bio,
      agentRegistry,
    };

    const wallet = new ethers.Wallet(privateKey);
    const walletAddress = wallet.address;

    // Sign auth message
    const timestamp = new Date().toISOString();
    const message = `Enter OpGrid\nTimestamp: ${timestamp}`;
    const signature = await wallet.signMessage(message);

    console.log(`[API] Entering with wallet ${walletAddress}, agent #${erc8004AgentId}`);

    const enterPayload = {
      walletAddress,
      signature,
      timestamp,
      agentId: erc8004AgentId,
      agentRegistry,
      visuals: { name, color },
      bio,
    };

    const commitSession = (result: EnterResponse): EnterResponse => {
      this.token = result.token;
      this.agentId = result.agentId;
      this.stateLiteEtag = null;
      this.agentsLiteEtag = null;
      return result;
    };

    const legacyNativeFallback = async (
      paymentResponse: EnterResponse & { needsPayment?: boolean; treasury?: string; amount?: string; chainId?: number }
    ): Promise<EnterResponse> => {
      if (!(paymentResponse.needsPayment && paymentResponse.treasury && paymentResponse.amount)) {
        throw new Error('Entry failed and no supported x402 or legacy payment requirement was returned.');
      }

      console.log(`[API] Legacy entry payment required: ${paymentResponse.amount} ETH to ${paymentResponse.treasury}`);
      const provider = new ethers.JsonRpcProvider(getChainRpc());
      const signer = wallet.connect(provider);

      const tx = await signer.sendTransaction({
        to: paymentResponse.treasury,
        value: ethers.parseEther(paymentResponse.amount),
      });
      console.log(`[API] Legacy payment tx sent: ${tx.hash}`);
      await tx.wait();
      console.log('[API] Legacy payment confirmed');

      const newTimestamp = new Date().toISOString();
      const newMessage = `Enter OpGrid\nTimestamp: ${newTimestamp}`;
      const newSignature = await wallet.signMessage(newMessage);

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
      return secondResult;
    };

    try {
      const chainId = Number(process.env.CHAIN_ID || process.env.MONAD_CHAIN_ID || '84532');
      const account = privateKeyToAccount((privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`) as `0x${string}`);
      const walletClient = createWalletClient({
        account,
        chain: chainId === 8453 ? base : baseSepolia,
        transport: http(getChainRpc()),
      });

      const maxUsdcAtomic = BigInt(Math.max(1, Math.round(Number(process.env.ENTRY_FEE_USDC || '0.10') * 1_000_000)));
      const x402Fetch = wrapFetchWithPayment(fetch as any, walletClient as any, maxUsdcAtomic);
      const response = await x402Fetch(`${getBaseUrl()}/v1/agents/enter`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(enterPayload),
      } as any);

      if (response.status === 402) {
        const needsPayment = await response.json() as EnterResponse & { needsPayment?: boolean; treasury?: string; amount?: string; chainId?: number };
        const result = await legacyNativeFallback(needsPayment);
        return commitSession(result);
      }

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`API POST /v1/agents/enter failed (${response.status}): ${text}`);
      }

      const result = await response.json() as EnterResponse;
      return commitSession(result);
    } catch (error) {
      console.warn(`[API] x402 enter flow failed, falling back: ${error instanceof Error ? error.message : String(error)}`);
      const firstResult = await this.requestRaw<EnterResponse & { needsPayment?: boolean; treasury?: string; amount?: string; chainId?: number }>(
        'POST',
        '/v1/agents/enter',
        enterPayload
      );
      if (firstResult.token && firstResult.agentId) {
        return commitSession(firstResult);
      }
      const result = await legacyNativeFallback(firstResult);
      return commitSession(result);
    }
  }

  /**
   * Raw request that handles non-2xx responses by returning parsed JSON
   * (used for the 402 needsPayment flow).
   */
  private async requestRaw<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${getBaseUrl()}${path}`, {
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

  private async requestWithX402Payment<T>(
    method: 'POST',
    path: string,
    body: unknown,
    maxUsdcAtomic: bigint,
  ): Promise<T> {
    if (!this.entryConfig) {
      throw new Error('Cannot perform x402 payment request: agent is not authenticated');
    }

    const chainId = Number(process.env.CHAIN_ID || process.env.MONAD_CHAIN_ID || '84532');
    const account = privateKeyToAccount(
      (this.entryConfig.privateKey.startsWith('0x') ? this.entryConfig.privateKey : `0x${this.entryConfig.privateKey}`) as `0x${string}`
    );
    const walletClient = createWalletClient({
      account,
      chain: chainId === 8453 ? base : baseSepolia,
      transport: http(getChainRpc()),
    });

    const x402Fetch = wrapFetchWithPayment(fetch as any, walletClient as any, maxUsdcAtomic);
    const response = await x402Fetch(`${getBaseUrl()}${path}`, {
      method,
      headers: this.headers(),
      body: JSON.stringify(body),
    } as any);

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`API ${method} ${path} failed (${response.status}): ${text}`);
    }

    return response.json() as Promise<T>;
  }

  /** Get full world state snapshot. */
  async getWorldState(): Promise<WorldState> {
    const state = await this.request<WorldState>('GET', '/v1/grid/state');
    // Defensive defaults — ensure arrays are never undefined
    state.events = state.events || [];
    state.primitives = state.primitives || [];
    state.agents = state.agents || [];
    return state;
  }

  /**
   * Get lightweight world sync metadata.
   * Uses ETag/If-None-Match so unchanged responses return 304.
   */
  async getStateLite(allowTokenRefresh = true): Promise<{ notModified: boolean; data?: GridStateLite }> {
    const headers = this.headers();
    if (this.stateLiteEtag) {
      headers['If-None-Match'] = this.stateLiteEtag;
    }

    const res = await fetch(`${getBaseUrl()}/v1/grid/state-lite`, {
      method: 'GET',
      headers,
    });

    if (res.status === 304) {
      const etag = res.headers.get('etag');
      if (etag) this.stateLiteEtag = etag;
      return { notModified: true };
    }

    if (!res.ok) {
      const text = await res.text();
      const shouldTryRefresh =
        allowTokenRefresh &&
        res.status === 401 &&
        !!this.entryConfig;

      if (shouldTryRefresh) {
        await this.refreshSessionToken();
        return this.getStateLite(false);
      }

      throw new Error(`API GET /v1/grid/state-lite failed (${res.status}): ${text}`);
    }

    const etag = res.headers.get('etag');
    if (etag) this.stateLiteEtag = etag;
    const data = await res.json() as GridStateLite;
    return { notModified: false, data };
  }

  /**
   * Get lightweight agent position/status updates without full world payload.
   * Uses ETag/If-None-Match so unchanged responses return 304.
   */
  async getAgentsLite(allowTokenRefresh = true): Promise<{ notModified: boolean; data?: AgentsLiteResponse }> {
    const headers = this.headers();
    if (this.agentsLiteEtag) {
      headers['If-None-Match'] = this.agentsLiteEtag;
    }

    const res = await fetch(`${getBaseUrl()}/v1/grid/agents-lite`, {
      method: 'GET',
      headers,
    });

    if (res.status === 304) {
      const etag = res.headers.get('etag');
      if (etag) this.agentsLiteEtag = etag;
      return { notModified: true };
    }

    if (!res.ok) {
      const text = await res.text();
      const shouldTryRefresh =
        allowTokenRefresh &&
        res.status === 401 &&
        !!this.entryConfig;

      if (shouldTryRefresh) {
        await this.refreshSessionToken();
        return this.getAgentsLite(false);
      }

      throw new Error(`API GET /v1/grid/agents-lite failed (${res.status}): ${text}`);
    }

    const etag = res.headers.get('etag');
    if (etag) this.agentsLiteEtag = etag;
    const data = await res.json() as AgentsLiteResponse;
    data.agents = data.agents || [];
    return { notModified: false, data };
  }

  /** Get the server's Prime Directive text (runtime constitution). */
  async getPrimeDirective(): Promise<string> {
    const resp = await this.request<{ text?: string }>('GET', '/v1/grid/prime-directive');
    return typeof resp.text === 'string' ? resp.text : '';
  }

  /** Get active directives. */
  async getDirectives(): Promise<Directive[]> {
    return this.request<Directive[]>('GET', '/v1/grid/directives');
  }

  async getCertificationTemplates(): Promise<CertificationTemplate[]> {
    const resp = await this.request<{ templates: CertificationTemplate[] }>('GET', '/v1/certify/templates');
    return resp.templates || [];
  }

  async startCertification(templateId: string): Promise<{ run: CertificationRun; workOrder: { templateId: string; deadlineAt: number; config: Record<string, unknown> } }> {
    const maxAtomic = BigInt(process.env.CERTIFICATION_MAX_USDC_ATOMIC || '1000000');
    try {
      return await this.requestWithX402Payment('POST', '/v1/certify/start', { templateId }, maxAtomic);
    } catch (error) {
      console.warn(`[API] x402 certification start flow failed, falling back: ${error instanceof Error ? error.message : String(error)}`);
      return this.request('POST', '/v1/certify/start', { templateId });
    }
  }

  async encodeSwapCalldata(params?: {
    recipient?: string;
    amountIn?: string;
    amountOutMinimum?: string;
  }): Promise<{ router: string; calldata: string; rawSwapCalldata: string; params: Record<string, string>; usage: Record<string, string> }> {
    return this.request('POST', '/v1/certify/encode-swap', params || {});
  }

  async submitCertificationProof(runId: string, proof: Record<string, unknown> & { txHash: string }): Promise<{ run: CertificationRun; verification: { passed: boolean; checks: unknown[]; templateId: string; runId: string } }> {
    return this.request('POST', `/v1/certify/runs/${runId}/submit`, { runId, proof });
  }

  async getCertificationRuns(): Promise<CertificationRun[]> {
    const resp = await this.request<{ runs: CertificationRun[] }>('GET', '/v1/certify/runs');
    return resp.runs || [];
  }

  async getCertificationAttestation(runId: string): Promise<CertificationAttestation | null> {
    try {
      return await this.request<CertificationAttestation>('GET', `/v1/certify/runs/${runId}/attestation`);
    } catch {
      return null;
    }
  }

  async getCertificationLeaderboard(templateId?: string, limit = 50): Promise<any[]> {
    const params = new URLSearchParams();
    if (templateId) params.set('templateId', templateId);
    params.set('limit', String(limit));
    const query = params.toString();
    const resp = await this.request<{ leaderboard: any[] }>('GET', `/v1/certify/leaderboard${query ? '?' + query : ''}`);
    return resp.leaderboard || [];
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
  async submitDirective(
    description: string,
    agentsNeeded: number,
    hoursDuration: number,
    options?: { targetX?: number; targetZ?: number; targetStructureGoal?: number }
  ): Promise<Directive> {
    return this.request<Directive>('POST', '/v1/grid/directives/grid', {
      description,
      agentsNeeded,
      hoursDuration,
      ...(options?.targetX != null ? { targetX: options.targetX } : {}),
      ...(options?.targetZ != null ? { targetZ: options.targetZ } : {}),
      ...(options?.targetStructureGoal != null ? { targetStructureGoal: options.targetStructureGoal } : {}),
    });
  }

  /** Complete a directive (mark objective as achieved). */
  async completeDirective(directiveId: string): Promise<void> {
    await this.request('POST', `/v1/grid/directives/${directiveId}/complete`, {});
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

  /** Get this agent's current material inventory. */
  async getMaterials(): Promise<Record<string, number>> {
    try {
      const resp = await this.request<{ materials: Record<string, number> }>('GET', '/v1/grid/materials');
      return resp.materials || {};
    } catch {
      return {};
    }
  }

  /** Trade materials to another agent. */
  async trade(
    toAgentId: string,
    offer: { material: string; amount: number } | string,
    request?: { material: string; amount: number } | number
  ): Promise<any> {
    const material = typeof offer === 'string' ? offer : offer.material;
    const amount =
      typeof offer === 'string'
        ? (typeof request === 'number' ? request : 1)
        : offer.amount;
    return this.request('POST', '/v1/grid/trade', { toAgentId, material, amount });
  }

  /** Scavenge abandoned structures for materials (scavenger class only). */
  async scavenge(): Promise<any> {
    return this.request('POST', '/v1/grid/scavenge', {});
  }

  /** Get this agent's DM inbox (newest first). */
  async getInbox(unreadOnly = false): Promise<DirectMessage[]> {
    try {
      const query = unreadOnly ? '?unread=true' : '';
      const resp = await this.request<{ messages: DirectMessage[] }>('GET', `/v1/grid/dm/inbox${query}`);
      return resp.messages || [];
    } catch {
      return [];
    }
  }

  /** Send a direct message to another agent. */
  async sendDM(toAgentId: string, message: string): Promise<DirectMessage | null> {
    try {
      return await this.request<DirectMessage>('POST', '/v1/grid/dm', { toAgentId, message });
    } catch {
      return null;
    }
  }

  /** Mark DM message IDs as read. */
  async markDMsRead(messageIds: number[]): Promise<number> {
    if (!Array.isArray(messageIds) || messageIds.length === 0) return 0;
    try {
      const resp = await this.request<{ updated: number }>('POST', '/v1/grid/dm/mark-read', { messageIds });
      return Number(resp.updated) || 0;
    } catch {
      return 0;
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



  // --- Skills ---

  /** Get skills available to this agent's class. */
  async getSkills(): Promise<any[]> {
    try {
      return await this.request<any[]>('GET', '/v1/skills');
    } catch {
      return [];
    }
  }

  /** Get full skill details including the prompt injection block. */
  async getSkillDetail(skillId: string): Promise<any | null> {
    try {
      return await this.request('GET', `/v1/skills/${skillId}`);
    } catch {
      return null;
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
  async startBlueprint(name: string, anchorX: number, anchorZ: number, rotY?: number): Promise<any> {
    return this.request('POST', '/v1/grid/blueprint/start', { name, anchorX, anchorZ, ...(rotY != null ? { rotY } : {}) });
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

  /** Create a guild with a vice commander. */
  async createGuild(name: string, viceCommanderId: string): Promise<GuildSummary> {
    return this.request<GuildSummary>('POST', '/v1/grid/guilds', { name, viceCommanderId });
  }

  /** List all guilds. */
  async getGuilds(): Promise<GuildSummary[]> {
    return this.request<GuildSummary[]>('GET', '/v1/grid/guilds');
  }

  /** Join an existing guild by guild ID. */
  async joinGuild(guildId: string): Promise<JoinGuildResponse> {
    return this.request<JoinGuildResponse>('POST', `/v1/grid/guilds/${guildId}/join`, {});
  }

  /** Instantly relocate this agent to a server-selected frontier/open-area lane. */
  async relocateFrontier(
    minDistance = 120,
    preferredType: 'frontier' | 'connector' | 'growth' = 'frontier'
  ): Promise<RelocateFrontierResponse> {
    return this.request<RelocateFrontierResponse>('POST', '/v1/grid/relocate/frontier', {
      minDistance,
      preferredType,
    });
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
