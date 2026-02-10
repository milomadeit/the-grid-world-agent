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
  BuildPlotSchema,
  BuildSphereSchema,
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

  // --- World Objects ---

  fastify.post('/v1/grid/plot', async (request, reply) => {
    const agentId = await requireAgent(request, reply);
    if (!agentId) return;

    const credits = await db.getAgentCredits(agentId);
    if (credits < BUILD_CREDIT_CONFIG.PLOT_COST) {
      return reply.status(403).send({ error: 'Insufficient credits' });
    }

    const body = BuildPlotSchema.parse(request.body);
    const plot = {
      id: `plot_${randomUUID()}`,
      type: 'plot' as const,
      ownerAgentId: agentId,
      x: body.x,
      y: body.y,
      z: 0, // Plots are on ground
      width: body.width,
      length: body.length,
      height: body.height,
      color: body.color,
      rotation: body.rotation || 0,
      createdAt: Date.now()
    };

    await db.createWorldObject(plot);
    await db.deductCredits(agentId, BUILD_CREDIT_CONFIG.PLOT_COST);
    
    // Update WorldManager cache & broadcast
    world.addWorldObject(plot);

    return plot;
  });

  fastify.delete('/v1/grid/plot/:id', async (request, reply) => {
    const agentId = await requireAgent(request, reply);
    if (!agentId) return;

    const { id } = request.params as { id: string };
    const plot = await db.getWorldObject(id);

    if (!plot) return reply.status(404).send({ error: 'Plot not found' });
    if (plot.ownerAgentId !== agentId) return reply.status(403).send({ error: 'Not owner' });

    await db.deleteWorldObject(id);
    world.removeWorldObject(id);

    return { success: true };
  });

  fastify.post('/v1/grid/sphere', async (request, reply) => {
    const agentId = await requireAgent(request, reply);
    if (!agentId) return;

    const credits = await db.getAgentCredits(agentId);
    if (credits < BUILD_CREDIT_CONFIG.SPHERE_COST) {
      return reply.status(403).send({ error: 'Insufficient credits' });
    }

    const body = BuildSphereSchema.parse(request.body);
    const sphere = {
      id: `sphere_${randomUUID()}`,
      type: 'sphere' as const,
      ownerAgentId: agentId,
      x: body.x,
      y: body.y,
      z: 0, // Spheres start on ground
      radius: body.radius,
      color: body.color,
      createdAt: Date.now()
    };

    await db.createWorldObject(sphere);
    await db.deductCredits(agentId, BUILD_CREDIT_CONFIG.SPHERE_COST);
    
    world.addWorldObject(sphere);

    return sphere;
  });

  fastify.delete('/v1/grid/sphere/:id', async (request, reply) => {
    const agentId = await requireAgent(request, reply);
    if (!agentId) return;

    const { id } = request.params as { id: string };
    const sphere = await db.getWorldObject(id);

    if (!sphere) return reply.status(404).send({ error: 'Sphere not found' });
    if (sphere.ownerAgentId !== agentId) return reply.status(403).send({ error: 'Not owner' });

    await db.deleteWorldObject(id);
    world.removeWorldObject(id);

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
    // reputation score needs to be >= 3
    if ((agent as any).reputationScore < 3) {
      return reply.status(403).send({ error: 'Insufficient reputation (need 3+)' });
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
    
    // In a real implementation we would broadcast the vote update
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
    // Return full snapshot
    const agents = await db.getAllAgents();
    const objects = await db.getAllWorldObjects();
    const messages = await db.getTerminalMessages(20);
    
    return {
      tick: world.getCurrentTick(),
      agents,
      objects,
      messages
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
