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
import { join } from 'path';
import { GridAPIClient } from './api-client.js';
import { ChainClient } from './chain-client.js';
import { captureWorldView } from './vision.js';

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

interface SettlementNode {
  center: { x: number; z: number };
  count: number;
  radius: number;
  structures: string[];
}

function computeSettlementNodes(primitives: PrimitiveData[]): SettlementNode[] {
  if (primitives.length === 0) return [];

  // Grid-based clustering with 30-unit cells
  const cellSize = 30;
  const cellMap = new Map<string, { xs: number[]; zs: number[]; shapes: string[] }>();
  for (const p of primitives) {
    const cx = Math.floor(p.position.x / cellSize);
    const cz = Math.floor(p.position.z / cellSize);
    const key = `${cx},${cz}`;
    if (!cellMap.has(key)) cellMap.set(key, { xs: [], zs: [], shapes: [] });
    const cell = cellMap.get(key)!;
    cell.xs.push(p.position.x);
    cell.zs.push(p.position.z);
    cell.shapes.push(p.shape);
  }

  return Array.from(cellMap.values()).map(cell => {
    const centerX = cell.xs.reduce((a, b) => a + b, 0) / cell.xs.length;
    const centerZ = cell.zs.reduce((a, b) => a + b, 0) / cell.zs.length;
    const maxDist = Math.max(...cell.xs.map(x => Math.abs(x - centerX)), ...cell.zs.map(z => Math.abs(z - centerZ)), 1);
    return {
      center: { x: centerX, z: centerZ },
      count: cell.xs.length,
      radius: Math.ceil(maxDist),
      structures: [...new Set(cell.shapes)],
    };
  }).sort((a, b) => b.count - a.count);
}

function formatSettlementMap(nodes: SettlementNode[], agentPos: { x: number; z: number }): string {
  if (nodes.length === 0) return '## Settlement Map\n_No settlements yet. You can start the first node! Pick a spot 50+ units from origin._';

  const lines = ['## Settlement Map'];
  let activeNode: SettlementNode | null = null;
  let activeNodeDist = Infinity;

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const dx = node.center.x - agentPos.x;
    const dz = node.center.z - agentPos.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    const status = node.count >= 5 ? 'established' : 'growing';
    lines.push(`- **Node ${i + 1}** at (${node.center.x.toFixed(0)}, ${node.center.z.toFixed(0)}) — ${node.count} structures, ${status} | types: ${node.structures.join(', ')} | ${dist.toFixed(0)}u away`);
    if (dist < activeNodeDist) {
      activeNodeDist = dist;
      activeNode = node;
    }
  }

  if (activeNode) {
    if (activeNode.count >= 5) {
      lines.push(`\n**Active node** at (${activeNode.center.x.toFixed(0)}, ${activeNode.center.z.toFixed(0)}) is established (${activeNode.count} structures). Consider connecting it to another node with a BRIDGE, or start a new node 50-100 units away.`);
    } else {
      lines.push(`\n**Active node** at (${activeNode.center.x.toFixed(0)}, ${activeNode.center.z.toFixed(0)}) needs more structures (${activeNode.count}/5). Build within 30 units of it to fill it out.`);
    }
  }

  return lines.join('\n');
}

// --- LLM Calls ---

async function callGemini(apiKey: string, model: string, systemPrompt: string, userPrompt: string, imageBase64?: string | null): Promise<string> {
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
  };
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
}

async function callAnthropic(apiKey: string, model: string, systemPrompt: string, userPrompt: string, imageBase64?: string | null): Promise<string> {
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
  };
  return data.content?.[0]?.text || '{}';
}

async function callOpenAI(apiKey: string, model: string, systemPrompt: string, userPrompt: string, imageBase64?: string | null): Promise<string> {
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
  };
  return data.choices?.[0]?.message?.content || '{}';
}

async function callMinimax(apiKey: string, model: string, systemPrompt: string, userPrompt: string): Promise<string> {
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
  };
  return data.choices?.[0]?.message?.content || '{}';
}

interface LLMConfig {
  llmProvider: 'gemini' | 'anthropic' | 'openai' | 'minimax';
  llmModel: string;
  llmApiKey: string;
}

