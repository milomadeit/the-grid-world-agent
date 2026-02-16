import { Server as SocketServer } from 'socket.io';
import type { AgentInputEvent } from './types.js';
import { getWorldManager } from './world.js';
import * as db from './db.js';
import { verifyToken } from './auth.js';
import { checkRateLimit } from './throttle.js';

const MAX_CHAT_MESSAGE_LENGTH = 280;
const SOCKET_INPUT_RATE_LIMIT = { limit: 30, windowMs: 10_000 };
const SOCKET_CHAT_RATE_LIMIT = { limit: 5, windowMs: 20_000 };
const SOCKET_MOVE_RATE_LIMIT = { limit: 20, windowMs: 10_000 };

function extractSocketToken(socket: any): string | null {
  const authToken = typeof socket.handshake?.auth?.token === 'string'
    ? socket.handshake.auth.token
    : null;

  const queryTokenRaw = socket.handshake?.query?.token;
  const queryToken = typeof queryTokenRaw === 'string'
    ? queryTokenRaw
    : (Array.isArray(queryTokenRaw) ? queryTokenRaw[0] : null);

  const authHeader = socket.handshake?.headers?.authorization;
  const headerToken = typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : null;

  return authToken || queryToken || headerToken;
}

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
    const token = extractSocketToken(socket);
    const auth = token ? verifyToken(token) : null;

    if (token && !auth) {
      socket.emit('error', { message: 'Invalid or expired socket token' });
      socket.disconnect(true);
      return;
    }

    const authenticatedAgentId = auth?.agentId || null;
    const authenticatedOwnerId = auth?.ownerId?.toLowerCase() || null;
    console.log(
      `[Socket] Client connected: ${socket.id} (${authenticatedAgentId ? `agent:${authenticatedAgentId}` : 'spectator'})`
    );

    // Get messages async, then build + send snapshot atomically to avoid
    // race where an agent joins between snapshot build and send.
    Promise.all([
      db.getTerminalMessages(50),
      db.getChatMessages(50),
      db.getAllWorldPrimitives()
    ]).then(([terminalMessages, chatMessages, primitives]) => {
      const agents = world.getAgents();

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

      socket.emit('world:snapshot', {
        tick: world.getCurrentTick(),
        agents: mappedAgents,
        primitives,
        terminalMessages,
        chatMessages
      });
    });



    // Handle agent input from frontend clients
    socket.on('agent:input', async (data: AgentInputEvent & { agentId?: string }) => {
      if (!authenticatedAgentId) {
        socket.emit('error', { message: 'Authentication required for agent actions' });
        return;
      }

      const { agentId, op, to, message } = data;

      if (agentId && agentId !== authenticatedAgentId) {
        socket.emit('error', { message: 'Cannot act as another agent' });
        return;
      }

      const actingAgentId = authenticatedAgentId;
      await world.touchAgent(actingAgentId);

      const agent = world.getAgent(actingAgentId);
      if (!agent) {
        socket.emit('error', { message: 'Agent not active. Re-enter via POST /v1/agents/enter.' });
        return;
      }

      const agentOwner = (agent.ownerId || '').toLowerCase();
      if (authenticatedOwnerId && agentOwner && agentOwner !== authenticatedOwnerId) {
        socket.emit('error', { message: 'Token owner does not match agent owner' });
        return;
      }

      const inputThrottle = checkRateLimit(
        'socket:agent:input',
        actingAgentId,
        SOCKET_INPUT_RATE_LIMIT.limit,
        SOCKET_INPUT_RATE_LIMIT.windowMs
      );
      if (!inputThrottle.allowed) {
        socket.emit('error', {
          message: 'Action rate limited. Slow down.',
          retryAfterMs: inputThrottle.retryAfterMs,
        });
        return;
      }

      switch (op) {
        case 'MOVE': {
          const moveThrottle = checkRateLimit(
            'socket:agent:move',
            actingAgentId,
            SOCKET_MOVE_RATE_LIMIT.limit,
            SOCKET_MOVE_RATE_LIMIT.windowMs
          );
          if (!moveThrottle.allowed) {
            socket.emit('error', {
              message: 'Move rate limited. Slow down.',
              retryAfterMs: moveThrottle.retryAfterMs,
            });
            return;
          }

          if (to) {
            world.queueAction(actingAgentId, {
              type: 'MOVE',
              targetPosition: { x: to.x, y: 0, z: to.z }
            });
          }
          break;
        }

        case 'CHAT': {
          const chatThrottle = checkRateLimit(
            'socket:agent:chat',
            actingAgentId,
            SOCKET_CHAT_RATE_LIMIT.limit,
            SOCKET_CHAT_RATE_LIMIT.windowMs
          );
          if (!chatThrottle.allowed) {
            socket.emit('error', {
              message: 'Chat rate limited. Slow down.',
              retryAfterMs: chatThrottle.retryAfterMs,
            });
            return;
          }

          if (message) {
            if (typeof message !== 'string') {
              socket.emit('error', { message: 'CHAT message must be a string' });
              return;
            }
            const trimmed = message.trim();
            if (!trimmed) {
              socket.emit('error', { message: 'CHAT message cannot be empty' });
              return;
            }
            if (trimmed.length > MAX_CHAT_MESSAGE_LENGTH) {
              socket.emit('error', {
                message: `CHAT message too long (${trimmed.length}). Max ${MAX_CHAT_MESSAGE_LENGTH} characters.`,
              });
              return;
            }

            // Persist chat to DB then broadcast
            db.writeChatMessage({
              id: 0,
              agentId: actingAgentId,
              agentName: agent.name,
              message: trimmed,
              createdAt: Date.now()
            }).then(() => {
              world.broadcastChat(actingAgentId, trimmed, agent.name);
            }).catch(err => {
              console.error('[Socket] Failed to persist chat:', err);
              world.broadcastChat(actingAgentId, trimmed, agent.name);
            });
          }
          break;
        }

        default:
          socket.emit('error', { message: `Unknown operation: ${op}` });
      }
    });

    // Registration is intentionally disabled on sockets; identity + payment checks
    // are enforced through POST /v1/agents/enter.
    socket.on('agent:register', async () => {
      socket.emit('error', {
        message: 'Socket registration is disabled. Use POST /v1/agents/enter.'
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
