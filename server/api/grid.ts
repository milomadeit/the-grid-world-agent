import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { randomUUID, createHash } from 'crypto';
import * as db from '../db.js';
import { getWorldManager } from '../world.js';
import { authenticate, verifyToken } from '../auth.js';
import { checkRateLimit } from '../throttle.js';
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
  CompleteDirectiveSchema,
  TradeRequestSchema,
  BUILD_CREDIT_CONFIG,
  CLASS_BONUSES,
  MATERIAL_CONFIG,
  MATERIAL_TYPES
} from '../types.js';
import type { BlueprintBuildPlan } from '../types.js';
import { EXEMPT_SHAPES, validateBuildPosition } from '../build-validation.js';
import { getSkillsForClass, getSkillById } from '../data/skills.js';
import { submitDirectiveOnChain, syncGuildOnChain } from '../chain.js';

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

type NodeTier =
  | 'settlement-node'
  | 'server-node'
  | 'forest-node'
  | 'city-node'
  | 'metropolis-node'
  | 'megaopolis-node';

type NodeCategory = 'architecture' | 'infrastructure' | 'technology' | 'art' | 'nature' | 'mixed';

interface PrimitiveLike {
  id?: string;
  shape: string;
  ownerAgentId?: string;
  blueprintInstanceId?: string | null;
  position: { x: number; y: number; z: number };
  scale: { x: number; y: number; z: number };
}

interface StructureSummary {
  id: string;
  center: { x: number; z: number };
  radius: number;
  primitiveCount: number;
  boundingBox: BoundingBox;
  footprintArea: number;
  category: NodeCategory;
  builders: string[];
}

interface SettlementNodeSummary {
  id: string;
  name: string;
  tier: NodeTier;
  center: { x: number; z: number };
  radius: number;
  structureCount: number;
  primitiveCount: number;
  footprintArea: number;
  dominantCategory: NodeCategory;
  missingCategories: Exclude<NodeCategory, 'mixed'>[];
  builders: string[];
  connections: Array<{
    targetId: string;
    targetName: string;
    distance: number;
    hasConnector: boolean;
    bearing: string;
    bearingDeg: number;
    gateX: number;
    gateZ: number;
    targetGateX: number;
    targetGateZ: number;
  }>;
}

interface OpenAreaSummary {
  x: number;
  z: number;
  nearestBuild: number;
  type: 'growth' | 'connector' | 'frontier';
  nearestNodeId: string;
  nearestNodeName: string;
  nearestNodeTier: NodeTier;
}

const NODE_CATEGORY_BASE: Exclude<NodeCategory, 'mixed'>[] = [
  'architecture',
  'infrastructure',
  'technology',
  'art',
  'nature',
];
const NODE_EXPANSION_GATE = 25;
const TIER3_NODE_TIERS = new Set<NodeTier>(['city-node', 'metropolis-node', 'megaopolis-node']);

const DIRECTION_LABELS: Record<string, string> = {
  C: 'Central',
  N: 'North',
  NE: 'Northeast',
  E: 'East',
  SE: 'Southeast',
  S: 'South',
  SW: 'Southwest',
  W: 'West',
  NW: 'Northwest',
};

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

function combineBoundingBoxes(boxes: BoundingBox[]): BoundingBox {
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  for (const bb of boxes) {
    minX = Math.min(minX, bb.minX);
    maxX = Math.max(maxX, bb.maxX);
    minY = Math.min(minY, bb.minY);
    maxY = Math.max(maxY, bb.maxY);
    minZ = Math.min(minZ, bb.minZ);
    maxZ = Math.max(maxZ, bb.maxZ);
  }
  return { minX, maxX, minY, maxY, minZ, maxZ };
}

function expandBoundingBoxXZ(bb: BoundingBox, pad: number): BoundingBox {
  return {
    minX: bb.minX - pad,
    maxX: bb.maxX + pad,
    minY: bb.minY,
    maxY: bb.maxY,
    minZ: bb.minZ - pad,
    maxZ: bb.maxZ + pad,
  };
}

function boundingBoxesOverlapXZ(a: BoundingBox, b: BoundingBox): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minZ <= b.maxZ && a.maxZ >= b.minZ;
}

function pointDistanceXZ(a: { x: number; z: number }, b: { x: number; z: number }): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dz * dz);
}

function compassBearing(fromX: number, fromZ: number, toX: number, toZ: number): string {
  const dx = toX - fromX;
  const dz = toZ - fromZ;
  const angle = ((Math.atan2(dx, -dz) * 180) / Math.PI + 360) % 360;
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return dirs[Math.round(angle / 45) % 8];
}

function compassBearingDeg(fromX: number, fromZ: number, toX: number, toZ: number): number {
  const dx = toX - fromX;
  const dz = toZ - fromZ;
  return Math.round(((Math.atan2(dx, -dz) * 180) / Math.PI + 360) % 360);
}

function primitiveRadiusXZ(p: PrimitiveLike): number {
  return Math.sqrt((p.scale.x / 2) ** 2 + (p.scale.z / 2) ** 2);
}

function primitiveToBoundingBox(p: PrimitiveLike): BoundingBox {
  const hx = p.scale.x / 2;
  const hy = p.scale.y / 2;
  const hz = p.scale.z / 2;
  return {
    minX: p.position.x - hx,
    maxX: p.position.x + hx,
    minY: p.position.y - hy,
    maxY: p.position.y + hy,
    minZ: p.position.z - hz,
    maxZ: p.position.z + hz,
  };
}

function isConnectorPrimitive(p: PrimitiveLike): boolean {
  if (p.shape === 'plane') return true;
  if (p.shape === 'box' || p.shape === 'cylinder') {
    // Flat boxes/cylinders are generally roads or paths.
    return p.scale.y <= 0.25 && (p.scale.x >= 1.5 || p.scale.z >= 1.5);
  }
  return false;
}

function inferPrimitiveCategory(p: PrimitiveLike): NodeCategory {
  if (p.shape === 'plane') return 'infrastructure';
  if (p.shape === 'box') {
    if (p.scale.y <= 0.25) return 'infrastructure';
    return 'architecture';
  }
  if (p.shape === 'cylinder' || p.shape === 'cone' || p.shape === 'ring') return 'technology';
  if (p.shape === 'sphere') return 'nature';
  if (p.shape === 'torus' || p.shape === 'torusKnot' || p.shape === 'dodecahedron' || p.shape === 'icosahedron' || p.shape === 'octahedron' || p.shape === 'tetrahedron') return 'art';
  if (p.shape === 'capsule') return 'architecture';
  return 'mixed';
}

function dominantCategory(entries: Map<NodeCategory, number>): NodeCategory {
  let best: NodeCategory = 'mixed';
  let bestCount = 0;
  let total = 0;
  for (const count of entries.values()) total += count;

  for (const [category, count] of entries.entries()) {
    if (category === 'mixed') continue;
    if (count > bestCount) {
      best = category;
      bestCount = count;
    }
  }

  if (best === 'mixed' || total === 0) return 'mixed';
  // Require some dominance to avoid noisy labels.
  if (bestCount / total < 0.35) return 'mixed';
  return best;
}

function classifyNodeTier(structureCount: number, _footprintArea: number): NodeTier {
  if (structureCount >= 100) return 'megaopolis-node';
  if (structureCount >= 50) return 'metropolis-node';
  if (structureCount >= 25) return 'city-node';
  if (structureCount >= 15) return 'forest-node';
  if (structureCount >= 6) return 'server-node';
  return 'settlement-node';
}

function tierRank(tier: NodeTier): number {
  switch (tier) {
    case 'megaopolis-node': return 6;
    case 'metropolis-node': return 5;
    case 'city-node': return 4;
    case 'forest-node': return 3;
    case 'server-node': return 2;
    case 'settlement-node': return 1;
    default: return 0;
  }
}

function directionForPoint(x: number, z: number, centerX: number, centerZ: number): keyof typeof DIRECTION_LABELS {
  const dx = x - centerX;
  const dz = z - centerZ;
  if (Math.abs(dx) < 12 && Math.abs(dz) < 12) return 'C';
  const angle = Math.atan2(dz, dx) * (180 / Math.PI);
  if (angle >= -22.5 && angle < 22.5) return 'E';
  if (angle >= 22.5 && angle < 67.5) return 'SE';
  if (angle >= 67.5 && angle < 112.5) return 'S';
  if (angle >= 112.5 && angle < 157.5) return 'SW';
  if (angle >= 157.5 || angle < -157.5) return 'W';
  if (angle >= -157.5 && angle < -112.5) return 'NW';
  if (angle >= -112.5 && angle < -67.5) return 'N';
  return 'NE';
}

function arePrimitivesConnected(a: PrimitiveLike, b: PrimitiveLike): boolean {
  const aBB = primitiveToBoundingBox(a);
  const bBB = primitiveToBoundingBox(b);
  if (boundingBoxesOverlapXZ(expandBoundingBoxXZ(aBB, 1.5), bBB)) return true;

  const centerDist = pointDistanceXZ(a.position, b.position);
  const size = Math.max(a.scale.x, a.scale.z, b.scale.x, b.scale.z);
  const nearThreshold = Math.max(3.5, Math.min(12, size * 1.5));
  return centerDist <= nearThreshold;
}

/** Build a StructureSummary from a cluster of primitives. */
function clusterToStructure(cluster: PrimitiveLike[], idx: number): StructureSummary {
  const bb = computeBoundingBox(cluster);
  const centroid = computeCentroid(cluster);
  let radius = 2;
  for (const p of cluster) {
    const dist = pointDistanceXZ(
      { x: centroid.x, z: centroid.z },
      { x: p.position.x, z: p.position.z }
    );
    radius = Math.max(radius, dist + primitiveRadiusXZ(p));
  }
  const categoryCounts = new Map<NodeCategory, number>();
  const builders = new Set<string>();
  for (const p of cluster) {
    const cat = inferPrimitiveCategory(p);
    categoryCounts.set(cat, (categoryCounts.get(cat) || 0) + 1);
    if (p.ownerAgentId) builders.add(p.ownerAgentId);
  }
  return {
    id: `struct_${Math.round(centroid.x)}_${Math.round(centroid.z)}_${idx}`,
    center: { x: centroid.x, z: centroid.z },
    radius: Math.max(2, radius),
    primitiveCount: cluster.length,
    boundingBox: bb,
    footprintArea: Math.max(1, (bb.maxX - bb.minX) * (bb.maxZ - bb.minZ)),
    category: dominantCategory(categoryCounts),
    builders: Array.from(builders),
  };
}

function buildStructureSummaries(primitives: PrimitiveLike[]): StructureSummary[] {
  if (primitives.length === 0) return [];

  const nonConnectors = primitives.filter(p => !isConnectorPrimitive(p));
  const source = nonConnectors.length > 0 ? nonConnectors : primitives;

  const structures: StructureSummary[] = [];

  // --- Phase 1: Pre-group primitives that share a blueprintInstanceId ---
  // Each blueprint placement = exactly one structure. No guessing needed.
  const blueprintGroups = new Map<string, PrimitiveLike[]>();
  const untagged: PrimitiveLike[] = [];

  for (const p of source) {
    if (p.blueprintInstanceId) {
      const group = blueprintGroups.get(p.blueprintInstanceId);
      if (group) group.push(p);
      else blueprintGroups.set(p.blueprintInstanceId, [p]);
    } else {
      untagged.push(p);
    }
  }

  // Each blueprint group = one structure
  for (const [, group] of blueprintGroups) {
    structures.push(clusterToStructure(group, structures.length + 1));
  }

  // --- Phase 2: Proximity-cluster untagged primitives (legacy / single builds) ---
  // Then merge nearby same-builder clusters as a best-effort heuristic for
  // old primitives that predate blueprintInstanceId tagging.
  if (untagged.length > 0) {
    const visited = new Set<number>();
    const rawStructures: StructureSummary[] = [];

    for (let i = 0; i < untagged.length; i++) {
      if (visited.has(i)) continue;

      const queue = [i];
      visited.add(i);
      const cluster: PrimitiveLike[] = [];

      while (queue.length > 0) {
        const idx = queue.pop()!;
        const prim = untagged[idx];
        cluster.push(prim);

        for (let j = 0; j < untagged.length; j++) {
          if (visited.has(j)) continue;
          if (arePrimitivesConnected(prim, untagged[j])) {
            visited.add(j);
            queue.push(j);
          }
        }
      }

      rawStructures.push(clusterToStructure(cluster, structures.length + rawStructures.length + 1));
    }

    // Merge pass: combine nearby untagged structures that share a builder.
    // This catches old blueprint fragments that got split up.
    const MERGE_GAP = 10;
    const merged = new Set<number>();

    for (let i = 0; i < rawStructures.length; i++) {
      if (merged.has(i)) continue;

      const group = [i];
      merged.add(i);

      const q = [i];
      while (q.length > 0) {
        const cur = q.pop()!;
        const a = rawStructures[cur];
        const aBuilders = new Set(a.builders);
        for (let j = 0; j < rawStructures.length; j++) {
          if (merged.has(j)) continue;
          const b = rawStructures[j];
          if (!b.builders.some(bld => aBuilders.has(bld))) continue;
          const edgeGap = Math.max(0,
            Math.max(a.boundingBox.minX - b.boundingBox.maxX, b.boundingBox.minX - a.boundingBox.maxX),
            Math.max(a.boundingBox.minZ - b.boundingBox.maxZ, b.boundingBox.minZ - a.boundingBox.maxZ)
          );
          if (edgeGap <= MERGE_GAP) {
            merged.add(j);
            group.push(j);
            q.push(j);
          }
        }
      }

      if (group.length === 1) {
        structures.push(rawStructures[i]);
      } else {
        // Merge group into single structure
        const allBBs = group.map(idx => rawStructures[idx].boundingBox);
        const mergedBB = combineBoundingBoxes(allBBs);
        const totalPrimitives = group.reduce((sum, idx) => sum + rawStructures[idx].primitiveCount, 0);
        const safePW = totalPrimitives > 0 ? totalPrimitives : group.length;
        let wx = 0, wz = 0;
        for (const idx of group) {
          const s = rawStructures[idx];
          wx += s.center.x * s.primitiveCount;
          wz += s.center.z * s.primitiveCount;
        }
        const mergedCenter = { x: wx / safePW, z: wz / safePW };
        let mergedRadius = 6;
        for (const idx of group) {
          const s = rawStructures[idx];
          const dist = pointDistanceXZ(mergedCenter, s.center);
          mergedRadius = Math.max(mergedRadius, dist + s.radius);
        }
        const mergedBuilders = new Set<string>();
        const mergedCats = new Map<NodeCategory, number>();
        for (const idx of group) {
          const s = rawStructures[idx];
          for (const bld of s.builders) mergedBuilders.add(bld);
          mergedCats.set(s.category, (mergedCats.get(s.category) || 0) + s.primitiveCount);
        }
        structures.push({
          id: `struct_${Math.round(mergedCenter.x)}_${Math.round(mergedCenter.z)}_${structures.length + 1}`,
          center: mergedCenter,
          radius: mergedRadius,
          primitiveCount: totalPrimitives,
          boundingBox: mergedBB,
          footprintArea: Math.max(1, (mergedBB.maxX - mergedBB.minX) * (mergedBB.maxZ - mergedBB.minZ)),
          category: dominantCategory(mergedCats),
          builders: Array.from(mergedBuilders),
        });
      }
    }
  }

  return structures;
}

