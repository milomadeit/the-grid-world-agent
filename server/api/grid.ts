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

// --- Build Validation ---

interface ValidationResult {
  valid: boolean;
  correctedY?: number;
  error?: string;
}

const EXEMPT_SHAPES = new Set(['plane', 'circle']);
const SNAP_TOLERANCE = 0.25;

function validateBuildPosition(
  shape: string,
  position: { x: number; y: number; z: number },
  scale: { x: number; y: number; z: number },
  existingPrimitives: Array<{
    position: { x: number; y: number; z: number };
    scale: { x: number; y: number; z: number };
    shape: string;
  }>
): ValidationResult {
  // Exempt shapes skip validation (roofs, signs, decorative planes)
  if (EXEMPT_SHAPES.has(shape)) {
    return { valid: true };
  }

  const bottomEdge = position.y - scale.y / 2;

  // Ground contact: bottom edge within tolerance of y=0
  if (Math.abs(bottomEdge) <= SNAP_TOLERANCE) {
    const correctedY = scale.y / 2;
    return { valid: true, correctedY };
  }

  // Stacking: check if bottom edge rests on top of any existing shape
  for (const existing of existingPrimitives) {
    // Skip exempt shapes as supports
    if (EXEMPT_SHAPES.has(existing.shape)) continue;

    const existingTopEdge = existing.position.y + existing.scale.y / 2;

    // Bottom edge within tolerance of existing top edge
    if (Math.abs(bottomEdge - existingTopEdge) <= SNAP_TOLERANCE) {
      // Check XZ overlap: new shape's center must be within existing shape's footprint (with tolerance)
      const overlapX = Math.abs(position.x - existing.position.x) < (existing.scale.x / 2 + scale.x / 2);
      const overlapZ = Math.abs(position.z - existing.position.z) < (existing.scale.z / 2 + scale.z / 2);

      if (overlapX && overlapZ) {
        const correctedY = existingTopEdge + scale.y / 2;
        return { valid: true, correctedY };
      }
    }
  }

  // Floating: find the nearest valid Y
  let bestY = scale.y / 2; // default: ground level

  for (const existing of existingPrimitives) {
    if (EXEMPT_SHAPES.has(existing.shape)) continue;

    const existingTopEdge = existing.position.y + existing.scale.y / 2;
    const overlapX = Math.abs(position.x - existing.position.x) < (existing.scale.x / 2 + scale.x / 2);
    const overlapZ = Math.abs(position.z - existing.position.z) < (existing.scale.z / 2 + scale.z / 2);

    if (overlapX && overlapZ) {
      const candidateY = existingTopEdge + scale.y / 2;
      if (Math.abs(candidateY - position.y) < Math.abs(bestY - position.y)) {
        bestY = candidateY;
      }
    }
  }

  return {
    valid: false,
    correctedY: bestY,
    error: `Shape would float at y=${position.y.toFixed(2)}. Nearest valid y=${bestY.toFixed(2)} (ground or top of existing shape).`
  };
}

// --- Spatial Computation Helpers ---

interface BoundingBox {
  minX: number; maxX: number;
  minY: number; maxY: number;
  minZ: number; maxZ: number;
}

interface Cluster {
  centerX: number;
  centerZ: number;
  count: number;
  maxY: number;
}

function computeBoundingBox(prims: Array<{ position: { x: number; y: number; z: number }; scale: { x: number; y: number; z: number } }>): BoundingBox {
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  for (const p of prims) {
    const hx = (p.scale?.x || 1) / 2;
    const hy = (p.scale?.y || 1) / 2;
    const hz = (p.scale?.z || 1) / 2;
    minX = Math.min(minX, p.position.x - hx);
    maxX = Math.max(maxX, p.position.x + hx);
    minY = Math.min(minY, p.position.y - hy);
    maxY = Math.max(maxY, p.position.y + hy);
    minZ = Math.min(minZ, p.position.z - hz);
    maxZ = Math.max(maxZ, p.position.z + hz);
  }
  return { minX, maxX, minY, maxY, minZ, maxZ };
}

function computeCentroid(prims: Array<{ position: { x: number; y: number; z: number } }>): { x: number; y: number; z: number } {
  let sx = 0, sy = 0, sz = 0;
  for (const p of prims) { sx += p.position.x; sy += p.position.y; sz += p.position.z; }
  return { x: sx / prims.length, y: sy / prims.length, z: sz / prims.length };
}

