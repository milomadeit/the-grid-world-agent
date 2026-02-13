import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { initDatabase, closeDatabase } from './db.js';
import { initWorldManager, getWorldManager } from './world.js';
import { setupSocketServer } from './socket.js';
import { registerAgentRoutes } from './api/agents.js';
import { registerSimulateRoutes } from './api/simulate.js';
import { registerReputationRoutes } from './api/reputation.js';
import { registerGridRoutes } from './api/grid.js';
import { initChain } from './chain.js';
import { initAgent0 } from './agent0.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = parseInt(process.env.PORT || '3001', 10);
const HOST = process.env.HOST || '0.0.0.0';

async function main() {
  console.log('[Server] Starting The Grid Backend...');

  // Initialize Fastify with server factory for Socket.io compatibility
  const fastify = Fastify({
    logger: {
      level: 'info',
      transport: {
        target: 'pino-pretty',
        options: { colorize: true }
      }
    }
  });

  // Register CORS
  await fastify.register(cors, {
    origin: [
      'http://localhost:5173',
      'http://localhost:3000',
      'http://127.0.0.1:5173'
    ],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']
  });

  // Health check endpoint
  fastify.get('/health', async () => {
    const world = getWorldManager();
    return {
      status: 'ok',
      tick: world.getCurrentTick(),
      agents: world.getAgents().length,
      timestamp: Date.now()
    };
  });

  // Serve skill.md — the onboarding document all agents fetch on startup
  const skillMdPath = join(__dirname, '..', 'public', 'skill.md');
  fastify.get('/skill.md', async (request, reply) => {
    try {
      const content = await readFile(skillMdPath, 'utf-8');
      return reply.type('text/markdown').send(content);
    } catch (err) {
      request.log.error(err);
      return reply.status(500).send('skill.md not found');
    }
  });

  // Register API routes
  await registerAgentRoutes(fastify);
  await registerSimulateRoutes(fastify);
  await registerReputationRoutes(fastify);
  await registerGridRoutes(fastify);


  // Initialize database
  await initDatabase();

  // Initialize world manager
  const world = await initWorldManager();

  // Start Fastify first
  await fastify.listen({ port: PORT, host: '::' });

  // Now attach Socket.io to the running server
  const io = setupSocketServer(fastify.server);

  // Initialize on-chain connections (read-only)
  initChain();
  initAgent0();

  // Start the world simulation
  world.start();



  console.log(`[Server] HTTP server running at http://${HOST}:${PORT}`);
  console.log(`[Server] WebSocket server ready`);

  console.log(`[Server] API endpoints:`);
  console.log(`  - GET  /health`);
  console.log(`  - POST /v1/agents/enter`);
  console.log(`  - POST /v1/agents/action`);
  console.log(`  - GET  /v1/world/state`);
  console.log(`  - GET  /v1/agents/:id`);
  console.log(`  - DELETE /v1/agents/:id`);
  console.log(`  - POST /api/simulate`);
  console.log(`  - POST /v1/reputation/feedback`);
  console.log(`  - GET  /v1/reputation/:agentId`);
  console.log(`  - GET  /v1/reputation/:agentId/feedback`);
  console.log(`  - POST /v1/reputation/:feedbackId/revoke`);
  console.log(`  - POST /v1/grid/plot`);
  console.log(`  - POST /v1/grid/terminal`);
  console.log(`  - GET  /v1/grid/state`);

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\n[Server] Received ${signal}, shutting down...`);

    world.stop();
    await world.syncToDatabase();
    io.close();
    await closeDatabase();
    await fastify.close();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[Server] Fatal error:', err);
  process.exit(1);
});
