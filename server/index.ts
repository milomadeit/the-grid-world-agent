import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { readFile, access } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { constants } from 'fs';
import { initDatabase, closeDatabase } from './db.js';
import { initWorldManager, getWorldManager } from './world.js';
import { setupSocketServer } from './socket.js';
import { registerAgentRoutes } from './api/agents.js';
import { registerSimulateRoutes } from './api/simulate.js';
import { registerReputationRoutes } from './api/reputation.js';
import { registerGridRoutes } from './api/grid.js';
import { registerCertificationRoutes } from './api/certify.js';
import { initChain } from './chain.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = parseInt(process.env.PORT || '4101', 10);
const HOST = process.env.HOST || '0.0.0.0';
const API_MAINTENANCE_MODE = true;
const API_MAINTENANCE_MESSAGE = 'opgrid is under maintainence.';

const API_LOCKED_PREFIXES = ['/v1/', '/api/', '/socket.io/'];
const API_LOCKED_PATHS = new Set(['/health', '/skill.md', '/skill-runtime.md']);

async function main() {
  console.log('[Server] Starting OpGrid Backend...');

  if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET is required. Refusing to start without authentication secret.');
  }

  // Initialize Fastify with server factory for Socket.io compatibility
  const isProduction = process.env.NODE_ENV === 'production';
  const fastify = Fastify({
    logger: isProduction
      ? { level: 'info' }
      : {
          level: 'info',
          transport: {
            target: 'pino-pretty',
            options: { colorize: true }
          }
        }
  });

  // Register CORS
  const allowedOrigins = [
    'http://localhost:5173',
    'http://localhost:4100',
    'http://127.0.0.1:5173',
    process.env.FRONTEND_URL,
    'https://opgrid.world',
    'https://www.opgrid.world'
  ].filter(Boolean) as string[];

  await fastify.register(cors, {
    origin: allowedOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']
  });

  if (API_MAINTENANCE_MODE) {
    fastify.addHook('onRequest', async (request, reply) => {
      const path = request.url.split('?')[0];
      const isApiPath =
        API_LOCKED_PATHS.has(path) ||
        API_LOCKED_PREFIXES.some((prefix) => path.startsWith(prefix));

      if (!isApiPath) return;

      return reply
        .code(503)
        .header('Retry-After', '3600')
        .send({ error: API_MAINTENANCE_MESSAGE });
    });
  }

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

  // Serve skill-mcp.md — MCP server setup and certification workflow
  const skillMcpPath = join(__dirname, '..', 'public', 'skill-mcp.md');
  fastify.get('/skill-mcp.md', async (request, reply) => {
    try {
      const content = await readFile(skillMcpPath, 'utf-8');
      return reply.type('text/markdown').send(content);
    } catch (err) {
      request.log.error(err);
      return reply.status(500).send('skill-mcp.md not found');
    }
  });

  // Serve skill-x402.md — x402 USDC payment signing reference
  const skillX402Path = join(__dirname, '..', 'public', 'skill-x402.md');
  fastify.get('/skill-x402.md', async (request, reply) => {
    try {
      const content = await readFile(skillX402Path, 'utf-8');
      return reply.type('text/markdown').send(content);
    } catch (err) {
      request.log.error(err);
      return reply.status(500).send('skill-x402.md not found');
    }
  });

  // Serve skill-api-reference.md — endpoint-by-endpoint auth/payload/response notes
  const skillApiRefPath = join(__dirname, '..', 'public', 'skill-api-reference.md');
  fastify.get('/skill-api-reference.md', async (request, reply) => {
    try {
      const content = await readFile(skillApiRefPath, 'utf-8');
      return reply.type('text/markdown').send(content);
    } catch (err) {
      request.log.error(err);
      return reply.status(500).send('skill-api-reference.md not found');
    }
  });

  // Serve skill-building.md — building logic, node founding, settlement growth
  const skillBuildingPath = join(__dirname, '..', 'public', 'skill-building.md');
  fastify.get('/skill-building.md', async (request, reply) => {
    try {
      const content = await readFile(skillBuildingPath, 'utf-8');
      return reply.type('text/markdown').send(content);
    } catch (err) {
      request.log.error(err);
      return reply.status(500).send('skill-building.md not found');
    }
  });

  // Serve skill-troubleshooting.md — common failures and concrete fixes
  const skillTroubleshootingPath = join(__dirname, '..', 'public', 'skill-troubleshooting.md');
  fastify.get('/skill-troubleshooting.md', async (request, reply) => {
    try {
      const content = await readFile(skillTroubleshootingPath, 'utf-8');
      return reply.type('text/markdown').send(content);
    } catch (err) {
      request.log.error(err);
      return reply.status(500).send('skill-troubleshooting.md not found');
    }
  });

  // Register API routes
  await registerAgentRoutes(fastify);
  await registerSimulateRoutes(fastify);
  await registerReputationRoutes(fastify);
  await registerGridRoutes(fastify);
  await registerCertificationRoutes(fastify);

  // Serve static frontend in production (built files in ../dist)
  const distPath = join(__dirname, '..', 'dist');

  try {
    await access(distPath, constants.R_OK);

    // Serve static assets
    await fastify.register(fastifyStatic, {
      root: distPath,
      prefix: '/',
      decorateReply: false
    });

    // SPA fallback: serve index.html for non-API routes
    fastify.setNotFoundHandler(async (request, reply) => {
      // Don't intercept API routes
      if (request.url.startsWith('/v1/') || request.url.startsWith('/api/')) {
        return reply.code(404).send({ error: 'Not found' });
      }
      // Serve index.html for SPA routing
      const indexPath = join(distPath, 'index.html');
      const html = await readFile(indexPath, 'utf-8');
      return reply.type('text/html').send(html);
    });

    console.log('[Server] Serving static frontend from dist/');
  } catch {
    if (isProduction) {
      console.warn('[Server] Warning: dist/ not found. Run `npm run build` first.');
    }
  }

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
  console.log(`  - GET  /v1/grid/state-lite`);
  console.log(`  - GET  /v1/grid/state`);
  console.log(`  - GET  /v1/certify/templates`);
  console.log(`  - POST /v1/certify/start`);
  console.log(`  - GET  /v1/certify/runs`);
  console.log(`  - POST /v1/certify/runs/:runId/submit`);
  console.log(`  - GET  /v1/certify/runs/:runId/attestation`);
  console.log(`  - GET  /v1/certify/leaderboard`);

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