async function callLLM(config: LLMConfig, systemPrompt: string, userPrompt: string, imageBase64?: string | null): Promise<string> {
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
    // If wallet doesn't own the configured agent ID, register a new one
    if (errMsg.includes('403') && config.privateKey) {
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
      console.error(`[${agentName}] Make sure wallet ${config.walletAddress} owns agent ID ${config.erc8004AgentId} on-chain.`);
      return;
    }
  }

  if (!enteredOk) return;

  // Reset working memory on startup — agents should NOT resume from stale state
  const freshMemory = [
    '# Working Memory',
    `Last updated: ${timestamp()}`,
    `Session started: ${timestamp()}`,
    `Last action: NONE`,
    `Consecutive same-action: 0`,
    `Last action detail: Just entered the world — fresh session`,
    `Last seen message id: 0`,
  ].join('\n');
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

  // --- Heartbeat Loop ---
  console.log(`[${agentName}] Heartbeat started (every ${config.heartbeatSeconds}s)`);

  const tick = async () => {
    try {
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
        .slice(-20);

      // Track which messages are new since last tick
      const lastSeenId = parseInt(workingMemory?.match(/Last seen message id: (\d+)/)?.[1] || '0');
      const latestMsgId = allChatMessages.length > 0 ? Math.max(...allChatMessages.map(m => m.id || 0)) : lastSeenId;
      const newMessages = allChatMessages.filter(m => (m.id || 0) > lastSeenId);
      const mentionedInNew = newMessages.some(m =>
        m.message.toLowerCase().includes(agentName.toLowerCase()) && m.agentId !== api.getAgentId()
      );

      // Format messages with NEW tags
      const formatMessage = (m: typeof allChatMessages[0]) => {
        const isNew = (m.id || 0) > lastSeenId;
        const isMention = isNew && m.message.toLowerCase().includes(agentName.toLowerCase()) && m.agentId !== api.getAgentId();
        const tag = isMention ? '[NEW — YOU WERE MENTIONED] ' : isNew ? '[NEW] ' : '';
        return `- ${tag}${m.agentName}: ${m.message}`;
      };

      const userPrompt = [
        '# CURRENT WORLD STATE',
        `Tick: ${world.tick}`,
        `Your position: (${self?.position.x.toFixed(1)}, ${self?.position.z.toFixed(1)})`,
        `Your status: ${self?.status || 'unknown'}`,
        `Your credits: ${credits}`,
        '',
        '## GROUP CHAT (this is a live conversation between all agents — read it like a group chat)',
        '**HOW TO TALK:** This is a group chat. Talk like a person. Ask questions, react to others, share ideas. Don\'t just narrate what you see.',
        allChatMessages.length > 0
          ? [
              ...(newMessages.length > 0 ? [
                `**${newMessages.length} new message(s) since your last tick.${mentionedInNew ? ' Someone mentioned you — respond!' : ''}**`,
                '**INSTRUCTION: Someone said something new. Read it, react to it, and engage. Don\'t just state what YOU are doing — respond to THEM.**',
                '**BAD:** "I observe the grid is growing. I shall build a tree."',
                '**GOOD:** "Nice builds over there! I\'m gonna add a tree nearby, any objections?"'
              ] : []),
              ...allChatMessages.map(formatMessage),
            ].join('\n')
          : '_No messages yet. Say hello!_',
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
              ...directives.map(d => `- **ACTIVE** [ID: ${d.id}] "${d.description}" — needs ${d.agentsNeeded} agents, votes so far: ${d.yesVotes} yes / ${d.noVotes} no. Use VOTE with this exact directiveId to vote.`)
            ].join('\n')
          : '_No active directives right now. If the TERMINAL mentions a past directive proposal, it may have already expired. Only directives listed HERE are voteable._',
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
        // Settlement Map — graph/node view of all world builds
        (() => {
          const allPrims = world.primitives as PrimitiveData[];
          const myPos = self?.position || { x: 0, z: 0 };
          const nodes = computeSettlementNodes(allPrims);
          return formatSettlementMap(nodes, myPos);
        })(),
        '',
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
        // Build error warnings — surface failures prominently
        ...(workingMemory ? (() => {
          const lastBuildError = workingMemory.match(/Last build error: (.+)/)?.[1];
          const consecutiveBuildFails = parseInt(workingMemory.match(/Consecutive build failures: (\d+)/)?.[1] || '0');
          const warnings: string[] = [];
          if (lastBuildError) {
            warnings.push(`**⚠️ YOUR LAST BUILD FAILED:** ${lastBuildError}. Try a different spot within the SAME neighborhood (adjust anchor by 5-10 units). Do NOT leave the area.`);
          }
          if (consecutiveBuildFails >= 2) {
            warnings.push(`**🛑 You have failed ${consecutiveBuildFails} builds in a row. STOP building and MOVE to a new area first.**`);
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
        'Decide your next action. Respond with EXACTLY one JSON object:',
        '{ "thought": "...", "action": "MOVE|CHAT|BUILD_BLUEPRINT|BUILD_CONTINUE|CANCEL_BUILD|BUILD_PRIMITIVE|BUILD_MULTI|TERMINAL|VOTE|SUBMIT_DIRECTIVE|TRANSFER_CREDITS|IDLE", "payload": {...} }',
        '',
        'Payload formats:',
        '  MOVE: {"x": 5, "z": 3}',
        '  CHAT: {"message": "Hello!"}',
        '  BUILD_BLUEPRINT: {"name":"BRIDGE","anchorX":120,"anchorZ":120}  ← start a blueprint build (server computes all coordinates)',
        '  BUILD_CONTINUE: {}  ← place next batch from your active blueprint (must be near site)',
        '  CANCEL_BUILD: {}  ← abandon current blueprint (placed pieces stay)',
        '  BUILD_PRIMITIVE: {"shape": "cylinder", "x": 100, "y": 1, "z": 100, "scaleX": 2, "scaleY": 2, "scaleZ": 2, "rotX": 0, "rotY": 0, "rotZ": 0, "color": "#3b82f6"}',
        '  BUILD_MULTI: {"primitives": [{"shape":"cylinder","x":100,"y":1,"z":100,"scaleX":1,"scaleY":2,"scaleZ":1,"color":"#3b82f6"},{"shape":"cone","x":100,"y":3,"z":100,"scaleX":2,"scaleY":2,"scaleZ":2,"color":"#f59e0b"}]}  ← up to 5 per tick',
        '    Available shapes: box, sphere, cone, cylinder, plane, torus, dodecahedron, icosahedron, octahedron, torusKnot, capsule',
        '  TRANSFER_CREDITS: {"toAgentId": "agent_xxx", "amount": 25}  ← send credits to another agent',
        '    **USE VARIETY:** Do NOT just build boxes. Use cylinders for pillars, cones for roofs, spheres for decorations, torus for rings/arches.',
        '    **STACKING GUIDE:** Shapes are centered on Y. CRITICAL: ground_y = scaleY / 2. Examples: scaleY=1 → y=0.5, scaleY=0.2 → y=0.1, scaleY=2 → y=1.0. Stacking: next_y = prev_y + prev_scaleY/2 + new_scaleY/2.',
        '  TERMINAL: {"message": "Status update..."}',
        '  VOTE: {"directiveId": "dir_xxx", "vote": "yes"}  ← directiveId MUST start with "dir_"',
        '  SUBMIT_DIRECTIVE: {"description": "Build X at Y", "agentsNeeded": 2, "hoursDuration": 24}',
        '  IDLE: {}',
        '',
        '**EFFICIENCY:** Use BUILD_BLUEPRINT for structures from the catalog (recommended — server handles coordinate math). Use BUILD_MULTI for custom/freehand shapes (up to 5 per tick).',
        'IMPORTANT: You can build on your own any time you have credits. You do NOT need a directive or permission to build. Directives are ONLY for organizing group projects with other agents.',
        'If you already voted on a directive, do NOT vote again. If you already submitted a directive with a similar description, do NOT submit another.',
        '**BUILD ZONE RULE:** You MUST NOT build within 50 units of the origin (0,0). The area around origin is reserved for the system terminal. All builds must be at least 50 units away (e.g., x=60, z=70). Builds closer than 50 units will be REJECTED by the server.',
        '**BUILD DISTANCE RULE:** You must be within 20 units (XZ plane) of the target coordinates to build there. If you are too far away, the server will reject your build with an error. MOVE to the location first, THEN build.',
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
              '',
              ...Object.entries(blueprints).map(([name, bp]: [string, any]) =>
                `- **${name}** — ${bp.description} | ${bp.totalPrimitives} pieces, ~${Math.ceil(bp.totalPrimitives / 5)} ticks | ${bp.difficulty}`
              ),
              '',
              (() => {
                const allPrims = world.primitives as PrimitiveData[];
                const myPos = self?.position || { x: 0, z: 0 };
                const nodes = computeSettlementNodes(allPrims);
                if (nodes.length > 0) {
                  const nearest = nodes.reduce((best, n) => {
                    const d = Math.sqrt((n.center.x - myPos.x) ** 2 + (n.center.z - (myPos as any).z) ** 2);
                    const bestD = Math.sqrt((best.center.x - myPos.x) ** 2 + (best.center.z - (myPos as any).z) ** 2);
                    return d < bestD ? n : best;
                  });
                  if (nearest.count >= 5) {
                    return `**Nearest settlement node is at (${nearest.center.x.toFixed(0)}, ${nearest.center.z.toFixed(0)}) with ${nearest.count} structures.** Build within 30 units of it, or connect it to another node with a BRIDGE.`;
                  }
                  return `**Nearest settlement node is at (${nearest.center.x.toFixed(0)}, ${nearest.center.z.toFixed(0)}) with ${nearest.count} structures.** Build within 30 units of it to grow this neighborhood.`;
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

      const raw = await callLLM(config, fullSystemPrompt, userPrompt, imageBase64);
      let decision: AgentDecision;
      try {
        // Extract JSON from response (handle markdown code fences)
        const jsonStr = raw.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        decision = JSON.parse(jsonStr);
      } catch {
        console.warn(`[${agentName}] Failed to parse LLM response, idling. Raw: ${raw.slice(0, 200)}`);
        decision = { thought: 'Could not parse response', action: 'IDLE' };
      }

      // 6. Execute action
      console.log(`[${agentName}] ${decision.thought} -> ${decision.action}`);
      const buildError = await executeAction(api, agentName, decision);
      if (buildError) {
        console.warn(`[${agentName}] Action error: ${buildError}`);
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

      // Track consecutive build failures
      const prevBuildFails = parseInt(workingMemory?.match(/Consecutive build failures: (\d+)/)?.[1] || '0');
      const buildActions = ['BUILD_PRIMITIVE', 'BUILD_MULTI', 'BUILD_BLUEPRINT', 'BUILD_CONTINUE'];
      const wasBuildAction = buildActions.includes(decision.action);
      const consecutiveBuildFails = wasBuildAction && buildError ? prevBuildFails + 1 : wasBuildAction && !buildError ? 0 : prevBuildFails;

      // Track build plan across ticks
      const prevBuildPlan = workingMemory?.match(/Current build plan: (.+)/)?.[1] || '';
      let currentBuildPlan = prevBuildPlan;
      
      // Server-authoritative build status
      if (blueprintStatus?.active) {
        currentBuildPlan = `Blueprint: ${blueprintStatus.blueprintName} at (${blueprintStatus.anchorX}, ${blueprintStatus.anchorZ}) — ${blueprintStatus.placedCount}/${blueprintStatus.totalPrimitives} placed`;
      } else {
        currentBuildPlan = ''; // Clear if server says no active plan
      }

      const newWorking = [
        `# Working Memory`,
        `Last updated: ${timestamp()}`,
        `Last action: ${decision.action}`,
        `Consecutive same-action: ${consecutive}`,
        `Last action detail: ${actionSummary}`,
        `Position: (${self?.position.x.toFixed(1)}, ${self?.position.z.toFixed(1)})`,
        `Credits: ${credits}`,
        `Last seen message id: ${latestMsgId}`,
        currentBuildPlan ? `Current build plan: ${currentBuildPlan}` : '',
        votedOn ? `Voted on: ${votedOn}` : '',
        submittedDirectives ? `Submitted directives: ${submittedDirectives}` : '',
        buildError ? `Last build error: ${buildError}` : '',
        consecutiveBuildFails > 0 ? `Consecutive build failures: ${consecutiveBuildFails}` : '',
      ].filter(Boolean).join('\n');
      writeMd(join(memoryDir, 'WORKING.md'), newWorking);

      // 8. Append to daily log
      const dailyLogPath = join(memoryDir, `${todayDate()}.md`);
      if (!existsSync(dailyLogPath)) {
        writeMd(dailyLogPath, `# Daily Log — ${todayDate()}\n\n`);
      }
      appendLog(dailyLogPath, `[${timestamp()}] ${decision.action}: ${decision.thought}`);

    } catch (err) {
      console.error(`[${agentName}] Heartbeat error:`, err);
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
    const raw = await callLLM(config, systemPrompt, bootstrapPrompt);
    const jsonStr = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
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
      const tick = async () => {
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
            .slice(-20);

          // Track which messages are new since last tick
          const bsAgentName = identity.match(/^#\s+(.+)/m)?.[1] || 'Agent';
          const bsLastSeenId = parseInt(wm?.match(/Last seen message id: (\d+)/)?.[1] || '0');
          const bsLatestMsgId = bsAllMessages.length > 0 ? Math.max(...bsAllMessages.map(m => m.id || 0)) : bsLastSeenId;
          const bsNewMessages = bsAllMessages.filter(m => (m.id || 0) > bsLastSeenId);
          const bsMentioned = bsNewMessages.some(m =>
            m.message.toLowerCase().includes(bsAgentName.toLowerCase()) && m.agentId !== api.getAgentId()
          );

          const bsFormatMessage = (m: typeof bsAllMessages[0]) => {
            const isNew = (m.id || 0) > bsLastSeenId;
            const isMention = isNew && m.message.toLowerCase().includes(bsAgentName.toLowerCase()) && m.agentId !== api.getAgentId();
            const tag = isMention ? '[NEW — YOU WERE MENTIONED] ' : isNew ? '[NEW] ' : '';
            return `- ${tag}${m.agentName}: ${m.message}`;
          };

          const userPrompt = [
            '# CURRENT WORLD STATE',
            `Tick: ${world.tick}`,
            `Your position: (${self?.position.x.toFixed(1)}, ${self?.position.z.toFixed(1)})`,
            `Your status: ${self?.status || 'unknown'}`,
            `Your credits: ${credits}`,
            '',
            '## GROUP CHAT (this is a live conversation between all agents — read it like a group chat)',
            bsAllMessages.length > 0
              ? [
                  ...(bsNewMessages.length > 0 ? [`**${bsNewMessages.length} new message(s) since your last tick.${bsMentioned ? ' Someone mentioned you — respond!' : ''}**`] : []),
                  ...bsAllMessages.map(bsFormatMessage),
                ].join('\n')
              : '_No messages yet. Say hello!_',
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
              : '_No active directives right now._',
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
            '**HOW TO TALK:** The GROUP CHAT above is a live conversation. Messages tagged [NEW] arrived since your last tick. If you see [NEW — YOU WERE MENTIONED], someone is talking to you — reply via CHAT. You are in a group chat with other agents. Talk like a person, not a robot.',
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
          const raw = await callLLM(fullConfig, fullSystemPrompt, userPrompt, imageBase64);
          let decision: AgentDecision;
          try {
            const jsonStr = raw.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
            decision = JSON.parse(jsonStr);
          } catch {
            decision = { thought: 'Could not parse response', action: 'IDLE' };
          }

          console.log(`[${agentName}] ${decision.thought} -> ${decision.action}`);
          const bsBuildError = await executeAction(api, agentName, decision);
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

          const newWorking = [
            '# Working Memory',
            `Last updated: ${timestamp()}`,
            `Last action: ${decision.action}`,
            `Consecutive same-action: ${bsConsecutive}`,
            `Last action detail: ${bootActionSummary}`,
            `Position: (${self?.position.x.toFixed(1)}, ${self?.position.z.toFixed(1)})`,
            `Credits: ${credits}`,
            `Last seen message id: ${bsLatestMsgId}`,
            bsCurrentBuildPlan ? `Current build plan: ${bsCurrentBuildPlan}` : '',
            bsBuildError ? `Last build error: ${bsBuildError}` : '',
          ].filter(Boolean).join('\n');
          writeMd(join(memoryDir, 'WORKING.md'), newWorking);
          appendLog(dailyLogPath, `[${timestamp()}] ${decision.action}: ${decision.thought}`);
        } catch (err) {
          console.error(`[${agentName}] Heartbeat error:`, err);
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

async function executeAction(api: GridAPIClient, name: string, decision: AgentDecision): Promise<string | null> {
  const p = decision.payload || {};

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

      case 'BUILD_PRIMITIVE':
        await api.buildPrimitive(
          (p.shape as string || 'box') as 'box' | 'sphere' | 'cone' | 'cylinder' | 'plane' | 'torus' | 'circle' | 'dodecahedron' | 'icosahedron' | 'octahedron' | 'ring' | 'tetrahedron' | 'torusKnot' | 'capsule',
          { x: p.x as number || 0, y: p.y as number || 0, z: p.z as number || 0 },
          { x: p.rotX as number || 0, y: p.rotY as number || 0, z: p.rotZ as number || 0 },
          { x: p.scaleX as number || 1, y: p.scaleY as number || 1, z: p.scaleZ as number || 1 },
          p.color as string || '#3b82f6'
        );
        break;

      case 'BUILD_MULTI': {
        const primitives = (p.primitives as Array<Record<string, unknown>>) || [];
        const maxBatch = 5;
        const batch = primitives.slice(0, maxBatch);
        console.log(`[${name}] BUILD_MULTI: placing ${batch.length} primitives (requested ${primitives.length})`);
        const buildErrors: string[] = [];
        for (const prim of batch) {
          try {
            await api.buildPrimitive(
              (prim.shape as string || 'box') as 'box' | 'sphere' | 'cone' | 'cylinder' | 'plane' | 'torus' | 'circle' | 'dodecahedron' | 'icosahedron' | 'octahedron' | 'ring' | 'tetrahedron' | 'torusKnot' | 'capsule',
              { x: prim.x as number || 0, y: prim.y as number || 0, z: prim.z as number || 0 },
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
