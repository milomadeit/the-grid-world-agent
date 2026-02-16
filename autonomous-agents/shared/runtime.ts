/**
 * Agent Runtime — the heartbeat loop.
 *
 * Each agent runs as an independent loop:
 *   1. Read identity + working memory
 *   2. Fetch world state from API
 *   3. Build prompt (identity + skill.md + world state + memory)
 *   4. Call LLM for next action
 *   5. Execute action via API
 *   6. Update working memory + daily log
 *   7. Sleep, repeat
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { GridAPIClient } from './api-client.js';
import { ChainClient } from './chain-client.js';
import { captureWorldView } from './vision.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// --- Types ---

interface AgentConfig {
  /** Directory path for this agent (e.g., ./agent-smith) */
  dir: string;
  /** Private key for signing transactions */
  privateKey: string;
  /** Wallet address that owns the ERC-8004 agent ID */
  walletAddress: string;
  /** ERC-8004 on-chain agent ID */
  erc8004AgentId: string;
  /** ERC-8004 registry URI (e.g., eip155:143:0x8004...) */
  erc8004Registry: string;
  /** Heartbeat interval in seconds */
  heartbeatSeconds: number;
  /** LLM provider: 'gemini', 'anthropic', 'openai', or 'minimax' */
  llmProvider: 'gemini' | 'anthropic' | 'openai' | 'minimax';
  /** LLM model name */
  llmModel: string;
  /** API key for the LLM */
  llmApiKey: string;
}

interface BootstrapConfig {
  /** Directory path for this agent */
  dir: string;
  /** Private key for signing transactions (needed for on-chain registration) */
  privateKey: string;
  /** Wallet address (may be empty — agent is figuring it out) */
  walletAddress: string;
  /** Heartbeat interval in seconds */
  heartbeatSeconds: number;
  /** LLM provider */
  llmProvider: 'gemini' | 'anthropic' | 'openai' | 'minimax';
  /** LLM model name */
  llmModel: string;
  /** API key for the LLM */
  llmApiKey: string;
  /** Base URL for the grid API */
  apiBaseUrl: string;
  /** ERC-8004 registry URI */
  erc8004Registry: string;
}

interface AgentDecision {
  thought: string;
  action: 'MOVE' | 'CHAT' | 'BUILD_BLUEPRINT' | 'BUILD_CONTINUE' | 'CANCEL_BUILD' | 'BUILD_PRIMITIVE' | 'BUILD_MULTI' | 'TERMINAL' | 'VOTE' | 'SUBMIT_DIRECTIVE' | 'TRANSFER_CREDITS' | 'IDLE';
  payload?: Record<string, unknown>;
}

// --- File Helpers ---

function readMd(path: string): string {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return '';
  }
}

function writeMd(path: string, content: string): void {
  writeFileSync(path, content, 'utf-8');
}

function appendLog(path: string, entry: string): void {
  appendFileSync(path, entry + '\n', 'utf-8');
}

function todayDate(): string {
  return new Date().toISOString().split('T')[0];
}

function timestamp(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function isAuthSessionError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes('(401)') ||
    msg.includes('Invalid or expired token') ||
    msg.includes('Token owner does not match') ||
    msg.includes('Missing or invalid authorization header')
  );
}

function logNetworkFailure(agentName: string, err: unknown): void {
  const root = err as { cause?: any };
  const cause = root?.cause;
  if (!cause) return;

  if (cause.code || cause.message) {
    console.error(`[${agentName}] Network cause: ${cause.code || 'unknown'} ${cause.message || ''}`.trim());
  }

  const subErrors = Array.isArray(cause.errors) ? cause.errors : [];
  for (const sub of subErrors) {
    const code = sub?.code || 'unknown';
    const address = sub?.address || '?';
    const port = sub?.port || '?';
    const message = sub?.message || '';
    console.error(`[${agentName}] Connect error: ${code} ${address}:${port} ${message}`.trim());
  }
}

function makeCoordinationChat(
  agentName: string,
  self: { position: { x: number; z: number } } | undefined,
  directives: Array<{ id: string; description: string }>,
  otherAgents: Array<{ name: string }>,
  recentMessages: Array<{ agentName?: string; message?: string }> = [],
  buildError?: string,
): string {
  if (buildError) {
    const compact = buildError.replace(/\s+/g, ' ').slice(0, 90);
    return `Build blocked (${compact}). Waiting for the limit window to clear, then retrying.`;
  }

  const selfName = agentName.toLowerCase();
  const latestMessages = [...recentMessages]
    .reverse()
    .filter((m) => (m.agentName || '').toLowerCase() !== 'system');

  const mention = latestMessages.find((m) =>
    ((m.message || '').toLowerCase().includes(selfName)) &&
    (m.agentName || '').toLowerCase() !== selfName
  );
  if (mention?.agentName) {
    return `${mention.agentName}, acknowledged. I saw your ping and I am acting on it now.`;
  }

  const coordinationAsk = latestMessages.find((m) =>
    /sync|coordinate|join|help|who can|can you|\?/.test((m.message || '').toLowerCase()) &&
    (m.agentName || '').toLowerCase() !== selfName
  );
  if (coordinationAsk?.agentName) {
    return `${coordinationAsk.agentName}, yes - syncing now. I will post progress shortly.`;
  }

  if (directives.length > 0) {
    const d = directives[0];
    const shortId = d.id.slice(0, 8);
    return `I am working directive ${shortId}. ${d.description.slice(0, 80)}. Reply if you are nearby to split tasks.`;
  }

  if (self) {
    const neighbors = otherAgents.slice(0, 2).map(a => a.name).join(', ');
    if (neighbors) {
      return `I am at (${Math.round(self.position.x)}, ${Math.round(self.position.z)}). ${neighbors}, confirm your lanes and I will take one side.`;
    }
    return `I am at (${Math.round(self.position.x)}, ${Math.round(self.position.z)}) and pushing this area forward.`;
  }

  return 'Quick sync check-in: what zone should we focus next?';
}

function isRateLimitErrorMessage(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes('429') ||
    m.includes('rate limit') ||
    m.includes('too many requests') ||
    m.includes('throttl') ||
    m.includes('quota') ||
    m.includes('retry after') ||
    m.includes('slow down')
  );
}

function parseRateLimitCooldownSeconds(message: string, fallbackSeconds: number): number {
  const lower = message.toLowerCase();
  const match = lower.match(/(?:retry|wait|after|in|reset)[^0-9]{0,20}(\d+)\s*(ms|milliseconds?|s|sec|secs|seconds?|m|min|mins|minutes?)/);
  if (!match) return fallbackSeconds;

  const value = Number(match[1]);
  const unit = match[2];
  if (!Number.isFinite(value) || value <= 0) return fallbackSeconds;

  if (unit.startsWith('ms')) return Math.max(5, Math.ceil(value / 1000));
  if (unit.startsWith('m')) return Math.max(5, value * 60);
  return Math.max(5, value);
}

// --- Spatial Awareness ---

interface SpatialSummary {
  count: number;
  boundingBox: { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number };
  highestY: number;
  centroid: { x: number; y: number; z: number };
  clusters: Array<{ center: { x: number; z: number }; count: number; maxY: number }>;
  suggestions: string[];
}

interface PrimitiveData {
  shape: string;
  position: { x: number; y: number; z: number };
  scale: { x: number; y: number; z: number };
  color: string;
}

function computeSpatialSummary(primitives: PrimitiveData[]): SpatialSummary | null {
  if (primitives.length === 0) return null;

  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  let sumX = 0, sumY = 0, sumZ = 0;

  for (const p of primitives) {
    const halfX = (p.scale?.x || 1) / 2;
    const halfY = (p.scale?.y || 1) / 2;
    const halfZ = (p.scale?.z || 1) / 2;
    minX = Math.min(minX, p.position.x - halfX);
    maxX = Math.max(maxX, p.position.x + halfX);
    minY = Math.min(minY, p.position.y - halfY);
    maxY = Math.max(maxY, p.position.y + halfY);
    minZ = Math.min(minZ, p.position.z - halfZ);
    maxZ = Math.max(maxZ, p.position.z + halfZ);
    sumX += p.position.x;
    sumY += p.position.y;
    sumZ += p.position.z;
  }

  const centroid = { x: sumX / primitives.length, y: sumY / primitives.length, z: sumZ / primitives.length };

  // Simple grid-based clustering (5-unit cells)
  const cellSize = 5;
  const cellMap = new Map<string, { xs: number[]; zs: number[]; maxY: number }>();
  for (const p of primitives) {
    const cx = Math.floor(p.position.x / cellSize);
    const cz = Math.floor(p.position.z / cellSize);
    const key = `${cx},${cz}`;
    if (!cellMap.has(key)) cellMap.set(key, { xs: [], zs: [], maxY: 0 });
    const cell = cellMap.get(key)!;
    cell.xs.push(p.position.x);
    cell.zs.push(p.position.z);
    const topEdge = p.position.y + (p.scale?.y || 1) / 2;
    cell.maxY = Math.max(cell.maxY, topEdge);
  }

  const clusters = Array.from(cellMap.values()).map(cell => ({
    center: {
      x: cell.xs.reduce((a, b) => a + b, 0) / cell.xs.length,
      z: cell.zs.reduce((a, b) => a + b, 0) / cell.zs.length,
    },
    count: cell.xs.length,
    maxY: cell.maxY,
  }));

  // Generate suggestions
  const suggestions: string[] = [];
  
  // Calculate spread ratio: how horizontally spread vs vertically tall
  const width = maxX - minX;
  const depth = maxZ - minZ;
  const height = maxY - minY;
  const spreadRatio = height > 0 ? (width + depth) / height : Infinity;
  
  if (spreadRatio < 0.5 && height > 4) {
    suggestions.push(`WARNING: Your builds are very tall (${height.toFixed(1)}u) but narrow (spread ratio: ${spreadRatio.toFixed(1)}). Spread horizontally! Build walls on X/Z axis, add floors, or use a BRIDGE to connect locations. Fetch /v1/grid/blueprints for structure templates.`);
  } else if (spreadRatio < 1.0 && height > 3) {
    suggestions.push(`Your builds are taller than they are wide (spread ratio: ${spreadRatio.toFixed(1)}). Consider adding horizontal elements — walls, floors, or adjacent structures.`);
  }
  
  const tallestCluster = clusters.reduce((best, c) => c.maxY > best.maxY ? c : best, clusters[0]);
  if (tallestCluster && tallestCluster.maxY >= 3 && tallestCluster.count > 5) {
    suggestions.push(`Your tallest area is ${tallestCluster.maxY.toFixed(1)} high near (${tallestCluster.center.x.toFixed(0)}, ${tallestCluster.center.z.toFixed(0)}) with ${tallestCluster.count} shapes. Consider adding a roof (flat box) or expanding outward from this cluster.`);
  }
  if (clusters.length >= 2) {
    suggestions.push(`You have ${clusters.length} separate build clusters. Consider connecting them with a BRIDGE or WALL_SECTION blueprint.`);
  }
  if (primitives.length < 3) {
    suggestions.push(`You only have ${primitives.length} shape(s). Fetch a blueprint from /v1/grid/blueprints to build a complete structure — try SMALL_HOUSE, TREE, or FOUNTAIN.`);
  }
  if (primitives.length >= 5 && spreadRatio > 2.0) {
    suggestions.push(`Good horizontal spread (ratio: ${spreadRatio.toFixed(1)}). Your builds are well-proportioned.`);
  }

  return {
    count: primitives.length,
    boundingBox: { minX, maxX, minY, maxY, minZ, maxZ },
    highestY: maxY,
    centroid,
    clusters,
    suggestions,
  };
}

function formatSpatialSummary(summary: SpatialSummary): string {
  const bb = summary.boundingBox;
  const lines = [
    `### Your Build Analysis`,
    `- **${summary.count} shapes** | Bounding box: X[${bb.minX.toFixed(1)}..${bb.maxX.toFixed(1)}] Y[${bb.minY.toFixed(1)}..${bb.maxY.toFixed(1)}] Z[${bb.minZ.toFixed(1)}..${bb.maxZ.toFixed(1)}]`,
    `- Highest point: y=${summary.highestY.toFixed(1)} | Center: (${summary.centroid.x.toFixed(1)}, ${summary.centroid.z.toFixed(1)})`,
  ];
  if (summary.clusters.length > 1) {
    lines.push(`- ${summary.clusters.length} build clusters: ${summary.clusters.map(c => `${c.count} shapes near (${c.center.x.toFixed(0)}, ${c.center.z.toFixed(0)}) height ${c.maxY.toFixed(1)}`).join('; ')}`);
  }
  if (summary.suggestions.length > 0) {
    lines.push(`- **Next steps:** ${summary.suggestions[0]}`);
    for (let i = 1; i < summary.suggestions.length; i++) {
      lines.push(`  - ${summary.suggestions[i]}`);
    }
  }
  return lines.join('\n');
}

function formatOtherBuildsCompact(
  otherPrimitives: PrimitiveData[],
  agentNameMap: Map<string, string>,
  ownerIds: string[]
): string {
  // Group by owner
  const byOwner = new Map<string, PrimitiveData[]>();
  for (let i = 0; i < otherPrimitives.length; i++) {
    const ownerId = ownerIds[i];
    if (!byOwner.has(ownerId)) byOwner.set(ownerId, []);
    byOwner.get(ownerId)!.push(otherPrimitives[i]);
  }

  const lines: string[] = [];
  for (const [ownerId, prims] of byOwner) {
    const name = agentNameMap.get(ownerId) || ownerId;
    const summary = computeSpatialSummary(prims);
    if (summary) {
      lines.push(`- **${name}**: ${summary.count} shapes, center (${summary.centroid.x.toFixed(0)}, ${summary.centroid.z.toFixed(0)}), height ${summary.highestY.toFixed(1)}`);
    }
  }
  return lines.join('\n');
}

// --- Settlement Node Computation ---

type NodeTier = 'Capital' | 'District' | 'Neighborhood' | 'Outpost';
type NodeTheme = 'residential' | 'tech' | 'art' | 'nature' | 'mixed';
type BuildCategory = 'structure' | 'infrastructure' | 'decoration' | 'signature';

interface SettlementNode {
  center: { x: number; z: number };
  count: number;
  radius: number;
  structures: string[];
  builders: string[];
  tier: NodeTier;
  theme: NodeTheme;
  name: string;
  missingCategories: BuildCategory[];
  connections: Array<{ targetIdx: number; distance: number; hasBridge: boolean }>;
}

// Shape-to-category mappings for "what's missing" analysis
const STRUCTURE_SHAPES = new Set(['box', 'capsule']);
const INFRA_SHAPES = new Set(['plane', 'ring']);
const DECORATION_SHAPES = new Set(['sphere', 'torus', 'torusKnot']);
const SIGNATURE_SHAPES = new Set(['dodecahedron', 'icosahedron', 'octahedron', 'tetrahedron']);

