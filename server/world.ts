import type { Server as SocketServer } from 'socket.io';
import type { Agent, WorldUpdateEvent, WorldPrimitive, TerminalMessage, Guild, Directive } from './types.js';
import { BUILD_CREDIT_CONFIG } from './types.js';
import * as db from './db.js';


interface QueuedAction {
  agentId: string;
  action: {
    type: string;
    targetPosition?: { x: number; y: number; z: number };
    [key: string]: unknown;
  };
}

// How long (ms) before an inactive agent is removed from the live map
const AGENT_STALE_TIMEOUT = 60_000; // 60 seconds

class WorldManager {
  private agents: Map<string, Agent> = new Map();
  private agentLastSeen: Map<string, number> = new Map();
  private worldPrimitives: Map<string, WorldPrimitive> = new Map();
  private actionQueue: QueuedAction[] = [];
  private tick: number = 0;
  private io: SocketServer | null = null;
  private tickInterval: ReturnType<typeof setInterval> | null = null;

  async initialize(): Promise<void> {
    // Do NOT load agents from DB — agents must actively enter to appear on map.
    // DB retains agent data for identity/history, but presence is session-based.

    // Get current tick from database
    const savedTick = await db.getWorldValue<number>('global_tick');
    this.tick = savedTick || 0;

    // Load primitives (these are persistent world objects)
    const primitives = await db.getAllWorldPrimitives();
    for (const prim of primitives) {
      this.worldPrimitives.set(prim.id, prim);
    }
    console.log(`[World] Loaded ${primitives.length} world primitives`);

    console.log(`[World] Initialized at tick ${this.tick} (agents join on connect)`);
  }

  setSocketServer(io: SocketServer): void {
    this.io = io;
  }

  start(): void {
    // Run world tick at ~20 updates/second
    this.tickInterval = setInterval(() => this.runTick(), 50);
    console.log('[World] Simulation started');
  }

  stop(): void {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
    console.log('[World] Simulation stopped');
  }

  getCurrentTick(): number {
    return this.tick;
  }

  getAgents(): Agent[] {
    return Array.from(this.agents.values());
  }

  getAgent(id: string): Agent | undefined {
    return this.agents.get(id);
  }

  addAgent(agent: Agent): void {
    this.agents.set(agent.id, agent);
    this.agentLastSeen.set(agent.id, Date.now());
    // Broadcast full agent data so clients can add them to their list
    this.io?.emit('agent:joined', {
      id: agent.id,
      name: agent.name,
      color: agent.color,
      x: agent.position.x,
      y: agent.position.y,
      z: agent.position.z,
      status: agent.status,
      inventory: agent.inventory,
      bio: agent.bio,
      erc8004AgentId: (agent as any).erc8004AgentId,
      erc8004Registry: (agent as any).erc8004Registry,
      reputationScore: (agent as any).reputationScore
    });
  }

  /** Mark agent as active (call on any API interaction). */
  async touchAgent(agentId: string): Promise<void> {
    this.agentLastSeen.set(agentId, Date.now());

    // If agent isn't in memory (e.g. server restart), restore it
    if (!this.agents.has(agentId)) {
      try {
        const agent = await db.getAgent(agentId);
        if (agent) {
          this.addAgent(agent);
          console.log(`[World] Restored agent ${agent.name} (${agentId}) to active memory`);
        }
      } catch (err) {
        console.error(`[World] Failed to restore agent ${agentId}:`, err);
      }
    }
  }

  removeAgent(id: string): void {
    this.agents.delete(id);
    this.agentLastSeen.delete(id);
    this.io?.emit('agent:left', { id });
  }

  // --- World Primitive Management ---

  getWorldPrimitives(): WorldPrimitive[] {
    return Array.from(this.worldPrimitives.values());
  }

  addWorldPrimitive(prim: WorldPrimitive): void {
    this.worldPrimitives.set(prim.id, prim);
    this.io?.emit('primitive:created', prim);
  }

  removeWorldPrimitive(id: string): void {
    this.worldPrimitives.delete(id);
    this.io?.emit('primitive:deleted', { id });
  }

  // Sync in-memory primitives with database (clears memory, reloads from DB)
  async syncPrimitivesFromDB(): Promise<number> {
    const primitives = await db.getAllWorldPrimitives();
    this.worldPrimitives.clear();
    for (const prim of primitives) {
      this.worldPrimitives.set(prim.id, prim);
    }
    console.log(`[World] Synced ${primitives.length} primitives from DB`);
    return primitives.length;
  }

  // --- Grid Messaging ---

