import type { Server as SocketServer } from 'socket.io';
import type { Agent, WorldUpdateEvent, WorldObject, TerminalMessage, Guild, Directive, BUILD_CREDIT_CONFIG } from './types.js';
import * as db from './db.js';


interface QueuedAction {
  agentId: string;
  action: {
    type: string;
    targetPosition?: { x: number; y: number; z: number };
    [key: string]: unknown;
  };
}

class WorldManager {
  private agents: Map<string, Agent> = new Map();
  private worldObjects: Map<string, WorldObject> = new Map();
  private actionQueue: QueuedAction[] = [];
  private tick: number = 0;
  private io: SocketServer | null = null;
  private tickInterval: ReturnType<typeof setInterval> | null = null;

  async initialize(): Promise<void> {
    // Load existing agents from database
    const agents = await db.getAllAgents();
    for (const agent of agents) {
      this.agents.set(agent.id, agent);
    }

    // Get current tick from database
    const savedTick = await db.getWorldValue<number>('global_tick');
    this.tick = savedTick || 0;

    // Load world objects
    const objects = await db.getAllWorldObjects();
    for (const obj of objects) {
      this.worldObjects.set(obj.id, obj);
    }
    console.log(`[World] Loaded ${objects.length} world objects`);

    console.log(`[World] Initialized with ${this.agents.size} agents at tick ${this.tick}`);
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
    this.broadcastUpdate();
  }

  removeAgent(id: string): void {
    this.agents.delete(id);
    this.broadcastUpdate();
  }

  // --- World Object Management ---

  getWorldObjects(): WorldObject[] {
    return Array.from(this.worldObjects.values());
  }

  addWorldObject(obj: WorldObject): void {
    this.worldObjects.set(obj.id, obj);
    this.io?.emit('object:created', obj);
  }

  removeWorldObject(id: string): void {
    this.worldObjects.delete(id);
    this.io?.emit('object:deleted', { id });
  }

  // --- Grid Messaging ---

  broadcastTerminalMessage(msg: TerminalMessage): void {
    this.io?.emit('terminal:message', msg);
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

  broadcastChat(agentId: string, message: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    this.io?.emit('chat:message', {
      agentId,
      agentName: agent.name,
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

    // Daily Credit Reset (every ~24 hours = 86400 seconds = 1728000 ticks at 20tps)
    // Checking every ~1 minute (1200 ticks) to see if DB reset is needed
    if (this.tick % 1200 === 0) {
      db.resetDailyCredits(10).catch(console.error);
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