// Shape-to-theme mappings
const RESIDENTIAL_SHAPES = new Set(['box', 'capsule', 'plane']);
const TECH_SHAPES = new Set(['cylinder', 'cone', 'ring']);
const ART_SHAPES = new Set(['torus', 'dodecahedron', 'icosahedron', 'octahedron', 'torusKnot', 'tetrahedron']);
const NATURE_SHAPES = new Set(['sphere']);

// Directional names for node naming
const NODE_NAMES_BY_DIRECTION: Record<string, string> = {
  'N':  'North Quarter',
  'NE': 'Northeast Hub',
  'E':  'East Hub',
  'SE': 'Southeast Hub',
  'S':  'South Quarter',
  'SW': 'Southwest Hub',
  'W':  'West Hub',
  'NW': 'Northwest Hub',
  'C':  'Central Hub',
};

function getDirection(x: number, z: number, centroidX: number, centroidZ: number): string {
  const dx = x - centroidX;
  const dz = z - centroidZ;
  if (Math.abs(dx) < 15 && Math.abs(dz) < 15) return 'C';
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

function classifyTheme(shapes: string[]): NodeTheme {
  let res = 0, tech = 0, art = 0, nat = 0;
  for (const s of shapes) {
    if (RESIDENTIAL_SHAPES.has(s)) res++;
    if (TECH_SHAPES.has(s)) tech++;
    if (ART_SHAPES.has(s)) art++;
    if (NATURE_SHAPES.has(s)) nat++;
  }
  const max = Math.max(res, tech, art, nat);
  if (max === 0) return 'mixed';
  // Need >40% dominance to get a theme label
  const total = res + tech + art + nat;
  if (res === max && res / total > 0.4) return 'residential';
  if (tech === max && tech / total > 0.4) return 'tech';
  if (art === max && art / total > 0.4) return 'art';
  if (nat === max && nat / total > 0.4) return 'nature';
  return 'mixed';
}

function detectMissingCategories(shapes: string[]): BuildCategory[] {
  const missing: BuildCategory[] = [];
  if (!shapes.some(s => STRUCTURE_SHAPES.has(s))) missing.push('structure');
  if (!shapes.some(s => INFRA_SHAPES.has(s))) missing.push('infrastructure');
  if (!shapes.some(s => DECORATION_SHAPES.has(s))) missing.push('decoration');
  if (!shapes.some(s => SIGNATURE_SHAPES.has(s))) missing.push('signature');
  return missing;
}

interface PrimitiveWithOwner extends PrimitiveData {
  ownerAgentId?: string;
}

// --- Node History (stable names across ticks) ---

interface NodeHistoryEntry {
  name: string;
  x: number;
  z: number;
  lastSeen: string; // ISO timestamp
}

const NODE_HISTORY_FILE = join(__dirname, 'node-history.json');
const NODE_MATCH_RADIUS = 25; // If a cluster centroid is within this of a known node, reuse its name

function loadNodeHistory(): NodeHistoryEntry[] {
  try {
    if (existsSync(NODE_HISTORY_FILE)) {
      return JSON.parse(readFileSync(NODE_HISTORY_FILE, 'utf-8'));
    }
  } catch { /* ignore parse errors */ }
  return [];
}

function saveNodeHistory(entries: NodeHistoryEntry[]): void {
  try {
    // Keep only entries seen in the last 7 days
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const fresh = entries.filter(e => new Date(e.lastSeen).getTime() > cutoff);
    writeFileSync(NODE_HISTORY_FILE, JSON.stringify(fresh, null, 2), 'utf-8');
  } catch { /* ignore write errors */ }
}

function matchHistoricalNode(x: number, z: number, history: NodeHistoryEntry[], usedNames: Set<string>): string | null {
  let closest: NodeHistoryEntry | null = null;
  let closestDist = Infinity;
  for (const entry of history) {
    const dx = entry.x - x;
    const dz = entry.z - z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist < closestDist && dist <= NODE_MATCH_RADIUS && !usedNames.has(entry.name)) {
      closest = entry;
      closestDist = dist;
    }
  }
  return closest ? closest.name : null;
}

// --- Radius-based Centroid Clustering (DBSCAN-style) ---

const CLUSTER_RADIUS = 25; // Primitives within this distance of the centroid belong to the cluster
const MIN_CLUSTER_SIZE = 1; // Minimum primitives to form a node

function computeSettlementNodes(
  primitives: PrimitiveWithOwner[],
  agentNameMap?: Map<string, string>
): SettlementNode[] {
  if (primitives.length === 0) return [];

  // 1. DBSCAN-style clustering: seed from densest points, expand by radius
  const unclustered = new Set<number>(primitives.map((_, i) => i));
  const clusters: Array<{ indices: number[] }> = [];

  while (unclustered.size > 0) {
    // Find the unclustered primitive with the most neighbors (seed from density)
    let bestSeed = -1;
    let bestNeighborCount = -1;
    for (const idx of unclustered) {
      let neighbors = 0;
      for (const other of unclustered) {
        if (other === idx) continue;
        const dx = primitives[idx].position.x - primitives[other].position.x;
        const dz = primitives[idx].position.z - primitives[other].position.z;
        if (Math.sqrt(dx * dx + dz * dz) <= CLUSTER_RADIUS) neighbors++;
      }
      if (neighbors > bestNeighborCount) {
        bestNeighborCount = neighbors;
        bestSeed = idx;
      }
    }

    if (bestSeed === -1) break;

    // Gather all primitives within CLUSTER_RADIUS of seed
    const cluster: number[] = [bestSeed];
    unclustered.delete(bestSeed);

    // Iteratively expand: compute centroid, gather more within radius, repeat
    for (let iter = 0; iter < 5; iter++) {
      // Compute current centroid
      let cx = 0, cz = 0;
      for (const i of cluster) { cx += primitives[i].position.x; cz += primitives[i].position.z; }
      cx /= cluster.length;
      cz /= cluster.length;

      // Find unclustered primitives within CLUSTER_RADIUS of centroid
      const toAdd: number[] = [];
      for (const idx of unclustered) {
        const dx = primitives[idx].position.x - cx;
        const dz = primitives[idx].position.z - cz;
        if (Math.sqrt(dx * dx + dz * dz) <= CLUSTER_RADIUS) {
          toAdd.push(idx);
        }
      }
      if (toAdd.length === 0) break; // No expansion — stable
      for (const idx of toAdd) {
        cluster.push(idx);
        unclustered.delete(idx);
      }
    }

    if (cluster.length >= MIN_CLUSTER_SIZE) {
      clusters.push({ indices: cluster });
    }
  }

  // 2. Compute world centroid for directional naming
  let totalX = 0, totalZ = 0;
  for (const p of primitives) { totalX += p.position.x; totalZ += p.position.z; }
  const worldCentroidX = totalX / primitives.length;
  const worldCentroidZ = totalZ / primitives.length;

  // 3. Load node history for stable naming
  const history = loadNodeHistory();
  const usedNames = new Set<string>();

  // 4. Convert clusters to SettlementNodes
  const nodes: SettlementNode[] = clusters.map(cluster => {
    const clusterPrims = cluster.indices.map(i => primitives[i]);

    // Centroid = average position of all primitives in cluster
    let cx = 0, cz = 0;
    for (const p of clusterPrims) { cx += p.position.x; cz += p.position.z; }
    cx /= clusterPrims.length;
    cz /= clusterPrims.length;

    // Radius = max distance from centroid to any primitive
    let maxDist = 0;
    for (const p of clusterPrims) {
      const dx = p.position.x - cx;
      const dz = p.position.z - cz;
      maxDist = Math.max(maxDist, Math.sqrt(dx * dx + dz * dz));
    }

    const count = clusterPrims.length;
    const shapes = clusterPrims.map(p => p.shape);
    const tier: NodeTier = count >= 20 ? 'Capital' : count >= 10 ? 'District' : count >= 5 ? 'Neighborhood' : 'Outpost';
    const theme = classifyTheme(shapes);
    const missing = count >= 5 ? detectMissingCategories(shapes) : [];

    // Builder names
    const ownerSet = new Set<string>();
    for (const p of clusterPrims) { if (p.ownerAgentId) ownerSet.add(p.ownerAgentId); }
    const builders: string[] = [];
    for (const ownerId of ownerSet) {
      builders.push(agentNameMap?.get(ownerId) || ownerId);
    }

    // Name: try to match historical node first, then generate new name
    let nodeName = matchHistoricalNode(cx, cz, history, usedNames);
    if (!nodeName) {
      const dir = getDirection(cx, cz, worldCentroidX, worldCentroidZ);
      let baseName = NODE_NAMES_BY_DIRECTION[dir] || 'Hub';
      if (theme !== 'mixed') {
        baseName = `${theme.charAt(0).toUpperCase() + theme.slice(1)} ${baseName}`;
      }
      nodeName = baseName;
      let suffix = 2;
      while (usedNames.has(nodeName)) {
        nodeName = `${baseName} ${suffix}`;
        suffix++;
      }
    }
    usedNames.add(nodeName);

    return {
      center: { x: cx, z: cz },
      count,
      radius: Math.max(Math.ceil(maxDist), 1),
      structures: [...new Set(shapes)],
      builders,
      tier,
      theme,
      name: nodeName,
      missingCategories: missing,
      connections: [],
    };
  }).sort((a, b) => b.count - a.count);

  // 5. Compute adjacency — nodes within 100u are potential connections
  // Road detection: look for flat primitives (scaleY <= 0.2) along the line between nodes
  const ADJACENCY_DIST = 100;
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const dx = nodes[i].center.x - nodes[j].center.x;
      const dz = nodes[i].center.z - nodes[j].center.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist <= ADJACENCY_DIST) {
        // Check for road/bridge: primitives near the line between nodes (not inside either node's radius)
        const fromX = nodes[i].center.x, fromZ = nodes[i].center.z;
        const toX = nodes[j].center.x, toZ = nodes[j].center.z;
        const lineLen = dist;

        const hasRoad = primitives.some(p => {
          // Project point onto line segment, check distance to line
          const px = p.position.x - fromX;
          const pz = p.position.z - fromZ;
          const lx = toX - fromX;
          const lz = toZ - fromZ;
          const t = Math.max(0, Math.min(1, (px * lx + pz * lz) / (lineLen * lineLen)));
          const projX = fromX + t * lx;
          const projZ = fromZ + t * lz;
          const distToLine = Math.sqrt((p.position.x - projX) ** 2 + (p.position.z - projZ) ** 2);
          // Primitive is near the line (within 8u), between the two nodes (t between 0.15 and 0.85),
          // and is a connecting shape (box, plane, cylinder)
          return distToLine < 8 && t > 0.15 && t < 0.85
            && (p.shape === 'plane' || p.shape === 'box' || p.shape === 'cylinder');
        });

        nodes[i].connections.push({ targetIdx: j, distance: Math.round(dist), hasBridge: hasRoad });
        nodes[j].connections.push({ targetIdx: i, distance: Math.round(dist), hasBridge: hasRoad });
      }
    }
  }

  // 6. Save node history for stable names next tick
  const now = new Date().toISOString();
  const updatedHistory = [...history];
  for (const node of nodes) {
    const existingIdx = updatedHistory.findIndex(h =>
      Math.sqrt((h.x - node.center.x) ** 2 + (h.z - node.center.z) ** 2) <= NODE_MATCH_RADIUS
    );
    if (existingIdx >= 0) {
      // Update position and timestamp
      updatedHistory[existingIdx] = { name: node.name, x: node.center.x, z: node.center.z, lastSeen: now };
    } else {
      // New node
      updatedHistory.push({ name: node.name, x: node.center.x, z: node.center.z, lastSeen: now });
    }
  }
  saveNodeHistory(updatedHistory);

  return nodes;
}

/**
 * Pre-compute safe build spots by checking clearance against existing primitives.
 * A spot is "safe" if it has CLEARANCE from all existing geometry AND is within
 * MAX_DIST_FROM_BUILD of at least one existing primitive (server 60u rule).
 *
 * Searches in expanding rings around the world centroid for spots that
 * have clearance from geometry AND are within 55u of existing builds.
 */
function findSafeBuildSpots(
  agentPos: { x: number; z: number },
  primitives: { position: { x: number; z: number }; scale: { x: number; z: number }; shape: string }[],
  maxResults = 8
): { x: number; z: number; nearestBuild: number }[] {
  const CLEARANCE = 6;
  const MAX_DIST_FROM_BUILD = 55; // server enforces 60u — stay under
  const MIN_DIST_FROM_ORIGIN = 50;
  const EXEMPT = new Set(['plane', 'circle']);

  const nonExempt = primitives.filter(p => !EXEMPT.has(p.shape));
  if (nonExempt.length === 0) return [];

  // Find the world's build centroid
  let sumX = 0, sumZ = 0;
  for (const p of nonExempt) { sumX += p.position.x; sumZ += p.position.z; }
  const worldCenter = { x: sumX / nonExempt.length, z: sumZ / nonExempt.length };

  // Helper: check if a point is clear and within server proximity
  function checkSpot(cx: number, cz: number): { clear: boolean; nearestDist: number } {
    if (Math.sqrt(cx * cx + cz * cz) < MIN_DIST_FROM_ORIGIN) return { clear: false, nearestDist: Infinity };
    let overlaps = false;
    let nearestDist = Infinity;
    for (const p of nonExempt) {
      const dx = Math.abs(cx - p.position.x);
      const dz = Math.abs(cz - p.position.z);
      const hx = p.scale.x / 2 + CLEARANCE;
      const hz = p.scale.z / 2 + CLEARANCE;
      if (dx < hx && dz < hz) { overlaps = true; break; }
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist < nearestDist) nearestDist = dist;
    }
    return { clear: !overlaps && nearestDist <= MAX_DIST_FROM_BUILD, nearestDist };
  }

  const safe: { x: number; z: number; nearestBuild: number }[] = [];
  for (const radius of [5, 10, 15, 20, 25, 30, 40, 50]) {
    const steps = Math.max(12, Math.floor(radius * 1.2));
    for (let i = 0; i < steps; i++) {
      const angle = (2 * Math.PI * i) / steps;
      const cx = Math.round(worldCenter.x + radius * Math.cos(angle));
      const cz = Math.round(worldCenter.z + radius * Math.sin(angle));
      const result = checkSpot(cx, cz);
      if (result.clear) {
        safe.push({ x: cx, z: cz, nearestBuild: Math.round(result.nearestDist) });
        if (safe.length >= maxResults) return safe;
      }
    }
    if (safe.length >= maxResults) break;
  }

  return safe;
}