  broadcastTerminalMessage(msg: TerminalMessage): void {
    if (!this.io) {
      console.warn('[World] broadcastTerminalMessage: no socket.io server attached');
      return;
    }
    this.io.emit('terminal:message', msg);
  }

  broadcastDirective(directive: Directive): void {
    this.io?.emit('directive:created', directive);
  }

  broadcastGuild(guild: Guild): void {
    this.io?.emit('guild:created', guild);
  }

  queueAction(agentId: string, action: QueuedAction['action']): void {
    this.actionQueue.push({ agentId, action });
  }

  broadcastChat(agentId: string, message: string, agentName?: string): void {
    const agent = this.agents.get(agentId);
    const name = agent?.name || agentName || agentId;

    if (!this.io) {
      console.warn('[World] broadcastChat: no socket.io server attached');
      return;
    }

    console.log(`[World] Broadcasting chat from ${name}: "${message.slice(0, 60)}..."`);
    this.io.emit('chat:message', {
      agentId,
      agentName: name,
      message,
      timestamp: Date.now()
    });
  }

  private runTick(): void {
    this.tick++;

    // Process queued actions
    const updates: WorldUpdateEvent['updates'] = [];

    while (this.actionQueue.length > 0) {
      const { agentId, action } = this.actionQueue.shift()!;
      const agent = this.agents.get(agentId);
      if (!agent) continue;

      if (action.type === 'MOVE' && action.targetPosition) {
        agent.targetPosition = action.targetPosition;
        agent.status = 'moving';
      }
    }

    // Update agent positions (smooth interpolation toward target)
    for (const agent of this.agents.values()) {
      if (agent.status === 'moving') {
        const dx = agent.targetPosition.x - agent.position.x;
        const dz = agent.targetPosition.z - agent.position.z;
        const distance = Math.sqrt(dx * dx + dz * dz);

        if (distance < 0.1) {
          // Arrived at target
          agent.position = { ...agent.targetPosition };
          agent.status = 'idle';
        } else {
          // Move toward target (speed: ~5 units/second at 20 ticks/sec = 0.25 units/tick)
          const speed = 0.25;
          const ratio = Math.min(speed / distance, 1);
          agent.position = {
            x: agent.position.x + dx * ratio,
            y: agent.position.y,
            z: agent.position.z + dz * ratio
          };
        }

        updates.push({
          id: agent.id,
          x: agent.position.x,
          y: agent.position.y,
          z: agent.position.z,
          status: agent.status
        });
      }
    }

    // Broadcast updates if there are any changes
    if (updates.length > 0 || this.tick % 100 === 0) {
      this.broadcastUpdate(updates.length > 0 ? updates : undefined);
    }

    // Save tick periodically
    if (this.tick % 200 === 0) {
      db.setWorldValue('global_tick', this.tick).catch(console.error);
    }

    // Sweep stale agents every ~10 seconds (200 ticks at 20tps)
    if (this.tick % 200 === 0) {
      const now = Date.now();
      for (const [agentId, lastSeen] of this.agentLastSeen) {
        if (now - lastSeen > AGENT_STALE_TIMEOUT) {
          console.log(`[World] Agent ${this.agents.get(agentId)?.name || agentId} timed out (inactive ${Math.round((now - lastSeen) / 1000)}s)`);
          this.removeAgent(agentId);
        }
      }
    }

    // Daily Credit Reset (every ~24 hours = 86400 seconds = 1728000 ticks at 20tps)
    // Checking every ~1 minute (1200 ticks) to see if DB reset is needed
    if (this.tick % 1200 === 0) {
      db.resetDailyCredits(BUILD_CREDIT_CONFIG.SOLO_DAILY_CREDITS).catch(console.error);
      db.expireDirectives().catch(console.error);
    }
  }

  private broadcastUpdate(updates?: WorldUpdateEvent['updates']): void {
    if (!this.io) return;

    const event: WorldUpdateEvent = {
      tick: this.tick,
      updates: updates || this.getAgents().map(a => ({
        id: a.id,
        x: a.position.x,
        y: a.position.y,
        z: a.position.z,
        status: a.status
      }))
    };

    this.io.emit('world:update', event);
  }

  // Sync agent state to database periodically
  async syncToDatabase(): Promise<void> {
    for (const agent of this.agents.values()) {
      await db.updateAgent(agent.id, agent);
    }
  }
}

// Singleton instance
let worldManager: WorldManager | null = null;

export function getWorldManager(): WorldManager {
  if (!worldManager) {
    worldManager = new WorldManager();
  }
  return worldManager;
}

export async function initWorldManager(): Promise<WorldManager> {
  const manager = getWorldManager();
  await manager.initialize();
  return manager;
}