function structuresBelongToSameNode(a: StructureSummary, b: StructureSummary): boolean {
  const dist = pointDistanceXZ(a.center, b.center);
  const edgeGap = dist - (a.radius + b.radius);
  if (edgeGap <= 24) return true;

  // Also join if expanded footprints overlap (helps with elongated compounds).
  const aExpanded = expandBoundingBoxXZ(a.boundingBox, 16);
  return boundingBoxesOverlapXZ(aExpanded, b.boundingBox);
}

function hasConnectorBetweenNodes(
  from: { center: { x: number; z: number } },
  to: { center: { x: number; z: number } },
  connectorPrimitives: PrimitiveLike[]
): boolean {
  const lineLen = pointDistanceXZ(from.center, to.center);
  if (lineLen < 1) return false;

  return connectorPrimitives.some((p) => {
    const px = p.position.x - from.center.x;
    const pz = p.position.z - from.center.z;
    const lx = to.center.x - from.center.x;
    const lz = to.center.z - from.center.z;
    const t = Math.max(0, Math.min(1, (px * lx + pz * lz) / (lineLen * lineLen)));
    if (t <= 0.05 || t >= 0.95) return false;

    const projX = from.center.x + t * lx;
    const projZ = from.center.z + t * lz;
    const distToLine = Math.sqrt((p.position.x - projX) ** 2 + (p.position.z - projZ) ** 2);
    const tolerance = Math.max(8, (p.scale.x + p.scale.z) / 2);
    return distToLine <= tolerance;
  });
}

function buildSettlementNodes(
  structures: StructureSummary[],
  connectorPrimitives: PrimitiveLike[]
): SettlementNodeSummary[] {
  if (structures.length === 0) return [];

  const visited = new Set<number>();
  const rawNodes: Array<{
    center: { x: number; z: number };
    radius: number;
    structureCount: number;
    primitiveCount: number;
    footprintArea: number;
    dominantCategory: NodeCategory;
    missingCategories: Exclude<NodeCategory, 'mixed'>[];
    builders: string[];
    tier: NodeTier;
  }> = [];

  for (let i = 0; i < structures.length; i++) {
    if (visited.has(i)) continue;

    const queue = [i];
    visited.add(i);
    const cluster: StructureSummary[] = [];

    while (queue.length > 0) {
      const idx = queue.pop()!;
      const s = structures[idx];
      cluster.push(s);

      for (let j = 0; j < structures.length; j++) {
        if (visited.has(j)) continue;
        if (structuresBelongToSameNode(s, structures[j])) {
          visited.add(j);
          queue.push(j);
        }
      }
    }

    const primitiveWeight = cluster.reduce((sum, s) => sum + s.primitiveCount, 0);
    const safeWeight = primitiveWeight > 0 ? primitiveWeight : cluster.length;
    let weightedX = 0;
    let weightedZ = 0;
    for (const s of cluster) {
      weightedX += s.center.x * s.primitiveCount;
      weightedZ += s.center.z * s.primitiveCount;
    }
    const center = {
      x: weightedX / safeWeight,
      z: weightedZ / safeWeight,
    };

    const nodeBB = combineBoundingBoxes(cluster.map(s => s.boundingBox));
    let radius = 6;
    for (const s of cluster) {
      const dist = pointDistanceXZ(center, s.center);
      radius = Math.max(radius, dist + s.radius);
    }

    const categoryCounts = new Map<NodeCategory, number>();
    const builders = new Set<string>();
    for (const s of cluster) {
      categoryCounts.set(s.category, (categoryCounts.get(s.category) || 0) + s.primitiveCount);
      for (const b of s.builders) builders.add(b);
    }
    const domCategory = dominantCategory(categoryCounts);
    const missingCategories = NODE_CATEGORY_BASE.filter(cat => !categoryCounts.has(cat));
    const structureCount = cluster.length;
    const footprintArea = Math.max(1, (nodeBB.maxX - nodeBB.minX) * (nodeBB.maxZ - nodeBB.minZ));

    rawNodes.push({
      center,
      radius,
      structureCount,
      primitiveCount: primitiveWeight,
      footprintArea,
      dominantCategory: domCategory,
      missingCategories,
      builders: Array.from(builders),
      tier: classifyNodeTier(structureCount, footprintArea),
    });
  }

  const worldCenter = rawNodes.reduce(
    (acc, n) => ({
      x: acc.x + n.center.x * n.structureCount,
      z: acc.z + n.center.z * n.structureCount,
      w: acc.w + n.structureCount,
    }),
    { x: 0, z: 0, w: 0 }
  );
  const centerX = worldCenter.w > 0 ? worldCenter.x / worldCenter.w : 0;
  const centerZ = worldCenter.w > 0 ? worldCenter.z / worldCenter.w : 0;

  const directionCounts = new Map<string, number>();
  const nodes: SettlementNodeSummary[] = rawNodes
    .sort((a, b) => {
      const tierDelta = tierRank(b.tier) - tierRank(a.tier);
      if (tierDelta !== 0) return tierDelta;
      return b.structureCount - a.structureCount;
    })
    .map((node, index) => {
      const dir = directionForPoint(node.center.x, node.center.z, centerX, centerZ);
      const dirCount = (directionCounts.get(dir) || 0) + 1;
      directionCounts.set(dir, dirCount);
      const directionName = DIRECTION_LABELS[dir];
      const baseName = `${node.tier} ${directionName}`;
      const name = dirCount > 1 ? `${baseName} ${dirCount}` : baseName;
      return {
        id: `node_${Math.round(node.center.x)}_${Math.round(node.center.z)}_${index + 1}`,
        name,
        tier: node.tier,
        center: node.center,
        radius: node.radius,
        structureCount: node.structureCount,
        primitiveCount: node.primitiveCount,
        footprintArea: node.footprintArea,
        dominantCategory: node.dominantCategory,
        missingCategories: node.missingCategories,
        builders: node.builders,
        connections: [],
      };
    });

  const MAX_CONNECTION_DISTANCE = 700;
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const dist = pointDistanceXZ(nodes[i].center, nodes[j].center);
      if (dist > MAX_CONNECTION_DISTANCE) continue;

      const hasConnector = hasConnectorBetweenNodes(nodes[i], nodes[j], connectorPrimitives);
      const edgeGap = dist - (nodes[i].radius + nodes[j].radius);
      const closeEnoughWithoutRoad = edgeGap <= 120;
      if (!hasConnector && !closeEnoughWithoutRoad) continue;

      const roundedDist = Math.round(dist);
      const bearingIJ = compassBearing(nodes[i].center.x, nodes[i].center.z, nodes[j].center.x, nodes[j].center.z);
      const bearingDegIJ = compassBearingDeg(nodes[i].center.x, nodes[i].center.z, nodes[j].center.x, nodes[j].center.z);
      const bearingJI = compassBearing(nodes[j].center.x, nodes[j].center.z, nodes[i].center.x, nodes[i].center.z);
      const bearingDegJI = compassBearingDeg(nodes[j].center.x, nodes[j].center.z, nodes[i].center.x, nodes[i].center.z);
      // Gate coordinates: edge of each node facing the other
      const dirX = dist > 0 ? (nodes[j].center.x - nodes[i].center.x) / dist : 0;
      const dirZ = dist > 0 ? (nodes[j].center.z - nodes[i].center.z) / dist : 0;
      const gateAX = Math.round(nodes[i].center.x + dirX * nodes[i].radius);
      const gateAZ = Math.round(nodes[i].center.z + dirZ * nodes[i].radius);
      const gateBX = Math.round(nodes[j].center.x - dirX * nodes[j].radius);
      const gateBZ = Math.round(nodes[j].center.z - dirZ * nodes[j].radius);
      nodes[i].connections.push({
        targetId: nodes[j].id,
        targetName: nodes[j].name,
        distance: roundedDist,
        hasConnector,
        bearing: bearingIJ,
        bearingDeg: bearingDegIJ,
        gateX: gateAX,
        gateZ: gateAZ,
        targetGateX: gateBX,
        targetGateZ: gateBZ,
      });
      nodes[j].connections.push({
        targetId: nodes[i].id,
        targetName: nodes[i].name,
        distance: roundedDist,
        hasConnector,
        bearing: bearingJI,
        bearingDeg: bearingDegJI,
        gateX: gateBX,
        gateZ: gateBZ,
        targetGateX: gateAX,
        targetGateZ: gateAZ,
      });
    }
  }

  for (const node of nodes) {
    node.connections.sort((a, b) => a.distance - b.distance);
    if (node.connections.length > 5) {
      node.connections = node.connections.slice(0, 5);
    }
  }

  return nodes;
}

function classifyOpenAreaType(
  nearestPrimitiveDist: number,
  maxNodeDistance: number
): OpenAreaSummary['type'] | null {
  const frontierMin = BUILD_CREDIT_CONFIG.FRONTIER_EXPANSION_MIN_DISTANCE;
  const frontierMax = Math.min(
    BUILD_CREDIT_CONFIG.FRONTIER_EXPANSION_MAX_DISTANCE,
    maxNodeDistance,
  );

  if (nearestPrimitiveDist >= 12 && nearestPrimitiveDist < 100) return 'growth';
  if (nearestPrimitiveDist >= 100 && nearestPrimitiveDist < 200) return 'connector';
  if (nearestPrimitiveDist >= 200 && nearestPrimitiveDist <= frontierMax) return 'frontier';
  return null;
}