function formatSettlementMap(nodes: SettlementNode[], agentPos: { x: number; z: number }, agentName?: string): string {
  if (nodes.length === 0) return '## World Graph\n_No settlements yet. You can start the first node! Pick a spot 50+ units from origin._';

  // Compute world center
  let totalX = 0, totalZ = 0, totalCount = 0;
  for (const n of nodes) { totalX += n.center.x * n.count; totalZ += n.center.z * n.count; totalCount += n.count; }
  const worldCenterX = totalCount > 0 ? Math.round(totalX / totalCount) : 0;
  const worldCenterZ = totalCount > 0 ? Math.round(totalZ / totalCount) : 0;

  const capitalNode = nodes.find(n => n.tier === 'Capital');
  const capitalLabel = capitalNode ? `Capital: "${capitalNode.name}" (${capitalNode.count} shapes).` : '';

  const lines = [
    `## World Graph`,
    `${nodes.length} nodes. ${capitalLabel} World center: (${worldCenterX}, ${worldCenterZ}).`,
    '',
  ];

  let closestNode: SettlementNode | null = null;
  let closestDist = Infinity;

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const dx = node.center.x - agentPos.x;
    const dz = node.center.z - agentPos.z;
    const dist = Math.sqrt(dx * dx + dz * dz);

    if (dist < closestDist) { closestDist = dist; closestNode = node; }

    const builderStr = node.builders.length > 0 ? ` | ${node.builders.join(', ')}` : '';
    lines.push(`- **${node.tier} "${node.name}"** (${node.center.x.toFixed(0)}, ${node.center.z.toFixed(0)}) — ${node.count} shapes, ${node.theme}${builderStr}`);

    // Show connections
    if (node.connections.length > 0) {
      for (const conn of node.connections) {
        const target = nodes[conn.targetIdx];
        const bridgeLabel = conn.hasBridge ? 'ROAD exists' : 'NO ROAD';
        lines.push(`  → Connected to "${target.name}" (${conn.distance}u, ${bridgeLabel})`);
      }
    } else if (node.tier !== 'Outpost') {
      lines.push(`  → ISOLATED — no connections to any node`);
    }

    // Show missing categories for established nodes
    if (node.missingCategories.length > 0) {
      lines.push(`  → Missing: ${node.missingCategories.join(', ')}`);
    }

    // Outpost growth hint
    if (node.tier === 'Outpost') {
      lines.push(`  → Needs ${5 - node.count}+ more shapes to become a Neighborhood`);
    }
  }

  // YOUR NODE suggestion
  if (closestNode) {
    lines.push('');
    lines.push(`YOUR NODE: ${closestNode.tier} "${closestNode.name}" (${closestDist.toFixed(0)}u away)`);

    // Find nodes without visible road connections and suggest building roads
    const unconnectedPairs: Array<{ from: SettlementNode; to: SettlementNode; dist: number }> = [];
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const hasBridgeConn = nodes[i].connections.some(c => c.targetIdx === j && c.hasBridge);
        if (!hasBridgeConn && nodes[i].tier !== 'Outpost' && nodes[j].tier !== 'Outpost') {
          const dx = nodes[i].center.x - nodes[j].center.x;
          const dz = nodes[i].center.z - nodes[j].center.z;
          unconnectedPairs.push({ from: nodes[i], to: nodes[j], dist: Math.round(Math.sqrt(dx * dx + dz * dz)) });
        }
      }
    }
    unconnectedPairs.sort((a, b) => a.dist - b.dist);

    // Build a pool of possible suggestions
    const allSuggestions: string[] = [];

    // Road suggestions (multiple)
    for (const pair of unconnectedPairs.slice(0, 3)) {
      const midX = Math.round((pair.from.center.x + pair.to.center.x) / 2);
      const midZ = Math.round((pair.from.center.z + pair.to.center.z) / 2);
      allSuggestions.push(`ROAD: Connect "${pair.from.name}" ↔ "${pair.to.name}" (${pair.dist}u, midpoint: ${midX},${midZ})`);
    }

    // Structure suggestions at different nodes
    for (const node of nodes.slice(0, 5)) {
      if (node.missingCategories.length > 0) {
        allSuggestions.push(`BUILD at "${node.name}" (${node.center.x.toFixed(0)},${node.center.z.toFixed(0)}): missing ${node.missingCategories.join(', ')}. Add a ${node.missingCategories[0]} structure.`);
      }
    }

    // Outpost growth
    const outposts = nodes.filter(n => n.tier === 'Outpost');
    for (const o of outposts.slice(0, 2)) {
      allSuggestions.push(`GROW outpost "${o.name}" (${o.center.x.toFixed(0)},${o.center.z.toFixed(0)}): needs ${5 - o.count}+ structures to become a Neighborhood.`);
    }

    if (allSuggestions.length > 0) {
      // Use agent name hash to rotate which suggestion is highlighted for THIS agent
      // so different agents get different top suggestions
      const nameHash = (agentName || '').split('').reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0);
      const offset = Math.abs(nameHash) % allSuggestions.length;

      lines.push('');
      lines.push('**YOUR SUGGESTED TASK:**');
      lines.push(`→ ${allSuggestions[offset]}`);
      if (allSuggestions.length > 1) {
        lines.push('');
        lines.push('Other options (if another agent is already doing yours):');
        // Show 2 more rotated options
        for (let i = 1; i <= Math.min(2, allSuggestions.length - 1); i++) {
          lines.push(`- ${allSuggestions[(offset + i) % allSuggestions.length]}`);
        }
      }
      lines.push('');
      lines.push('**SPREAD OUT.** Don\'t build where other agents already are. If builds keep failing due to overlap, MOVE 30+ units away to a different node and build there instead.');
    }
  }

  return lines.join('\n');
}

// --- LLM Calls ---

interface LLMUsage {
  inputTokens: number;
  outputTokens: number;
}

interface LLMResponse {
  text: string;
  usage: LLMUsage | null;
}

// Cost estimates per 1K tokens (input/output) by provider
const COST_PER_1K: Record<string, { input: number; output: number }> = {
  'gemini': { input: 0.00010, output: 0.00040 },      // Gemini 2.0 Flash
  'anthropic': { input: 0.00080, output: 0.00400 },    // Claude 3.5 Haiku
  'openai': { input: 0.00015, output: 0.00060 },       // GPT-4o-mini
  'minimax': { input: 0.00015, output: 0.00060 },      // MiniMax estimate
};

function formatTokenLog(provider: string, usage: LLMUsage | null): string {
  if (!usage) return 'Tokens: unknown';
  const costs = COST_PER_1K[provider] || { input: 0.0001, output: 0.0004 };
  const costEst = (usage.inputTokens / 1000) * costs.input + (usage.outputTokens / 1000) * costs.output;
  return `Tokens: ${usage.inputTokens.toLocaleString()} in / ${usage.outputTokens.toLocaleString()} out | Cost est: $${costEst.toFixed(4)}`;
}

function promptBudgetForProvider(provider: AgentConfig['llmProvider']): { maxChars: number; tailChars: number } {
  if (provider === 'anthropic') return { maxChars: 12000, tailChars: 4000 };
  if (provider === 'openai') return { maxChars: 24000, tailChars: 8000 };
  return { maxChars: 32000, tailChars: 12000 };
}

function trimPromptForLLM(prompt: string, maxChars = 32000, tailChars = 12000): string {
  if (prompt.length <= maxChars) return prompt;

  const safeTail = Math.min(tailChars, maxChars - 4000);
  const headChars = Math.max(4000, maxChars - safeTail);
  const removed = prompt.length - (headChars + safeTail);

  return [
    prompt.slice(0, headChars),
    '',
    `...[prompt truncated: removed ${removed} chars to stay within model budget]...`,
    '',
    prompt.slice(prompt.length - safeTail),
  ].join('\n');
}

async function callGemini(apiKey: string, model: string, systemPrompt: string, userPrompt: string, imageBase64?: string | null): Promise<LLMResponse> {
  const parts: any[] = [{ text: userPrompt }];
  if (imageBase64) {
    parts.push({ inline_data: { mime_type: "image/jpeg", data: imageBase64 } });
  }

  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: [{ parts }],
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.7,
      },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gemini API error (${res.status}): ${text}`);
  }

  const data = await res.json() as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  };
  const usage = data.usageMetadata
    ? { inputTokens: data.usageMetadata.promptTokenCount || 0, outputTokens: data.usageMetadata.candidatesTokenCount || 0 }
    : null;
  return { text: data.candidates?.[0]?.content?.parts?.[0]?.text || '{}', usage };
}

async function callAnthropic(apiKey: string, model: string, systemPrompt: string, userPrompt: string, imageBase64?: string | null): Promise<LLMResponse> {
  const content: any[] = [{ type: 'text', text: userPrompt }];
  if (imageBase64) {
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } });
  }

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content }],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic API error (${res.status}): ${text}`);
  }

  const data = await res.json() as {
    content?: Array<{ text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const usage = data.usage
    ? { inputTokens: data.usage.input_tokens || 0, outputTokens: data.usage.output_tokens || 0 }
    : null;
  return { text: data.content?.[0]?.text || '{}', usage };
}

async function callOpenAI(apiKey: string, model: string, systemPrompt: string, userPrompt: string, imageBase64?: string | null): Promise<LLMResponse> {
  const content: any[] = [{ type: 'text', text: userPrompt }];
  if (imageBase64) {
    content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}` } });
  }

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.7,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content },
      ],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI API error (${res.status}): ${text}`);
  }

  const data = await res.json() as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const usage = data.usage
    ? { inputTokens: data.usage.prompt_tokens || 0, outputTokens: data.usage.completion_tokens || 0 }
    : null;
  return { text: data.choices?.[0]?.message?.content || '{}', usage };
}

async function callMinimax(apiKey: string, model: string, systemPrompt: string, userPrompt: string): Promise<LLMResponse> {
  const res = await fetch('https://api.minimax.io/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.7,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`MiniMax API error (${res.status}): ${text}`);
  }

  const data = await res.json() as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const usage = data.usage
    ? { inputTokens: data.usage.prompt_tokens || 0, outputTokens: data.usage.completion_tokens || 0 }
    : null;
  return { text: data.choices?.[0]?.message?.content || '{}', usage };
}

interface LLMConfig {
  llmProvider: 'gemini' | 'anthropic' | 'openai' | 'minimax';
  llmModel: string;
  llmApiKey: string;
}

async function callLLM(config: LLMConfig, systemPrompt: string, userPrompt: string, imageBase64?: string | null): Promise<LLMResponse> {
  if (config.llmProvider === 'anthropic') {
    return callAnthropic(config.llmApiKey, config.llmModel, systemPrompt, userPrompt, imageBase64);
  }
  if (config.llmProvider === 'openai') {
    return callOpenAI(config.llmApiKey, config.llmModel, systemPrompt, userPrompt, imageBase64);
  }
  if (config.llmProvider === 'minimax') {
    return callMinimax(config.llmApiKey, config.llmModel, systemPrompt, userPrompt);
  }
  return callGemini(config.llmApiKey, config.llmModel, systemPrompt, userPrompt, imageBase64);
}

// --- Core Runtime ---

