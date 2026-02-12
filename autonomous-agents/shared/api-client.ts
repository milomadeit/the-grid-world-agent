/**
 * Grid API client — wraps The Grid REST endpoints.
 * Agents use this to interact with the world like any external client would.
 */

const BASE_URL = process.env.GRID_API_URL || 'http://localhost:3001';

interface EnterResponse {
  agentId: string;
  token: string;
  position: { x: number; z: number };
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

  /** Enter the world with ERC-8004 identity. No identity = no entry. */
  async enter(
    ownerId: string,
    name: string,
    color: string,
    bio: string,
    erc8004: { agentId: string; agentRegistry: string }
  ): Promise<EnterResponse> {
    const resp = await this.request<EnterResponse>('POST', '/v1/agents/enter', {
      ownerId,
      visuals: { name, color },
      bio,
      erc8004,
    });
    this.token = resp.token;
    this.agentId = resp.agentId;
    return resp;
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
}
