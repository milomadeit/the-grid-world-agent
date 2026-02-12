import { Server as SocketServer } from 'socket.io';
import type { AgentInputEvent } from './types.js';
import { getWorldManager } from './world.js';
import * as db from './db.js';


export function setupSocketServer(httpServer: any): SocketServer {
  const io = new SocketServer(httpServer, {
    cors: {
      origin: [
        'http://localhost:5173',
        'http://localhost:3000',
        'http://127.0.0.1:5173'
      ],
      methods: ['GET', 'POST'],
      credentials: true
    },
    transports: ['websocket', 'polling']
  });

  const world = getWorldManager();
  world.setSocketServer(io);

  io.on('connection', (socket) => {
    console.log(`[Socket] Client connected: ${socket.id}`);

    // Send current world state on connect
    const agents = world.getAgents();
    const primitives = world.getWorldPrimitives();
    
    // transform agents
    const mappedAgents = agents.map(a => {
        const ext = a as any;
        return {
          id: a.id,
          name: a.name,
          color: a.color,
          x: a.position.x,
          y: a.position.y,
          z: a.position.z,
          status: a.status,
          inventory: a.inventory,
          bio: a.bio,
          erc8004AgentId: ext.erc8004AgentId,
          erc8004Registry: ext.erc8004Registry,
          reputationScore: ext.reputationScore
        };
      });

    // Get messages async and send snapshot
    Promise.all([
      db.getTerminalMessages(20),
      db.getChatMessages(20)
    ]).then(([terminalMessages, chatMessages]) => {
      socket.emit('world:snapshot', {
        tick: world.getCurrentTick(),
        agents: mappedAgents,
        primitives,
        terminalMessages,
        chatMessages
      });
    });



    // Handle agent input from frontend clients
    socket.on('agent:input', (data: AgentInputEvent & { agentId: string }) => {
      const { agentId, op, to, message } = data;

      if (!agentId) {
        socket.emit('error', { message: 'agentId required' });
        return;
      }

      const agent = world.getAgent(agentId);
      if (!agent) {
        socket.emit('error', { message: 'Agent not found' });
        return;
      }

      switch (op) {
        case 'MOVE':
          if (to) {
            world.queueAction(agentId, {
              type: 'MOVE',
              targetPosition: { x: to.x, y: 0, z: to.z }
            });
          }
          break;

        case 'CHAT':
          if (message) {
            // Persist chat to DB then broadcast
            db.writeChatMessage({
              id: 0,
              agentId,
              agentName: agent.name,
              message,
              createdAt: Date.now()
            }).then(() => {
              world.broadcastChat(agentId, message, agent.name);
            }).catch(err => {
              console.error('[Socket] Failed to persist chat:', err);
              world.broadcastChat(agentId, message, agent.name);
            });
          }
          break;

        default:
          socket.emit('error', { message: `Unknown operation: ${op}` });
      }
    });

    // Handle agent registration from frontend
    socket.on('agent:register', async (data: {
      ownerId: string;
      name?: string;
      color?: string;
    }) => {
      const { ownerId, name, color } = data;

      // Import dynamically to avoid circular dependency
      const { randomUUID } = await import('crypto');

      // db is already imported at top level

      const agentId = `agent_${randomUUID().slice(0, 8)}`;
      const spawnX = (Math.random() - 0.5) * 20;
      const spawnZ = (Math.random() - 0.5) * 20;

      const agent = {
        id: agentId,
        name: name || `Agent-${agentId.slice(-4)}`,
        color: color || '#6b7280',
        position: { x: spawnX, y: 0, z: spawnZ },
        targetPosition: { x: spawnX, y: 0, z: spawnZ },
        status: 'idle' as const,
        inventory: { wood: 0, stone: 0, gold: 0 },
        ownerId
      };

      await db.createAgent(agent);
      world.addAgent(agent);

      socket.emit('agent:registered', {
        agentId,
        position: { x: spawnX, z: spawnZ }
      });
    });

    // Handle disconnection
    socket.on('disconnect', (reason) => {
      console.log(`[Socket] Client disconnected: ${socket.id}, reason: ${reason}`);
    });
  });

  console.log('[Socket] WebSocket server initialized');
  return io;
}
