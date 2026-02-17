import { io, Socket } from 'socket.io-client';
import { useWorldStore } from '../store';
import type { Agent, WorldPrimitive, TerminalMessage } from '../types';

// In production, use same origin (server serves frontend). In dev, use localhost:3001.
const SERVER_URL = import.meta.env.VITE_SERVER_URL ||
  (typeof window !== 'undefined' && !window.location.hostname.includes('localhost')
    ? window.location.origin
    : 'http://localhost:3001');

interface WorldSnapshot {
  tick: number;
  primitiveRevision?: number;
  agents: Array<{
    id: string;
    name: string;
    color: string;
    x: number;
    y: number;
    z: number;
    status: string;
    inventory: Record<string, number>;
    bio?: string;
    erc8004AgentId?: string;
    erc8004Registry?: string;
    reputationScore?: number;
  }>;
  primitives: WorldPrimitive[];
  terminalMessages: TerminalMessage[];
  chatMessages: TerminalMessage[];
}

interface WorldUpdate {
  tick: number;
  updates: Array<{
    id: string;
    x: number;
    y: number;
    z: number;
    status?: string;
  }>;
}

interface ChatMessage {
  agentId: string;
  agentName: string;
  message: string;
  timestamp: number;
}

interface WorldRevisionEvent {
  primitiveRevision: number;
  reason?: 'primitive:created' | 'primitive:deleted' | 'primitives:sync';
}

export interface ERC8004Input {
  agentId: string;
  agentRegistry: string;
}

export interface EnterWorldResponse {
  agentId: string;
  position: { x: number; z: number };
  token: string;
  erc8004?: { agentId: string; agentRegistry: string };
}

class SocketService {
  private socket: Socket | null = null;
  private authToken: string | null = null;
  private agentId: string | null = null;

  // Register agent via REST API, returns token for WebSocket auth
  async enterWorld(ownerId: string, visuals?: { name?: string; color?: string }, erc8004?: ERC8004Input, bio?: string, signature?: string, timestamp?: string): Promise<EnterWorldResponse> {
    const body: Record<string, unknown> = {
      walletAddress: ownerId,
      signature,
      timestamp,
      visuals,
    };
    if (erc8004) {
      body.agentId = erc8004.agentId;
      body.agentRegistry = erc8004.agentRegistry;
    }
    if (bio) {
      body.bio = bio;
    }

    const response = await fetch(`${SERVER_URL}/v1/agents/enter`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error(error.error || `Failed to enter world: ${response.status}`);
    }

    const data: EnterWorldResponse = await response.json();
    this.authToken = data.token;
    this.agentId = data.agentId;
    return data;
  }

  // Connect as spectator (no auth required) — receive world updates, can't act
  connectSpectator(): Promise<void> {
    return this.connectInternal();
  }

  // Connect to WebSocket with auth token
  connect(token?: string): Promise<void> {
    const authToken = token || this.authToken;

    if (!authToken) {
      return Promise.reject(new Error('No auth token. Call enterWorld() first.'));
    }

    return this.connectInternal(authToken);
  }

  private connectInternal(authToken?: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.socket?.connected) {
        console.log('[Socket] Already connected');
        resolve();
        return;
      }

      const mode = authToken ? 'authenticated' : 'spectator';
      console.log(`[Socket] Connecting to ${SERVER_URL} (${mode})...`);

      const opts: Record<string, unknown> = {
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionAttempts: 5,
        reconnectionDelay: 1000,
      };

      if (authToken) {
        opts.auth = { token: authToken };
        opts.query = { token: authToken };
      }

      this.socket = io(SERVER_URL, opts);

      const connectTimeout = setTimeout(() => {
        reject(new Error('Connection timeout'));
      }, 10000);

      this.socket.on('connect', () => {
        clearTimeout(connectTimeout);
        console.log(`[Socket] Connected (${mode})`);
        resolve();
      });

      this.socket.on('connect_error', (error) => {
        clearTimeout(connectTimeout);
        console.error('[Socket] Connection error:', error.message);
        reject(new Error(`Connection failed: ${error.message}`));
      });