export async function startAgent(config: AgentConfig): Promise<void> {
  const sharedDir = join(config.dir, '..', 'shared');
  const memoryDir = join(config.dir, 'memory');

  // Ensure memory dir exists
  if (!existsSync(memoryDir)) mkdirSync(memoryDir, { recursive: true });

  // Load static files
  const identity = readMd(join(config.dir, 'IDENTITY.md'));
  const agentOps = readMd(join(config.dir, 'AGENTS.md'));
  const longMemory = readMd(join(config.dir, 'MEMORY.md'));

  const agentName = identity.match(/^#\s+(.+)/m)?.[1] || 'Agent';
  const agentColor = identity.match(/color:\s*(#[0-9a-fA-F]{6})/)?.[1] || '#6b7280';
  const agentBio = identity.match(/bio:\s*"([^"]+)"/)?.[1] || 'An autonomous agent on OpGrid.';

  // Build system prompt (loaded once, doesn't change per tick)
  const systemPrompt = [
    '# YOUR IDENTITY\n',
    identity,
    '\n---\n',
    '# OPERATING MANUAL\n',
    agentOps,
    '\n---\n',
    '# STRATEGIC THINKING\n',
    'Don\'t just react to what\'s nearby. Before each action, consider:',
    '1. What is your CURRENT OBJECTIVE? (e.g., "connect Garden to East Hub", "establish a civic center at the new outpost")',
    '2. What STEP are you on? Break objectives into 3-5 concrete steps.',
    '3. Is this the highest-impact action right now? Building a 4th lamp post matters less than connecting an isolated node.',
    '',
    '## The City is a Graph',
    'Think top-down like a city planner. The world should look like a MAP with:',
    '- **Nodes** = dense clusters of builds (districts, hubs, parks)',
    '- **Edges** = visible roads/paths/bridges connecting them',
    'Every node must connect to at least one other node. No islands.',
    '',
    '## How to Build Roads (Edges)',
    'To connect two nodes, build a ROAD between them using BUILD_MULTI:',
    '- Calculate the line between two node centers',
    '- Place flat boxes (scaleX=2, scaleY=0.1, scaleZ=2) every 3-4 units along the line',
    '- Example: road from (100,100) to (130,100) = flat boxes at (103,0.05,100), (107,0.05,100), (111,0.05,100)... etc',
    '- Use a neutral color like #94a3b8 for roads, or your agent color for decorative paths',
    '- Add LAMP_POST blueprints along roads every 15-20 units for visual structure',
    '- For longer spans (30+ units), use a BRIDGE blueprint at the midpoint',
    '',
    '## Layout Patterns',
    '- **Hub-and-spoke**: One central PLAZA/FOUNTAIN, roads radiating outward to surrounding nodes',
    '- **Ring road**: Circular path connecting all perimeter nodes, with radial roads to center',
    '- **Grid**: Parallel roads forming blocks (build roads first, then fill blocks with structures)',
    '- **The Capital node should be the hub.** Build roads FROM it TO other nodes.',
    '',
    '## Action Discipline',
    '- **Follow your OPERATING MANUAL priorities.** Your AGENTS.md defines your specific role — builder, connector, or explorer. Follow those priorities, not chat pressure.',
    '- **Don\'t chat more than you act.** Max 1 chat per 3-4 actions. If you chatted last tick, build or move this tick.',
    '- **Don\'t respond to every mention.** A brief acknowledgment is fine. Then get back to your objective.',
    '- **Spread out.** Check Nearby Agents. If others are at your node, move to a different one.',
    '- **If a build fails, relocate.** Don\'t retry at the same spot. Move 30+ units away.',
    '',
    'Write your current objective and step number in your "thought" before choosing an action.',
    '\n---\n',
    '# LONG-TERM MEMORY\n',
    longMemory || '_No long-term memories yet._',
  ].join('\n');

  // API client
  const api = new GridAPIClient();

  // Enter the world with ERC-8004 identity — same door as everyone
  console.log(`[${agentName}] Entering OpGrid (wallet: ${config.walletAddress}, agent ID: ${config.erc8004AgentId})...`);
  let enteredOk = false;
  try {
    const entry = await api.enter(
      config.privateKey,
      config.erc8004AgentId,
      agentName,
      agentColor,
      agentBio,
      config.erc8004Registry
    );
    console.log(`[${agentName}] Entered at (${entry.position.x}, ${entry.position.z}) — ID: ${entry.agentId}`);
    enteredOk = true;
  } catch (err: any) {
    const errMsg = err?.message || String(err);
    const isOwnershipDenied =
      errMsg.includes('does not own or control this agent identity') ||
      errMsg.includes('wallet does not own') ||
      errMsg.includes('tokenOwner') ||
      errMsg.includes('agentWallet');

    // Only auto-register when the server explicitly says ownership failed.
    if (isOwnershipDenied && config.privateKey) {
      console.log(`[${agentName}] Wallet doesn't own agent ID ${config.erc8004AgentId}. Registering a new one...`);
      const chain = new ChainClient(config.privateKey);
      try {
        const balance = await chain.getBalance();
        console.log(`[${agentName}] Wallet balance: ${(Number(balance) / 1e18).toFixed(4)} MON`);
        if (balance > BigInt(0)) {
          const newId = await chain.register();
          console.log(`[${agentName}] REGISTERED new agent ID: ${newId}`);
          console.log(`[${agentName}] Update .env: set agent ID to ${newId}`);
          // Retry entry with new ID
          const entry = await api.enter(
            config.privateKey,
            newId.toString(),
            agentName,
            agentColor,
            agentBio,
            config.erc8004Registry
          );
          console.log(`[${agentName}] Entered at (${entry.position.x}, ${entry.position.z}) — ID: ${entry.agentId}`);
          enteredOk = true;
        } else {
          console.error(`[${agentName}] No MON for gas. Fund wallet ${chain.getAddress()} and restart.`);
          return;
        }
      } catch (regErr) {
        console.error(`[${agentName}] Registration failed:`, regErr);
        return;
      }
    } else {
      console.error(`[${agentName}] Failed to enter world:`, err);
      logNetworkFailure(agentName, err);
      if (errMsg.includes('403')) {
        console.error(`[${agentName}] Entry rejected with 403, but not an ownership-denied response. Check signature/wallet pairing, entry fee state, and server chain config.`);
      }
      return;
    }
  }

  if (!enteredOk) return;

  // Reset working memory on startup — agents should NOT resume from stale state
  const freshMemoryLines = [
    '# Working Memory',
    `Last updated: ${timestamp()}`,
    `Session started: ${timestamp()}`,
    `Last action: NONE`,
    `Consecutive same-action: 0`,
    `Last action detail: Just entered the world — fresh session`,
    `Last seen message id: 0`,
  ];
  // Smith-specific: seed guild tracking fields
  if (agentName.toLowerCase() === 'smith') {
    freshMemoryLines.push('Guild members: (none yet)');
    freshMemoryLines.push('Declined recruitment: (none)');
  }
  const freshMemory = freshMemoryLines.join('\n');
  writeMd(join(memoryDir, 'WORKING.md'), freshMemory);
  console.log(`[${agentName}] Working memory reset for fresh session`);

  // Fetch skill.md from server and append to system prompt
  let skillDoc = '';
  try {
    const skillRes = await fetch(`${process.env.GRID_API_URL || 'http://localhost:3001'}/skill.md`);
    if (skillRes.ok) {
      skillDoc = await skillRes.text();
      console.log(`[${agentName}] Loaded skill.md (${skillDoc.length} chars)`);
    }
  } catch (err) {
    console.warn(`[${agentName}] Could not fetch skill.md:`, err);
  }

  // Rebuild system prompt with skill.md appended
  const fullSystemPrompt = skillDoc
    ? systemPrompt + '\n---\n# SERVER SKILL DOCUMENT\n' + skillDoc
    : systemPrompt;

  // --- Static Prompt Sections (cached, refreshed every 50 ticks) ---
  // These sections rarely change and don't need to be rebuilt every tick
  const ACTION_FORMAT_BLOCK = [
    'Decide your next action. Respond with EXACTLY one JSON object:',
    '{ "thought": "...", "action": "MOVE|CHAT|BUILD_BLUEPRINT|BUILD_CONTINUE|CANCEL_BUILD|BUILD_PRIMITIVE|BUILD_MULTI|TERMINAL|VOTE|SUBMIT_DIRECTIVE|TRANSFER_CREDITS|IDLE", "payload": {...} }',
    '',
    'Payload formats:',
    '  MOVE: {"x": 5, "z": 3}',
    '  CHAT: {"message": "Hello!"}',
    '  BUILD_BLUEPRINT: {"name":"BRIDGE","anchorX":120,"anchorZ":120}  \u2190 USE coordinates from SAFE BUILD SPOTS above!',
    '  BUILD_CONTINUE: {}  \u2190 place next batch from your active blueprint (must be near site)',
    '  CANCEL_BUILD: {}  \u2190 abandon current blueprint (placed pieces stay)',
    '  BUILD_PRIMITIVE: {"shape": "cylinder", "x": 100, "y": 1, "z": 100, "scaleX": 2, "scaleY": 2, "scaleZ": 2, "rotX": 0, "rotY": 0, "rotZ": 0, "color": "#3b82f6"}',
    '  BUILD_MULTI: {"primitives": [{"shape":"cylinder","x":100,"y":1,"z":100,"scaleX":1,"scaleY":2,"scaleZ":1,"color":"#3b82f6"},{"shape":"cone","x":100,"y":3,"z":100,"scaleX":2,"scaleY":2,"scaleZ":2,"color":"#f59e0b"}]}  \u2190 up to 5 per tick',
    '    Available shapes: box, sphere, cone, cylinder, plane, torus, dodecahedron, icosahedron, octahedron, torusKnot, capsule',
    '  TRANSFER_CREDITS: {"toAgentId": "agent_xxx", "amount": 25}  \u2190 send credits to another agent',
    '    **USE VARIETY:** Do NOT just build boxes. Use cylinders for pillars, cones for roofs, spheres for decorations, torus for rings/arches.',
    '    **STACKING GUIDE:** Shapes are centered on Y. CRITICAL: ground_y = scaleY / 2. Examples: scaleY=1 \u2192 y=0.5, scaleY=0.2 \u2192 y=0.1, scaleY=2 \u2192 y=1.0. Stacking: next_y = prev_y + prev_scaleY/2 + new_scaleY/2.',
    '  TERMINAL: {"message": "Status update..."}',
    '  VOTE: {"directiveId": "dir_xxx", "vote": "yes"}  \u2190 directiveId MUST start with "dir_"',
    '  SUBMIT_DIRECTIVE: {"description": "Build X at Y", "agentsNeeded": 2, "hoursDuration": 24}',
    '  IDLE: {}',
    '',
    '**EFFICIENCY:** Use BUILD_BLUEPRINT for structures from the catalog (recommended \u2014 server handles coordinate math). Use BUILD_MULTI for custom/freehand shapes (up to 5 per tick).',
    'IMPORTANT: You can build on your own any time you have credits. You do NOT need a directive or permission to build. Directives are ONLY for organizing group projects with other agents.',
    'If you already voted on a directive, do NOT vote again. If you already submitted a directive with a similar description, do NOT submit another.',
    '**BUILD ZONE RULE:** You MUST NOT build within 50 units of the origin (0,0). The area around origin is reserved for the system terminal. All builds must be at least 50 units away (e.g., x=60, z=70). Builds closer than 50 units will be REJECTED by the server.',
    '**BUILD DISTANCE RULE:** You must be within 20 units (XZ plane) of the target coordinates to build there. If you are too far away, the server will reject your build with an error. MOVE to the location first, THEN build.',
    '',
  ].join('\n');

  // Blueprint catalog — cached and refreshed periodically
  let cachedBlueprintCatalog = '';
  let blueprintCacheTickCount = 0;
  const BLUEPRINT_CACHE_REFRESH_INTERVAL = 50;

  // --- Heartbeat Loop ---
  console.log(`[${agentName}] Heartbeat started (every ${config.heartbeatSeconds}s)`);
  const forceChatCadence = true;
  console.log(`[${agentName}] Chat cadence override: enabled`);

  // Change detection gate — skip LLM calls when world state hasn't meaningfully changed
  let lastWorldHash = '';
  let ticksSinceLastLLMCall = 0;
  const MAX_SKIP_TICKS = 5; // Force an LLM call at least every 5 ticks
  let rateLimitCooldownUntil = 0;
  let tickInProgress = false;

  const tick = async () => {
    if (tickInProgress) {
      console.log(`[${agentName}] Previous tick still running, skipping this heartbeat`);
      return;
    }

    tickInProgress = true;
    try {
      const cooldownRemainingMs = rateLimitCooldownUntil - Date.now();
      if (cooldownRemainingMs > 0) {
        console.log(`[${agentName}] Rate-limit cooldown active (${Math.ceil(cooldownRemainingMs / 1000)}s left). Waiting.`);
        return;
      }

      // 1. Read working memory
      const workingMemory = readMd(join(memoryDir, 'WORKING.md'));

      // 2. Fetch world state
      const world = await api.getWorldState();
      const directives = await api.getDirectives();
      const credits = await api.getCredits();

      // Fetch blueprint build status (lightweight — reads in-memory map)
      let blueprintStatus: any = { active: false };
      try {
        blueprintStatus = await api.getBlueprintStatus();
      } catch {
        // Non-critical — default to no active plan
      }

      // Fetch blueprints (cached, agents should use these!)
      let blueprints: Record<string, any> = {};
      try {
        blueprints = await api.getBlueprints();
      } catch (e) {
        console.warn(`[${agentName}] Could not fetch blueprints`);
      }

      // Fetch spatial summary from server (rate-limited server-side)
      let serverSpatial: Awaited<ReturnType<typeof api.getSpatialSummary>> = null;
      try {
        serverSpatial = await api.getSpatialSummary();
      } catch {
        // Non-critical — skip if unavailable or rate-limited
      }

      // Safe build spots — hoisted to tick scope for use in both prompt and error enrichment
      let safeSpots: { x: number; z: number; nearestBuild: number }[] = [];

      // Debug: log what agents actually receive
      console.log(`[${agentName}] State: ${world.agents.length} agents, ${(world.chatMessages||[]).length} chat msgs, ${(world.messages||[]).length} terminal msgs, ${directives.length} directives`);
      if (directives.length > 0) {
        directives.forEach(d => console.log(`[${agentName}]   Directive: [${d.id}] "${d.description}" status=${d.status} votes=${d.yesVotes}y/${d.noVotes}n`));
      }

      // 3. Find self in world
      const self = world.agents.find(a => a.id === api.getAgentId());
      const otherAgents = world.agents.filter(a => a.id !== api.getAgentId());

      // 4. Build user prompt (changes every tick)
      // Build agent name lookup for primitives
      const agentNameMap = new Map(world.agents.map(a => [a.id, a.name]));
      const myId = api.getAgentId();
      const myPrimitives = world.primitives.filter(o => o.ownerAgentId === myId);
      const otherPrimitives = world.primitives.filter(o => o.ownerAgentId !== myId);

      // Merge chat + terminal into one unified chat feed
      const chatMessages = world.chatMessages || [];
      const terminalMessages = world.messages || [];
      const allChatMessages = [...chatMessages, ...terminalMessages]
        .sort((a, b) => a.createdAt - b.createdAt)
        .slice(-15);

      // Track which messages are new since last tick
      const lastSeenId = parseInt(workingMemory?.match(/Last seen message id: (\d+)/)?.[1] || '0');
      const latestMsgId = allChatMessages.length > 0 ? Math.max(...allChatMessages.map(m => m.id || 0)) : lastSeenId;
      const newMessages = allChatMessages.filter(m => (m.id || 0) > lastSeenId);
      const prevTicksSinceChat = parseInt(workingMemory?.match(/Ticks since chat: (\d+)/)?.[1] || '0');
      const currentTicksSinceChat = prevTicksSinceChat + 1;
      const chatDue = currentTicksSinceChat >= 2 && otherAgents.length > 0;

      // Format messages with NEW tags (no mention pressure — agents should prioritize their objective)
      const formatMessage = (m: typeof allChatMessages[0]) => {
        const isNew = (m.id || 0) > lastSeenId;
        const tag = isNew ? '[NEW] ' : '';
        return `- ${tag}${m.agentName}: ${m.message}`;
      };

      // --- Change detection gate ---
      // Build a lightweight fingerprint of world state to detect meaningful changes
      const mentionsMe = newMessages.some(m =>
        m.message?.toLowerCase().includes(agentName.toLowerCase())
      );

      const selfPosKey = self
        ? `${self.position.x.toFixed(1)},${self.position.z.toFixed(1)},${self.status}`
        : 'noself';
      const directivesKey = directives
        .map(d => `${d.id}:${d.status}:${d.yesVotes}:${d.noVotes}`)
        .sort()
        .join(',');
      const worldHash = [
        selfPosKey,
        world.agents.length,
        world.primitives.length,
        latestMsgId,
        directivesKey,
        credits,
        blueprintStatus?.active ? `bp:${blueprintStatus.placedCount}/${blueprintStatus.totalPrimitives}` : 'nobp',
      ].join('|');

      ticksSinceLastLLMCall++;

      if (worldHash === lastWorldHash && !mentionsMe && !chatDue && ticksSinceLastLLMCall < MAX_SKIP_TICKS) {
        console.log(`[${agentName}] No meaningful change, skipping LLM call (tick ${ticksSinceLastLLMCall}/${MAX_SKIP_TICKS})`);
        return;
      }

      lastWorldHash = worldHash;
      ticksSinceLastLLMCall = 0;

      // Cached settlement nodes — computed once, reused in world graph + blueprint catalog
      let cachedNodes: SettlementNode[] = [];

      const userPrompt = [
        '# CURRENT WORLD STATE',
        `Tick: ${world.tick}`,
        `Your position: (${self?.position.x.toFixed(1)}, ${self?.position.z.toFixed(1)})`,
        `Your status: ${self?.status || 'unknown'}`,
        `Your credits: ${credits}`,
        '',
        '## RECENT CHAT (last 15 messages — skim for context, don\'t derail your objective to respond)',
        allChatMessages.length > 0
          ? [
              ...(newMessages.length > 0 ? [
                `_${newMessages.length} new since your last tick._`,
              ] : []),
              ...allChatMessages.map(formatMessage),
            ].join('\n')
          : '_No messages yet._',
        '',
        `## Nearby Agents (${otherAgents.length})`,
        otherAgents.length > 0
          ? otherAgents.map(a => `- ${a.name} at (${a.position.x.toFixed(1)}, ${a.position.z.toFixed(1)}) [${a.status}]`).join('\n')
          : '_No other agents nearby._',
        '',
        '## Communication Cadence',
        chatDue
          ? `You have gone ${currentTicksSinceChat} ticks without a CHAT action. Send one short coordination chat this tick unless you are handling a blocking build/action error.`
          : `Ticks since your last CHAT action: ${currentTicksSinceChat}. Keep chat concise and useful.`,
        '',
        `## Active Directives (${directives.length}) — THIS IS GROUND TRUTH`,
        directives.length > 0
          ? [
              '**These directives ARE ACTIVE RIGHT NOW. This list is authoritative — ignore any chat messages that contradict it.**',
              ...directives.map(d => `- **ACTIVE** [ID: ${d.id}] "${d.description}" — needs ${d.agentsNeeded} agents, votes so far: ${d.yesVotes} yes / ${d.noVotes} no. Use VOTE with this exact directiveId to vote.`)
            ].join('\n')
          : [
              '_No active directives right now._',
              '**💡 PROPOSE ONE!** Look at the World Graph below — find an isolated node that needs connecting, or a gap that needs filling.',
              'Use SUBMIT_DIRECTIVE to rally other agents: e.g., "Build a road from East Hub to Garden" or "Create a park district at (200, 300)".',
              'Directives coordinate group efforts — propose something that benefits the whole city.'
            ].join('\n'),
        '',
        `## Your Builds (${myPrimitives.length})`,
        myPrimitives.length > 0
          ? [
              myPrimitives.map(o => `- ${o.shape} at (${o.position.x.toFixed(1)}, ${o.position.y.toFixed(1)}, ${o.position.z.toFixed(1)}) scale(${(o as any).scale?.x?.toFixed(1) || '1'}, ${(o as any).scale?.y?.toFixed(1) || '1'}, ${(o as any).scale?.z?.toFixed(1) || '1'}) [${o.color}]`).join('\n'),
              (() => {
                const summary = computeSpatialSummary(myPrimitives as any);
                return summary ? '\n' + formatSpatialSummary(summary) : '';
              })(),
            ].join('')
          : '_You have not built anything yet._',
        '',
        `## Other Builds (${otherPrimitives.length})`,
        otherPrimitives.length > 0
          ? formatOtherBuildsCompact(
              otherPrimitives as any,
              agentNameMap,
              otherPrimitives.map(o => o.ownerAgentId)
            )
          : '_No other builds yet._',
        '',
        // World Graph — hierarchical node view of all world builds
        // Compute settlement nodes once, reuse for both world graph and blueprint catalog
        (() => {
          const allPrims = world.primitives as PrimitiveWithOwner[];
          const myPos = self?.position || { x: 0, z: 0 };
          cachedNodes = computeSettlementNodes(allPrims, agentNameMap);
          return formatSettlementMap(cachedNodes, myPos, agentName);
        })(),
        '',
        // Safe build spots — pre-computed valid anchor points verified clear of overlap
        ...(() => {
          const myPos = self?.position || { x: 0, z: 0 };
          const primData = world.primitives.map(p => ({ position: p.position, scale: p.scale || { x: 1, z: 1 }, shape: p.shape }));
          safeSpots = findSafeBuildSpots(myPos, primData);
          if (safeSpots.length === 0) {
            return [
              '## ⚠ NO SAFE BUILD SPOTS FOUND',
              'The area is very dense. MOVE 50+ units in any direction and try again next tick.',
              '',
            ];
          }
          const lines: string[] = [];
          lines.push('## SAFE BUILD SPOTS (verified clear of overlap)');
          for (const spot of safeSpots) {
            const distFromAgent = Math.round(Math.sqrt((spot.x - myPos.x) ** 2 + (spot.z - myPos.z) ** 2));
            lines.push(`- **(${spot.x}, ${spot.z})** — ${distFromAgent}u from you, ${spot.nearestBuild}u from nearest build`);
          }
          lines.push('');
          lines.push('**IMPORTANT:** MOVE within 20u of a spot FIRST, then use it as anchorX/anchorZ. You must be within 20u of the build site.');
          lines.push('');
          return lines;
        })(),
        // Nearby blueprint dedup hints
        ...(() => {
          const myPos = self?.position || { x: 0, z: 0 };
          const nearbyRadius = 15;
          const nearbyPrims = world.primitives.filter(p => {
            const dx = p.position.x - myPos.x;
            const dz = p.position.z - (myPos as any).z;
            return Math.sqrt(dx * dx + dz * dz) <= nearbyRadius;
          });
          if (nearbyPrims.length === 0) return [];
          // Count blueprint-like clusters by shape composition within radius
          const shapeCounts = new Map<string, number>();
          for (const p of nearbyPrims) {
            shapeCounts.set(p.shape, (shapeCounts.get(p.shape) || 0) + 1);
          }
          const duplicateWarnings: string[] = [];
          // Detect lamp_post-like patterns (cylinder + cone + sphere clusters)
          const spheres = shapeCounts.get('sphere') || 0;
          const cones = shapeCounts.get('cone') || 0;
          const cylinders = shapeCounts.get('cylinder') || 0;
          if (spheres >= 3 && cones >= 2 && cylinders >= 3) {
            duplicateWarnings.push('Multiple LAMP_POST-like structures detected nearby.');
          }
          if (nearbyPrims.length >= 8) {
            duplicateWarnings.push(`${nearbyPrims.length} shapes within ${nearbyRadius} units of you.`);
          }
          if (duplicateWarnings.length > 0) {
            return [
              '## ⚠ NEARBY BUILD DENSITY WARNING',
              ...duplicateWarnings,
              '**Build something DIFFERENT here — this node needs variety, not more of the same type. Try a complementary structure.**',
              '',
            ];
          }
          return [];
        })(),
        '## YOUR WORKING MEMORY',
        workingMemory || '_No working memory. This is your first tick._',
        '',
        '---',
        '**HOW TO TALK:** See instructions above. Talk like a person, not a robot.',
        '',
        // Build error warnings — direct agents to safe spots
        ...(workingMemory ? (() => {
          const lastBuildError = workingMemory.match(/Last build error: (.+)/)?.[1];
          const consecutiveBuildFails = parseInt(workingMemory.match(/Consecutive build failures: (\d+)/)?.[1] || '0');
          const warnings: string[] = [];
          if (lastBuildError) {
            warnings.push(`**⚠️ LAST BUILD FAILED:** ${lastBuildError}`);
            warnings.push('**FIX:** Use a coordinate from SAFE BUILD SPOTS above as your anchorX/anchorZ. Do NOT guess — use the exact coordinates listed.');
          }
          if (consecutiveBuildFails >= 3) {
            // Show nearest 3 safe spots directly in the warning
            const myPos = self?.position || { x: 0, z: 0 };
            const nearest3 = [...safeSpots]
              .sort((a, b) => {
                const da = Math.sqrt((a.x - myPos.x) ** 2 + (a.z - myPos.z) ** 2);
                const db = Math.sqrt((b.x - myPos.x) ** 2 + (b.z - myPos.z) ** 2);
                return da - db;
              })
              .slice(0, 3);
            const spotList = nearest3.map(s => `(${s.x}, ${s.z})`).join(', ');
            warnings.push(`**🛑 ${consecutiveBuildFails} CONSECUTIVE BUILD FAILURES. You MUST use one of these exact coordinates: ${spotList}. MOVE within 20u first, then use as anchorX/anchorZ.**`);
          }
          return warnings.length > 0 ? [...warnings, ''] : [];
        })() : []),
        // Loop detection: warn if same action repeated (threshold: 3)
        ...(workingMemory ? (() => {
          const lastActionMatch = workingMemory.match(/Last action: (\w+)/);
          const consecutiveMatch = workingMemory.match(/Consecutive same-action: (\d+)/);
          const lastAction = lastActionMatch?.[1];
          const consecutive = parseInt(consecutiveMatch?.[1] || '0');
          if (lastAction && consecutive >= 4 && lastAction !== 'BUILD_CONTINUE') {
            const buildActions = ['BUILD_PRIMITIVE', 'BUILD_MULTI', 'BUILD_BLUEPRINT'];
            const isBuildAction = buildActions.includes(lastAction);
            return [`**⚠ WARNING: You have done ${lastAction} ${consecutive} times in a row. You MUST choose a DIFFERENT action category this tick.${isBuildAction ? ' Try MOVE or CHAT instead.' : ''}**`, ''];
          }
          if (lastAction && consecutive >= 3 && lastAction !== 'BUILD_CONTINUE') {
            return [`**⚠ WARNING: You have done ${lastAction} ${consecutive} times in a row. Consider doing something different.**`, ''];
          }
          return [];
        })() : []),
        // Static action format instructions (cached at startup)
        ACTION_FORMAT_BLOCK,
        // Blueprint section — either show active plan or cached catalog
        ...(blueprintStatus?.active
          ? [
              '## ACTIVE BUILD PLAN',
              `Building: **${blueprintStatus.blueprintName}** at (${blueprintStatus.anchorX}, ${blueprintStatus.anchorZ})`,
              `Progress: ${blueprintStatus.placedCount}/${blueprintStatus.totalPrimitives} pieces placed${blueprintStatus.currentPhase ? ` (Phase: "${blueprintStatus.currentPhase}")` : ''}`,
              `Next: Use **BUILD_CONTINUE** to place next ${blueprintStatus.nextBatchSize} pieces (must be within 20 units of anchor)`,
              `Or: CHAT, MOVE, VOTE, etc. — your build plan persists until you CANCEL_BUILD.`,
              '',
            ]
          : [
              // Refresh blueprint catalog cache periodically
              (() => {
                blueprintCacheTickCount++;
                if (!cachedBlueprintCatalog || blueprintCacheTickCount >= BLUEPRINT_CACHE_REFRESH_INTERVAL) {
                  blueprintCacheTickCount = 0;
                  cachedBlueprintCatalog = [
                    '## BLUEPRINT CATALOG',
                    'Pick a blueprint and start building. The server computes all coordinates for you.',
                    '  BUILD_BLUEPRINT: {"name":"BRIDGE","anchorX":120,"anchorZ":120}',
                    '',
                    ...Object.entries(blueprints).map(([name, bp]: [string, any]) =>
                      `- **${name}** — ${bp.description} | ${bp.totalPrimitives} pieces, ~${Math.ceil(bp.totalPrimitives / 5)} ticks | ${bp.difficulty}`
                    ),
                  ].join('\n');
                }
                return cachedBlueprintCatalog;
              })(),
              '',
              (() => {
                const myPos = self?.position || { x: 0, z: 0 };
                const nodes = cachedNodes;
                if (nodes.length > 0) {
                  const nearest = nodes.reduce((best, n) => {
                    const d = Math.sqrt((n.center.x - myPos.x) ** 2 + (n.center.z - (myPos as any).z) ** 2);
                    const bestD = Math.sqrt((best.center.x - myPos.x) ** 2 + (best.center.z - (myPos as any).z) ** 2);
                    return d < bestD ? n : best;
                  });
                  if (nearest.count >= 5) {
                    return `**Nearest node: "${nearest.name}" at (${nearest.center.x.toFixed(0)}, ${nearest.center.z.toFixed(0)}) with ${nearest.count} structures.** Build within 30 units of it, or connect it to another node with a BRIDGE.`;
                  }
                  return `**Nearest node: "${nearest.name}" at (${nearest.center.x.toFixed(0)}, ${nearest.center.z.toFixed(0)}) with ${nearest.count} structures.** Build within 30 units of it — add something that complements or contrasts what's already there.`;
                }
                return `**YOUR POSITION is (${self?.position?.x?.toFixed(0) || '?'}, ${self?.position?.z?.toFixed(0) || '?'}).** Choose anchorX/anchorZ near here (50+ from origin).`;
              })(),
              'Move within 20 units of your anchor before using BUILD_CONTINUE.',
              '',
            ]
        ),
      ].join('\n');

      // 5. Capture View & Call LLM
      const imageBase64 = await captureWorldView(api.getAgentId() || config.erc8004AgentId);
      if (imageBase64) {
        console.log(`[${agentName}] Captured visual input`);
      }

      const budget = promptBudgetForProvider(config.llmProvider);
      const modelPrompt = trimPromptForLLM(userPrompt, budget.maxChars, budget.tailChars);
      if (modelPrompt.length !== userPrompt.length) {
        console.log(`[${agentName}] Prompt trimmed ${userPrompt.length} -> ${modelPrompt.length} chars`);
      }
      let decision: AgentDecision;
      let rateLimitWaitThisTick = false;
      try {
        const llmResponse = await callLLM(config, fullSystemPrompt, modelPrompt, imageBase64);
        const raw = llmResponse.text;
        console.log(`[${agentName}] ${formatTokenLog(config.llmProvider, llmResponse.usage)}`);
        try {
          // Extract JSON from response — strip think tags, code fences, then find the first {…} block
          const cleaned = raw.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
          // Find the first balanced JSON object in the response
          const firstBrace = cleaned.indexOf('{');
          if (firstBrace === -1) throw new Error('No JSON object found');
          let depth = 0;
          let lastBrace = -1;
          for (let i = firstBrace; i < cleaned.length; i++) {
            if (cleaned[i] === '{') depth++;
            else if (cleaned[i] === '}') { depth--; if (depth === 0) { lastBrace = i; break; } }
          }
          if (lastBrace === -1) throw new Error('Unbalanced braces');
          const jsonStr = cleaned.slice(firstBrace, lastBrace + 1);
          decision = JSON.parse(jsonStr);
        } catch {
          console.warn(`[${agentName}] Failed to parse LLM response, idling. Raw: ${raw.slice(0, 200)}`);
          decision = { thought: 'Could not parse response', action: 'IDLE' };
        }
      } catch (llmErr) {
        const llmMsg = llmErr instanceof Error ? llmErr.message : String(llmErr);
        const compact = llmMsg.replace(/\s+/g, ' ').slice(0, 140);
        console.error(`[${agentName}] LLM call failed: ${compact}`);
        if (isRateLimitErrorMessage(llmMsg)) {
          const waitSeconds = parseRateLimitCooldownSeconds(llmMsg, 30);
          rateLimitCooldownUntil = Math.max(rateLimitCooldownUntil, Date.now() + waitSeconds * 1000);
          rateLimitWaitThisTick = true;
          decision = {
            thought: `LLM rate-limited (${compact}); waiting ${waitSeconds}s before retry.`,
            action: 'IDLE',
          };
        } else if (otherAgents.length > 0) {
          decision = {
            thought: `LLM unavailable (${compact}); sending coordination heartbeat.`,
            action: 'CHAT',
            payload: { message: makeCoordinationChat(agentName, self, directives, otherAgents, allChatMessages).slice(0, 220) },
          };
        } else {
          decision = { thought: `LLM unavailable (${compact}); waiting for next tick.`, action: 'IDLE' };
        }
      }

      if (forceChatCadence && chatDue && decision.action !== 'CHAT' && !(blueprintStatus?.active && decision.action === 'BUILD_CONTINUE') && !rateLimitWaitThisTick) {
        const forcedMessage = makeCoordinationChat(agentName, self, directives, otherAgents, allChatMessages);
        console.log(`[${agentName}] Communication cadence override -> CHAT`);
        decision = {
          thought: `${decision.thought} | Communication is overdue; sending coordination update.`,
          action: 'CHAT',
          payload: { message: forcedMessage.slice(0, 220) },
        };
      }

      // 6. Execute action
      console.log(`[${agentName}] ${decision.thought} -> ${decision.action}`);
      let buildError = await executeAction(api, agentName, decision, self?.position ? { x: self.position.x, z: self.position.z } : undefined);
      if (buildError) {
        console.warn(`[${agentName}] Action error: ${buildError}`);
        if (isRateLimitErrorMessage(buildError)) {
          const waitSeconds = parseRateLimitCooldownSeconds(buildError, 20);
          rateLimitCooldownUntil = Math.max(rateLimitCooldownUntil, Date.now() + waitSeconds * 1000);
          console.warn(`[${agentName}] Rate-limited on ${decision.action}. Cooling down ${waitSeconds}s before retry.`);
          buildError = `${buildError} — Rate-limited; waiting ${waitSeconds}s before retry.`;
        } else if (safeSpots.length > 0) {
          // Enrich non-rate-limit build errors with nearest safe spot coordinates
          const myPos = self?.position || { x: 0, z: 0 };
          const nearest3 = [...safeSpots]
            .sort((a, b) => {
              const da = Math.sqrt((a.x - myPos.x) ** 2 + (a.z - myPos.z) ** 2);
              const db = Math.sqrt((b.x - myPos.x) ** 2 + (b.z - myPos.z) ** 2);
              return da - db;
            })
            .slice(0, 3);
          const spotList = nearest3.map(s => `(${s.x}, ${s.z})`).join(', ');
          buildError = `${buildError} — Try these clear spots instead: ${spotList}`;
        }
      }

      // 7. Update working memory (DO NOT include agent names — prevents hallucination from stale memory)
      // Track consecutive same-action count for loop detection
      const prevActionMatch = workingMemory?.match(/Last action: (\w+)/);
      const prevConsecutiveMatch = workingMemory?.match(/Consecutive same-action: (\d+)/);
      const prevAction = prevActionMatch?.[1];
      const prevConsecutive = parseInt(prevConsecutiveMatch?.[1] || '0');
      const consecutive = (decision.action === prevAction) ? prevConsecutive + 1 : 1;

      // Store only factual state — NOT the LLM's thought (prevents feedback loops
      // where stale thoughts like "directive is not active" override current world state)
      const actionSummary = decision.action === 'CHAT' ? `CHAT: "${(decision.payload as any)?.message?.slice(0, 80) || ''}"`
        : decision.action === 'BUILD_PRIMITIVE' ? `BUILD_PRIMITIVE: ${(decision.payload as any)?.shape || 'shape'} at (${(decision.payload as any)?.x ?? '?'}, ${(decision.payload as any)?.y ?? 0}, ${(decision.payload as any)?.z ?? '?'})`
        : decision.action === 'BUILD_MULTI' ? `BUILD_MULTI: ${((decision.payload as any)?.primitives || []).length} primitives`
        : decision.action === 'BUILD_BLUEPRINT' ? `BUILD_BLUEPRINT: ${(decision.payload as any)?.name || '?'} at (${(decision.payload as any)?.anchorX ?? '?'}, ${(decision.payload as any)?.anchorZ ?? '?'})`
        : decision.action === 'BUILD_CONTINUE' ? `BUILD_CONTINUE: continued active blueprint`
        : decision.action === 'CANCEL_BUILD' ? `CANCEL_BUILD: cancelled active blueprint`
        : decision.action === 'VOTE' ? `VOTE: ${(decision.payload as any)?.vote || '?'} on ${(decision.payload as any)?.directiveId || '?'}`
        : decision.action === 'SUBMIT_DIRECTIVE' ? `SUBMIT_DIRECTIVE: "${(decision.payload as any)?.description?.slice(0, 60) || '?'}"`
        : decision.action === 'TRANSFER_CREDITS' ? `TRANSFER_CREDITS: ${(decision.payload as any)?.amount || '?'} to ${(decision.payload as any)?.toAgentId || '?'}`
        : decision.action === 'MOVE' ? `MOVE to (${(decision.payload as any)?.x ?? '?'}, ${(decision.payload as any)?.z ?? '?'})`
        : decision.action;

      // Track voted directives and submitted directives across ticks
      const prevVoted = workingMemory?.match(/Voted on: (.+)/)?.[1] || '';
      const prevSubmitted = workingMemory?.match(/Submitted directives: (.+)/)?.[1] || '';
      let votedOn = prevVoted;
      let submittedDirectives = prevSubmitted;
      if (decision.action === 'VOTE' && (decision.payload as any)?.directiveId) {
        const dirId = (decision.payload as any).directiveId;
        if (!votedOn.includes(dirId)) votedOn = votedOn ? `${votedOn}, ${dirId}` : dirId;
      }
      if (decision.action === 'SUBMIT_DIRECTIVE' && (decision.payload as any)?.description) {
        const desc = (decision.payload as any).description.slice(0, 40);
        if (!submittedDirectives.includes(desc)) submittedDirectives = submittedDirectives ? `${submittedDirectives}, ${desc}` : desc;
      }

      // Track consecutive build failures — only reset on successful build
      const prevBuildFails = parseInt(workingMemory?.match(/Consecutive build failures: (\d+)/)?.[1] || '0');
      const buildActions = ['BUILD_PRIMITIVE', 'BUILD_MULTI', 'BUILD_BLUEPRINT', 'BUILD_CONTINUE'];
      const wasBuildAction = buildActions.includes(decision.action);
      const consecutiveBuildFails = wasBuildAction && buildError
        ? prevBuildFails + 1
        : (wasBuildAction && !buildError) ? 0
        : prevBuildFails;

      // Track build plan across ticks
      const prevBuildPlan = workingMemory?.match(/Current build plan: (.+)/)?.[1] || '';
      let currentBuildPlan = prevBuildPlan;

      // Server-authoritative build status
      if (blueprintStatus?.active) {
        currentBuildPlan = `Blueprint: ${blueprintStatus.blueprintName} at (${blueprintStatus.anchorX}, ${blueprintStatus.anchorZ}) — ${blueprintStatus.placedCount}/${blueprintStatus.totalPrimitives} placed`;
      } else {
        currentBuildPlan = ''; // Clear if server says no active plan
      }

      // Extract objective from thought (persists across ticks)
      const prevObjective = workingMemory?.match(/Current objective: (.+)/)?.[1] || '';
      const prevObjectiveStep = parseInt(workingMemory?.match(/Objective step: (\d+)/)?.[1] || '0');
      // Parse objective from thought if agent mentions one (look for patterns like "Objective: ..." or "Step N:")
      const thoughtObjectiveMatch = decision.thought?.match(/(?:objective|goal|mission)[:\s]+["']?([^"'\n.]{10,80})["']?/i);
      const thoughtStepMatch = decision.thought?.match(/step\s+(\d+)/i);
      const currentObjective = thoughtObjectiveMatch?.[1]?.trim() || prevObjective;
      const objectiveStep = thoughtStepMatch ? parseInt(thoughtStepMatch[1]) : (currentObjective === prevObjective ? prevObjectiveStep : 1);

      // Smith-specific: track guild membership
      let guildMembers = workingMemory?.match(/Guild members: (.+)/)?.[1] || '(none yet)';
      let declinedRecruitment = workingMemory?.match(/Declined recruitment: (.+)/)?.[1] || '(none)';
      if (agentName.toLowerCase() === 'smith') {
        const recruitedMatch = decision.thought?.match(
          /(?:recruited|joined.*guild|new.*member)[:\s]+(\w+)/i
        );
        if (recruitedMatch) {
          const name = recruitedMatch[1].toLowerCase();
          if (guildMembers === '(none yet)') guildMembers = name;
          else if (!guildMembers.includes(name)) guildMembers = `${guildMembers}, ${name}`;
        }
        const declinedMatch = decision.thought?.match(
          /(?:declined|not interested|rejected)[:\s]+(\w+)/i
        );
        if (declinedMatch) {
          const name = declinedMatch[1].toLowerCase();
          if (declinedRecruitment === '(none)') declinedRecruitment = name;
          else if (!declinedRecruitment.includes(name)) declinedRecruitment = `${declinedRecruitment}, ${name}`;
        }
      }
      const ticksSinceChat = decision.action === 'CHAT' ? 0 : currentTicksSinceChat;

      const newWorking = [
        `# Working Memory`,
        `Last updated: ${timestamp()}`,
        `Last action: ${decision.action}`,
        `Consecutive same-action: ${consecutive}`,
        `Last action detail: ${actionSummary}`,
        `Position: (${self?.position.x.toFixed(1)}, ${self?.position.z.toFixed(1)})`,
        `Credits: ${credits}`,
        `Last seen message id: ${latestMsgId}`,
        `Ticks since chat: ${ticksSinceChat}`,
        currentObjective ? `Current objective: ${currentObjective}` : '',
        objectiveStep > 0 ? `Objective step: ${objectiveStep}` : '',
        currentBuildPlan ? `Current build plan: ${currentBuildPlan}` : '',
        votedOn ? `Voted on: ${votedOn}` : '',
        submittedDirectives ? `Submitted directives: ${submittedDirectives}` : '',
        buildError ? `Last build error: ${buildError}` : '',
        consecutiveBuildFails > 0 ? `Consecutive build failures: ${consecutiveBuildFails}` : '',
        // Smith guild tracking
        ...(agentName.toLowerCase() === 'smith' ? [
          `Guild members: ${guildMembers}`,
          `Declined recruitment: ${declinedRecruitment}`,
        ] : []),
      ].filter(Boolean).join('\n');
      writeMd(join(memoryDir, 'WORKING.md'), newWorking);

      // 8. Append to daily log
      const dailyLogPath = join(memoryDir, `${todayDate()}.md`);
      if (!existsSync(dailyLogPath)) {
        writeMd(dailyLogPath, `# Daily Log — ${todayDate()}\n\n`);
      }
      appendLog(dailyLogPath, `[${timestamp()}] ${decision.action}: ${decision.thought}`);

    } catch (err) {
      if (isAuthSessionError(err)) {
        console.warn(`[${agentName}] Session rejected (401). Re-entering...`);
        try {
          const entry = await api.enter(
            config.privateKey,
            config.erc8004AgentId,
            agentName,
            agentColor,
            agentBio,
            config.erc8004Registry
          );
          console.log(`[${agentName}] Re-entered at (${entry.position.x}, ${entry.position.z}) — ID: ${entry.agentId}`);
          return;
        } catch (reauthErr) {
          console.error(`[${agentName}] Re-entry failed:`, reauthErr);
        }
      }
      console.error(`[${agentName}] Heartbeat error:`, err);
    } finally {
      tickInProgress = false;
    }
  };

  // Run first tick immediately, then loop
  await tick();
  setInterval(tick, config.heartbeatSeconds * 1000);
}

// --- Bootstrap Runtime (for agents without an ID) ---

export async function bootstrapAgent(config: BootstrapConfig): Promise<void> {
  const sharedDir = join(config.dir, '..', 'shared');
  const memoryDir = join(config.dir, 'memory');

  if (!existsSync(memoryDir)) mkdirSync(memoryDir, { recursive: true });

  // Load identity files
  const identity = readMd(join(config.dir, 'IDENTITY.md'));
  const agentOps = readMd(join(config.dir, 'AGENTS.md'));

  const agentName = identity.match(/^#\s+(.+)/m)?.[1] || 'Agent';
  const agentColor = identity.match(/color:\s*(#[0-9a-fA-F]{6})/)?.[1] || '#6b7280';
  const agentBio = identity.match(/bio:\s*"([^"]+)"/)?.[1] || 'A new agent trying to enter OpGrid.';

  const systemPrompt = [
    '# YOUR IDENTITY\n',
    identity,
    '\n---\n',
    '# OPERATING MANUAL\n',
    agentOps,
  ].join('\n');

  const dailyLogPath = join(memoryDir, `${todayDate()}.md`);
  if (!existsSync(dailyLogPath)) {
    writeMd(dailyLogPath, `# Daily Log — ${todayDate()}\n\n`);
  }

  const log = (msg: string) => {
    console.log(`[${agentName}] ${msg}`);
    appendLog(dailyLogPath, `[${timestamp()}] ${msg}`);
  };

  log('Starting bootstrap — no agent ID yet.');

  // Step 1: Try to enter without an agent ID — expect rejection
  log('Step 1: Attempting to enter OpGrid without agent ID...');
  let entryError = '';
  try {
    const res = await fetch(`${config.apiBaseUrl}/v1/agents/enter`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ownerId: config.walletAddress || 'unknown_wallet',
        visuals: { name: agentName, color: agentColor },
        bio: agentBio,
      }),
    });
    const body = await res.json() as Record<string, unknown>;
    if (!res.ok) {
      entryError = JSON.stringify(body, null, 2);
      log(`Entry rejected (${res.status}): ${body.error || 'unknown'}`);
    } else {
      log('Unexpectedly entered without an agent ID! This should not happen.');
      return;
    }
  } catch (err) {
    entryError = `Network error: ${err}`;
    log(`Failed to reach server: ${err}`);
  }

  // Step 2: Fetch skill.md onboarding doc
  log('Step 2: Fetching skill.md onboarding document...');
  let skillDoc = '';
  try {
    const skillRes = await fetch(`${config.apiBaseUrl}/skill.md`);
    if (skillRes.ok) {
      skillDoc = await skillRes.text();
      log(`Fetched skill.md (${skillDoc.length} chars)`);
    } else {
      log(`skill.md not available (${skillRes.status})`);
    }
  } catch (err) {
    log(`Failed to fetch skill.md: ${err}`);
  }

  // Step 3: Check wallet and balance
  log('Step 3: Checking wallet and on-chain balance...');
  let chain: ChainClient | null = null;
  let walletBalance = BigInt(0);

  if (config.privateKey) {
    chain = new ChainClient(config.privateKey);
    const derivedAddr = chain.getAddress();
    log(`Wallet from PK: ${derivedAddr}`);
    if (config.walletAddress && derivedAddr && derivedAddr.toLowerCase() !== config.walletAddress.toLowerCase()) {
      log(`WARNING: CLANK_WALLET (${config.walletAddress}) does not match PK-derived address (${derivedAddr})`);
    }

    try {
      walletBalance = await chain.getBalance();
      const balMon = Number(walletBalance) / 1e18;
      log(`Balance: ${balMon.toFixed(4)} MON`);
    } catch (err) {
      log(`Failed to check balance: ${err}`);
    }
  } else {
    log('No private key — cannot interact with chain.');
  }

  // Step 4: Ask LLM to analyze the situation
  log('Step 4: Asking LLM to analyze the bootstrap situation...');
  const workingMemory = readMd(join(memoryDir, 'WORKING.md'));
  const bootstrapPrompt = [
    '# BOOTSTRAP SITUATION',
    '',
    'You just tried to enter OpGrid and were REJECTED because you have no agent ID. This is expected.',
    '',
    '## Entry Rejection',
    entryError,
    '',
    skillDoc ? '## Onboarding Document (skill.md)\n' + skillDoc : '## Onboarding Document\n_Could not fetch._',
    '',
    '## Your Wallet Status',
    config.walletAddress ? `Address: ${config.walletAddress}` : 'No wallet configured.',
    config.privateKey ? 'Private key: LOADED (you can sign transactions)' : 'Private key: MISSING',
    `Balance: ${Number(walletBalance) / 1e18} MON`,
    '',
    '## What You Need To Do',
    `Call register() on the IdentityRegistry at ${config.erc8004Registry} to mint your agent ID.`,
    'You have a private key and MON for gas. You CAN do this yourself.',
    'After registration, re-enter OpGrid with your new agent ID.',
    '',
    '## Your Working Memory',
    workingMemory || '_First bootstrap attempt._',
    '',
    '---',
    'Respond with: { "thought": "your analysis", "should_register": true/false, "reason": "why or why not" }',
  ].join('\n');

  let shouldRegister = true;
  try {
    const llmResponse = await callLLM(config, systemPrompt, bootstrapPrompt);
    log(`${formatTokenLog(config.llmProvider, llmResponse.usage)}`);
    const jsonStr = llmResponse.text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(jsonStr) as {
      thought?: string;
      should_register?: boolean;
      reason?: string;
    };
    log(`LLM analysis: ${parsed.thought}`);
    shouldRegister = parsed.should_register !== false;
  } catch (err) {
    log(`LLM analysis failed: ${err}. Proceeding with registration anyway.`);
  }

  // Step 5: Register on-chain
  let newAgentId: bigint | null = null;
  if (shouldRegister && chain && walletBalance > BigInt(0)) {
    log('Step 5: Calling register() on IdentityRegistry...');
    try {
      newAgentId = await chain.register();
      log(`REGISTERED! New agent ID: ${newAgentId}`);
    } catch (err) {
      log(`Registration failed: ${err}`);
    }
  } else if (!chain) {
    log('Step 5: SKIPPED — no private key, cannot register.');
  } else if (walletBalance === BigInt(0)) {
    log('Step 5: SKIPPED — wallet has no MON for gas.');
  } else {
    log('Step 5: SKIPPED — LLM decided not to register.');
  }

  // Step 6: If registered, enter the world
  if (newAgentId !== null && chain) {
    log(`Step 6: Entering OpGrid with new agent ID ${newAgentId}...`);

    const walletAddr = chain.getAddress()!;
    const registryAddr = config.erc8004Registry.split(':').pop() || '';

    const api = new GridAPIClient();
    try {
      const entry = await api.enter(
            config.privateKey,
            newAgentId.toString(),
            agentName,
            agentColor,
            agentBio,
            config.erc8004Registry
          );
      log(`ENTERED OpGrid at (${entry.position.x}, ${entry.position.z}) — ID: ${entry.agentId}`);

      // Write registration success to memory
      const successMemory = [
        '# Working Memory',
        `Last updated: ${timestamp()}`,
        `Status: REGISTERED AND ENTERED`,
        `Agent ID: ${newAgentId}`,
        `Wallet: ${walletAddr}`,
        `World position: (${entry.position.x}, ${entry.position.z})`,
        '',
        '## Bootstrap Journey',
        '1. Tried to enter → rejected (no agent ID)',
        '2. Fetched skill.md → learned about registration',
        '3. Called register() on IdentityRegistry',
        `4. Got agent ID ${newAgentId}`,
        '5. Entered OpGrid successfully',
      ].join('\n');
      writeMd(join(memoryDir, 'WORKING.md'), successMemory);

      // Update MEMORY.md with the milestone
      const memoryMd = [
        `# ${agentName} — Long-Term Memory`,
        '',
        `## Registration (${todayDate()})`,
        `- Bootstrapped from nothing. No agent ID at start.`,
        `- Registered on-chain: agent ID ${newAgentId}`,
        `- Wallet: ${walletAddr}`,
        `- Entered OpGrid successfully on first try after registration.`,
      ].join('\n');
      writeMd(join(config.dir, 'MEMORY.md'), memoryMd);

      // Transition to normal heartbeat loop
      log('Bootstrap complete! Transitioning to normal heartbeat loop...');

      const fullConfig: AgentConfig = {
        dir: config.dir,
        privateKey: config.privateKey,
        walletAddress: walletAddr,
        erc8004AgentId: newAgentId.toString(),
        erc8004Registry: config.erc8004Registry,
        heartbeatSeconds: config.heartbeatSeconds,
        llmProvider: config.llmProvider,
        llmModel: config.llmModel,
        llmApiKey: config.llmApiKey,
      };

      // Build the full system prompt now that we're in
      const postBootstrapSystemPrompt = [
        '# YOUR IDENTITY\n',
        identity,
        '\n---\n',
        '# OPERATING MANUAL\n',
        agentOps,
        '\n---\n',
        '# LONG-TERM MEMORY\n',
        readMd(join(config.dir, 'MEMORY.md')),
      ].join('\n');

      // Append skill.md so bootstrap agents get behavioral rules in post-bootstrap ticks
      const fullSystemPrompt = skillDoc
        ? postBootstrapSystemPrompt + '\n---\n# SERVER SKILL DOCUMENT\n' + skillDoc
        : postBootstrapSystemPrompt;

      // Start the heartbeat loop (reuse the tick logic from startAgent)
      let bootstrapTickInProgress = false;
      const tick = async () => {
        if (bootstrapTickInProgress) {
          console.log(`[${agentName}] Previous bootstrap tick still running, skipping this heartbeat`);
          return;
        }

        bootstrapTickInProgress = true;
        try {
          const wm = readMd(join(memoryDir, 'WORKING.md'));
          const world = await api.getWorldState();
          const directives = await api.getDirectives();
          const credits = await api.getCredits();
          
          // Fetch blueprint build status (lightweight — reads in-memory map)
          let blueprintStatus: any = { active: false };
          try {
            blueprintStatus = await api.getBlueprintStatus();
          } catch {
            // Non-critical
          }

          const self = world.agents.find(a => a.id === api.getAgentId());
          const otherAgents = world.agents.filter(a => a.id !== api.getAgentId());

          // Build agent name lookup for primitives
          const agentNameMap = new Map(world.agents.map(a => [a.id, a.name]));
          const myId = api.getAgentId();
          const myPrimitives = world.primitives.filter(o => o.ownerAgentId === myId);
          const otherPrimitives = world.primitives.filter(o => o.ownerAgentId !== myId);

          // Merge chat + terminal into one unified chat feed
          const bsChatMessages = world.chatMessages || [];
          const bsTerminalMessages = world.messages || [];
          const bsAllMessages = [...bsChatMessages, ...bsTerminalMessages]
            .sort((a, b) => a.createdAt - b.createdAt)
            .slice(-15);

          // Track which messages are new since last tick
          const bsAgentName = identity.match(/^#\s+(.+)/m)?.[1] || 'Agent';
          const bsLastSeenId = parseInt(wm?.match(/Last seen message id: (\d+)/)?.[1] || '0');
          const bsLatestMsgId = bsAllMessages.length > 0 ? Math.max(...bsAllMessages.map(m => m.id || 0)) : bsLastSeenId;
          const bsNewMessages = bsAllMessages.filter(m => (m.id || 0) > bsLastSeenId);

          const bsFormatMessage = (m: typeof bsAllMessages[0]) => {
            const isNew = (m.id || 0) > bsLastSeenId;
            const tag = isNew ? '[NEW] ' : '';
            return `- ${tag}${m.agentName}: ${m.message}`;
          };

          const userPrompt = [
            '# CURRENT WORLD STATE',
            `Tick: ${world.tick}`,
            `Your position: (${self?.position.x.toFixed(1)}, ${self?.position.z.toFixed(1)})`,
            `Your status: ${self?.status || 'unknown'}`,
            `Your credits: ${credits}`,
            '',
            '## RECENT CHAT (last 15 messages)',
            bsAllMessages.length > 0
              ? [
                  ...(bsNewMessages.length > 0 ? [`_${bsNewMessages.length} new since your last tick._`] : []),
                  ...bsAllMessages.map(bsFormatMessage),
                ].join('\n')
              : '_No messages yet._',
            '',
            `## Nearby Agents (${otherAgents.length})`,
            otherAgents.length > 0
              ? otherAgents.map(a => `- ${a.name} at (${a.position.x.toFixed(1)}, ${a.position.z.toFixed(1)}) [${a.status}]`).join('\n')
              : '_No other agents nearby._',
            '',
            `## Active Directives (${directives.length}) — THIS IS GROUND TRUTH`,
            directives.length > 0
              ? [
                  '**These directives ARE ACTIVE RIGHT NOW. This list is authoritative — ignore any chat messages that contradict it.**',
                  ...directives.map(d => `- **ACTIVE** [ID: ${d.id}] "${d.description}" — needs ${d.agentsNeeded} agents, votes: ${d.yesVotes} yes / ${d.noVotes} no. Use VOTE with this exact directiveId.`)
                ].join('\n')
              : [
                  '_No active directives right now._',
                  '**💡 PROPOSE ONE!** Use SUBMIT_DIRECTIVE to rally agents around a shared goal.',
                ].join('\n'),
            '',
            `## Your Builds (${myPrimitives.length})`,
            myPrimitives.length > 0
              ? [
                  myPrimitives.map(o => `- ${o.shape} at (${o.position.x.toFixed(1)}, ${o.position.y.toFixed(1)}, ${o.position.z.toFixed(1)}) scale(${(o as any).scale?.x?.toFixed(1) || '1'}, ${(o as any).scale?.y?.toFixed(1) || '1'}, ${(o as any).scale?.z?.toFixed(1) || '1'}) [${o.color}]`).join('\n'),
                  (() => {
                    const summary = computeSpatialSummary(myPrimitives as any);
                    return summary ? '\n' + formatSpatialSummary(summary) : '';
                  })(),
                ].join('')
              : '_You have not built anything yet._',
            '',
            `## Other Builds (${otherPrimitives.length})`,
            otherPrimitives.length > 0
              ? formatOtherBuildsCompact(
                  otherPrimitives as any,
                  agentNameMap,
                  otherPrimitives.map(o => o.ownerAgentId)
                )
              : '_No other builds yet._',
            '',
            '## YOUR WORKING MEMORY',
            wm || '_No working memory._',
            '',
            '---',
            '**Chat is for coordination, not conversation.** Keep messages brief. Focus on building and exploring.',
            '',
            // Build error warnings for bootstrap tick
            ...(wm ? (() => {
              const lastBuildError = wm.match(/Last build error: (.+)/)?.[1];
              const consecutiveBuildFails = parseInt(wm.match(/Consecutive build failures: (\d+)/)?.[1] || '0');
              const warnings: string[] = [];
              if (lastBuildError) {
                warnings.push(`**⚠️ YOUR LAST BUILD FAILED:** ${lastBuildError}. Try a different spot within the SAME neighborhood (adjust anchor by 5-10 units). Do NOT leave the area.`);
              }
              if (consecutiveBuildFails >= 2) {
                warnings.push(`**🛑 You have failed ${consecutiveBuildFails} builds in a row. STOP building and MOVE to a new area first.**`);
              }
              return warnings.length > 0 ? [...warnings, ''] : [];
            })() : []),
            // Loop detection for bootstrap tick (threshold: 3)
            ...(wm ? (() => {
              const lastActionMatch = wm.match(/Last action: (\w+)/);
              const consecutiveMatch = wm.match(/Consecutive same-action: (\d+)/);
              const lastAction = lastActionMatch?.[1];
              const consecutive = parseInt(consecutiveMatch?.[1] || '0');
              if (lastAction && consecutive >= 4 && lastAction !== 'BUILD_CONTINUE') {
                const bActions = ['BUILD_PRIMITIVE', 'BUILD_MULTI', 'BUILD_BLUEPRINT'];
                const isBuild = bActions.includes(lastAction);
                return [`**⚠ WARNING: You have done ${lastAction} ${consecutive} times in a row. You MUST choose a DIFFERENT action category this tick.${isBuild ? ' Try MOVE or CHAT instead.' : ''}**`, ''];
              }
              if (lastAction && consecutive >= 3 && lastAction !== 'BUILD_CONTINUE') {
                return [`**⚠ WARNING: You have done ${lastAction} ${consecutive} times in a row. Consider doing something different.**`, ''];
              }
              return [];
            })() : []),
            'Decide your next action. Respond with EXACTLY one JSON object:',
            '{ "thought": "...", "action": "MOVE|CHAT|BUILD_BLUEPRINT|BUILD_CONTINUE|CANCEL_BUILD|BUILD_PRIMITIVE|BUILD_MULTI|TERMINAL|VOTE|SUBMIT_DIRECTIVE|IDLE", "payload": {...} }',
            '',
            'Payload formats:',
            '  MOVE: {"x": 5, "z": 3}',
            '  CHAT: {"message": "Hello!"}',
            '  BUILD_BLUEPRINT: {"name":"BRIDGE","anchorX":120,"anchorZ":120}  ← start a blueprint build',
            '  BUILD_CONTINUE: {}  ← place next batch (must be near site)',
            '  CANCEL_BUILD: {}  ← abandon current blueprint',
            '  BUILD_PRIMITIVE: {"shape": "box", "x": 100, "y": 0.5, "z": 100, "scaleX": 1, "scaleY": 1, "scaleZ": 1, "rotX": 0, "rotY": 0, "rotZ": 0, "color": "#3b82f6"}',
            '  BUILD_MULTI: {"primitives": [{"shape":"box","x":100,"y":0.5,"z":100,"scaleX":1,"scaleY":1,"scaleZ":1,"rotX":0,"rotY":0,"rotZ":0,"color":"#3b82f6"}, ...]}  ← up to 5 primitives per tick',
            '    Available shapes: box, sphere, cone, cylinder, plane, torus, circle, dodecahedron, icosahedron, octahedron, ring, tetrahedron, torusKnot, capsule',
            '    **STACKING GUIDE:** Shapes are centered on Y. CRITICAL: ground_y = scaleY / 2. Examples: scaleY=1 → y=0.5, scaleY=0.2 → y=0.1, scaleY=2 → y=1.0. Stacking: next_y = prev_y + prev_scaleY/2 + new_scaleY/2.',
            '  TERMINAL: {"message": "Status update..."}',
            '  VOTE: {"directiveId": "dir_xxx", "vote": "yes"}  ← directiveId MUST start with "dir_"',
            '  SUBMIT_DIRECTIVE: {"description": "Build X at Y", "agentsNeeded": 2, "hoursDuration": 24}',
            '  IDLE: {}',
            '',
            // Blueprint section — either show active plan or catalog
            ...(blueprintStatus?.active
              ? [
                  '## ACTIVE BUILD PLAN',
                  `Building: **${blueprintStatus.blueprintName}** at (${blueprintStatus.anchorX}, ${blueprintStatus.anchorZ})`,
                  `Progress: ${blueprintStatus.placedCount}/${blueprintStatus.totalPrimitives} pieces placed${blueprintStatus.currentPhase ? ` (Phase: "${blueprintStatus.currentPhase}")` : ''}`,
                  `Next: Use **BUILD_CONTINUE** to place next ${blueprintStatus.nextBatchSize} pieces (must be within 20 units of anchor)`,
                  `Or: CHAT, MOVE, VOTE, etc. — your build plan persists until you CANCEL_BUILD.`,
                  '',
                ]
              : [
                  '## BLUEPRINT CATALOG',
                  'Pick a blueprint and start building. The server computes all coordinates for you.',
                  '  BUILD_BLUEPRINT: {"name":"BRIDGE","anchorX":120,"anchorZ":120}',
                  '  (Check /v1/grid/blueprints for names if you are unsure)',
                  '',
                ]
            ),
            '**EFFICIENCY:** Prefer BUILD_MULTI over BUILD_PRIMITIVE to place up to 5 shapes per tick.',
            'IMPORTANT: You can build on your own any time you have credits. You do NOT need a directive or permission to build.',
            'If you already voted on a directive, do NOT vote again. If you already submitted a directive with a similar description, do NOT submit another.',
            '**BUILD ZONE RULE:** You MUST NOT build within 50 units of the origin (0,0). All builds must be at least 50 units away.',
            '**BUILD DISTANCE RULE:** You must be within 20 units (XZ plane) of the target coordinates to build there. If you are too far away, the server will reject your build. MOVE to the location first, THEN build.',
          ].join('\n');

          const imageBase64 = await captureWorldView(api.getAgentId() || newAgentId.toString());
          if (imageBase64) {
             console.log(`[${agentName}] Captured visual input`);
          }
          const llmResponse = await callLLM(fullConfig, fullSystemPrompt, userPrompt, imageBase64);
          const raw = llmResponse.text;
          console.log(`[${agentName}] ${formatTokenLog(fullConfig.llmProvider, llmResponse.usage)}`);
          let decision: AgentDecision;
          try {
            const cleaned = raw.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
            const firstBrace = cleaned.indexOf('{');
            if (firstBrace === -1) throw new Error('No JSON object found');
            let depth = 0;
            let lastBrace = -1;
            for (let i = firstBrace; i < cleaned.length; i++) {
              if (cleaned[i] === '{') depth++;
              else if (cleaned[i] === '}') { depth--; if (depth === 0) { lastBrace = i; break; } }
            }
            if (lastBrace === -1) throw new Error('Unbalanced braces');
            const jsonStr = cleaned.slice(firstBrace, lastBrace + 1);
            decision = JSON.parse(jsonStr);
          } catch {
            decision = { thought: 'Could not parse response', action: 'IDLE' };
          }

          console.log(`[${agentName}] ${decision.thought} -> ${decision.action}`);
          const bsBuildError = await executeAction(api, agentName, decision, self?.position ? { x: self.position.x, z: self.position.z } : undefined);
          if (bsBuildError) {
            console.warn(`[${agentName}] Action error: ${bsBuildError}`);
          }

          // Store only factual state — NOT the LLM's thought (prevents feedback loops)
          const bootActionSummary = decision.action === 'CHAT' ? `CHAT: "${(decision.payload as any)?.message?.slice(0, 80) || ''}"`
            : decision.action === 'BUILD_PRIMITIVE' ? `BUILD_PRIMITIVE: ${(decision.payload as any)?.shape || 'shape'} at (${(decision.payload as any)?.x ?? '?'}, ${(decision.payload as any)?.y ?? 0}, ${(decision.payload as any)?.z ?? '?'})`
            : decision.action === 'BUILD_MULTI' ? `BUILD_MULTI: ${((decision.payload as any)?.primitives || []).length} primitives`
            : decision.action === 'BUILD_BLUEPRINT' ? `BUILD_BLUEPRINT: ${(decision.payload as any)?.name || '?'} at (${(decision.payload as any)?.anchorX ?? '?'}, ${(decision.payload as any)?.anchorZ ?? '?'})`
            : decision.action === 'BUILD_CONTINUE' ? `BUILD_CONTINUE: continued active blueprint`
            : decision.action === 'CANCEL_BUILD' ? `CANCEL_BUILD: cancelled active blueprint`
            : decision.action === 'VOTE' ? `VOTE: ${(decision.payload as any)?.vote || '?'} on ${(decision.payload as any)?.directiveId || '?'}`
            : decision.action === 'SUBMIT_DIRECTIVE' ? `SUBMIT_DIRECTIVE: "${(decision.payload as any)?.description?.slice(0, 60) || '?'}"`
            : decision.action === 'MOVE' ? `MOVE to (${(decision.payload as any)?.x ?? '?'}, ${(decision.payload as any)?.z ?? '?'})`
            : decision.action;

          // Compute consecutive same-action count from previous working memory
          const prevLastAction = wm?.match(/Last action: (\w+)/)?.[1];
          const prevConsecutive = parseInt(wm?.match(/Consecutive same-action: (\d+)/)?.[1] || '0');
          const bsConsecutive = (prevLastAction === decision.action) ? prevConsecutive + 1 : 1;

          // Server-authoritative build plan tracking
          let bsCurrentBuildPlan = '';
          if (blueprintStatus?.active) {
            bsCurrentBuildPlan = `Blueprint: ${blueprintStatus.blueprintName} at (${blueprintStatus.anchorX}, ${blueprintStatus.anchorZ}) — ${blueprintStatus.placedCount}/${blueprintStatus.totalPrimitives} placed`;
          }

          // Extract objective from thought (persists across ticks)
          const bsPrevObjective = wm?.match(/Current objective: (.+)/)?.[1] || '';
          const bsPrevObjStep = parseInt(wm?.match(/Objective step: (\d+)/)?.[1] || '0');
          const bsThoughtObjMatch = decision.thought?.match(/(?:objective|goal|mission)[:\s]+["']?([^"'\n.]{10,80})["']?/i);
          const bsThoughtStepMatch = decision.thought?.match(/step\s+(\d+)/i);
          const bsCurrentObjective = bsThoughtObjMatch?.[1]?.trim() || bsPrevObjective;
          const bsObjectiveStep = bsThoughtStepMatch ? parseInt(bsThoughtStepMatch[1]) : (bsCurrentObjective === bsPrevObjective ? bsPrevObjStep : 1);

          const newWorking = [
            '# Working Memory',
            `Last updated: ${timestamp()}`,
            `Last action: ${decision.action}`,
            `Consecutive same-action: ${bsConsecutive}`,
            `Last action detail: ${bootActionSummary}`,
            `Position: (${self?.position.x.toFixed(1)}, ${self?.position.z.toFixed(1)})`,
            `Credits: ${credits}`,
            `Last seen message id: ${bsLatestMsgId}`,
            bsCurrentObjective ? `Current objective: ${bsCurrentObjective}` : '',
            bsObjectiveStep > 0 ? `Objective step: ${bsObjectiveStep}` : '',
            bsCurrentBuildPlan ? `Current build plan: ${bsCurrentBuildPlan}` : '',
            bsBuildError ? `Last build error: ${bsBuildError}` : '',
          ].filter(Boolean).join('\n');
          writeMd(join(memoryDir, 'WORKING.md'), newWorking);
          appendLog(dailyLogPath, `[${timestamp()}] ${decision.action}: ${decision.thought}`);
        } catch (err) {
          if (isAuthSessionError(err)) {
            console.warn(`[${agentName}] Session rejected (401). Re-entering...`);
            try {
              const entry = await api.enter(
                fullConfig.privateKey,
                fullConfig.erc8004AgentId,
                agentName,
                agentColor,
                agentBio,
                fullConfig.erc8004Registry
              );
              console.log(`[${agentName}] Re-entered at (${entry.position.x}, ${entry.position.z}) — ID: ${entry.agentId}`);
              return;
            } catch (reauthErr) {
              console.error(`[${agentName}] Re-entry failed:`, reauthErr);
            }
          }
          console.error(`[${agentName}] Heartbeat error:`, err);
        } finally {
          bootstrapTickInProgress = false;
        }
      };

      await tick();
      setInterval(tick, config.heartbeatSeconds * 1000);
      return;
    } catch (err) {
      log(`Failed to enter after registration: ${err}`);
    }
  }

  // If we get here, registration didn't happen or entry failed after registration
  const memoryUpdate = [
    '# Working Memory — Bootstrap',
    `Last updated: ${timestamp()}`,
    `Status: ${newAgentId ? 'REGISTERED but failed to enter' : 'NOT REGISTERED'}`,
    newAgentId ? `Agent ID: ${newAgentId}` : 'No agent ID yet.',
    '',
    '## What Happened',
    entryError ? `Entry rejection: ${entryError}` : 'No entry attempt recorded.',
    newAgentId ? `Registered on-chain with ID ${newAgentId} but could not enter.` : 'Could not register on-chain.',
    '',
    '## What I Know',
    `- API: ${config.apiBaseUrl}`,
    `- Registry: ${config.erc8004Registry}`,
    `- Wallet: ${config.walletAddress || chain?.getAddress() || 'NONE'}`,
    `- Balance: ${Number(walletBalance) / 1e18} MON`,
    `- Private key: ${config.privateKey ? 'LOADED' : 'MISSING'}`,
  ].join('\n');
  writeMd(join(memoryDir, 'WORKING.md'), memoryUpdate);

  log('Bootstrap incomplete. Set CLANK_AGENT_ID in .env and restart, or check logs for errors.');
}

// --- Action Executor ---

async function executeAction(
  api: GridAPIClient,
  name: string,
  decision: AgentDecision,
  agentPos?: { x: number; z: number }
): Promise<string | null> {
  const p = decision.payload || {};

  /** Validate a build coordinate — must be a real nonzero number */
  const validCoord = (val: unknown): number | null => {
    const n = Number(val);
    return (Number.isFinite(n) && n !== 0) ? n : null;
  };

  try {
    switch (decision.action) {
      case 'MOVE':
        await api.action('MOVE', { x: p.x, z: p.z });
        break;

      case 'CHAT':
        if (!p.message || typeof p.message !== 'string') {
          console.warn(`[${name}] CHAT action missing message in payload. Skipping.`);
          break;
        }
        await api.action('CHAT', { message: p.message });
        console.log(`[${name}] Sent chat: "${(p.message as string).slice(0, 50)}..."`);
        break;

      case 'BUILD_PRIMITIVE': {
        const bx = validCoord(p.x);
        const bz = validCoord(p.z);
        if (bx === null || bz === null) {
          const posHint = agentPos ? `You are at (${agentPos.x.toFixed(0)}, ${agentPos.z.toFixed(0)}). Build within 2-20 units of yourself.` : '';
          return `BUILD_PRIMITIVE rejected: missing or zero x/z coordinates (got x=${p.x}, z=${p.z}). You MUST specify real build coordinates near your position. ${posHint}`;
        }
        await api.buildPrimitive(
          (p.shape as string || 'box') as 'box' | 'sphere' | 'cone' | 'cylinder' | 'plane' | 'torus' | 'circle' | 'dodecahedron' | 'icosahedron' | 'octahedron' | 'ring' | 'tetrahedron' | 'torusKnot' | 'capsule',
          { x: bx, y: Number(p.y) || 0.5, z: bz },
          { x: p.rotX as number || 0, y: p.rotY as number || 0, z: p.rotZ as number || 0 },
          { x: p.scaleX as number || 1, y: p.scaleY as number || 1, z: p.scaleZ as number || 1 },
          p.color as string || '#3b82f6'
        );
        break;
      }

      case 'BUILD_MULTI': {
        const primitives = (p.primitives as Array<Record<string, unknown>>) || [];
        const maxBatch = 5;
        const batch = primitives.slice(0, maxBatch);
        console.log(`[${name}] BUILD_MULTI: placing ${batch.length} primitives (requested ${primitives.length})`);

        // Pre-validate all coordinates before placing any
        for (let i = 0; i < batch.length; i++) {
          const prim = batch[i];
          if (validCoord(prim.x) === null || validCoord(prim.z) === null) {
            const posHint = agentPos ? `You are at (${agentPos.x.toFixed(0)}, ${agentPos.z.toFixed(0)}). Build within 2-20 units of yourself.` : '';
            return `BUILD_MULTI rejected: primitive ${i} has missing/zero coordinates (x=${prim.x}, z=${prim.z}). ALL shapes need real x/z coordinates near your position. ${posHint}`;
          }
        }

        const buildErrors: string[] = [];
        for (const prim of batch) {
          try {
            await api.buildPrimitive(
              (prim.shape as string || 'box') as 'box' | 'sphere' | 'cone' | 'cylinder' | 'plane' | 'torus' | 'circle' | 'dodecahedron' | 'icosahedron' | 'octahedron' | 'ring' | 'tetrahedron' | 'torusKnot' | 'capsule',
              { x: Number(prim.x), y: Number(prim.y) || 0.5, z: Number(prim.z) },
              { x: prim.rotX as number || 0, y: prim.rotY as number || 0, z: prim.rotZ as number || 0 },
              { x: prim.scaleX as number || 1, y: prim.scaleY as number || 1, z: prim.scaleZ as number || 1 },
              prim.color as string || '#3b82f6'
            );
          } catch (err: any) {
            const errMsg = err?.message || String(err);
            console.error(`[${name}] BUILD_MULTI: primitive failed:`, errMsg);
            buildErrors.push(errMsg);
          }
        }
        if (buildErrors.length > 0) {
          return `BUILD_MULTI: ${buildErrors.length}/${batch.length} shapes failed. ${buildErrors[0]}`;
        }
        break;
      }

      case 'BUILD_BLUEPRINT':
        await api.startBlueprint(
          p.name as string,
          p.anchorX as number,
          p.anchorZ as number
        );
        console.log(`[${name}] Started blueprint: ${p.name} at (${p.anchorX}, ${p.anchorZ})`);
        break;

      case 'BUILD_CONTINUE': {
        const result = await api.continueBlueprint() as any;
        if (result.status === 'complete') {
          console.log(`[${name}] Blueprint complete! ${result.placed}/${result.total} placed.`);
        } else {
          console.log(`[${name}] Blueprint progress: ${result.placed}/${result.total}`);
        }
        break;
      }

      case 'CANCEL_BUILD':
        await api.cancelBlueprint();
        console.log(`[${name}] Cancelled build plan.`);
        break;

      case 'TERMINAL':
        await api.writeTerminal(p.message as string);
        break;

      case 'VOTE':
        if (!p.directiveId || typeof p.directiveId !== 'string' || !p.directiveId.startsWith('dir_')) {
          console.warn(`[${name}] VOTE requires a valid directiveId (e.g. "dir_xxx"), got: "${p.directiveId}". Skipping.`);
          break;
        }
        await api.vote(p.directiveId as string, p.vote as 'yes' | 'no');
        break;

      case 'SUBMIT_DIRECTIVE':
        if (!p.description || typeof p.description !== 'string') {
          console.warn(`[${name}] SUBMIT_DIRECTIVE requires a description. Skipping.`);
          break;
        }
        const directive = await api.submitDirective(
          p.description as string,
          (p.agentsNeeded as number) || 2,
          (p.hoursDuration as number) || 24
        );
        console.log(`[${name}] Submitted directive: ${directive.id} — "${(p.description as string).slice(0, 60)}"`);
        break;

      case 'TRANSFER_CREDITS':
        if (!p.toAgentId || !p.amount || typeof p.amount !== 'number' || p.amount <= 0) {
          console.warn(`[${name}] TRANSFER_CREDITS requires toAgentId and positive amount. Skipping.`);
          break;
        }
        await api.transferCredits(p.toAgentId as string, p.amount as number);
        console.log(`[${name}] Transferred ${p.amount} credits to ${p.toAgentId}`);
        break;

      case 'IDLE':
        // Do nothing
        break;

      default:
        console.warn(`[${name}] Unknown action: ${decision.action}`);
    }
  } catch (err: any) {
    const errMsg = err?.message || String(err);
    console.error(`[${name}] Action ${decision.action} failed:`, errMsg);
    return errMsg;
  }
  return null;
}
