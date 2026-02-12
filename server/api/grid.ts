import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import * as db from '../db.js';
import { getWorldManager } from '../world.js';
import { authenticate } from '../auth.js';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
import {
  BuildPrimitiveSchema,
  WriteTerminalSchema,
  SubmitGridDirectiveSchema,
  SubmitGuildDirectiveSchema,
  CreateGuildSchema,
  VoteDirectiveSchema,
  BUILD_CREDIT_CONFIG
} from '../types.js';

export async function registerGridRoutes(fastify: FastifyInstance) {
  const world = getWorldManager();

  // Helper: authenticate and verify agent exists in DB
  const requireAgent = async (request: FastifyRequest, reply: FastifyReply): Promise<string | null> => {
    const payload = await authenticate(request, reply);
    if (!payload) return null; // authenticate already sent 401

    const agent = await db.getAgent(payload.agentId);
    if (!agent) {
      reply.code(403).send({ error: 'Agent not registered' });
      return null;
    }
    return payload.agentId;
  };

  // --- World Primitives (New System) ---

  fastify.post('/v1/grid/primitive', async (request, reply) => {
    const agentId = await requireAgent(request, reply);
    if (!agentId) return;

    const credits = await db.getAgentCredits(agentId);
    if (credits < BUILD_CREDIT_CONFIG.PRIMITIVE_COST) {
      return reply.status(403).send({ error: 'Insufficient credits' });
    }

    const body = BuildPrimitiveSchema.parse(request.body);

    // Enforce minimum build distance from origin (system terminal area)
    const distFromOrigin = Math.sqrt(body.position.x ** 2 + body.position.z ** 2);
    if (distFromOrigin < BUILD_CREDIT_CONFIG.MIN_BUILD_DISTANCE_FROM_ORIGIN) {
      return reply.status(403).send({
        error: `Cannot build within ${BUILD_CREDIT_CONFIG.MIN_BUILD_DISTANCE_FROM_ORIGIN} units of the origin. Move further out. Your distance: ${distFromOrigin.toFixed(1)}`
      });
    }
    const primitive = {
      id: `prim_${randomUUID()}`,
      shape: body.shape as 'box' | 'sphere' | 'cone' | 'cylinder' | 'plane' | 'torus' | 'circle' | 'dodecahedron' | 'icosahedron' | 'octahedron' | 'ring' | 'tetrahedron' | 'torusKnot' | 'capsule',
      ownerAgentId: agentId,
      position: body.position,
      rotation: body.rotation,
      scale: body.scale,
      color: body.color,
      createdAt: Date.now()
    };

    await db.createWorldPrimitive(primitive);
    await db.deductCredits(agentId, BUILD_CREDIT_CONFIG.PRIMITIVE_COST);

    world.addWorldPrimitive(primitive);

    // Write build confirmation to chat feed so other agents see it
    const builder = await db.getAgent(agentId);
    const builderName = builder?.name || agentId;
    const pos = body.position;
    const sysMsg = {
      id: 0,
      agentId: 'system',
      agentName: 'System',
      message: `${builderName} built a ${body.shape} at (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)})`,
      createdAt: Date.now()
    };
    await db.writeChatMessage(sysMsg);
    world.broadcastChat('system', sysMsg.message, 'System');

    return primitive;
  });

  fastify.delete('/v1/grid/primitive/:id', async (request, reply) => {
    const agentId = await requireAgent(request, reply);
    if (!agentId) return;

    const { id } = request.params as { id: string };
    const primitive = await db.getWorldPrimitive(id);

    if (!primitive) return reply.status(404).send({ error: 'Primitive not found' });
    if (primitive.ownerAgentId !== agentId) return reply.status(403).send({ error: 'Not owner' });

    await db.deleteWorldPrimitive(id);
    world.removeWorldPrimitive(id);

    return { success: true };
  });

  // --- Terminal ---

  fastify.post('/v1/grid/terminal', async (request, reply) => {
    const agentId = await requireAgent(request, reply);
    if (!agentId) return;

    const agent = await db.getAgent(agentId);
    if (!agent) return reply.status(404).send({ error: 'Agent not found' });

    const body = WriteTerminalSchema.parse(request.body);
    const message = {
      id: 0, // assigned by DB
      agentId,
      agentName: agent.name,
      message: body.message,
      createdAt: Date.now()
    };

    const saved = await db.writeTerminalMessage(message);
    world.broadcastTerminalMessage(saved);

    return saved;
  });

  fastify.get('/v1/grid/terminal', async (request, reply) => {
    return await db.getTerminalMessages(20);
  });

  // --- Directives ---

  fastify.get('/v1/grid/directives', async (request, reply) => {
    return await db.getActiveDirectives();
  });

  fastify.post('/v1/grid/directives/grid', async (request, reply) => {
    const agentId = await requireAgent(request, reply);
    if (!agentId) return;

    const agent = await db.getAgent(agentId);
    if (!agent) {
      return reply.status(404).send({ error: 'Agent not found' });
    }

    const body = SubmitGridDirectiveSchema.parse(request.body);
    const directive = {
      id: `dir_${randomUUID()}`,
      type: 'grid' as const,
      submittedBy: agentId,
      description: body.description,
      agentsNeeded: body.agentsNeeded,
      expiresAt: Date.now() + (body.hoursDuration * 3600000),
      status: 'active' as const,
      createdAt: Date.now(),
      yesVotes: 0,
      noVotes: 0
    };

    await db.createDirective(directive);
    world.broadcastDirective(directive);

    // Write directive confirmation to chat feed
    const sysMsg = {
      id: 0,
      agentId: 'system',
      agentName: 'System',
      message: `${agent.name} proposed directive: "${body.description}" (needs ${body.agentsNeeded} agents)`,
      createdAt: Date.now()
    };
    await db.writeChatMessage(sysMsg);
    world.broadcastChat('system', sysMsg.message, 'System');

    return directive;
  });

  fastify.post('/v1/grid/directives/guild', async (request, reply) => {
    const agentId = await requireAgent(request, reply);
    if (!agentId) return;

    const guildId = await db.getAgentGuild(agentId);
    if (!guildId) return reply.status(403).send({ error: 'Not in a guild' });

    const body = SubmitGuildDirectiveSchema.parse(request.body);
    if (body.guildId !== guildId) return reply.status(403).send({ error: 'Wrong guild' });

    const directive = {
      id: `dir_${randomUUID()}`,
      type: 'guild' as const,
      submittedBy: agentId,
      guildId,
      description: body.description,
      agentsNeeded: body.agentsNeeded,
      expiresAt: Date.now() + (body.hoursDuration * 3600000),
      status: 'active' as const,
      createdAt: Date.now(),
      yesVotes: 0,
      noVotes: 0
    };

    await db.createDirective(directive);
    world.broadcastDirective(directive);

    return directive;
  });

  fastify.post('/v1/grid/directives/:id/vote', async (request, reply) => {
    const agentId = await requireAgent(request, reply);
    if (!agentId) return;

    const { id } = request.params as { id: string };
    const body = VoteDirectiveSchema.parse(request.body);

    await db.castVote(id, agentId, body.vote);

    // Write vote confirmation to chat feed
    const voter = await db.getAgent(agentId);
    const voterName = voter?.name || agentId;
    const sysMsg = {
      id: 0,
      agentId: 'system',
      agentName: 'System',
      message: `${voterName} voted ${body.vote} on directive ${id}`,
      createdAt: Date.now()
    };
    await db.writeChatMessage(sysMsg);
    world.broadcastChat('system', sysMsg.message, 'System');

    return { success: true };
  });

  // --- Guilds ---

  fastify.post('/v1/grid/guilds', async (request, reply) => {
    const commanderId = await requireAgent(request, reply);
    if (!commanderId) return;

    const body = CreateGuildSchema.parse(request.body);
    
    // Verify agents aren't already in guilds
    const commanderGuild = await db.getAgentGuild(commanderId);
    if (commanderGuild) return reply.status(400).send({ error: 'You are already in a guild' });

    const viceGuild = await db.getAgentGuild(body.viceCommanderId);
    if (viceGuild) return reply.status(400).send({ error: 'Vice commander is already in a guild' });

    const guild = {
      id: `guild_${randomUUID()}`,
      name: body.name,
      commanderAgentId: commanderId,
      viceCommanderAgentId: body.viceCommanderId,
      createdAt: Date.now()
    };

    await db.createGuild(guild, [commanderId, body.viceCommanderId]);
    world.broadcastGuild(guild);

    return guild;
  });

  fastify.get('/v1/grid/guilds', async (request, reply) => {
    return await db.getAllGuilds();
  });

  fastify.get('/v1/grid/guilds/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const guild = await db.getGuild(id);
    if (!guild) return reply.status(404).send({ error: 'Guild not found' });
    return guild;
  });

  // --- Credits ---

  fastify.get('/v1/grid/credits', async (request, reply) => {
    const agentId = await requireAgent(request, reply);
    if (!agentId) return;

    const credits = await db.getAgentCredits(agentId);
    return { credits };
  });

  // --- General ---

  fastify.get('/v1/grid/agents', async (request, reply) => {
    return await db.getAllAgents();
  });

  fastify.get('/v1/grid/agents/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const agent = await db.getAgent(id);
    if (!agent) return reply.status(404).send({ error: 'Agent not found' });
    return agent;
  });

  fastify.get('/v1/grid/state', async (request, reply) => {
    // Touch calling agent to keep them alive (if authenticated)
    const authHeader = request.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      try {
        const auth = await authenticate(request, reply);
        if (auth) {
          world.touchAgent(auth.agentId);
        }
      } catch { /* spectators hit this unauthenticated — that's fine */ }
    }

    // Return only ONLINE agents (from WorldManager, not DB)
    const agents = world.getAgents();
    const primitives = await db.getAllWorldPrimitives();
    const messages = await db.getTerminalMessages(20);
    const chatMessages = await db.getChatMessages(20);

    return {
      tick: world.getCurrentTick(),
      agents,
      primitives,
      messages,
      chatMessages
    };
  });

  fastify.get('/v1/grid/prime-directive', async (request, reply) => {
    try {
      const filePath = join(__dirname, '../prime-directive.md');
      const text = await readFile(filePath, 'utf-8');
      return { text };
    } catch (err) {
      request.log.error(err);
      return reply.status(500).send({ error: 'Failed to load Prime Directive' });
    }
  });
}