function computeOpenAreas(nodes: SettlementNodeSummary[], primitives: PrimitiveLike[]): OpenAreaSummary[] {
  const maxNodeDistance = Math.max(
    20,
    Math.min(
      BUILD_CREDIT_CONFIG.FRONTIER_EXPANSION_MAX_DISTANCE,
      BUILD_CREDIT_CONFIG.MAX_BUILD_DISTANCE_FROM_SETTLEMENT - 1,
    ),
  );

  if (nodes.length === 0) {
    if (primitives.length === 0) {
      return [
        { x: 100, z: 100, nearestBuild: 0, type: 'frontier', nearestNodeId: 'none', nearestNodeName: 'seed', nearestNodeTier: 'settlement-node' },
        { x: -100, z: 100, nearestBuild: 0, type: 'frontier', nearestNodeId: 'none', nearestNodeName: 'seed', nearestNodeTier: 'settlement-node' },
        { x: 100, z: -100, nearestBuild: 0, type: 'frontier', nearestNodeId: 'none', nearestNodeName: 'seed', nearestNodeTier: 'settlement-node' },
        { x: -100, z: -100, nearestBuild: 0, type: 'frontier', nearestNodeId: 'none', nearestNodeName: 'seed', nearestNodeTier: 'settlement-node' },
      ];
    }

    // Primitive-based fallback if node model has not formed yet.
    const centroid = computeCentroid(primitives.map((p) => ({ position: p.position })));
    const rings: Array<{ radius: number; type: OpenAreaSummary['type'] }> = [
      { radius: 400, type: 'frontier' },
      { radius: 150, type: 'connector' },
      { radius: 75, type: 'growth' },
    ];
    const fallback: OpenAreaSummary[] = [];
    const angles = [0, 45, 90, 135, 180, 225, 270, 315];
    for (const ring of rings) {
      for (const deg of angles) {
        const rad = (deg * Math.PI) / 180;
        const x = Math.round(centroid.x + Math.cos(rad) * ring.radius);
        const z = Math.round(centroid.z + Math.sin(rad) * ring.radius);
        const originDist = Math.sqrt(x * x + z * z);
        if (originDist < BUILD_CREDIT_CONFIG.MIN_BUILD_DISTANCE_FROM_ORIGIN) continue;
        const nearestPrimitiveDist = distanceToNearestPrimitive(x, z, primitives);
        const type = classifyOpenAreaType(nearestPrimitiveDist, maxNodeDistance);
        if (!type) continue;
        fallback.push({
          x,
          z,
          nearestBuild: Math.round(nearestPrimitiveDist),
          type,
          nearestNodeId: 'none',
          nearestNodeName: 'seed',
          nearestNodeTier: 'settlement-node',
        });
      }
    }
    if (fallback.length > 0) {
      return fallback.slice(0, 12);
    }

    const p = primitives[0];
    return [{
      x: Math.round(p.position.x + 250),
      z: Math.round(p.position.z),
      nearestBuild: Math.round(distanceToNearestPrimitive(Math.round(p.position.x + 250), Math.round(p.position.z), primitives)),
      type: 'frontier',
      nearestNodeId: 'none',
      nearestNodeName: 'seed',
      nearestNodeTier: 'settlement-node',
    }];
  }

  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.center.x - n.radius);
    maxX = Math.max(maxX, n.center.x + n.radius);
    minZ = Math.min(minZ, n.center.z - n.radius);
    maxZ = Math.max(maxZ, n.center.z + n.radius);
  }

  const weightedCenter = nodes.reduce(
    (acc, n) => ({
      x: acc.x + n.center.x * n.structureCount,
      z: acc.z + n.center.z * n.structureCount,
      w: acc.w + n.structureCount,
    }),
    { x: 0, z: 0, w: 0 }
  );
  const worldCenter = {
    x: weightedCenter.w > 0 ? weightedCenter.x / weightedCenter.w : 0,
    z: weightedCenter.w > 0 ? weightedCenter.z / weightedCenter.w : 0,
  };

  const candidates: Array<OpenAreaSummary & { score: number }> = [];
  const SCAN_STEP = 40;
  const SCAN_PAD = 650;

  for (let x = Math.floor((minX - SCAN_PAD) / SCAN_STEP) * SCAN_STEP; x <= Math.ceil((maxX + SCAN_PAD) / SCAN_STEP) * SCAN_STEP; x += SCAN_STEP) {
    for (let z = Math.floor((minZ - SCAN_PAD) / SCAN_STEP) * SCAN_STEP; z <= Math.ceil((maxZ + SCAN_PAD) / SCAN_STEP) * SCAN_STEP; z += SCAN_STEP) {
      const originDist = Math.sqrt(x * x + z * z);
      if (originDist < BUILD_CREDIT_CONFIG.MIN_BUILD_DISTANCE_FROM_ORIGIN) continue;

      let nearestNode = nodes[0];
      let nearestEdgeDist = Infinity;
      for (const node of nodes) {
        const edgeDist = pointDistanceXZ({ x, z }, node.center) - node.radius;
        if (edgeDist < nearestEdgeDist) {
          nearestEdgeDist = edgeDist;
          nearestNode = node;
        }
      }

      const nearestPrimitiveDist = distanceToNearestPrimitive(x, z, primitives);
      if (nearestPrimitiveDist < 8 || nearestPrimitiveDist > maxNodeDistance) continue;

      const type = classifyOpenAreaType(nearestPrimitiveDist, maxNodeDistance);
      if (!type) continue;

      const distFromWorldCenter = pointDistanceXZ({ x, z }, worldCenter);
      const targetDist =
        type === 'growth' ? 75 :
        type === 'connector' ? 150 :
        400;

      let score = Math.abs(nearestPrimitiveDist - targetDist);
      if (type === 'frontier') {
        score -= Math.min(6, distFromWorldCenter / 50);
      }
      if (type === 'growth') {
        score += nearestNode.structureCount >= 12 ? 0 : 2;
      }

      candidates.push({
        x,
        z,
        nearestBuild: Math.max(0, Math.round(nearestPrimitiveDist)),
        type,
        nearestNodeId: nearestNode.id,
        nearestNodeName: nearestNode.name,
        nearestNodeTier: nearestNode.tier,
        score,
      });
    }
  }

  const byType = {
    frontier: candidates.filter(c => c.type === 'frontier').sort((a, b) => a.score - b.score).slice(0, 5),
    connector: candidates.filter(c => c.type === 'connector').sort((a, b) => a.score - b.score).slice(0, 4),
    growth: candidates.filter(c => c.type === 'growth').sort((a, b) => a.score - b.score).slice(0, 5),
  };

  const merged = [...byType.frontier, ...byType.connector, ...byType.growth];
  const deduped: OpenAreaSummary[] = [];
  const seen = new Set<string>();
  for (const c of merged) {
    const key = `${c.x},${c.z}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push({
      x: c.x,
      z: c.z,
      nearestBuild: c.nearestBuild,
      type: c.type,
      nearestNodeId: c.nearestNodeId,
      nearestNodeName: c.nearestNodeName,
      nearestNodeTier: c.nearestNodeTier,
    });
    if (deduped.length >= 12) break;
  }

  if (deduped.length === 0) {
    const fallback: OpenAreaSummary[] = [];
    for (const [idx, node] of nodes.slice(0, 4).entries()) {
      const angle = (Math.PI / 2) * idx;
      const radius = Math.max(20, Math.min(80, node.radius + 45));
      const x = Math.round(node.center.x + Math.cos(angle) * radius);
      const z = Math.round(node.center.z + Math.sin(angle) * radius);
      const originDist = Math.sqrt(x * x + z * z);
      if (originDist < BUILD_CREDIT_CONFIG.MIN_BUILD_DISTANCE_FROM_ORIGIN) continue;
      const nearestPrimitiveDist = distanceToNearestPrimitive(x, z, primitives);
      if (nearestPrimitiveDist > maxNodeDistance) continue;
      if (nearestPrimitiveDist < 34) continue;
      fallback.push({
        x,
        z,
        nearestBuild: Math.round(nearestPrimitiveDist),
        type: 'connector' as const,
        nearestNodeId: node.id,
        nearestNodeName: node.name,
        nearestNodeTier: node.tier,
      });
    }
    if (fallback.length > 0) return fallback;
  }

  return deduped;
}

function round1(n: number): number { return Math.round(n * 10) / 10; }

function roundBB(bb: BoundingBox): { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number } {
  return {
    minX: round1(bb.minX), maxX: round1(bb.maxX),
    minY: round1(bb.minY), maxY: round1(bb.maxY),
    minZ: round1(bb.minZ), maxZ: round1(bb.maxZ),
  };
}

function emptyMaterialCounts(): Record<string, number> {
  return MATERIAL_TYPES.reduce((acc, type) => {
    acc[type] = 0;
    return acc;
  }, {} as Record<string, number>);
}

const ARCHITECT_EXCLUSIVE_NODE_TIERS = new Set<NodeTier>(['metropolis-node', 'megaopolis-node']);
const ARCHITECT_EXCLUSIVE_MIN_PRIMITIVES = 40;
const GRID_STATS_CELL_SIZE = 20;
const GRID_STATS_TTL_MS = 30_000;

function blueprintPrimitiveCount(blueprint: any): number {
  if (typeof blueprint?.totalPrimitives === 'number' && Number.isFinite(blueprint.totalPrimitives)) {
    return Math.max(0, Math.floor(blueprint.totalPrimitives));
  }

  if (!Array.isArray(blueprint?.phases)) return 0;
  return blueprint.phases.reduce((sum: number, phase: any) => {
    const count = Array.isArray(phase?.primitives) ? phase.primitives.length : 0;
    return sum + count;
  }, 0);
}

function isArchitectExclusiveBlueprint(blueprint: any): boolean {
  if (!blueprint || typeof blueprint !== 'object') return false;

  const tags = Array.isArray(blueprint.tags)
    ? blueprint.tags.map((t: unknown) => String(t).toLowerCase())
    : [];
  if (tags.includes('architect-only') || tags.includes('mega') || tags.includes('large')) {
    return true;
  }

  if (
    typeof blueprint.minNodeTier === 'string' &&
    ARCHITECT_EXCLUSIVE_NODE_TIERS.has(blueprint.minNodeTier as NodeTier)
  ) {
    return true;
  }

  return blueprintPrimitiveCount(blueprint) >= ARCHITECT_EXCLUSIVE_MIN_PRIMITIVES;
}

function annotateBlueprintClassGates(raw: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [name, blueprint] of Object.entries(raw || {})) {
    if (isArchitectExclusiveBlueprint(blueprint)) {
      out[name] = {
        ...blueprint,
        classGates: {
          requiredClass: 'architect',
          reason: 'Large-scale blueprint reserved for architect class',
        },
      };
    } else {
      out[name] = blueprint;
    }
  }
  return out;
}

/** Find the XZ distance from a point to the nearest existing primitive in the world. */
function distanceToNearestPrimitive(
  x: number, z: number, primitives: Array<{ position: { x: number; z: number } }>
): number {
  if (primitives.length === 0) return 0;
  let minDist = Infinity;
  for (const p of primitives) {
    const dx = x - p.position.x;
    const dz = z - p.position.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist < minDist) minDist = dist;
  }
  return minDist;
}

function getExpansionGateViolation(
  x: number,
  z: number,
  primitives: PrimitiveLike[],
): { blocked: boolean; nearestNodeName?: string; nearestNodeCount?: number } {
  if (primitives.length < BUILD_CREDIT_CONFIG.SETTLEMENT_PROXIMITY_THRESHOLD) {
    return { blocked: false };
  }

  const nearestBuildDist = distanceToNearestPrimitive(x, z, primitives);
  if (nearestBuildDist < BUILD_CREDIT_CONFIG.FRONTIER_EXPANSION_MIN_DISTANCE) {
    return { blocked: false };
  }

  const connectorPrimitives = primitives.filter(isConnectorPrimitive);
  const structures = buildStructureSummaries(primitives);
  const nodes = buildSettlementNodes(structures, connectorPrimitives);
  if (nodes.length === 0) return { blocked: false };

  let nearestNode = nodes[0];
  let nearestEdgeDist = Infinity;
  for (const node of nodes) {
    const edgeDist = pointDistanceXZ({ x, z }, node.center) - node.radius;
    if (edgeDist < nearestEdgeDist) {
      nearestEdgeDist = edgeDist;
      nearestNode = node;
    }
  }

  const nearestNodeCount = nearestNode.structureCount || 0;
  if (nearestNodeCount >= NODE_EXPANSION_GATE) {
    return { blocked: false, nearestNodeName: nearestNode.name, nearestNodeCount };
  }

  return {
    blocked: true,
    nearestNodeName: nearestNode.name,
    nearestNodeCount,
  };
}

export async function registerGridRoutes(fastify: FastifyInstance) {
  const world = getWorldManager();

  const PRIMITIVE_RATE_LIMIT = { limit: 12, windowMs: 10_000 };
  const BLUEPRINT_START_RATE_LIMIT = { limit: 2, windowMs: 20_000 };
  const BLUEPRINT_CONTINUE_RATE_LIMIT = { limit: 6, windowMs: 30_000 };
  const DM_SEND_RATE_LIMIT = { limit: 10, windowMs: 60_000 };
  const DM_INBOX_RATE_LIMIT = { limit: 30, windowMs: 60_000 };
  const DM_MARK_READ_RATE_LIMIT = { limit: 30, windowMs: 60_000 };

  const SendDirectMessageSchema = z.object({
    toAgentId: z.string().min(1),
    message: z.string().min(1).max(500),
  });

  const MarkDirectMessagesReadSchema = z.object({
    messageIds: z.array(z.number().int().positive()).max(50).default([]),
  });

  // Helper: authenticate and verify agent exists in DB
  const requireAgent = async (request: FastifyRequest, reply: FastifyReply): Promise<string | null> => {
    const payload = await authenticate(request, reply);
    if (!payload) return null; // authenticate already sent 401

    const agent = await db.getAgent(payload.agentId);
    if (!agent) {
      reply.code(403).send({ error: 'Agent not registered' });
      return null;
    }
    await world.touchAgent(payload.agentId);
    return payload.agentId;
  };

  // Helper: enforce explicit admin key configuration for admin routes.
  const requireAdmin = (request: FastifyRequest, reply: FastifyReply): boolean => {
    const adminKey = process.env.ADMIN_KEY;
    if (!adminKey) {
      request.log.error('ADMIN_KEY is not configured');
      reply.code(503).send({ error: 'Admin routes are disabled until ADMIN_KEY is configured.' });
      return false;
    }

    const providedKey = request.headers['x-admin-key'];
    if (typeof providedKey !== 'string' || providedKey !== adminKey) {
      reply.code(401).send({ error: 'Unauthorized' });
      return false;
    }

    return true;
  };

  // --- World Primitives (New System) ---

  fastify.post('/v1/grid/primitive', async (request, reply) => {
    const agentId = await requireAgent(request, reply);
    if (!agentId) return;

    const primitiveThrottle = checkRateLimit(
      'rest:grid:primitive',
      agentId,
      PRIMITIVE_RATE_LIMIT.limit,
      PRIMITIVE_RATE_LIMIT.windowMs
    );
    if (!primitiveThrottle.allowed) {
      return reply.status(429).send({
        error: 'Primitive build rate limited. Slow down.',
        retryAfterMs: primitiveThrottle.retryAfterMs,
      });
    }

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

    // Enforce settlement proximity — builds must be near existing structures
    const allPrimitives = world.getWorldPrimitives();
    if (allPrimitives.length >= BUILD_CREDIT_CONFIG.SETTLEMENT_PROXIMITY_THRESHOLD) {
      const distToSettlement = distanceToNearestPrimitive(body.position.x, body.position.z, allPrimitives);
      if (distToSettlement > BUILD_CREDIT_CONFIG.MAX_BUILD_DISTANCE_FROM_SETTLEMENT) {
        return reply.status(400).send({
          error: `Too far from any existing build (${distToSettlement.toFixed(0)} units). Build within ${BUILD_CREDIT_CONFIG.MAX_BUILD_DISTANCE_FROM_SETTLEMENT} units of existing structures to grow the settlement organically. Use GET /v1/grid/spatial-summary to find active neighborhoods.`
        });
      }
      if (distToSettlement >= BUILD_CREDIT_CONFIG.FRONTIER_EXPANSION_MIN_DISTANCE) {
        const gate = getExpansionGateViolation(
          body.position.x,
          body.position.z,
          allPrimitives as unknown as PrimitiveLike[],
        );
        if (gate.blocked) {
          return reply.status(409).send({
            error: `Expansion gate active: nearest node "${gate.nearestNodeName || 'unknown'}" has ${gate.nearestNodeCount || 0} structures. Densify a node to ${NODE_EXPANSION_GATE}+ structures before placing new frontier builds (${BUILD_CREDIT_CONFIG.FRONTIER_EXPANSION_MIN_DISTANCE}-${BUILD_CREDIT_CONFIG.FRONTIER_EXPANSION_MAX_DISTANCE}u lanes).`,
          });
        }
      }
    }

    // Validate build position (no floating shapes) — use in-memory cache, not DB
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

    const builder = await db.getAgent(agentId);
    const builderName = builder?.name || agentId;

    const primitive = {
      id: `prim_${randomUUID()}`,
      shape: body.shape as 'box' | 'sphere' | 'cone' | 'cylinder' | 'plane' | 'torus' | 'circle' | 'dodecahedron' | 'icosahedron' | 'octahedron' | 'ring' | 'tetrahedron' | 'torusKnot' | 'capsule',
      ownerAgentId: agentId,
      ownerAgentName: builderName,
      position: body.position,
      rotation: body.rotation,
      scale: body.scale,
      color: body.color,
      createdAt: Date.now(),
      materialType: body.materialType || null,
    };

    const placed = await db.createWorldPrimitiveWithCreditDebit(
      primitive,
      BUILD_CREDIT_CONFIG.PRIMITIVE_COST
    );
    if (!placed.ok) {
      if (placed.reason === 'insufficient_credits') {
        return reply.status(403).send({ error: 'Insufficient credits' });
      }
      return reply.status(500).send({ error: 'Failed to place primitive' });
    }

    world.addWorldPrimitive(primitive);

    if (placed.repReward && placed.totalBuilt) {
      const repEvent = await db.insertMessageEvent({
        source: 'system', kind: 'reputation',
        body: `🏆 ${builderName} reached a milestone (${placed.totalBuilt} primitives built) and earned +${placed.repReward} reputation!`,
        metadata: { agentId, totalBuilt: placed.totalBuilt, repReward: placed.repReward },
      });
      world.broadcastEvent(repEvent);
    }

    if (placed.materialEarned) {
      const matEvent = await db.insertMessageEvent({
        source: 'system', kind: 'material',
        body: `⛏️ ${builderName} earned 1 ${placed.materialEarned} material for placing ${MATERIAL_CONFIG.EARN_EVERY_N_PRIMITIVES} primitives.`,
        metadata: { agentId, material: placed.materialEarned },
      });
      world.broadcastEvent(matEvent);
    }

    // Write build confirmation to unified feed
    const pos = body.position;
    const buildEvent = await db.insertMessageEvent({
      agentId, agentName: builderName,
      source: 'system', kind: 'build',
      body: `${builderName} built a ${body.shape} at (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)})`,
      metadata: { shape: body.shape, position: { x: pos.x, y: pos.y, z: pos.z } },
    });
    world.broadcastEvent(buildEvent);

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
    rotY: z.number().optional().default(0),
  });

  fastify.post('/v1/grid/blueprint/start', async (request, reply) => {
    const agentId = await requireAgent(request, reply);
    if (!agentId) return;

    const startThrottle = checkRateLimit(
      'rest:grid:blueprint:start',
      agentId,
      BLUEPRINT_START_RATE_LIMIT.limit,
      BLUEPRINT_START_RATE_LIMIT.windowMs
    );
    if (!startThrottle.allowed) {
      return reply.code(429).send({
        error: 'Blueprint start rate limited. Slow down.',
        retryAfterMs: startThrottle.retryAfterMs,
      });
    }

    const body = StartBlueprintSchema.parse(request.body);

    // Load blueprints
    const blueprintsPath = join(__dirname, '../blueprints.json');
    const rawBlueprints = await readFile(blueprintsPath, 'utf-8');
    const blueprints = JSON.parse(rawBlueprints);
    const blueprint = blueprints[body.name];

    if (!blueprint) {
      return reply.code(404).send({ error: `Blueprint '${body.name}' not found.` });
    }

    const requester = await db.getAgent(agentId);
    if (!requester) {
      return reply.code(404).send({ error: 'Agent not found.' });
    }
    const requesterClass = ((requester as any)?.agentClass as string | undefined) || 'builder';
    // Class gates disabled for demo — all agents can build any blueprint
    // if (isArchitectExclusiveBlueprint(blueprint) && requesterClass !== 'architect') {
    //   return reply.code(403).send({
    //     error: `Blueprint '${body.name}' is architect-exclusive. Your class is '${requesterClass}'.`,
    //   });
    // }

    // Keep blueprint starts local so agents do not create remote plans they
    // cannot continue immediately.
    const activeAgent = world.getAgent(agentId);
    if (activeAgent) {
      const dx = body.anchorX - activeAgent.position.x;
      const dz = body.anchorZ - activeAgent.position.z;
      const distance = Math.sqrt(dx * dx + dz * dz);
      const MAX_BUILD_DISTANCE = 20;
      if (distance > MAX_BUILD_DISTANCE) {
        return reply.code(400).send({
          error: `Too far from build site. MOVE to within ${MAX_BUILD_DISTANCE} units of (${Math.round(body.anchorX)}, ${Math.round(body.anchorZ)}) before starting blueprint.`,
          distance: Math.round(distance),
          anchorX: body.anchorX,
          anchorZ: body.anchorZ,
        });
      }
    }

    // Compute settlement nodes for use in both tier-gate and expansion-gate checks
    const existingWorldPrims = world.getWorldPrimitives();
    const allPrimsTyped = existingWorldPrims as unknown as PrimitiveLike[];
    const connForGates = allPrimsTyped.filter(isConnectorPrimitive);
    const structsForGates = buildStructureSummaries(allPrimsTyped);
    const nodesForGates = buildSettlementNodes(structsForGates, connForGates);
    let bestNode: SettlementNodeSummary | null = null;
    let bestDist = Infinity;
    for (const n of nodesForGates) {
      const d = Math.hypot(n.center.x - body.anchorX, n.center.z - body.anchorZ);
      if (d < bestDist) { bestDist = d; bestNode = n; }
    }
    const isFoundingAnchor = !bestNode || bestDist > BUILD_CREDIT_CONFIG.ANCHOR_FOUNDING_RADIUS;
    const bpTags: string[] = Array.isArray(blueprint.tags) ? blueprint.tags.map((t: any) => String(t).toLowerCase()) : [];
    const isMegaBlueprint = bpTags.includes('mega');
    const isTier3Blueprint =
      (typeof blueprint.minNodeTier === 'string' && TIER3_NODE_TIERS.has(blueprint.minNodeTier as NodeTier)) ||
      String(blueprint.difficulty || '').toLowerCase() === 'hard' ||
      bpTags.includes('mega') ||
      bpTags.includes('tier-3');
    if (isTier3Blueprint) {
      const combinedReputation = await db.getCombinedReputation(agentId);
      if (combinedReputation < 1) {
        return reply.code(403).send({
          error: `Tier-3 blueprints require at least 1 certification pass. Current reputation: ${combinedReputation}. Complete a SWAP_EXECUTION_V1 certification first.`
        });
      }
    }

    // Node-tier gate: blueprints with minNodeTier require a nearby node at that tier or higher
    if (blueprint.minNodeTier) {
      const requiredRank = tierRank(blueprint.minNodeTier as NodeTier);
      // Founding anchor exemption: if the blueprint anchor is far from any existing
      // node, this is a "founding build" — the agent is starting a brand-new district
      // with a mega blueprint as the centerpiece. Skip the tier gate.
      if (!isFoundingAnchor && tierRank(bestNode!.tier) < requiredRank) {
        const nodeName = bestNode?.name ?? 'none nearby';
        const nodeTier = bestNode?.tier ?? 'none';
        return reply.code(403).send({
          error: `This blueprint requires a nearby ${blueprint.minNodeTier} or higher. Nearest node "${nodeName}" is ${nodeTier}. Try placing it 50+ units from any existing node to found a new district, or build more structures to grow this node.`
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

    // Enforce settlement proximity — blueprint anchor must be near existing structures
    if (existingWorldPrims.length >= BUILD_CREDIT_CONFIG.SETTLEMENT_PROXIMITY_THRESHOLD) {
      const distToSettlement = distanceToNearestPrimitive(body.anchorX, body.anchorZ, existingWorldPrims);
      if (distToSettlement > BUILD_CREDIT_CONFIG.MAX_BUILD_DISTANCE_FROM_SETTLEMENT) {
        return reply.code(400).send({
          error: `Blueprint anchor too far from any existing build (${distToSettlement.toFixed(0)} units). Place within ${BUILD_CREDIT_CONFIG.MAX_BUILD_DISTANCE_FROM_SETTLEMENT} units of existing structures. Use GET /v1/grid/spatial-summary to find active neighborhoods.`
        });
      }
      if (distToSettlement >= BUILD_CREDIT_CONFIG.FRONTIER_EXPANSION_MIN_DISTANCE) {
        // Mega founding exemption: mega blueprints at founding anchors skip the expansion gate
        const skipExpansionGate = isMegaBlueprint && isFoundingAnchor;
        if (!skipExpansionGate) {
          const gate = getExpansionGateViolation(
            body.anchorX,
            body.anchorZ,
            allPrimsTyped,
          );
          if (gate.blocked) {
            return reply.code(409).send({
              error: `Expansion gate active: nearest node "${gate.nearestNodeName || 'unknown'}" has ${gate.nearestNodeCount || 0} structures. Densify a node to ${NODE_EXPANSION_GATE}+ structures before starting new frontier blueprints (${BUILD_CREDIT_CONFIG.FRONTIER_EXPANSION_MIN_DISTANCE}-${BUILD_CREDIT_CONFIG.FRONTIER_EXPANSION_MAX_DISTANCE}u lanes).`,
            });
          }
        }
      }
    }

    // Check resource costs for this blueprint
    const totalPrims = blueprint.totalPrimitives || blueprint.phases.reduce(
      (sum: number, phase: any) => sum + phase.primitives.length, 0
    );
    const blueprintCreditCost = totalPrims * BUILD_CREDIT_CONFIG.PRIMITIVE_COST;
    const blueprintMaterialCost: Record<string, number> | null =
      blueprint.materialCost && typeof blueprint.materialCost === 'object'
        ? blueprint.materialCost as Record<string, number>
        : null;

    let creditsPrepaid = false;
    if (blueprintMaterialCost) {
      const inventory = await db.getAgentMaterials(agentId);
      const missing: string[] = [];
      for (const [material, amount] of Object.entries(blueprintMaterialCost)) {
        if (!amount || amount <= 0) continue;
        if (!MATERIAL_TYPES.includes(material as any)) {
          missing.push(`${material}: invalid material type`);
          continue;
        }
        const matKey = material as keyof typeof inventory;
        const current = inventory[matKey] ?? 0;
        if (current < amount) {
          missing.push(`${material}: need ${amount}, have ${current}`);
        }
      }
      if (missing.length > 0) {
        return reply.code(403).send({
          error: `Insufficient materials for blueprint start: ${missing.join(', ')}`
        });
      }
      const credits = await db.getAgentCredits(agentId);
      if (credits < blueprintCreditCost) {
        return reply.code(403).send({
          error: `Insufficient credits. Need ${blueprintCreditCost}, have ${credits}.`
        });
      }
      creditsPrepaid = true;
    } else {
      const credits = await db.getAgentCredits(agentId);
      if (credits < blueprintCreditCost) {
        return reply.code(403).send({
          error: `Insufficient credits. Need ${blueprintCreditCost}, have ${credits}.`
        });
      }
    }

    // Compute absolute coordinates — the core value of the blueprint engine.
    // Flatten all phases, apply anchor offset to x/z (y stays relative to ground).
    // Apply optional rotY rotation around the anchor point.
    const allPrimitives: BlueprintBuildPlan['allPrimitives'] = [];
    const phases: BlueprintBuildPlan['phases'] = [];
    const rotYRad = ((body.rotY || 0) * Math.PI) / 180;
    const cosR = Math.cos(rotYRad);
    const sinR = Math.sin(rotYRad);

    for (const phase of blueprint.phases) {
      const phaseCount = phase.primitives.length;
      phases.push({ name: phase.name, count: phaseCount });

      for (const prim of phase.primitives) {
        const ox = prim.x || 0;
        const oz = prim.z || 0;
        const rx = ox * cosR - oz * sinR;
        const rz = ox * sinR + oz * cosR;

        // Rotate primitive's local rotation axes to match blueprint orientation.
        // When the blueprint is rotated by rotY, the local X and Z axes of each
        // primitive also rotate in the XZ plane.
        const primRotX = prim.rotX || 0;
        const primRotZ = prim.rotZ || 0;
        const newRotX = primRotX * cosR + primRotZ * sinR;
        const newRotZ = -primRotX * sinR + primRotZ * cosR;

        allPrimitives.push({
          shape: prim.shape,
          position: {
            x: rx + body.anchorX,
            y: prim.y || 0,
            z: rz + body.anchorZ,
          },
          rotation: {
            x: newRotX,
            y: (prim.rotY || 0) + rotYRad,
            z: newRotZ,
          },
          scale: {
            x: prim.scaleX || 1,
            y: prim.scaleY || 1,
            z: prim.scaleZ || 1,
          },
          color: prim.color || '#808080',
          materialType: prim.materialType || null,
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

    // Atomic debit for premium (material-cost) blueprints after all placement validations pass.
    if (creditsPrepaid && blueprintMaterialCost) {
      const started = await db.startBlueprintWithMaterialCost(agentId, blueprintCreditCost, blueprintMaterialCost);
      if (!started) {
        return reply.code(403).send({
          error: 'Unable to start blueprint due to insufficient credits/materials.'
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
      creditsPrepaid,
    };
    world.setBuildPlan(agentId, plan);
    world.setBlueprintReservation(agentId, { minX: footMinX, maxX: footMaxX, minZ: footMinZ, maxZ: footMaxZ });

    // Persist plan so deploys/restarts don't wipe in-flight builds.
    try {
      await db.upsertBlueprintBuildPlan(agentId, plan);
    } catch (err: any) {
      world.clearBuildPlan(agentId);
      console.error('[Blueprint] Failed to persist build plan:', err);
      return reply.code(500).send({
        error: 'Failed to persist build plan. Try again shortly.',
      });
    }

    // Milestone broadcast: blueprint started (terminal, not chat).
    try {
      const builder = await db.getAgent(agentId);
      const builderName = builder?.name || agentId;
      const startEvent = await db.insertMessageEvent({
        agentId, agentName: builderName,
        source: 'system', kind: 'build',
        body: `${builderName} started ${body.name} at (${body.anchorX}, ${body.anchorZ}) [0/${allPrimitives.length}]`,
        metadata: { blueprint: body.name, anchorX: body.anchorX, anchorZ: body.anchorZ, total: allPrimitives.length },
      });
      world.broadcastEvent(startEvent);
    } catch (err) {
      console.warn('[Blueprint] Failed to broadcast start message:', err);
    }

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

    const continueThrottle = checkRateLimit(
      'rest:grid:blueprint:continue',
      agentId,
      BLUEPRINT_CONTINUE_RATE_LIMIT.limit,
      BLUEPRINT_CONTINUE_RATE_LIMIT.windowMs
    );
    if (!continueThrottle.allowed) {
      return reply.code(429).send({
        error: 'Blueprint continue rate limited. Slow down.',
        retryAfterMs: continueThrottle.retryAfterMs,
      });
    }

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
        // Position copy for potential Y correction
        const position = { ...prim.position };

        // Floating validation (same as single-primitive endpoint) — use in-memory cache
        const nearbyPrimitives = world.getWorldPrimitives();
        const relevant = nearbyPrimitives.filter(p =>
          Math.abs(p.position.x - position.x) < 20 &&
          Math.abs(p.position.z - position.z) < 20
        );
        let validation = validateBuildPosition(prim.shape, position, prim.scale, relevant);

        // Salvage floating (or mis-snapped) pieces by applying suggested correctedY once.
        if (!validation.valid && validation.correctedY !== undefined) {
          position.y = validation.correctedY;
          validation = validateBuildPosition(prim.shape, position, prim.scale, relevant);
        }

        if (!validation.valid) {
          results.push({
            index: idx,
            success: false,
            error: validation.error || 'Invalid build position',
          });
          continue;
        }

        if (validation.correctedY !== undefined) {
          position.y = validation.correctedY;
        }

        // Create the primitive — tag with blueprint instance so all pieces
        // from the same blueprint are grouped as one structure.
        const primitive = {
          id: `prim_${randomUUID()}`,
          shape: prim.shape as any,
          ownerAgentId: agentId,
          ownerAgentName: builderName,
          position,
          rotation: prim.rotation,
          scale: prim.scale,
          color: prim.color,
          createdAt: Date.now(),
          blueprintInstanceId: `bp_${agentId}_${plan.startedAt}`,
          blueprintName: plan.blueprintName,
          materialType: prim.materialType || null,
        };

        const placed = await db.createWorldPrimitiveWithCreditDebit(
          primitive,
          plan.creditsPrepaid ? 0 : BUILD_CREDIT_CONFIG.PRIMITIVE_COST
        );
        if (!placed.ok) {
          results.push({
            index: idx,
            success: false,
            error: placed.reason === 'insufficient_credits' ? 'Insufficient credits' : 'Failed to place primitive',
          });
          continue;
        }

        world.addWorldPrimitive(primitive);

        if (placed.repReward && placed.totalBuilt) {
          const repEvent = await db.insertMessageEvent({
            source: 'system', kind: 'reputation',
            body: `🏆 ${builderName} reached a milestone (${placed.totalBuilt} primitives built) and earned +${placed.repReward} reputation!`,
            metadata: { agentId, totalBuilt: placed.totalBuilt, repReward: placed.repReward },
          });
          world.broadcastEvent(repEvent);
        }

        if (placed.materialEarned) {
          const matEvent = await db.insertMessageEvent({
            source: 'system', kind: 'material',
            body: `⛏️ ${builderName} earned 1 ${placed.materialEarned} material for placing ${MATERIAL_CONFIG.EARN_EVERY_N_PRIMITIVES} primitives.`,
            metadata: { agentId, material: placed.materialEarned },
          });
          world.broadcastEvent(matEvent);
        }

        plan.placedCount++;
        results.push({ index: idx, success: true });
      } catch (err: any) {
        results.push({ index: idx, success: false, error: err?.message || String(err) });
      }
    }

    // Broadcast a single build message for the batch (terminal, not chat)
    const successCount = results.filter(r => r.success).length;
    if (successCount > 0) {
      const batchEvent = await db.insertMessageEvent({
        agentId, agentName: builderName,
        source: 'system', kind: 'build',
        body: `${builderName} placed ${successCount} pieces of ${plan.blueprintName} at (${plan.anchorX}, ${plan.anchorZ}) [${plan.placedCount}/${plan.totalPrimitives}]`,
        metadata: { blueprint: plan.blueprintName, placed: plan.placedCount, total: plan.totalPrimitives },
      });
      world.broadcastEvent(batchEvent);
    }

    // Check completion
    if (plan.nextIndex >= plan.totalPrimitives) {
      const failedCount = plan.totalPrimitives - plan.placedCount;
      const status = failedCount === 0 ? 'complete' : 'complete_with_failures';

      // Broadcast completion truth (terminal, not chat).
      const completionMsg = failedCount === 0
        ? `${builderName} completed ${plan.blueprintName} at (${plan.anchorX}, ${plan.anchorZ}) [${plan.placedCount}/${plan.totalPrimitives}]`
        : `${builderName} completed ${plan.blueprintName} at (${plan.anchorX}, ${plan.anchorZ}) with failures: placed ${plan.placedCount}/${plan.totalPrimitives}, failed ${failedCount}`;
      const completionEvent = await db.insertMessageEvent({
        agentId, agentName: builderName,
        source: 'system', kind: 'build',
        body: completionMsg,
        metadata: { blueprint: plan.blueprintName, placed: plan.placedCount, total: plan.totalPrimitives },
      });
      world.broadcastEvent(completionEvent);

      try {
        await db.deleteBlueprintBuildPlan(agentId);
      } catch (err) {
        console.error('[Blueprint] Failed to delete persisted build plan on completion:', err);
        return reply.code(500).send({
          error: 'Blueprint completed, but server failed to finalize build plan persistence. Try BUILD_CONTINUE again.',
        });
      }

      world.clearBuildPlan(agentId);
      return {
        status,
        placed: plan.placedCount,
        total: plan.totalPrimitives,
        failedCount,
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

    try {
      await db.upsertBlueprintBuildPlan(agentId, plan);
    } catch (err) {
      console.error('[Blueprint] Failed to persist build plan progress:', err);
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

    try {
      await db.deleteBlueprintBuildPlan(agentId);
    } catch (err) {
      console.error('[Blueprint] Failed to delete persisted build plan on cancel:', err);
      return reply.code(500).send({ error: 'Failed to cancel build plan. Try again shortly.' });
    }

    const piecesPlaced = plan.placedCount;
    world.clearBuildPlan(agentId);

    return { cancelled: true, piecesPlaced };
  });

  const RelocateFrontierSchema = z.object({
    minDistance: z.number().min(40).max(600).optional(),
    preferredType: z.enum(['frontier', 'connector', 'growth']).optional(),
  });

  fastify.post('/v1/grid/relocate/frontier', async (request, reply) => {
    const agentId = await requireAgent(request, reply);
    if (!agentId) return;

    const relocateThrottle = checkRateLimit(
      'rest:grid:relocate:frontier',
      agentId,
      1,
      20_000
    );
    if (!relocateThrottle.allowed) {
      return reply.code(429).send({
        error: 'Frontier relocation rate limited. Try again shortly.',
        retryAfterMs: relocateThrottle.retryAfterMs,
      });
    }

    const parsed = RelocateFrontierSchema.safeParse(request.body || {});
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Invalid relocation request body',
        details: parsed.error.issues,
      });
    }

    const minDistance = parsed.data.minDistance ?? BUILD_CREDIT_CONFIG.FRONTIER_EXPANSION_MAX_DISTANCE;
    const preferredType = parsed.data.preferredType ?? 'frontier';

    const agent = world.getAgent(agentId);
    if (!agent) {
      return reply.code(404).send({ error: 'Active agent not found in world state.' });
    }

    const allPrimitives = world.getWorldPrimitives();
    const primitiveInput = allPrimitives as unknown as PrimitiveLike[];
    const connectorPrimitives = primitiveInput.filter(isConnectorPrimitive);
    const structures = buildStructureSummaries(primitiveInput);
    const nodes = buildSettlementNodes(structures, connectorPrimitives);
    const openAreas = computeOpenAreas(nodes, primitiveInput);

    if (openAreas.length === 0) {
      return reply.code(409).send({
        error: 'No relocation candidates available right now. Try again after world expansion.',
      });
    }

    const otherAgents = world.getAgents().filter(a => a.id !== agentId);
    const targetDistance = Math.max(BUILD_CREDIT_CONFIG.FRONTIER_EXPANSION_MIN_DISTANCE, minDistance);

    const buildReachableAreas = openAreas.filter(
      (area) => area.nearestBuild <= BUILD_CREDIT_CONFIG.MAX_BUILD_DISTANCE_FROM_SETTLEMENT,
    );
    const candidateAreas = buildReachableAreas.length > 0 ? buildReachableAreas : openAreas;

    const scored = candidateAreas.map((area) => {
      const distToSelf = Math.hypot(area.x - agent.position.x, area.z - agent.position.z);
      const nearestOtherAgent = otherAgents.length > 0
        ? Math.min(...otherAgents.map(a => Math.hypot(area.x - a.position.x, area.z - a.position.z)))
        : 200;

      const type = area.type || 'growth';
      const preferredBonus = type === preferredType ? -22 : type === 'frontier' ? -10 : 6;
      const underDistancePenalty = distToSelf < minDistance ? (minDistance - distToSelf) * 8 : 0;

      const buildReachPenalty =
        area.nearestBuild > BUILD_CREDIT_CONFIG.MAX_BUILD_DISTANCE_FROM_SETTLEMENT
          ? (area.nearestBuild - BUILD_CREDIT_CONFIG.MAX_BUILD_DISTANCE_FROM_SETTLEMENT) * 3
          : 0;
      let score = Math.abs(distToSelf - targetDistance) + underDistancePenalty + buildReachPenalty;
      score -= Math.min(35, nearestOtherAgent / 5);
      score += preferredBonus;

      return { area, distToSelf, nearestOtherAgent, score };
    });

    scored.sort((a, b) => a.score - b.score || b.distToSelf - a.distToSelf);

    const chosen =
      scored.find((entry) => entry.distToSelf >= Math.max(45, minDistance * 0.75))
      || scored[0];

    if (!chosen) {
      return reply.code(409).send({
        error: 'Could not select a relocation target.',
      });
    }

    const moved = world.teleportAgent(agentId, chosen.area.x, chosen.area.z);
    if (!moved) {
      return reply.code(404).send({ error: 'Agent missing from world state during relocation.' });
    }

    await db.updateAgent(agentId, moved);

    return {
      success: true,
      position: {
        x: moved.position.x,
        z: moved.position.z,
      },
      distanceFromPrevious: Math.round(chosen.distToSelf),
      area: {
        x: chosen.area.x,
        z: chosen.area.z,
        type: chosen.area.type || 'growth',
        nearestBuild: chosen.area.nearestBuild,
        nearestNodeName: chosen.area.nearestNodeName,
      },
      guidance: `Relocated to a buildable lane. Frontier expansion is strongest around ${BUILD_CREDIT_CONFIG.FRONTIER_EXPANSION_MIN_DISTANCE}-${BUILD_CREDIT_CONFIG.FRONTIER_EXPANSION_MAX_DISTANCE} units from existing geometry.`,
    };
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
    const event = await db.insertMessageEvent({
      agentId, agentName: agent.name,
      source: 'agent', kind: 'status',
      body: body.message,
    });
    world.broadcastEvent(event);

    return event;
  });

  fastify.get('/v1/grid/terminal', async (request, reply) => {
    return await db.getRecentMessageEvents(50);
  });

  // --- Human-Agent DMs (REST polling inbox) ---

  fastify.post('/v1/grid/dm', async (request, reply) => {
    const agentId = await requireAgent(request, reply);
    if (!agentId) return;

    const dmThrottle = checkRateLimit(
      'rest:grid:dm:send',
      agentId,
      DM_SEND_RATE_LIMIT.limit,
      DM_SEND_RATE_LIMIT.windowMs
    );
    if (!dmThrottle.allowed) {
      return reply.status(429).send({
        error: 'DM rate limited. Slow down.',
        retryAfterMs: dmThrottle.retryAfterMs,
      });
    }

    const body = SendDirectMessageSchema.parse(request.body);
    if (body.toAgentId === agentId) {
      return reply.status(400).send({ error: 'Cannot DM yourself.' });
    }

    const sender = await db.getAgent(agentId);
    const recipient = await db.getAgent(body.toAgentId);
    if (!sender || !recipient) {
      return reply.status(404).send({ error: 'Sender or recipient agent not found.' });
    }

    const fromType = (sender as any)?.isAutonomous ? 'agent' : 'human';
    const fromId = fromType === 'human'
      ? ((sender as any)?.ownerId || sender.id)
      : sender.id;

    const saved = await db.sendDirectMessage(fromId, fromType, body.toAgentId, body.message.trim());
    return saved;
  });

  fastify.get('/v1/grid/dm/inbox', async (request, reply) => {
    const agentId = await requireAgent(request, reply);
    if (!agentId) return;

    const inboxThrottle = checkRateLimit(
      'rest:grid:dm:inbox',
      agentId,
      DM_INBOX_RATE_LIMIT.limit,
      DM_INBOX_RATE_LIMIT.windowMs
    );
    if (!inboxThrottle.allowed) {
      return reply.status(429).send({
        error: 'DM inbox polling is rate limited. Slow down.',
        retryAfterMs: inboxThrottle.retryAfterMs,
      });
    }

    const query = request.query as { unread?: string | boolean | number };
    const unreadRaw = query?.unread;
    const unreadOnly =
      unreadRaw === true ||
      unreadRaw === 1 ||
      String(unreadRaw || '').toLowerCase() === 'true' ||
      String(unreadRaw || '') === '1';

    const messages = await db.getAgentInbox(agentId, unreadOnly);
    return { messages };
  });

  fastify.post('/v1/grid/dm/mark-read', async (request, reply) => {
    const agentId = await requireAgent(request, reply);
    if (!agentId) return;

    const markReadThrottle = checkRateLimit(
      'rest:grid:dm:mark-read',
      agentId,
      DM_MARK_READ_RATE_LIMIT.limit,
      DM_MARK_READ_RATE_LIMIT.windowMs
    );
    if (!markReadThrottle.allowed) {
      return reply.status(429).send({
        error: 'DM mark-read is rate limited. Slow down.',
        retryAfterMs: markReadThrottle.retryAfterMs,
      });
    }

    const body = MarkDirectMessagesReadSchema.parse(request.body);
    const updated = await db.markDMsRead(agentId, body.messageIds);
    return { updated };
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

    const combinedReputation = await db.getCombinedReputation(agentId);
    const isExternal = (agent as any).isExternal === true;
    if (isExternal && combinedReputation <= 5) {
      return reply.status(403).send({
        error: `External visitors cannot submit directives until combined reputation exceeds 5. Current: ${combinedReputation}.`
      });
    }
    if (combinedReputation < 5) {
      return reply.status(403).send({
        error: `Combined reputation of 5 required to submit a directive. Current: ${combinedReputation}.`
      });
    }

    const body = SubmitGridDirectiveSchema.parse(request.body);

    // Submitter lock: reject if agent already has an unresolved directive
    const existingDirective = await db.getAgentActiveDirective(agentId);
    if (existingDirective) {
      return reply.status(409).send({
        error: 'You have an unresolved directive. Complete or let it expire before submitting another.',
        existingDirectiveId: existingDirective.id,
      });
    }

    // Charge submission cost
    const submitCost = BUILD_CREDIT_CONFIG.DIRECTIVE_SUBMIT_COST;
    const agentCredits = await db.getAgentCredits(agentId);
    if (agentCredits < submitCost) {
      return reply.status(403).send({
        error: `Insufficient credits to submit a directive. Need ${submitCost}, have ${agentCredits}.`,
      });
    }
    await db.deductCredits(agentId, submitCost);

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
      noVotes: 0,
      targetX: body.targetX,
      targetZ: body.targetZ,
      targetStructureGoal: body.targetStructureGoal,
    };

    await db.createDirective(directive);
    world.broadcastDirective(directive);

    const proposerTokenId = Number((agent as any)?.erc8004AgentId || 0);
    if (Number.isFinite(proposerTokenId) && proposerTokenId > 0) {
      try {
        const onchain = await submitDirectiveOnChain({
          kind: 'solo',
          proposerAgentTokenId: proposerTokenId,
          objective: body.description,
          agentsNeeded: body.agentsNeeded,
          x: Math.round(body.targetX ?? 0),
          z: Math.round(body.targetZ ?? 0),
          hoursDuration: body.hoursDuration,
        });
        if (onchain?.txHash) {
          console.log(`[Chain] Synced solo directive ${directive.id} -> tx ${onchain.txHash}`);
        }
      } catch (error) {
        console.warn('[Chain] Failed to sync solo directive on-chain (non-blocking):', error);
      }
    }

    // Write directive confirmation to unified feed
    const directiveEvent = await db.insertMessageEvent({
      agentId, agentName: agent.name,
      source: 'system', kind: 'directive',
      body: `${agent.name} proposed directive: "${body.description}" (needs ${body.agentsNeeded} agents)`,
      metadata: { directiveId: directive.id, agentsNeeded: body.agentsNeeded },
    });
    world.broadcastEvent(directiveEvent);

    return directive;
  });

  fastify.post('/v1/grid/directives/guild', async (request, reply) => {
    const agentId = await requireAgent(request, reply);
    if (!agentId) return;

    const guildId = await db.getAgentGuild(agentId);
    if (!guildId) return reply.status(403).send({ error: 'Not in a guild' });

    const agent = await db.getAgent(agentId);
    const combinedReputation = await db.getCombinedReputation(agentId);
    const isExternal = (agent as any)?.isExternal === true;
    if (isExternal && combinedReputation <= 5) {
      return reply.status(403).send({
        error: `External visitors cannot submit guild directives until combined reputation exceeds 5. Current: ${combinedReputation}.`
      });
    }
    if (!agent || combinedReputation < 5) {
      return reply.status(403).send({
        error: `Combined reputation of 5 required to submit a guild directive. Current: ${combinedReputation}.`
      });
    }

    const body = SubmitGuildDirectiveSchema.parse(request.body);
    if (body.guildId !== guildId) return reply.status(403).send({ error: 'Wrong guild' });

    // Submitter lock: reject if agent already has an unresolved directive
    const existingDirective = await db.getAgentActiveDirective(agentId);
    if (existingDirective) {
      return reply.status(409).send({
        error: 'You have an unresolved directive. Complete or let it expire before submitting another.',
        existingDirectiveId: existingDirective.id,
      });
    }

    // Charge submission cost
    const submitCost = BUILD_CREDIT_CONFIG.DIRECTIVE_SUBMIT_COST;
    const agentCredits = await db.getAgentCredits(agentId);
    if (agentCredits < submitCost) {
      return reply.status(403).send({
        error: `Insufficient credits to submit a directive. Need ${submitCost}, have ${agentCredits}.`,
      });
    }
    await db.deductCredits(agentId, submitCost);

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
      noVotes: 0,
      targetX: body.targetX,
      targetZ: body.targetZ,
      targetStructureGoal: body.targetStructureGoal,
    };

    await db.createDirective(directive);
    world.broadcastDirective(directive);

    const proposerTokenId = Number((agent as any)?.erc8004AgentId || 0);
    const numericGuildId = Number(guildId);
    if (Number.isFinite(proposerTokenId) && proposerTokenId > 0 && Number.isFinite(numericGuildId) && numericGuildId > 0) {
      try {
        const onchain = await submitDirectiveOnChain({
          kind: 'guild',
          guildId: numericGuildId,
          proposerAgentTokenId: proposerTokenId,
          objective: body.description,
          agentsNeeded: body.agentsNeeded,
          x: Math.round(body.targetX ?? 0),
          z: Math.round(body.targetZ ?? 0),
          hoursDuration: body.hoursDuration,
        });
        if (onchain?.txHash) {
          console.log(`[Chain] Synced guild directive ${directive.id} -> tx ${onchain.txHash}`);
        }
      } catch (error) {
        console.warn('[Chain] Failed to sync guild directive on-chain (non-blocking):', error);
      }
    }

    return directive;
  });

  fastify.post('/v1/grid/directives/:id/vote', async (request, reply) => {
    const agentId = await requireAgent(request, reply);
    if (!agentId) return;

    const { id } = request.params as { id: string };
    const body = VoteDirectiveSchema.parse(request.body);

    await db.castVote(id, agentId, body.vote);

    // Diplomat class gets 2x vote weight — cast an extra synthetic vote
    const voter = await db.getAgent(agentId);
    const voterClass = (voter as any)?.agentClass as string | undefined;
    if (voterClass === 'diplomat') {
      // Cast a second vote under a synthetic ID to represent double weight
      await db.castVote(id, `${agentId}_diplomat_weight`, body.vote);
    }

    // Write vote confirmation to terminal feed
    const voterName = voter?.name || agentId;
    const voteLabel = voterClass === 'diplomat' ? `${body.vote} (2x diplomat weight)` : body.vote;
    const voteEvent = await db.insertMessageEvent({
      agentId, agentName: voterName,
      source: 'system', kind: 'directive',
      body: `${voterName} voted ${voteLabel} on directive ${id}`,
      metadata: { directiveId: id, vote: body.vote },
    });
    world.broadcastEvent(voteEvent);

    // Check if directive should be passed (yes_votes >= agentsNeeded)
    const directiveData = await db.getDirective(id);
    if (directiveData && directiveData.status === 'active' && directiveData.yesVotes >= directiveData.agentsNeeded) {
      await db.passDirective(id);
      await db.activateDirective(id);

      // Reward only the submitter, capped at CREDIT_CAP
      const reward = BUILD_CREDIT_CONFIG.DIRECTIVE_COMPLETION_REWARD;
      await db.addCreditsWithCap(directiveData.submittedBy, reward, BUILD_CREDIT_CONFIG.CREDIT_CAP);

      const submitter = await db.getAgent(directiveData.submittedBy);
      const submitterName = submitter?.name || directiveData.submittedBy;
      const passedEvent = await db.insertMessageEvent({
        source: 'system', kind: 'directive',
        body: `Directive passed: "${directiveData.description}" — now in progress. ${submitterName} earned ${reward} credits.`,
        metadata: { directiveId: id, reward },
      });
      world.broadcastEvent(passedEvent);
    }

    // Check if directive should be declined (no_votes >= agentsNeeded)
    if (directiveData && directiveData.status === 'active' && directiveData.noVotes >= directiveData.agentsNeeded) {
      await db.declineDirective(id);

      const declinedEvent = await db.insertMessageEvent({
        source: 'system', kind: 'directive',
        body: `Directive declined: "${directiveData.description}" — agents voted it down.`,
        metadata: { directiveId: id },
      });
      world.broadcastEvent(declinedEvent);
    }

    return { success: true };
  });

  // --- Complete Directive (objective achieved) ---

  fastify.post('/v1/grid/directives/:id/complete', async (request, reply) => {
    const agentId = await requireAgent(request, reply);
    if (!agentId) return;

    const { id } = request.params as { id: string };

    const directiveData = await db.getDirective(id);
    if (!directiveData) {
      return reply.status(404).send({ error: 'Directive not found' });
    }

    if (directiveData.status !== 'passed' && directiveData.status !== 'in_progress') {
      return reply.status(400).send({
        error: `Directive cannot be completed — current status is "${directiveData.status}". Only passed or in_progress directives can be completed.`,
      });
    }

    await db.completeDirective(id, agentId);
    await db.addLocalReputation(agentId, 5); // Feature 7b reward

    // No credit reward — building itself earns credits
    const completer = await db.getAgent(agentId);
    const completerName = completer?.name || agentId;
    const completionEvent = await db.insertMessageEvent({
      agentId, agentName: completerName,
      source: 'system', kind: 'directive',
      body: `Directive completed by ${completerName}: "${directiveData.description}" — objective achieved!`,
      metadata: { directiveId: id },
    });
    world.broadcastEvent(completionEvent);

    return { success: true, completed: true };
  });

  // --- Guilds ---

  fastify.post('/v1/grid/guilds', async (request, reply) => {
    const commanderId = await requireAgent(request, reply);
    if (!commanderId) return;

    const commander = await db.getAgent(commanderId);
    const combinedReputation = await db.getCombinedReputation(commanderId);
    const isExternal = (commander as any)?.isExternal === true;
    if (isExternal && combinedReputation <= 5) {
      return reply.status(403).send({
        error: `External visitors cannot create guilds until combined reputation exceeds 5. Current: ${combinedReputation}.`
      });
    }
    if (!commander || combinedReputation < 10) {
      return reply.status(403).send({
        error: `Combined reputation of 10 required to create a guild. Current: ${combinedReputation}.`
      });
    }

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

    const commanderTokenId = Number((commander as any)?.erc8004AgentId || 0);
    const vice = await db.getAgent(body.viceCommanderId);
    const viceTokenId = Number((vice as any)?.erc8004AgentId || 0);
    const viceWallet = (vice as any)?.ownerId as string | undefined;
    if (
      Number.isFinite(commanderTokenId) &&
      commanderTokenId > 0 &&
      Number.isFinite(viceTokenId) &&
      viceTokenId > 0 &&
      typeof viceWallet === 'string' &&
      viceWallet.length > 0
    ) {
      try {
        const onchain = await syncGuildOnChain({
          name: guild.name,
          lieutenant: viceWallet,
          captainAgentTokenId: commanderTokenId,
          lieutenantAgentTokenId: viceTokenId,
        });
        if (onchain?.txHash) {
          console.log(`[Chain] Synced guild ${guild.id} -> tx ${onchain.txHash}`);
        }
      } catch (error) {
        console.warn('[Chain] Failed to sync guild on-chain (non-blocking):', error);
      }
    }

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

  fastify.post('/v1/grid/guilds/:id/join', async (request, reply) => {
    const agentId = await requireAgent(request, reply);
    if (!agentId) return;

    const { id } = request.params as { id: string };
    const guild = await db.getGuild(id);
    if (!guild) return reply.status(404).send({ error: 'Guild not found' });

    const currentGuild = await db.getAgentGuild(agentId);
    if (currentGuild === id) {
      return { success: true, guildId: id, guildName: guild.name, alreadyMember: true };
    }
    if (currentGuild) {
      return reply.status(400).send({ error: 'You are already in a guild' });
    }

    await db.addGuildMember(id, agentId);

    const joiner = await db.getAgent(agentId);
    const joinerName = joiner?.name || agentId;
    const joinEvent = await db.insertMessageEvent({
      agentId, agentName: joinerName,
      source: 'system', kind: 'guild',
      body: `${joinerName} joined guild "${guild.name}"`,
      metadata: { guildId: id, guildName: guild.name },
    });
    world.broadcastEvent(joinEvent);

    return { success: true, guildId: id, guildName: guild.name, alreadyMember: false };
  });

  // --- Credits ---

  fastify.get('/v1/grid/credits', async (request, reply) => {
    const agentId = await requireAgent(request, reply);
    if (!agentId) return;

    const credits = await db.getAgentCredits(agentId);
    return { credits };
  });

  // --- Materials ---

  fastify.get('/v1/grid/materials', async (request, reply) => {
    const agentId = await requireAgent(request, reply);
    if (!agentId) return;
    const materials = await db.getAgentMaterials(agentId);
    return { materials };
  });

  fastify.post('/v1/grid/trade', async (request, reply) => {
    const agentId = await requireAgent(request, reply);
    if (!agentId) return;

    const body = TradeRequestSchema.parse(request.body);
    if (body.toAgentId === agentId) {
      return reply.status(400).send({ error: 'Cannot trade materials to yourself.' });
    }

    const sender = await db.getAgent(agentId);
    const recipient = await db.getAgent(body.toAgentId);
    if (!sender || !recipient) {
      return reply.status(404).send({ error: 'Sender or recipient agent not found.' });
    }

    const senderClass = (sender as any)?.agentClass as string | undefined;
    const transferMultiplier = senderClass === 'merchant' ? CLASS_BONUSES.merchant.transferBonus : 1;
    const receivedAmount = Math.round(body.amount * transferMultiplier);

    const transferred = await db.transferMaterial(agentId, body.toAgentId, body.material, body.amount);
    if (!transferred) {
      return reply.status(403).send({ error: 'Insufficient material balance for trade.' });
    }

    if (receivedAmount > body.amount) {
      await db.addMaterial(body.toAgentId, body.material, receivedAmount - body.amount);
    }

    await db.incrementSuccessfulTrades(agentId);
    await db.incrementSuccessfulTrades(body.toAgentId);
    await db.addLocalReputation(agentId, 1);
    await db.addLocalReputation(body.toAgentId, 1);

    const senderName = sender.name || agentId;
    const bonusLabel = receivedAmount > body.amount ? ` (+${receivedAmount - body.amount} merchant bonus)` : '';
    const tradeEvent = await db.insertMessageEvent({
      agentId, agentName: senderName,
      source: 'system', kind: 'trade',
      body: `${senderName} traded ${body.amount} ${body.material} to ${recipient.name}${bonusLabel}`,
      metadata: { material: body.material, amount: body.amount, toAgentId: body.toAgentId },
    });
    world.broadcastEvent(tradeEvent);

    return {
      success: true,
      material: body.material,
      transferred: body.amount,
      received: receivedAmount,
      to: body.toAgentId
    };
  });

  fastify.post('/v1/grid/scavenge', async (request, reply) => {
    const agentId = await requireAgent(request, reply);
    if (!agentId) return;

    const scavengeThrottle = checkRateLimit('rest:grid:scavenge', agentId, 1, 60_000);
    if (!scavengeThrottle.allowed) {
      return reply.code(429).send({
        error: 'Scavenge rate limited. Try again in a minute.',
        retryAfterMs: scavengeThrottle.retryAfterMs,
      });
    }

    const agent = await db.getAgent(agentId);
    const agentClass = (agent as any)?.agentClass as string | undefined;
    const isScavenger = agentClass === 'scavenger';

    // Base yield for all classes, scavenger gets bonus
    const baseYield = MATERIAL_CONFIG.SCAVENGE_YIELD;
    const yieldMultiplier = isScavenger ? 1.25 : 1.0;

    // All agents can scavenge from world activity (not just abandoned structures)
    // This represents gathering materials from the environment
    const abandonedStructures = await db.getAbandonedStructureCount(7);
    const worldPrimitiveCount = world.getWorldPrimitives().length;
    // Base scavenge opportunity: at least 1 if world has any structures, plus abandoned
    const scavengeOpportunity = Math.max(worldPrimitiveCount > 0 ? 1 : 0, abandonedStructures);
    if (scavengeOpportunity <= 0) {
      return {
        success: true,
        scavengeOpportunity: 0,
        harvested: emptyMaterialCounts(),
        totalHarvested: 0
      };
    }

    const totalHarvested = Math.min(5, Math.ceil(scavengeOpportunity * baseYield * yieldMultiplier));
    const harvested = emptyMaterialCounts();
    for (let i = 0; i < totalHarvested; i++) {
      const found = await db.addRandomMaterial(agentId);
      if (found) harvested[found] += 1;
    }

    const scavengerName = agent?.name || agentId;
    const bonusNote = isScavenger ? ' (scavenger bonus!)' : '';
    const scavengeEvent = await db.insertMessageEvent({
      agentId, agentName: scavengerName,
      source: 'system', kind: 'scavenge',
      body: `🧲 ${scavengerName} scavenged ${totalHarvested} materials${bonusNote}`,
      metadata: { totalHarvested, isScavenger },
    });
    world.broadcastEvent(scavengeEvent);

    return {
      success: true,
      harvested,
      totalHarvested,
      scavengerBonus: isScavenger,
    };
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

    // Merchant class gets 1.5x transfer bonus — recipient receives more
    const sender = await db.getAgent(agentId);
    const senderClass = (sender as any)?.agentClass as string | undefined;
    const transferMultiplier = senderClass === 'merchant' ? CLASS_BONUSES.merchant.transferBonus : 1;
    const receivedAmount = Math.round(body.amount * transferMultiplier);

    // Deduct the base amount from sender, credit the (possibly boosted) amount to recipient
    await db.transferCredits(agentId, body.toAgentId, body.amount, BUILD_CREDIT_CONFIG.CREDIT_CAP);
    // If merchant bonus, add the extra credits to recipient
    if (receivedAmount > body.amount) {
      const bonus = receivedAmount - body.amount;
      await db.addCreditsWithCap(body.toAgentId, bonus, BUILD_CREDIT_CONFIG.CREDIT_CAP);
    }
    await db.incrementSuccessfulTrades(agentId);
    await db.incrementSuccessfulTrades(body.toAgentId);
    await db.addLocalReputation(agentId, 1);
    await db.addLocalReputation(body.toAgentId, 1);

    // Broadcast transfer to terminal
    const senderName = sender?.name || agentId;
    const bonusLabel = receivedAmount > body.amount ? ` (+${receivedAmount - body.amount} merchant bonus)` : '';
    const transferEvent = await db.insertMessageEvent({
      agentId, agentName: senderName,
      source: 'system', kind: 'transfer',
      body: `${senderName} transferred ${body.amount} credits to ${recipient.name}${bonusLabel}`,
      metadata: { amount: body.amount, toAgentId: body.toAgentId, received: receivedAmount },
    });
    world.broadcastEvent(transferEvent);

    return { success: true, transferred: body.amount, received: receivedAmount, to: body.toAgentId };
  });

  // --- Referral ---

  fastify.get('/v1/grid/referral', async (request, reply) => {
    const agentId = await requireAgent(request, reply);
    if (!agentId) return;

    const agent = await db.getAgent(agentId);
    if (!agent) return reply.status(404).send({ error: 'Agent not found' });

    const referralCode = (agent as any).referralCode || null;
    const stats = await db.getReferralStats(agentId);

    return {
      referralCode,
      referralCount: stats.referralCount,
      creditsEarned: stats.creditsEarned,
    };
  });

  // --- Structure Details (Blueprint-aware click metadata) ---

  fastify.get<{ Params: { instanceId: string } }>('/v1/grid/structures/:instanceId', async (request, reply) => {
    const { instanceId } = request.params;
    if (!instanceId || !instanceId.startsWith('bp_')) {
      return reply.status(400).send({ error: 'Invalid blueprint instance ID.' });
    }

    const pieces = world.getWorldPrimitives().filter((primitive) => primitive.blueprintInstanceId === instanceId);
    if (pieces.length === 0) {
      return reply.status(404).send({ error: 'Structure not found.' });
    }

    const sortedPieces = [...pieces].sort((a, b) => a.createdAt - b.createdAt);
    const firstPiece = sortedPieces[0];
    const ownerAgentId = firstPiece.ownerAgentId;
    const ownerAgent = await db.getAgent(ownerAgentId);

    const summed = pieces.reduce(
      (acc, piece) => ({
        x: acc.x + piece.position.x,
        z: acc.z + piece.position.z,
      }),
      { x: 0, z: 0 }
    );
    const center = {
      x: summed.x / pieces.length,
      z: summed.z / pieces.length,
    };

    let builtAt = Number.isFinite(firstPiece.createdAt) ? firstPiece.createdAt : null;
    const parsedBlueprintStamp = /^bp_(.+)_(\d{10,})$/.exec(instanceId);
    if (parsedBlueprintStamp) {
      const parsed = Number(parsedBlueprintStamp[2]);
      if (Number.isFinite(parsed)) {
        builtAt = builtAt === null ? parsed : Math.min(builtAt, parsed);
      }
    }

    let guild: { id: string; name: string } | null = null;
    const guildId = await db.getAgentGuild(ownerAgentId);
    if (guildId) {
      const g = await db.getGuild(guildId);
      if (g) {
        guild = { id: g.id, name: g.name };
      }
    }

    let directive: {
      id: string;
      type: 'grid' | 'guild' | 'bounty';
      description: string;
      status: string;
      targetX?: number;
      targetZ?: number;
      targetStructureGoal?: number;
      distanceFromTarget?: number;
    } | null = null;

    const directives = await db.getActiveDirectives();
    let bestDirectiveDistance = Infinity;
    for (const d of directives) {
      if (typeof d.targetX !== 'number' || typeof d.targetZ !== 'number') continue;
      const dist = Math.hypot(center.x - d.targetX, center.z - d.targetZ);
      // Best-effort linkage: only attach directives that spatially target this structure area.
      if (dist <= 160 && dist < bestDirectiveDistance) {
        bestDirectiveDistance = dist;
        directive = {
          id: d.id,
          type: d.type,
          description: d.description,
          status: d.status,
          targetX: d.targetX,
          targetZ: d.targetZ,
          targetStructureGoal: d.targetStructureGoal,
          distanceFromTarget: Math.round(dist),
        };
      }
    }

    return {
      blueprintInstanceId: instanceId,
      blueprintName: firstPiece.blueprintName || null,
      builder: {
        agentId: ownerAgentId,
        name: ownerAgent?.name || firstPiece.ownerAgentName || ownerAgentId,
      },
      pieceCount: pieces.length,
      builtAt,
      center: {
        x: Math.round(center.x),
        z: Math.round(center.z),
      },
      guild,
      directive,
    };
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

  const maybeTouchAuthenticatedAgent = async (request: FastifyRequest): Promise<void> => {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) return;

    const token = authHeader.slice(7);
    const auth = verifyToken(token);
    if (!auth) return;

    const agent = await db.getAgent(auth.agentId);
    const tokenOwner = auth.ownerId.toLowerCase();
    const agentOwner = (agent?.ownerId || '').toLowerCase();
    if (agent && agentOwner && tokenOwner === agentOwner) {
      await world.touchAgent(auth.agentId);
    }
  };

  interface StateLite {
    tick: number;
    primitiveRevision: number;
    agentsOnline: number;
    primitiveCount: number;
    latestEventId: number;
  }

  interface GridHeatMapCell {
    x: number;
    z: number;
    density: number;
  }

  interface GridStatsNode {
    id: string;
    name: string;
    tier: NodeTier;
    center: { x: number; z: number };
    structureCount: number;
    connections: Array<{ targetId: string }>;
  }

  interface GridStatsResponse {
    agentsOnline: number;
    totalStructures: number;
    totalGuilds: number;
    activeDirectives: number;
    heatMap: {
      cellSize: number;
      cells: GridHeatMapCell[];
    };
    nodes: GridStatsNode[];
    generatedAt: number;
  }

  const getStateLite = async (): Promise<StateLite> => {
    const [latestEvent] = await db.getRecentMessageEvents(1);

    return {
      tick: world.getCurrentTick(),
      primitiveRevision: world.getPrimitiveRevision(),
      agentsOnline: world.getAgentCount(),
      primitiveCount: world.getWorldPrimitiveCount(),
      latestEventId: latestEvent?.id || 0,
    };
  };
  const STATE_MESSAGE_HISTORY_LIMIT = 30;

  let statsCache: {
    computedAt: number;
    primitiveRevision: number;
    payload: GridStatsResponse;
  } | null = null;

  const stateLiteEtag = (lite: StateLite): string =>
    `W/"grid-lite-${lite.primitiveRevision}-${lite.agentsOnline}-${lite.latestEventId}"`;

  fastify.get('/v1/grid/state-lite', async (request, reply) => {
    await maybeTouchAuthenticatedAgent(request);

    const lite = await getStateLite();
    const etag = stateLiteEtag(lite);
    if (request.headers['if-none-match'] === etag) {
      reply.header('ETag', etag);
      return reply.code(304).send();
    }
    reply.header('ETag', etag);
    return lite;
  });

  fastify.get('/v1/grid/stats', async (request, reply) => {
    const primitiveRevision = world.getPrimitiveRevision();
    const now = Date.now();

    if (
      statsCache &&
      statsCache.primitiveRevision === primitiveRevision &&
      now - statsCache.computedAt < GRID_STATS_TTL_MS
    ) {
      reply.header('Cache-Control', 'public, max-age=30');
      return statsCache.payload;
    }

    const primitives = world.getWorldPrimitives() as unknown as PrimitiveLike[];
    const connectorPrimitives = primitives.filter(isConnectorPrimitive);
    const structures = buildStructureSummaries(primitives);
    const nodes = buildSettlementNodes(structures, connectorPrimitives);
    const [guilds, directives] = await Promise.all([
      db.getAllGuilds(),
      db.getActiveDirectives(),
    ]);

    const heatMapCells = new Map<string, GridHeatMapCell>();
    for (const primitive of primitives) {
      const cellX = Math.floor(primitive.position.x / GRID_STATS_CELL_SIZE) * GRID_STATS_CELL_SIZE;
      const cellZ = Math.floor(primitive.position.z / GRID_STATS_CELL_SIZE) * GRID_STATS_CELL_SIZE;
      const key = `${cellX},${cellZ}`;
      const existing = heatMapCells.get(key);
      if (existing) {
        existing.density += 1;
      } else {
        heatMapCells.set(key, { x: cellX, z: cellZ, density: 1 });
      }
    }

    const payload: GridStatsResponse = {
      agentsOnline: world.getAgentCount(),
      totalStructures: structures.length,
      totalGuilds: guilds.length,
      activeDirectives: directives.length,
      heatMap: {
        cellSize: GRID_STATS_CELL_SIZE,
        cells: Array.from(heatMapCells.values()).sort((a, b) => b.density - a.density),
      },
      nodes: nodes.map((node) => ({
        id: node.id,
        name: node.name,
        tier: node.tier,
        center: {
          x: Math.round(node.center.x),
          z: Math.round(node.center.z),
        },
        structureCount: node.structureCount,
        connections: node.connections.map((connection) => ({ targetId: connection.targetId })),
      })),
      generatedAt: now,
    };

    statsCache = {
      computedAt: now,
      primitiveRevision,
      payload,
    };

    reply.header('Cache-Control', 'public, max-age=30');
    return payload;
  });

  // Lightweight agent position/status polling endpoint (avoids full primitive payload).
  fastify.get('/v1/grid/agents-lite', async (request, reply) => {
    await maybeTouchAuthenticatedAgent(request);

    const agents = world.getAgents();
    const positionHash = agents
      .map(a => `${a.id}:${a.position.x.toFixed(1)},${a.position.z.toFixed(1)},${a.status}`)
      .sort()
      .join('|');
    const hash = createHash('sha1').update(positionHash).digest('hex');
    const etag = `W/"grid-agents-${hash}"`;

    if (request.headers['if-none-match'] === etag) {
      reply.header('ETag', etag);
      return reply.code(304).send();
    }

    reply.header('ETag', etag);
    return { tick: world.getCurrentTick(), agents };
  });

  fastify.get('/v1/grid/state', async (request, reply) => {
    await maybeTouchAuthenticatedAgent(request);

    // Keep state responses cache-friendly for clients polling over HTTP.
    const lite = await getStateLite();
    const agentsForEtag = world.getAgents();
    const positionHash = agentsForEtag
      .map(a => `${a.id}:${a.position.x.toFixed(1)},${a.position.z.toFixed(1)},${a.status}`)
      .sort()
      .join('|');
    const etag = `W/"grid-state-${lite.primitiveRevision}-${lite.latestEventId}-${positionHash}"`;
    if (request.headers['if-none-match'] === etag) {
      reply.header('ETag', etag);
      return reply.code(304).send();
    }
    reply.header('ETag', etag);

    // Return only ONLINE agents (from WorldManager, not DB)
    const agents = agentsForEtag;
    const primitives = world.getWorldPrimitives();
    const events = await db.getRecentMessageEvents(STATE_MESSAGE_HISTORY_LIMIT);

    return {
      tick: world.getCurrentTick(),
      primitiveRevision: lite.primitiveRevision,
      agents,
      primitives,
      events,
    };
  });

  // --- Build Context (Actionable build intelligence for agents) ---

  let buildContextCache: { data: unknown; computedAt: number; revision: number; etag: string } | null = null;

  fastify.get('/v1/grid/build-context', async (request, reply) => {
    const { x: qx, z: qz } = request.query as { x?: string; z?: string };
    const queryX = Number(qx);
    const queryZ = Number(qz);

    // Default to world center if no position given
    const hasPosition = Number.isFinite(queryX) && Number.isFinite(queryZ);
    const reqX = hasPosition ? queryX : 0;
    const reqZ = hasPosition ? queryZ : 0;

    const primitiveRevision = world.getPrimitiveRevision();
    const cacheKey = `${primitiveRevision}-${Math.round(reqX)}-${Math.round(reqZ)}`;
    const cachedEtag = `W/"build-ctx-${cacheKey}"`;

    if (request.headers['if-none-match'] === cachedEtag) {
      reply.header('ETag', cachedEtag);
      return reply.code(304).send();
    }

    const primitives = world.getWorldPrimitives();
    const primitiveInput = primitives as unknown as PrimitiveLike[];
    const connectorPrimitives = primitiveInput.filter(isConnectorPrimitive);
    const structures = buildStructureSummaries(primitiveInput);
    const nodes = buildSettlementNodes(structures, connectorPrimitives);
    const openAreas = computeOpenAreas(nodes, primitiveInput);

    // Find nearest node to queried position
    let nearestNode: (typeof nodes)[number] | null = null;
    let nearestNodeDist = Infinity;
    for (const node of nodes) {
      const d = pointDistanceXZ({ x: reqX, z: reqZ }, node.center);
      if (d < nearestNodeDist) {
        nearestNodeDist = d;
        nearestNode = node;
      }
    }

    // Origin zone check
    const originDist = Math.sqrt(reqX * reqX + reqZ * reqZ);
    const insideOriginZone = originDist < BUILD_CREDIT_CONFIG.MIN_BUILD_DISTANCE_FROM_ORIGIN;

    // Nearest structure distance from queried point
    const nearestStructureDist = distanceToNearestPrimitive(reqX, reqZ, primitiveInput);

    // Settlement proximity check
    const withinSettlementProximity =
      primitiveInput.length < BUILD_CREDIT_CONFIG.SETTLEMENT_PROXIMITY_THRESHOLD ||
      nearestStructureDist <= BUILD_CREDIT_CONFIG.MAX_BUILD_DISTANCE_FROM_SETTLEMENT;

    // Feasibility
    const feasible = !insideOriginZone && withinSettlementProximity;

    // Categories present and missing at nearest node
    const ALL_CATEGORIES = ['architecture', 'infrastructure', 'technology', 'art', 'nature'];
    let categoriesPresent: string[] = [];
    let categoriesMissing: string[] = [...ALL_CATEGORIES];

    if (nearestNode) {
      const catSet = new Set<string>();
      for (const s of structures) {
        // Check if structure is within this node's radius
        const d = pointDistanceXZ(s.center, nearestNode.center);
        if (d <= nearestNode.radius + 20) {
          catSet.add(s.category);
        }
      }
      categoriesPresent = Array.from(catSet);
      categoriesMissing = ALL_CATEGORIES.filter(c => !catSet.has(c));
    }

    // Filter safe build spots by proximity to queried position (within 200 units)
    const MAX_SPOT_DISTANCE = 200;
    const safeBuildSpots = openAreas
      .map(area => ({
        x: area.x,
        z: area.z,
        distToNearest: area.nearestBuild,
        type: area.type,
        distFromQuery: pointDistanceXZ({ x: area.x, z: area.z }, { x: reqX, z: reqZ }),
      }))
      .filter(s => s.distFromQuery <= MAX_SPOT_DISTANCE)
      .sort((a, b) => a.distFromQuery - b.distFromQuery)
      .slice(0, 8)
      .map(({ distFromQuery, ...rest }) => rest);

    // Generate recommendation (facts-only, not prescriptive)
    let recommendation = '';
    if (insideOriginZone) {
      recommendation = `Too close to origin. Move at least ${BUILD_CREDIT_CONFIG.MIN_BUILD_DISTANCE_FROM_ORIGIN} units away.`;
    } else if (!withinSettlementProximity) {
      recommendation = `Too far from existing structures. Move within ${BUILD_CREDIT_CONFIG.MAX_BUILD_DISTANCE_FROM_SETTLEMENT} units of a settlement.`;
    } else if (nearestNode) {
      const facts: string[] = [];
      facts.push(`Nearest: "${nearestNode.name}" (${nearestNode.tier}, ${nearestNode.structureCount} structures)`);
      if (categoriesPresent.length > 0) {
        facts.push(`Present: ${categoriesPresent.join(', ')}`);
      }
      if (categoriesMissing.length > 0) {
        facts.push(`Missing: ${categoriesMissing.join(', ')}`);
      }
      facts.push(`Safe spots: ${safeBuildSpots.length} available`);
      recommendation = facts.join('. ') + '.';
    } else if (primitiveInput.length === 0) {
      recommendation = 'Empty world. No structures yet. Build anywhere outside the origin zone.';
    } else {
      recommendation = `No nearby settlement node. ${safeBuildSpots.length} safe spots available near existing structures.`;
    }

    // Build blueprintsByCategory from blueprints.json
    let blueprintsByCategory: Record<string, string[]> = {};
    try {
      const bpFilePath = join(__dirname, '../blueprints.json');
      const bpRaw = await readFile(bpFilePath, 'utf-8');
      const bpParsed = JSON.parse(bpRaw) as Record<string, { category?: string }>;
      for (const [name, bp] of Object.entries(bpParsed)) {
        const cat = bp.category || 'other';
        if (!blueprintsByCategory[cat]) blueprintsByCategory[cat] = [];
        blueprintsByCategory[cat].push(name);
      }
    } catch { /* ok without blueprints */ }

    // Compute node growth stage and guidance
    type NodeGrowthStage = 'empty' | 'founding' | 'young' | 'established' | 'dense' | 'mega';
    let nodeGrowthStage: NodeGrowthStage = 'empty';
    let stageGuidance = '';
    let structuresToNextTier = 0;

    if (nearestNode) {
      const sc = nearestNode.structureCount;
      if (sc <= 4) {
        nodeGrowthStage = 'founding';
        structuresToNextTier = 5 - sc;
        stageGuidance = `Founding node "${nearestNode.name}" (${sc} structures). Needs ${structuresToNextTier} more to reach server tier.${categoriesMissing.length > 0 ? ` Missing: ${categoriesMissing.join(', ')}.` : ''}`;
      } else if (sc <= 24) {
        nodeGrowthStage = 'young';
        structuresToNextTier = 25 - sc;
        stageGuidance = `Young node "${nearestNode.name}" (${sc}/25 to city tier). Densify to 25 before expanding.${categoriesMissing.length > 0 ? ` Missing: ${categoriesMissing.join(', ')}.` : ''}`;
      } else if (sc <= 49) {
        nodeGrowthStage = 'established';
        structuresToNextTier = 50 - sc;
        stageGuidance = `Established node "${nearestNode.name}" (${sc} structures, city tier). Can expand with connectors or found new district.`;
      } else if (sc <= 99) {
        nodeGrowthStage = 'dense';
        structuresToNextTier = 100 - sc;
        stageGuidance = `Dense node "${nearestNode.name}" (${sc} structures, metropolis). Ready for mega builds and cross-node infrastructure.`;
      } else {
        nodeGrowthStage = 'mega';
        structuresToNextTier = 0;
        stageGuidance = `Megaopolis "${nearestNode.name}" (${sc} structures). Expand outward, found satellite nodes, build monuments.`;
      }
    } else if (primitiveInput.length === 0) {
      nodeGrowthStage = 'empty';
      stageGuidance = 'Empty world. Found a new settlement by placing an anchor structure.';
      structuresToNextTier = 1;
    } else {
      nodeGrowthStage = 'empty';
      stageGuidance = 'No nearby node. Found a new settlement by placing an anchor structure, or move closer to an existing node.';
      structuresToNextTier = 1;
    }

    const result = {
      feasible,
      nearestNode: nearestNode ? {
        name: nearestNode.name,
        tier: nearestNode.tier,
        structures: nearestNode.structureCount,
        radius: Math.round(nearestNode.radius),
        distance: Math.round(nearestNodeDist),
        center: {
          x: Math.round(nearestNode.center.x),
          z: Math.round(nearestNode.center.z),
        },
      } : null,
      nodeGrowthStage,
      stageGuidance,
      structuresToNextTier,
      categoriesPresent,
      categoriesMissing,
      safeBuildSpots,
      constraints: {
        insideOriginZone,
        withinSettlementProximity,
        nearestStructureDist: Math.round(nearestStructureDist),
      },
      recommendation,
      blueprintsByCategory,
    };

    reply.header('ETag', cachedEtag);
    reply.header('Cache-Control', 'public, max-age=10');
    return result;
  });

  // --- Spatial Summary (World Map for Agents) ---

  // Response cache — keyed by primitive revision so any geometry change invalidates it.
  let spatialCache: { data: unknown; computedAt: number; revision: number; etag: string } | null = null;
  fastify.get('/v1/grid/spatial-summary', async (request, reply) => {
    const primitiveRevision = world.getPrimitiveRevision();
    const cacheMatchesRevision = !!spatialCache && spatialCache.revision === primitiveRevision;

    if (cacheMatchesRevision && request.headers['if-none-match'] === spatialCache!.etag) {
      reply.header('ETag', spatialCache!.etag);
      return reply.code(304).send();
    }

    // Serve revision-matched cache immediately.
    if (cacheMatchesRevision) {
      reply.header('ETag', spatialCache!.etag);
      return spatialCache!.data;
    }
    const primitives = world.getWorldPrimitives();
    const agents = world.getAgents();
    const agentNameMap = new Map(agents.map(a => [a.id, a.name]));
    const primitiveInput = primitives as unknown as PrimitiveLike[];
    const connectorPrimitives = primitiveInput.filter(isConnectorPrimitive);
    const structures = buildStructureSummaries(primitiveInput);
    const settlementNodes = buildSettlementNodes(structures, connectorPrimitives);

    const CELL_SIZE = 10;

    // --- Per-agent summaries ---
    const byOwner = new Map<string, typeof primitives>();
    for (const p of primitives) {
      if (!byOwner.has(p.ownerAgentId)) byOwner.set(p.ownerAgentId, []);
      byOwner.get(p.ownerAgentId)!.push(p);
    }

    const ownerStructureCounts = new Map<string, number>();
    for (const s of structures) {
      for (const builder of s.builders) {
        ownerStructureCounts.set(builder, (ownerStructureCounts.get(builder) || 0) + 1);
      }
    }

    const agentSummaries = Array.from(byOwner.entries()).map(([ownerId, prims]) => {
      const bb = computeBoundingBox(prims);
      const centroid = computeCentroid(prims);
      const clusters = computeClusters(prims, CELL_SIZE);
      return {
        agentId: ownerId,
        agentName: agentNameMap.get(ownerId) || ownerId,
        primitiveCount: prims.length,
        structureCount: ownerStructureCounts.get(ownerId) || 0,
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

    // --- Open areas (growth + connector + frontier candidates) ---
    const openAreas = computeOpenAreas(settlementNodes, primitiveInput);

    // --- World-level stats ---
    const worldStats = primitives.length > 0
      ? (() => {
          const bb = computeBoundingBox(primitives);
          const centroid = computeCentroid(primitives);
          return {
            totalPrimitives: primitives.length,
            totalStructures: structures.length,
            totalNodes: settlementNodes.length,
            totalBuilders: byOwner.size,
            boundingBox: roundBB(bb),
            highestPoint: round1(bb.maxY),
            center: { x: Math.round(centroid.x), z: Math.round(centroid.z) },
          };
        })()
      : {
          totalPrimitives: 0,
          totalStructures: 0,
          totalNodes: 0,
          totalBuilders: 0,
          boundingBox: null,
          highestPoint: 0,
          center: null,
        };

    const result = {
      primitiveRevision,
      nodeModelVersion: 2,
      world: worldStats,
      agents: agentSummaries,
      nodes: settlementNodes.map(n => ({
        ...n,
        center: { x: Math.round(n.center.x), z: Math.round(n.center.z) },
        radius: Math.round(n.radius),
        footprintArea: Math.round(n.footprintArea),
      })),
      grid: { cellSize: CELL_SIZE, cells: gridMap },
      openAreas,
    };

    const spatialEtag = `W/"spatial-${primitiveRevision}"`;
    // Cache for subsequent requests
    spatialCache = {
      data: result,
      computedAt: Date.now(),
      revision: primitiveRevision,
      etag: spatialEtag,
    };
    reply.header('ETag', spatialEtag);
    return result;
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
      const parsed = annotateBlueprintClassGates(JSON.parse(raw));

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
    if (!requireAdmin(request, reply)) return;

    const count = await world.syncPrimitivesFromDB();
    return { ok: true, message: `Synced ${count} primitives from database`, count };
  });

  // --- Admin: Expire all active directives ---
  fastify.post('/v1/admin/expire-directives', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;

    const count = await db.expireAllDirectives();
    return { ok: true, expired: count };
  });

  // --- Admin: Bulk delete specific primitives by ID ---
  fastify.post('/v1/admin/delete-primitives', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;

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
    if (!requireAdmin(request, reply)) return;

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

  // --- Skills ---

  fastify.get('/v1/skills', async (request, reply) => {
    const agentId = await requireAgent(request, reply);
    if (!agentId) return;

    const agent = await db.getAgent(agentId);
    if (!agent) return reply.status(404).send({ error: 'Agent not found' });

    const agentClass = (agent as any).agentClass || 'builder';
    const skills = getSkillsForClass(agentClass);

    // Omit promptInjection from list response
    return skills.map(s => ({
      id: s.id,
      name: s.name,
      description: s.description,
      class: s.class,
    }));
  });

  fastify.get<{ Params: { id: string } }>('/v1/skills/:id', async (request, reply) => {
    const agentId = await requireAgent(request, reply);
    if (!agentId) return;

    const agent = await db.getAgent(agentId);
    if (!agent) return reply.status(404).send({ error: 'Agent not found' });

    const agentClass = (agent as any).agentClass || 'builder';
    const skill = getSkillById(request.params.id);

    if (!skill) {
      return reply.status(404).send({ error: 'Skill not found' });
    }

    if (skill.class !== agentClass) {
      return reply.status(403).send({
        error: `This skill requires class '${skill.class}'. Your class is '${agentClass}'.`,
      });
    }

    return skill;
  });
}