function computeClusters(prims: Array<{ position: { x: number; y: number; z: number }; scale: { x: number; y: number; z: number } }>, cellSize: number): Cluster[] {
  const cells = new Map<string, { xs: number[]; zs: number[]; maxY: number }>();
  for (const p of prims) {
    const cx = Math.floor(p.position.x / cellSize);
    const cz = Math.floor(p.position.z / cellSize);
    const key = `${cx},${cz}`;
    if (!cells.has(key)) cells.set(key, { xs: [], zs: [], maxY: 0 });
    const cell = cells.get(key)!;
    cell.xs.push(p.position.x);
    cell.zs.push(p.position.z);
    const topEdge = p.position.y + (p.scale?.y || 1) / 2;
    cell.maxY = Math.max(cell.maxY, topEdge);
  }
  return Array.from(cells.values()).map(c => ({
    centerX: c.xs.reduce((a, b) => a + b, 0) / c.xs.length,
    centerZ: c.zs.reduce((a, b) => a + b, 0) / c.zs.length,
    count: c.xs.length,
    maxY: c.maxY,
  }));
}

function round1(n: number): number { return Math.round(n * 10) / 10; }

function roundBB(bb: BoundingBox): { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number } {
  return {
    minX: round1(bb.minX), maxX: round1(bb.maxX),
    minY: round1(bb.minY), maxY: round1(bb.maxY),
    minZ: round1(bb.minZ), maxZ: round1(bb.maxZ),
  };
}

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

    const body = { ...BuildPrimitiveSchema.parse(request.body) };
    body.position = { ...body.position };

    // Enforce that agent must be near the build target (prevents remote building)
    const agent = world.getAgent(agentId);
    if (agent) {
      const dx = body.position.x - agent.position.x;
      const dz = body.position.z - agent.position.z;
      const distance = Math.sqrt(dx * dx + dz * dz);
      const MAX_BUILD_DISTANCE = 20;
      const MIN_BUILD_DISTANCE = 2; // Don't build on top of yourself

      if (distance < MIN_BUILD_DISTANCE) {
        return reply.status(400).send({
          error: `Too close! Don't build on yourself. Move at least ${MIN_BUILD_DISTANCE} units away from your build site. Try x=${(agent.position.x + 3).toFixed(0)}, z=${(agent.position.z + 3).toFixed(0)}.`
        });
      }

      if (distance > MAX_BUILD_DISTANCE) {
        return reply.status(400).send({
          error: `Too far to build. You are ${distance.toFixed(1)} units away from (${body.position.x.toFixed(1)}, ${body.position.z.toFixed(1)}). Move within ${MAX_BUILD_DISTANCE} units first.`
        });
      }
    }

    // Enforce minimum build distance from origin (system terminal area)
    const distFromOrigin = Math.sqrt(body.position.x ** 2 + body.position.z ** 2);
    if (distFromOrigin < BUILD_CREDIT_CONFIG.MIN_BUILD_DISTANCE_FROM_ORIGIN) {
      return reply.status(403).send({
        error: `Cannot build within ${BUILD_CREDIT_CONFIG.MIN_BUILD_DISTANCE_FROM_ORIGIN} units of the origin. Move further out. Your distance: ${distFromOrigin.toFixed(1)}`
      });
    }

    // Validate build position (no floating shapes)
    const nearbyPrimitives = await db.getAllWorldPrimitives();
    // Filter to shapes within 20 units XZ for performance
    const relevant = nearbyPrimitives.filter(p =>
      Math.abs(p.position.x - body.position.x) < 20 &&
      Math.abs(p.position.z - body.position.z) < 20
    );
    const validation = validateBuildPosition(body.shape, body.position, body.scale, relevant);
    if (!validation.valid) {
      return reply.status(400).send({
        error: validation.error,
        suggestedY: validation.correctedY
      });
    }
    // Apply Y correction (snap to ground or top of existing shape)
    if (validation.correctedY !== undefined) {
      body.position.y = validation.correctedY;
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

    // --- Build Quality Warnings (soft feedback, not rejections) ---
    const warnings: string[] = [];
    
    // Check agent's builds for height vs spread ratio
    const agentPrims = nearbyPrimitives.filter(p => p.ownerAgentId === agentId);
    if (agentPrims.length >= 3) {
      const bb = computeBoundingBox(agentPrims);
      const width = bb.maxX - bb.minX;
      const depth = bb.maxZ - bb.minZ;
      const height = bb.maxY - bb.minY;
      const spreadRatio = height > 0 ? (width + depth) / height : Infinity;
      
      if (spreadRatio < 0.5 && height > 4) {
        warnings.push(`Your builds are very tall (${height.toFixed(1)}u) but narrow (spread ratio: ${spreadRatio.toFixed(1)}). Try spreading horizontally — build walls, floors, or adjacent structures instead of stacking higher.`);
      }
      if (pos.y > 15) {
        warnings.push(`Building very high (y=${pos.y.toFixed(1)}). Consider expanding horizontally first. Fetch /v1/grid/blueprints for structure templates.`);
      }
    }

    return { ...primitive, warnings: warnings.length > 0 ? warnings : undefined };
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

  // --- Spatial Summary (World Map for Agents) ---

  fastify.get('/v1/grid/spatial-summary', async (request, reply) => {
    const primitives = await db.getAllWorldPrimitives();
    const agents = world.getAgents();
    const agentNameMap = new Map(agents.map(a => [a.id, a.name]));

    const CELL_SIZE = 10;

    // --- Per-agent summaries ---
    const byOwner = new Map<string, typeof primitives>();
    for (const p of primitives) {
      if (!byOwner.has(p.ownerAgentId)) byOwner.set(p.ownerAgentId, []);
      byOwner.get(p.ownerAgentId)!.push(p);
    }

    const agentSummaries = Array.from(byOwner.entries()).map(([ownerId, prims]) => {
      const bb = computeBoundingBox(prims);
      const centroid = computeCentroid(prims);
      const clusters = computeClusters(prims, CELL_SIZE);
      return {
        agentId: ownerId,
        agentName: agentNameMap.get(ownerId) || ownerId,
        primitiveCount: prims.length,
        center: { x: Math.round(centroid.x), z: Math.round(centroid.z) },
        boundingBox: roundBB(bb),
        highestPoint: round1(bb.maxY),
        clusters: clusters.map(c => ({
          center: { x: Math.round(c.centerX), z: Math.round(c.centerZ) },
          count: c.count,
          maxHeight: round1(c.maxY),
        })),
      };
    });

    // --- World-wide grid map ---
    const worldCells = new Map<string, { count: number; maxY: number; agents: Set<string> }>();
    for (const p of primitives) {
      const cx = Math.floor(p.position.x / CELL_SIZE) * CELL_SIZE;
      const cz = Math.floor(p.position.z / CELL_SIZE) * CELL_SIZE;
      const key = `${cx},${cz}`;
      if (!worldCells.has(key)) worldCells.set(key, { count: 0, maxY: 0, agents: new Set() });
      const cell = worldCells.get(key)!;
      cell.count++;
      const topEdge = p.position.y + (p.scale?.y || 1) / 2;
      cell.maxY = Math.max(cell.maxY, topEdge);
      cell.agents.add(agentNameMap.get(p.ownerAgentId) || p.ownerAgentId);
    }

    const gridMap = Array.from(worldCells.entries()).map(([key, cell]) => {
      const [x, z] = key.split(',').map(Number);
      return {
        x, z,
        count: cell.count,
        maxHeight: round1(cell.maxY),
        agents: Array.from(cell.agents),
      };
    }).sort((a, b) => b.count - a.count); // densest first

    // --- Open areas (find gaps in the grid) ---
    const occupiedCells = new Set(worldCells.keys());
    const openAreas: Array<{ x: number; z: number; nearestBuild: number }> = [];

    if (primitives.length > 0) {
      const worldBB = computeBoundingBox(primitives);
      // Scan a grid around the built area, expanded by 30 units
      const scanMinX = Math.floor((worldBB.minX - 30) / CELL_SIZE) * CELL_SIZE;
      const scanMaxX = Math.ceil((worldBB.maxX + 30) / CELL_SIZE) * CELL_SIZE;
      const scanMinZ = Math.floor((worldBB.minZ - 30) / CELL_SIZE) * CELL_SIZE;
      const scanMaxZ = Math.ceil((worldBB.maxZ + 30) / CELL_SIZE) * CELL_SIZE;

      for (let x = scanMinX; x <= scanMaxX; x += CELL_SIZE) {
        for (let z = scanMinZ; z <= scanMaxZ; z += CELL_SIZE) {
          // Skip origin exclusion zone
          const distFromOrigin = Math.sqrt(x * x + z * z);
          if (distFromOrigin < BUILD_CREDIT_CONFIG.MIN_BUILD_DISTANCE_FROM_ORIGIN) continue;

          const key = `${x},${z}`;
          if (!occupiedCells.has(key)) {
            // Find distance to nearest occupied cell
            let nearest = Infinity;
            for (const oKey of occupiedCells) {
              const [ox, oz] = oKey.split(',').map(Number);
              const dist = Math.sqrt((x - ox) ** 2 + (z - oz) ** 2);
              nearest = Math.min(nearest, dist);
            }
            // Only suggest areas that are near existing builds (within 40 units) but not too close
            if (nearest >= CELL_SIZE && nearest <= 40) {
              openAreas.push({ x, z, nearestBuild: Math.round(nearest) });
            }
          }
        }
      }
      // Sort by proximity to existing builds, take top 8
      openAreas.sort((a, b) => a.nearestBuild - b.nearestBuild);
      openAreas.splice(8);
    } else {
      // No builds yet — suggest starting areas away from origin
      openAreas.push(
        { x: 100, z: 100, nearestBuild: 0 },
        { x: -100, z: 100, nearestBuild: 0 },
        { x: 100, z: -100, nearestBuild: 0 },
        { x: -100, z: -100, nearestBuild: 0 },
      );
    }

    // --- World-level stats ---
    const worldStats = primitives.length > 0
      ? (() => {
          const bb = computeBoundingBox(primitives);
          const centroid = computeCentroid(primitives);
          return {
            totalPrimitives: primitives.length,
            totalBuilders: byOwner.size,
            boundingBox: roundBB(bb),
            highestPoint: round1(bb.maxY),
            center: { x: Math.round(centroid.x), z: Math.round(centroid.z) },
          };
        })()
      : {
          totalPrimitives: 0,
          totalBuilders: 0,
          boundingBox: null,
          highestPoint: 0,
          center: null,
        };

    return {
      world: worldStats,
      agents: agentSummaries,
      grid: { cellSize: CELL_SIZE, cells: gridMap },
      openAreas,
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

  // --- Blueprints ---

  fastify.get('/v1/grid/blueprints', async (request, reply) => {
    try {
      const filePath = join(__dirname, '../blueprints.json');
      const raw = await readFile(filePath, 'utf-8');
      const parsed = JSON.parse(raw);

      // Optional: filter by tags
      const tagsParam = (request.query as any).tags;
      if (tagsParam && typeof tagsParam === 'string') {
        const tags = tagsParam.split(',').map((t: string) => t.trim().toLowerCase());
        const filtered: Record<string, any> = {};
        for (const [name, bp] of Object.entries(parsed)) {
          const bpTags: string[] = (bp as any).tags || [];
          if (tags.some(t => bpTags.includes(t))) {
            filtered[name] = bp;
          }
        }
        return filtered;
      }

      // Optional: filter by category
      const category = (request.query as any).category;
      if (category && typeof category === 'string') {
        const filtered: Record<string, any> = {};
        for (const [name, bp] of Object.entries(parsed)) {
          if ((bp as any).category === category.toLowerCase()) {
            filtered[name] = bp;
          }
        }
        return filtered;
      }

      return parsed;
    } catch (err) {
      request.log.error(err);
      return reply.status(500).send({ error: 'Failed to load blueprints' });
    }
  });

  // --- Agent Memory (bounded key-value store) ---

  const memoryWriteTimestamps = new Map<string, number>(); // rate limiting
  const MEMORY_WRITE_COOLDOWN_MS = 5000; // 1 write per 5 seconds

  fastify.get('/v1/grid/memory', async (request, reply) => {
    const auth = await authenticate(request, reply);
    if (!auth) return;

    const memory = await db.getAgentMemory(auth.agentId);
    return { agentId: auth.agentId, memory };
  });

  fastify.put<{ Params: { key: string } }>(
    '/v1/grid/memory/:key',
    async (request, reply) => {
      const auth = await authenticate(request, reply);
      if (!auth) return;

      const { key } = request.params;
      if (!key || key.length > 100) {
        return reply.code(400).send({ error: 'Key must be 1-100 characters.' });
      }

      // Rate limiting
      const lastWrite = memoryWriteTimestamps.get(auth.agentId) || 0;
      const now = Date.now();
      if (now - lastWrite < MEMORY_WRITE_COOLDOWN_MS) {
        return reply.code(429).send({
          error: 'Memory write rate limited. Max 1 write per 5 seconds.',
          retryAfterMs: MEMORY_WRITE_COOLDOWN_MS - (now - lastWrite)
        });
      }

      const value = request.body;
      const result = await db.setAgentMemory(auth.agentId, key, value);
      if (!result.ok) {
        return reply.code(400).send({ error: result.error });
      }

      memoryWriteTimestamps.set(auth.agentId, now);
      return { ok: true, key };
    }
  );

  fastify.delete<{ Params: { key: string } }>(
    '/v1/grid/memory/:key',
    async (request, reply) => {
      const auth = await authenticate(request, reply);
      if (!auth) return;

      const { key } = request.params;
      const deleted = await db.deleteAgentMemory(auth.agentId, key);
      return { ok: deleted, key };
    }
  );

  // --- Build History ---

  fastify.get('/v1/grid/my-builds', async (request, reply) => {
    const auth = await authenticate(request, reply);
    if (!auth) return;

    const builds = await db.getAgentBuilds(auth.agentId);
    return { agentId: auth.agentId, count: builds.length, builds };
  });
}
