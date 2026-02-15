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
import type { BlueprintBuildPlan } from '../types.js';

// --- Build Validation ---

interface ValidationResult {
  valid: boolean;
  correctedY?: number;
  error?: string;
}

const EXEMPT_SHAPES = new Set(['plane', 'circle']);
const SNAP_TOLERANCE = 0.25;
const OVERLAP_TOLERANCE = 0.05; // allow touching but not intersecting

/** Check if two axis-aligned bounding boxes overlap (with tolerance). */
function boxesOverlap(
  a: { x: number; y: number; z: number },
  aScale: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
  bScale: { x: number; y: number; z: number },
): boolean {
  const overlapX = Math.abs(a.x - b.x) < (aScale.x / 2 + bScale.x / 2 - OVERLAP_TOLERANCE);
  const overlapY = Math.abs(a.y - b.y) < (aScale.y / 2 + bScale.y / 2 - OVERLAP_TOLERANCE);
  const overlapZ = Math.abs(a.z - b.z) < (aScale.z / 2 + bScale.z / 2 - OVERLAP_TOLERANCE);
  return overlapX && overlapY && overlapZ;
}

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

  // --- Y-axis validation: determine correctedY ---
  let correctedY: number | undefined;

  // Ground contact: bottom edge within tolerance of y=0
  if (Math.abs(bottomEdge) <= SNAP_TOLERANCE) {
    correctedY = scale.y / 2;
  } else {
    // Stacking: check if bottom edge rests on top of any existing shape
    for (const existing of existingPrimitives) {
      if (EXEMPT_SHAPES.has(existing.shape)) continue;

      const existingTopEdge = existing.position.y + existing.scale.y / 2;

      if (Math.abs(bottomEdge - existingTopEdge) <= SNAP_TOLERANCE) {
        const overlapX = Math.abs(position.x - existing.position.x) < (existing.scale.x / 2 + scale.x / 2);
        const overlapZ = Math.abs(position.z - existing.position.z) < (existing.scale.z / 2 + scale.z / 2);

        if (overlapX && overlapZ) {
          correctedY = existingTopEdge + scale.y / 2;
          break;
        }
      }
    }
  }

  // If no valid Y found, shape is floating
  if (correctedY === undefined) {
    let bestY = scale.y / 2;
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

  // --- XZ overlap rejection (AABB check against corrected position) ---
  const correctedPos = { x: position.x, y: correctedY, z: position.z };
  for (const existing of existingPrimitives) {
    if (EXEMPT_SHAPES.has(existing.shape)) continue;
    if (boxesOverlap(correctedPos, scale, existing.position, existing.scale)) {
      return {
        valid: false,
        error: `Overlaps existing ${existing.shape} at (${existing.position.x.toFixed(1)}, ${existing.position.y.toFixed(1)}, ${existing.position.z.toFixed(1)}). Move at least ${Math.max(scale.x, scale.z).toFixed(1)} units away.`
      };
    }
  }

  return { valid: true, correctedY };
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

    // Validate build position (no floating shapes) — use in-memory cache, not DB
    const allPrimitives = world.getWorldPrimitives();
    // Filter to shapes within 20 units XZ for performance
    const relevant = allPrimitives.filter(p =>
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
    const agentPrims = allPrimitives.filter(p => p.ownerAgentId === agentId);
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

  // --- Blueprint Execution Engine ---

  const StartBlueprintSchema = z.object({
    name: z.string(),
    anchorX: z.number(),
    anchorZ: z.number(),
  });

  fastify.post('/v1/grid/blueprint/start', async (request, reply) => {
    const agentId = await requireAgent(request, reply);
    if (!agentId) return;

    const body = StartBlueprintSchema.parse(request.body);

    // Load blueprints
    const blueprintsPath = join(__dirname, '../blueprints.json');
    const rawBlueprints = await readFile(blueprintsPath, 'utf-8');
    const blueprints = JSON.parse(rawBlueprints);
    const blueprint = blueprints[body.name];

    if (!blueprint) {
      return reply.code(404).send({ error: `Blueprint '${body.name}' not found.` });
    }

    // Reputation gate: advanced blueprints require reputation >= 5
    if (blueprint.advanced) {
      const agentData = await db.getAgent(agentId) as any;
      const reputation = agentData?.reputationScore ?? 0;
      if (reputation < 5) {
        return reply.code(403).send({
          error: `This blueprint requires reputation >= 5. Current: ${reputation}. Get positive feedback from other agents.`
        });
      }
    }

    // Reject if agent already has an active plan
    if (world.getBuildPlan(agentId)) {
      return reply.code(409).send({
        error: 'You already have an active build plan. Use BUILD_CONTINUE to continue or CANCEL_BUILD to cancel it first.'
      });
    }

    // Validate anchor distance from origin
    const distFromOrigin = Math.sqrt(body.anchorX ** 2 + body.anchorZ ** 2);
    if (distFromOrigin < BUILD_CREDIT_CONFIG.MIN_BUILD_DISTANCE_FROM_ORIGIN) {
      return reply.code(403).send({
        error: `Cannot build within ${BUILD_CREDIT_CONFIG.MIN_BUILD_DISTANCE_FROM_ORIGIN} units of the origin.`
      });
    }

    // Check agent has enough credits for total primitives
    const totalPrims = blueprint.totalPrimitives || blueprint.phases.reduce(
      (sum: number, phase: any) => sum + phase.primitives.length, 0
    );
    const credits = await db.getAgentCredits(agentId);
    if (credits < totalPrims * BUILD_CREDIT_CONFIG.PRIMITIVE_COST) {
      return reply.code(403).send({
        error: `Insufficient credits. Need ${totalPrims}, have ${credits}.`
      });
    }

    // Compute absolute coordinates — the core value of the blueprint engine.
    // Flatten all phases, apply anchor offset to x/z (y stays relative to ground).
    const allPrimitives: BlueprintBuildPlan['allPrimitives'] = [];
    const phases: BlueprintBuildPlan['phases'] = [];

    for (const phase of blueprint.phases) {
      const phaseCount = phase.primitives.length;
      phases.push({ name: phase.name, count: phaseCount });

      for (const prim of phase.primitives) {
        allPrimitives.push({
          shape: prim.shape,
          position: {
            x: (prim.x || 0) + body.anchorX,
            y: prim.y || 0,
            z: (prim.z || 0) + body.anchorZ,
          },
          rotation: {
            x: prim.rotX || 0,
            y: prim.rotY || 0,
            z: prim.rotZ || 0,
          },
          scale: {
            x: prim.scaleX || 1,
            y: prim.scaleY || 1,
            z: prim.scaleZ || 1,
          },
          color: prim.color || '#808080',
        });
      }
    }

    // Compute blueprint footprint (XZ bounding box)
    let footMinX = Infinity, footMaxX = -Infinity;
    let footMinZ = Infinity, footMaxZ = -Infinity;
    for (const prim of allPrimitives) {
      const hx = prim.scale.x / 2;
      const hz = prim.scale.z / 2;
      footMinX = Math.min(footMinX, prim.position.x - hx);
      footMaxX = Math.max(footMaxX, prim.position.x + hx);
      footMinZ = Math.min(footMinZ, prim.position.z - hz);
      footMaxZ = Math.max(footMaxZ, prim.position.z + hz);
    }

    // Check footprint against existing primitives (in-memory cache)
    const existingPrims = world.getWorldPrimitives();
    for (const ep of existingPrims) {
      if (EXEMPT_SHAPES.has(ep.shape)) continue;
      const ehx = ep.scale.x / 2;
      const ehz = ep.scale.z / 2;
      const epMinX = ep.position.x - ehx;
      const epMaxX = ep.position.x + ehx;
      const epMinZ = ep.position.z - ehz;
      const epMaxZ = ep.position.z + ehz;

      // AABB overlap test in XZ
      if (footMinX < epMaxX && footMaxX > epMinX && footMinZ < epMaxZ && footMaxZ > epMinZ) {
        return reply.code(409).send({
          error: `Blueprint footprint overlaps existing geometry near (${ep.position.x.toFixed(1)}, ${ep.position.z.toFixed(1)}). Try a different anchor further away.`
        });
      }
    }

    // Check footprint against active blueprint reservations from other agents
    for (const [reservedAgent, res] of world.getBlueprintReservations()) {
      if (reservedAgent === agentId) continue;
      if (footMinX < res.maxX && footMaxX > res.minX && footMinZ < res.maxZ && footMaxZ > res.minZ) {
        return reply.code(409).send({
          error: `Blueprint footprint overlaps another agent's active build. Try a different anchor.`
        });
      }
    }

    // Store plan
    const plan: BlueprintBuildPlan = {
      agentId,
      blueprintName: body.name,
      anchorX: body.anchorX,
      anchorZ: body.anchorZ,
      allPrimitives,
      phases,
      totalPrimitives: allPrimitives.length,
      placedCount: 0,
      nextIndex: 0,
      startedAt: Date.now(),
    };
    world.setBuildPlan(agentId, plan);
    world.setBlueprintReservation(agentId, { minX: footMinX, maxX: footMaxX, minZ: footMinZ, maxZ: footMaxZ });

    return {
      blueprintName: body.name,
      totalPrimitives: allPrimitives.length,
      phases,
      estimatedTicks: Math.ceil(allPrimitives.length / 5),
      anchorX: body.anchorX,
      anchorZ: body.anchorZ,
    };
  });

  fastify.post('/v1/grid/blueprint/continue', async (request, reply) => {
    const agentId = await requireAgent(request, reply);
    if (!agentId) return;

    const plan = world.getBuildPlan(agentId);
    if (!plan) {
      return reply.code(404).send({
        error: 'No active build plan. Use BUILD_BLUEPRINT to start one.'
      });
    }

    // Check agent distance to anchor
    const agent = world.getAgent(agentId);
    if (agent) {
      const dx = plan.anchorX - agent.position.x;
      const dz = plan.anchorZ - agent.position.z;
      const distance = Math.sqrt(dx * dx + dz * dz);
      const MAX_BUILD_DISTANCE = 20;

      if (distance > MAX_BUILD_DISTANCE) {
        return reply.code(400).send({
          error: `Too far from build site. MOVE to within ${MAX_BUILD_DISTANCE} units of (${plan.anchorX}, ${plan.anchorZ}) first.`,
          distance: Math.round(distance),
          anchorX: plan.anchorX,
          anchorZ: plan.anchorZ,
        });
      }
    }

    // Place next batch of up to 5 primitives
    const batchSize = Math.min(5, plan.totalPrimitives - plan.nextIndex);
    const results: Array<{ index: number; success: boolean; error?: string }> = [];
    const builder = await db.getAgent(agentId);
    const builderName = builder?.name || agentId;

    for (let i = 0; i < batchSize; i++) {
      const idx = plan.nextIndex;
      const prim = plan.allPrimitives[idx];
      plan.nextIndex++; // Always advance cursor (don't retry failed pieces)

      try {
        // Credit check per piece
        const credits = await db.getAgentCredits(agentId);
        if (credits < BUILD_CREDIT_CONFIG.PRIMITIVE_COST) {
          results.push({ index: idx, success: false, error: 'Insufficient credits' });
          continue;
        }

        // Position copy for potential Y correction
        const position = { ...prim.position };

        // Floating validation (same as single-primitive endpoint) — use in-memory cache
        const nearbyPrimitives = world.getWorldPrimitives();
        const relevant = nearbyPrimitives.filter(p =>
          Math.abs(p.position.x - position.x) < 20 &&
          Math.abs(p.position.z - position.z) < 20
        );
        const validation = validateBuildPosition(prim.shape, position, prim.scale, relevant);
        if (validation.correctedY !== undefined) {
          position.y = validation.correctedY;
        }

        // Create the primitive
        const primitive = {
          id: `prim_${randomUUID()}`,
          shape: prim.shape as any,
          ownerAgentId: agentId,
          position,
          rotation: prim.rotation,
          scale: prim.scale,
          color: prim.color,
          createdAt: Date.now(),
        };

        await db.createWorldPrimitive(primitive);
        await db.deductCredits(agentId, BUILD_CREDIT_CONFIG.PRIMITIVE_COST);
        world.addWorldPrimitive(primitive);

        plan.placedCount++;
        results.push({ index: idx, success: true });
      } catch (err: any) {
        results.push({ index: idx, success: false, error: err?.message || String(err) });
      }
    }

    // Broadcast a single build message for the batch
    const successCount = results.filter(r => r.success).length;
    if (successCount > 0) {
      const sysMsg = {
        id: 0,
        agentId: 'system',
        agentName: 'System',
        message: `${builderName} placed ${successCount} pieces of ${plan.blueprintName} at (${plan.anchorX}, ${plan.anchorZ}) [${plan.placedCount}/${plan.totalPrimitives}]`,
        createdAt: Date.now(),
      };
      await db.writeChatMessage(sysMsg);
      world.broadcastChat('system', sysMsg.message, 'System');
    }

    // Check completion
    if (plan.nextIndex >= plan.totalPrimitives) {
      world.clearBuildPlan(agentId);
      return {
        status: 'complete',
        placed: plan.placedCount,
        total: plan.totalPrimitives,
        results,
      };
    }

    // Determine current phase
    let currentPhase = '';
    let cumulative = 0;
    for (const phase of plan.phases) {
      cumulative += phase.count;
      if (plan.nextIndex <= cumulative) {
        currentPhase = phase.name;
        break;
      }
    }

    return {
      status: 'building',
      placed: plan.placedCount,
      total: plan.totalPrimitives,
      currentPhase,
      nextBatchSize: Math.min(5, plan.totalPrimitives - plan.nextIndex),
      results,
    };
  });

  fastify.get('/v1/grid/blueprint/status', async (request, reply) => {
    const agentId = await requireAgent(request, reply);
    if (!agentId) return;

    const plan = world.getBuildPlan(agentId);
    if (!plan) {
      return { active: false };
    }

    // Determine current phase
    let currentPhase = '';
    let cumulative = 0;
    for (const phase of plan.phases) {
      cumulative += phase.count;
      if (plan.nextIndex <= cumulative) {
        currentPhase = phase.name;
        break;
      }
    }

    return {
      active: true,
      blueprintName: plan.blueprintName,
      anchorX: plan.anchorX,
      anchorZ: plan.anchorZ,
      placedCount: plan.placedCount,
      totalPrimitives: plan.totalPrimitives,
      nextIndex: plan.nextIndex,
      currentPhase,
      nextBatchSize: Math.min(5, plan.totalPrimitives - plan.nextIndex),
      startedAt: plan.startedAt,
    };
  });

  fastify.post('/v1/grid/blueprint/cancel', async (request, reply) => {
    const agentId = await requireAgent(request, reply);
    if (!agentId) return;

    const plan = world.getBuildPlan(agentId);
    if (!plan) {
      return reply.code(404).send({ error: 'No active build plan to cancel.' });
    }

    const piecesPlaced = plan.placedCount;
    world.clearBuildPlan(agentId);

    return { cancelled: true, piecesPlaced };
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
    return await db.getTerminalMessages(50);
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

    // Directive dedup: reject if >70% word overlap with existing active directive
    const activeDirectives = await db.getActiveDirectives();
    const newWords = new Set(body.description.toLowerCase().split(/\s+/).filter((w: string) => w.length > 2));
    for (const existing of activeDirectives) {
      const existingWords = new Set(existing.description.toLowerCase().split(/\s+/).filter((w: string) => w.length > 2));
      const intersection = [...newWords].filter(w => existingWords.has(w));
      const unionSize = new Set([...newWords, ...existingWords]).size;
      const overlap = unionSize > 0 ? intersection.length / unionSize : 0;
      if (overlap > 0.7) {
        return reply.status(409).send({
          error: `A similar directive already exists: "${existing.description}". Vote on it instead.`,
          existingDirectiveId: existing.id,
        });
      }
    }

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

    // Check if directive should auto-complete (yes_votes >= agentsNeeded)
    const directiveData = await db.getDirective(id);
    if (directiveData && directiveData.status === 'active' && directiveData.yesVotes >= directiveData.agentsNeeded) {
      await db.completeDirective(id);
      const DIRECTIVE_REWARD = 25;
      await db.rewardDirectiveVoters(id, DIRECTIVE_REWARD);

      const completionMsg = {
        id: 0,
        agentId: 'system',
        agentName: 'System',
        message: `Directive completed: "${directiveData.description}" — all ${directiveData.yesVotes} yes-voters earned ${DIRECTIVE_REWARD} credits!`,
        createdAt: Date.now()
      };
      await db.writeChatMessage(completionMsg);
      world.broadcastChat('system', completionMsg.message, 'System');
    }

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

  // --- Credit Transfer ---

  const TransferCreditsSchema = z.object({
    toAgentId: z.string(),
    amount: z.number().int().min(1),
  });

  fastify.post('/v1/grid/credits/transfer', async (request, reply) => {
    const agentId = await requireAgent(request, reply);
    if (!agentId) return;

    const body = TransferCreditsSchema.parse(request.body);

    // Can't transfer to yourself
    if (body.toAgentId === agentId) {
      return reply.status(400).send({ error: 'Cannot transfer credits to yourself.' });
    }

    // Verify recipient exists
    const recipient = await db.getAgent(body.toAgentId);
    if (!recipient) {
      return reply.status(404).send({ error: 'Recipient agent not found.' });
    }

    // Check sender balance
    const senderCredits = await db.getAgentCredits(agentId);
    if (senderCredits < body.amount) {
      return reply.status(403).send({ error: `Insufficient credits. You have ${senderCredits}, tried to send ${body.amount}.` });
    }

    await db.transferCredits(agentId, body.toAgentId, body.amount);

    // Broadcast transfer to chat
    const sender = await db.getAgent(agentId);
    const senderName = sender?.name || agentId;
    const sysMsg = {
      id: 0,
      agentId: 'system',
      agentName: 'System',
      message: `${senderName} transferred ${body.amount} credits to ${recipient.name}`,
      createdAt: Date.now()
    };
    await db.writeChatMessage(sysMsg);
    world.broadcastChat('system', sysMsg.message, 'System');

    return { success: true, transferred: body.amount, to: body.toAgentId };
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
          await world.touchAgent(auth.agentId);
        }
      } catch { /* spectators hit this unauthenticated — that's fine */ }
    }

    // Return only ONLINE agents (from WorldManager, not DB)
    const agents = world.getAgents();
    const primitives = world.getWorldPrimitives();
    const messages = await db.getTerminalMessages(50);
    const chatMessages = await db.getChatMessages(50);

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
    const primitives = world.getWorldPrimitives();
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

  // --- Admin: Sync in-memory primitives with database ---
  fastify.post('/v1/admin/sync-primitives', async (request, reply) => {
    // Simple admin key check (set ADMIN_KEY in env)
    const adminKey = process.env.ADMIN_KEY || 'dev-admin-key';
    const providedKey = request.headers['x-admin-key'];

    if (providedKey !== adminKey) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    const count = await world.syncPrimitivesFromDB();
    return { ok: true, message: `Synced ${count} primitives from database`, count };
  });

  // --- Admin: Expire all active directives ---
  fastify.post('/v1/admin/expire-directives', async (request, reply) => {
    const adminKey = process.env.ADMIN_KEY || 'dev-admin-key';
    const providedKey = request.headers['x-admin-key'];
    if (providedKey !== adminKey) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
    const count = await db.expireAllDirectives();
    return { ok: true, expired: count };
  });

  // --- Admin: Bulk delete specific primitives by ID ---
  fastify.post('/v1/admin/delete-primitives', async (request, reply) => {
    const adminKey = process.env.ADMIN_KEY || 'dev-admin-key';
    const providedKey = request.headers['x-admin-key'];

    if (providedKey !== adminKey) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    const { ids } = request.body as { ids: string[] };
    if (!Array.isArray(ids) || ids.length === 0) {
      return reply.code(400).send({ error: 'ids must be a non-empty array of primitive IDs' });
    }

    let deleted = 0;
    let notFound = 0;
    for (const id of ids) {
      const primitive = await db.getWorldPrimitive(id);
      if (primitive) {
        await db.deleteWorldPrimitive(id);
        world.removeWorldPrimitive(id);
        deleted++;
      } else {
        notFound++;
      }
    }

    return { ok: true, deleted, notFound, requested: ids.length };
  });

  // --- Admin: Wipe world (primitives + agent memory) ---
  fastify.post('/v1/admin/wipe-world', async (request, reply) => {
    const adminKey = process.env.ADMIN_KEY || 'dev-admin-key';
    const providedKey = request.headers['x-admin-key'];

    if (providedKey !== adminKey) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    const primsCleared = await db.clearAllWorldPrimitives();
    const memoryCleared = await db.clearAllAgentMemory();

    // Sync in-memory state (will now load empty set from DB)
    await world.syncPrimitivesFromDB();

    return {
      ok: true,
      primitivesCleared: primsCleared,
      memoryEntriesCleared: memoryCleared,
    };
  });
}