      this.setupListeners();
    });
  }

  private setupListeners(): void {
    if (!this.socket) return;

    this.socket.on('disconnect', (reason) => {
      console.log(`[Socket] Disconnected: ${reason}`);
      useWorldStore.getState().addEvent('Disconnected from server.');
    });

    // Handle initial world snapshot
    this.socket.on('world:snapshot', (data: WorldSnapshot) => {
      console.log(`[Socket] Received world snapshot: ${data.agents.length} agents at tick ${data.tick}`);

      const agents: Agent[] = data.agents.map(a => ({
        id: a.id,
        name: a.name,
        color: a.color,
        position: { x: a.x, y: a.y, z: a.z },
        targetPosition: { x: a.x, y: a.y, z: a.z },
        status: a.status as 'idle' | 'moving' | 'acting',
        inventory: a.inventory,
        bio: a.bio,
        erc8004AgentId: a.erc8004AgentId,
        erc8004Registry: a.erc8004Registry,
        reputationScore: a.reputationScore
      }));

      useWorldStore.getState().setAgents(agents);
      useWorldStore.getState().setWorldPrimitives(data.primitives || []);
      if (typeof data.primitiveRevision === 'number') {
        useWorldStore.getState().setPrimitiveRevision(data.primitiveRevision);
      }
      useWorldStore.getState().setTerminalMessages(data.terminalMessages);
      useWorldStore.getState().setChatMessages(data.chatMessages || []);
    });

    // Handle world updates — batch all agent updates into a single state change
    this.socket.on('world:update', (data: WorldUpdate) => {
      const store = useWorldStore.getState();

      const batch = data.updates.map(update => ({
        id: update.id,
        changes: {
          position: { x: update.x, y: update.y, z: update.z },
          ...(update.status && { status: update.status as 'idle' | 'moving' | 'acting' })
        } as Partial<Agent>
      }));

      store.batchUpdateAgents(batch);
    });

    // Handle agent join/leave
    this.socket.on('agent:joined', (data: {
      id: string;
      name: string;
      color: string;
      x: number;
      y: number;
      z: number;
      status: string;
      inventory: Record<string, number>;
      bio?: string;
      erc8004AgentId?: string;
      erc8004Registry?: string;
      reputationScore?: number;
    }) => {
      console.log(`[Socket] Agent joined: ${data.name}`);
      useWorldStore.getState().addAgent({
        id: data.id,
        name: data.name,
        color: data.color,
        position: { x: data.x, y: data.y, z: data.z },
        targetPosition: { x: data.x, y: data.y, z: data.z },
        status: data.status as 'idle' | 'moving' | 'acting',
        inventory: data.inventory,
        bio: data.bio,
        erc8004AgentId: data.erc8004AgentId,
        erc8004Registry: data.erc8004Registry,
        reputationScore: data.reputationScore
      });
    });

    this.socket.on('agent:left', (data: { id: string }) => {
      console.log(`[Socket] Agent left: ${data.id}`);
      useWorldStore.getState().removeAgent(data.id);
    });

    // Handle Chat events
    this.socket.on('chat:message', (data: ChatMessage) => {
      // Add to general messages
      useWorldStore.getState().addMessage({
        sender: data.agentName,
        content: data.message,
        timestamp: data.timestamp
      });
      // Add to chat messages
      useWorldStore.getState().addChatMessage({
        id: Date.now(),
        agentId: data.agentId,
        agentName: data.agentName,
        message: data.message,
        createdAt: data.timestamp
      });
    });

    // Handle Grid events
    this.socket.on('primitive:created', (primitive: WorldPrimitive) => {
      useWorldStore.getState().addWorldPrimitive(primitive);
    });

    this.socket.on('primitive:deleted', (data: { id: string }) => {
      useWorldStore.getState().removeWorldPrimitive(data.id);
    });

    this.socket.on('world:primitives_sync', (primitives: WorldPrimitive[]) => {
      useWorldStore.getState().setWorldPrimitives(primitives);
    });

    this.socket.on('world:revision', (data: WorldRevisionEvent) => {
      if (typeof data?.primitiveRevision === 'number') {
        useWorldStore.getState().setPrimitiveRevision(data.primitiveRevision);
      }
    });

    this.socket.on('terminal:message', (message: TerminalMessage) => {
      useWorldStore.getState().addTerminalMessage(message);
    });

    // Handle errors
    this.socket.on('error', (data: { message: string }) => {
      console.error('[Socket] Error:', data.message);
      useWorldStore.getState().addEvent(`Error: ${data.message}`);
    });
  }

  disconnect(): void {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
    this.authToken = null;
    this.agentId = null;
  }

  isConnected(): boolean {
    return this.socket?.connected ?? false;
  }

  getAgentId(): string | null {
    return this.agentId;
  }

  getToken(): string | null {
    return this.authToken;
  }

  // Send agent input to server
  sendMove(agentId: string, x: number, z: number): void {
    if (!this.socket?.connected) {
      console.log('[Socket] Not connected, cannot send move');
      return;
    }

    this.socket.emit('agent:input', {
      agentId,
      op: 'MOVE',
      to: { x, z }
    });
  }

  // Send chat message
  sendChat(agentId: string, message: string): void {
    if (!this.socket?.connected) {
      console.log('[Socket] Not connected, cannot send chat');
      return;
    }

    this.socket.emit('agent:input', {
      agentId,
      op: 'CHAT',
      message
    });
  }
}

// Singleton instance
export const socketService = new SocketService();
