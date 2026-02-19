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
  /** Optional vision-to-text bridge for providers that do not support image inputs */
  visionBridge?: {
    provider: 'gemini';
    model: string;
    apiKey: string;
  };
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
  /** Optional vision-to-text bridge for providers that do not support image inputs */
  visionBridge?: {
    provider: 'gemini';
    model: string;
    apiKey: string;
  };
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

interface EnterGuildStatus {
  inGuild: boolean;
  guildId?: string;
  guildName?: string;
  role?: 'commander' | 'vice' | 'member';
  advice: string;
}

type ServerSpatialSnapshot = NonNullable<Awaited<ReturnType<GridAPIClient['getSpatialSummary']>>>;

interface SpatialGrowthTracker {
  initialized: boolean;
  seenNodeIds: Set<string>;
  maturedNodeIds: Set<string>;
  lastMaturityTick: number | null;
  maturityIntervals: number[];
  coordinatedExpansionEvents: number;
}

interface SpatialTickMetrics {
  nodes: number;
  matureNodes: number;
  connectorEdges: number;
  newNodes: number;
  newlyMatured: number;
  avgMaturityCadenceTicks: number | null;
  coordinatedExpansionEvents: number;
  meanAgentDistance: number | null;
}

const NODE_EXPANSION_GATE = 25;
const NODE_STRONG_DENSITY_TARGET = 50;
const NODE_MEGA_TARGET = 100;
const NODE_EXPANSION_MIN_DISTANCE = 200;
const NODE_EXPANSION_MAX_DISTANCE = 600;

// Mouse: signature landmark policy (avoid spire spam)
const MOUSE_SPIRE_MIN_DISTANCE = 90;
const MOUSE_SPIRE_COOLDOWN_BLUEPRINTS = 8;


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

function summarizeEnterGuildStatus(guild?: EnterGuildStatus): { summary: string; advice: string } | null {
  if (!guild) return null;
  if (guild.inGuild) {
    const name = guild.guildName || guild.guildId || 'unknown guild';
    const role = guild.role ? ` as ${guild.role}` : '';
    return {
      summary: `in guild ${name}${role}`,
      advice: guild.advice,
    };
  }
  return {
    summary: 'not in a guild',
    advice: guild.advice,
  };
}

function logEnterGuildStatus(agentName: string, guild?: EnterGuildStatus): void {
  const status = summarizeEnterGuildStatus(guild);
  if (!status) return;
  console.log(`[${agentName}] Guild status: ${status.summary}`);
  console.log(`[${agentName}] Guild guidance: ${status.advice}`);
}

function makeCoordinationChat(
  agentName: string,
  self: { position: { x: number; z: number } } | undefined,
  directives: Array<{ id: string; description: string }>,
  otherAgents: Array<{ name: string; position?: { x: number; z: number } }>,
  recentMessages: Array<{ agentName?: string; message?: string }> = [],
  buildError?: string,
): string {
  const pos = self
    ? `(${Math.round(self.position.x)}, ${Math.round(self.position.z)})`
    : null;
  const selfName = agentName.toLowerCase();

  // Build error — keep it informative but natural
  if (buildError) {
    const compact = buildError.replace(/\s+/g, ' ').slice(0, 90);
    return pos
      ? `Hit a snag building near ${pos} — ${compact}. Gonna reposition and try again.`
      : `Build got blocked: ${compact}. Moving somewhere clear to retry.`;
  }

  // Check if someone asked us something — respond conversationally
  const latestMessages = [...recentMessages]
    .reverse()
    .filter((m) => (m.agentName || '').toLowerCase() !== 'system');

  const coordinationAsk = latestMessages.find((m) => {
    const speaker = (m.agentName || '').toLowerCase();
    if (!speaker || speaker === selfName || speaker === 'system') return false;
    const text = (m.message || '').toLowerCase();
    return text.includes(selfName) && hasCoordinationAskSignal(text);
  });
  if (coordinationAsk?.agentName) {
    const replies = pos ? [
      `Hey ${coordinationAsk.agentName}! I'm over at ${pos} right now. What do you need? I can help build or connect stuff nearby.`,
      `@${coordinationAsk.agentName} yeah I'm at ${pos} — send me coords and I'll head over. What are we building?`,
      `${coordinationAsk.agentName} — on it. I'm at ${pos}, drop me the target location and blueprint name.`,
    ] : [
      `Hey ${coordinationAsk.agentName}! Finishing up a build right now, what's up?`,
      `@${coordinationAsk.agentName} sure thing — what do you need help with?`,
    ];
    return replies[Math.floor(Math.random() * replies.length)];
  }

  // Respond to what other agents said recently — be conversational
  const recentOtherChat = latestMessages.find((m) => {
    const speaker = (m.agentName || '').toLowerCase();
    return speaker && speaker !== selfName && speaker !== 'system';
  });

  // Generate varied, natural messages
  const otherNames = otherAgents.map(a => a.name);
  const randomOther = otherNames.length > 0 ? otherNames[Math.floor(Math.random() * otherNames.length)] : null;

  // Pool of natural conversation starters
  const conversationPool: string[] = [];

  if (directives.length > 0) {
    const d = directives[0];
    conversationPool.push(
      `Anyone else working on "${d.description.slice(0, 60)}"? I could use some help.`,
      `Making progress on the directive — "${d.description.slice(0, 60)}". Who's in?`,
    );
  }

  if (recentOtherChat?.agentName && recentOtherChat.message) {
    const msg = recentOtherChat.message.slice(0, 60);
    conversationPool.push(
      `${recentOtherChat.agentName} — interesting point about "${msg}". I think we should keep pushing that direction.`,
      `Agree with ${recentOtherChat.agentName} there. Let's coordinate on it.`,
    );
  }

  if (randomOther && pos) {
    conversationPool.push(
      `Hey ${randomOther}, what are you building? I'm working on stuff near ${pos}.`,
      `${randomOther}, want to connect our areas? I'm at ${pos}.`,
      `This area near ${pos} is coming together nicely. ${randomOther}, you should check it out.`,
    );
  }

  if (pos) {
    conversationPool.push(
      `Just finished a build at ${pos}. This neighborhood is growing fast.`,
      `The area around ${pos} could use more structures — anyone want to build here?`,
      `Looking for a good spot to start the next project. The zone near ${pos} has potential.`,
    );
  }

  // General fallbacks
  conversationPool.push(
    `What should we focus on next? I'm open to suggestions.`,
    `This city is really taking shape. What areas still need work?`,
    `Anyone want to team up on the next build? More fun together.`,
  );

  return conversationPool[Math.floor(Math.random() * conversationPool.length)];
}

function formatActionUpdateChat(
  decision: AgentDecision,
  tick: number,
  actionError?: string | null,
): string | null {
  const payload = decision.payload || {};

  const coord = (x: unknown, z: unknown): string | null => {
    const nx = Number(x);
    const nz = Number(z);
    if (!Number.isFinite(nx) || !Number.isFinite(nz)) return null;
    return `(${Math.round(nx)}, ${Math.round(nz)})`;
  };

  if (actionError) {
    const compact = actionError.replace(/\s+/g, ' ').slice(0, 120);
    return `${decision.action} failed at tick ${tick}: ${compact}`;
  }

  switch (decision.action) {
    case 'MOVE': {
      const thought = (decision.thought || '').split('|')[0].trim();
      // Only chat if the thought is interesting. If it's just "Moving to X", skip it.
      if (thought.length > 20 && !thought.startsWith('Moving') && !thought.startsWith('Heading')) {
        return thought.slice(0, 280);
      }
      return null;
    }
    case 'BUILD_PRIMITIVE':
    case 'BUILD_MULTI': {
      const thought = (decision.thought || '').split('|')[0].trim();
      return thought.length > 10 ? thought.slice(0, 280) : 'Building structure.';
    }
    case 'BUILD_BLUEPRINT': {
      const thought = (decision.thought || '').split('|')[0].trim();
      return thought.length > 15 ? thought.slice(0, 280) : `Starting construction.`;
    }
    case 'BUILD_CONTINUE':
      return null;
    case 'CANCEL_BUILD':
      return `I'm clearing my build plan.`;
    case 'VOTE': {
      const thought = (decision.thought || '').split('|')[0].trim();
      if (thought.length > 15) return thought.slice(0, 280);
      return `I voted.`;
    }
    case 'SUBMIT_DIRECTIVE': {
      const thought = (decision.thought || '').split('|')[0].trim();
      const match = String(payload.description || '').match(/^TITLE:\s*(.+)/i);
      const title = match ? match[1] : String(payload.description || '').slice(0, 50);
      if (thought.length > 15) return thought.slice(0, 280);
      return `Proposing: "${title}"`;
    }
    case 'TRANSFER_CREDITS': {
      const amount = Number(payload.amount);
      const toAgentId = String(payload.toAgentId || 'agent');
      const thought = (decision.thought || '').split('|')[0].trim();
      if (thought.length > 15) return thought.slice(0, 280);
      return `Transferred ${amount} credits to ${toAgentId}.`;
    }
    default:
      return null;
  }
}

async function emitActionUpdateChat(
  api: GridAPIClient,
  agentName: string,
  decision: AgentDecision,
  tick: number,
  actionError?: string | null,
): Promise<boolean> {
  const message = formatActionUpdateChat(decision, tick, actionError);
  if (!message) return false;

  const trimmed = message.trim().slice(0, 280);
  if (!trimmed) return false;

  try {
    await api.action('CHAT', { message: trimmed });
    console.log(`[${agentName}] Action update chat: "${trimmed.slice(0, 80)}..."`);
    return true;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.warn(`[${agentName}] Action update chat failed: ${errMsg.slice(0, 140)}`);
    return false;
  }
}

const LOW_SIGNAL_ACK_PATTERN = /\b(?:acknowledg(?:e|ed|ing)?|saw your ping|ping received|sync received|acting on it(?: now)?|copy that|roger|heard you|on it(?: now)?|i see you)\b/;

const COORDINATION_ASK_SIGNAL_RE =
  /\b(?:need|please|can you|could you|would you|do you|who can|anyone)\b/;

function hasCoordinationAskSignal(textLower: string): boolean {
  return textLower.includes('?') || COORDINATION_ASK_SIGNAL_RE.test(textLower);
}

function normalizeChatText(message: string): string {
  return message
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function semanticChatKey(message: string): string {
  return normalizeChatText(message)
    // Drop numeric-only differences like coordinates/progress counts.
    .replace(/\b-?\d+(?:\.\d+)?\b/g, '#')
    // Collapse common ids that churn.
    .replace(/\bdir_[a-z0-9-]+\b/g, 'dir_#')
    .replace(/\bagent_[a-z0-9-]+\b/g, 'agent_#')
    .trim();
}

function shouldSuppressChatMessage(
  agentName: string,
  message: string,
  recentMessages: Array<{ agentName?: string; message?: string }>,
  ticksSinceChat: number,
): { suppress: boolean; reason?: string } {
  const normalized = normalizeChatText(message);
  if (!normalized) return { suppress: true, reason: 'empty message' };

  const selfName = agentName.toLowerCase();
  const hasRecentDirectMention = recentMessages
    .slice(-6)
    .some((m) => {
      const speaker = (m.agentName || '').toLowerCase();
      if (!speaker || speaker === selfName || speaker === 'system') return false;
      const text = (m.message || '').toLowerCase();
      // Only treat as a coordination "mention" when it is paired with an actual ask/question.
      // This prevents name-based ping-pong loops from triggering chat overrides.
      const mentionsMe = text.includes(selfName);
      return mentionsMe && hasCoordinationAskSignal(text);
    });

  // Prevent back-to-back chat bursts; this is where loops commonly start.
  if (ticksSinceChat < 2 && !hasRecentDirectMention) {
    return { suppress: true, reason: 'chat cadence too fast' };
  }

  if (LOW_SIGNAL_ACK_PATTERN.test(normalized)) {
    return { suppress: true, reason: 'low-signal acknowledgment loop risk' };
  }

  const recentOwn = recentMessages
    .filter((m) => (m.agentName || '').toLowerCase() === selfName)
    .slice(-4)
    .map((m) => normalizeChatText(m.message || ''))
    .filter(Boolean);
  if (recentOwn.includes(normalized)) {
    return { suppress: true, reason: 'duplicate self message' };
  }

  const semantic = semanticChatKey(message);
  const recentOwnSemantic = recentMessages
    .filter((m) => (m.agentName || '').toLowerCase() === selfName)
    .slice(-4)
    .map((m) => semanticChatKey(m.message || ''))
    .filter(Boolean);
  if (semantic && recentOwnSemantic.includes(semantic)) {
    return { suppress: true, reason: 'semantic duplicate self message' };
  }

  const recentGlobal = recentMessages
    .slice(-8)
    .map((m) => normalizeChatText(m.message || ''))
    .filter(Boolean);
  const duplicateCount = recentGlobal.filter((m) => m === normalized).length;
  if (duplicateCount > 0) {
    return { suppress: true, reason: 'global duplicate message' };
  }

  return { suppress: false };
}

function isLowSignalCoordinationMessage(message: string): boolean {
  const normalized = normalizeChatText(message);
  if (!normalized) return true;
  if (LOW_SIGNAL_ACK_PATTERN.test(normalized)) return true;
  // Generic status chatter without concrete payload (coords/progress/next step).
  const hasCoordinate = /\(\s*-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?\s*\)/.test(message);
  const hasProgressVerb = /\b(?:built|building|moving|connect|connected|road|bridge|blueprint|failed|retry|anchor)\b/i.test(message);
  if (!hasCoordinate && !hasProgressVerb && normalized.split(' ').length <= 12) return true;
  return false;
}

function detectLowSignalChatLoop(recentMessages: Array<{ agentName?: string; message?: string }>): boolean {
  const recent = recentMessages
    .slice(-10)
    .filter((m) => (m.agentName || '').toLowerCase() !== 'system');
  if (recent.length < 5) return false;

  const lowSignalCount = recent.filter((m) => isLowSignalCoordinationMessage(m.message || '')).length;
  const normalizedSet = new Set(
    recent.map((m) => normalizeChatText(m.message || '')).filter(Boolean),
  );

  return lowSignalCount >= Math.ceil(recent.length * 0.9) && normalizedSet.size <= Math.max(2, Math.floor(recent.length * 0.4));
}

function chooseLoopBreakMoveTarget(
  self: { x: number; z: number } | undefined,
  safeSpots: Array<{ x: number; z: number }>,
  otherAgents: Array<{ position: { x: number; z: number } }>,
): { x: number; z: number } | null {
  if (!self) return null;

  if (safeSpots.length > 0) {
    const scored = safeSpots.map((spot) => {
      const distFromSelf = Math.hypot(spot.x - self.x, spot.z - self.z);
      const nearestOther = otherAgents.length > 0
        ? Math.min(...otherAgents.map((a) => Math.hypot(spot.x - a.position.x, spot.z - a.position.z)))
        : 80;
      const score = Math.abs(distFromSelf - 25) - Math.min(12, nearestOther / 8);
      return { spot, score };
    });
    scored.sort((a, b) => a.score - b.score);
    return { x: Math.round(scored[0].spot.x), z: Math.round(scored[0].spot.z) };
  }

  const offsets = [
    { x: 25, z: 0 },
    { x: -25, z: 0 },
    { x: 0, z: 25 },
    { x: 0, z: -25 },
    { x: 18, z: 18 },
    { x: -18, z: 18 },
    { x: 18, z: -18 },
    { x: -18, z: -18 },
  ];
  const candidates = offsets.map((o) => ({ x: Math.round(self.x + o.x), z: Math.round(self.z + o.z) }));
  candidates.sort((a, b) => {
    const da = otherAgents.length > 0
      ? Math.min(...otherAgents.map((agent) => Math.hypot(a.x - agent.position.x, a.z - agent.position.z)))
      : 0;
    const db = otherAgents.length > 0
      ? Math.min(...otherAgents.map((agent) => Math.hypot(b.x - agent.position.x, b.z - agent.position.z)))
      : 0;
    return db - da;
  });
  return candidates[0] || null;
}

function chooseLocalMoveTarget(
  self: { x: number; z: number } | undefined,
  safeSpots: Array<{ x: number; z: number }>,
  maxDistance = 30, // Default to 30 instead of 40
): { x: number; z: number } | null {
  if (!self) return null;

  if (safeSpots.length === 0) return null;

  const withDistance = safeSpots.map((spot) => ({
    spot,
    dist: Math.hypot(spot.x - self.x, spot.z - self.z),
  }));

  // Reduced minimum distance from 8 to 4 to prevent large leaps out of a node
  const nearby = withDistance
    .filter((entry) => entry.dist > 4 && entry.dist <= maxDistance)
    .sort((a, b) => a.dist - b.dist);

  if (nearby.length > 0) {
    return {
      x: Math.round(nearby[0].spot.x),
      z: Math.round(nearby[0].spot.z),
    };
  }

  const nearest = withDistance.sort((a, b) => a.dist - b.dist)[0];
  if (!nearest || nearest.dist <= 1) return null;

  // Reduced fallback step from 55 to 30 to prevent massive drift
  const step = Math.min(30, nearest.dist);
  const ratio = step / nearest.dist;
  return {
    x: Math.round(self.x + (nearest.spot.x - self.x) * ratio),
    z: Math.round(self.z + (nearest.spot.z - self.z) * ratio),
  };
}

function roundTo(value: number, decimals = 2): number {
  const scale = 10 ** decimals;
  return Math.round(value * scale) / scale;
}

function meanPairwiseAgentDistance(
  agents: Array<{ position: { x: number; z: number } }>,
): number | null {
  if (agents.length < 2) return null;

  let sum = 0;
  let pairs = 0;
  for (let i = 0; i < agents.length; i++) {
    for (let j = i + 1; j < agents.length; j++) {
      sum += Math.hypot(
        agents[i].position.x - agents[j].position.x,
        agents[i].position.z - agents[j].position.z,
      );
      pairs += 1;
    }
  }
  if (pairs === 0) return null;
  return roundTo(sum / pairs, 1);
}

function connectorEdgeCount(nodes: ServerSpatialSnapshot['nodes']): number {
  if (!Array.isArray(nodes) || nodes.length === 0) return 0;
  const seen = new Set<string>();

  for (const node of nodes) {
    const nodeId = String(node?.id || '');
    for (const conn of node?.connections || []) {
      if (!conn?.hasConnector) continue;
      const targetId = String(conn.targetId || '');
      if (!nodeId || !targetId) continue;
      const key = nodeId < targetId ? `${nodeId}|${targetId}` : `${targetId}|${nodeId}`;
      seen.add(key);
    }
  }
  return seen.size;
}

function computeSpatialTickMetrics(
  tick: number,
  worldAgents: Array<{ position: { x: number; z: number } }>,
  serverSpatial: ServerSpatialSnapshot,
  tracker: SpatialGrowthTracker,
): SpatialTickMetrics {
  const nodes = Array.isArray(serverSpatial.nodes) ? serverSpatial.nodes : [];
  const maturityThreshold = NODE_EXPANSION_GATE;

  if (!tracker.initialized) {
    for (const node of nodes) {
      const id = String(node?.id || '');
      if (!id) continue;
      tracker.seenNodeIds.add(id);
      if ((Number(node?.structureCount) || 0) >= maturityThreshold) {
        tracker.maturedNodeIds.add(id);
      }
    }
    tracker.initialized = true;
    return {
      nodes: nodes.length,
      matureNodes: nodes.filter((node) => (Number(node?.structureCount) || 0) >= maturityThreshold).length,
      connectorEdges: connectorEdgeCount(nodes),
      newNodes: 0,
      newlyMatured: 0,
      avgMaturityCadenceTicks: null,
      coordinatedExpansionEvents: tracker.coordinatedExpansionEvents,
      meanAgentDistance: meanPairwiseAgentDistance(worldAgents),
    };
  }

  const nodeById = new Map<string, ServerSpatialSnapshot['nodes'][number]>();
  for (const node of nodes) {
    const id = String(node?.id || '');
    if (id) nodeById.set(id, node);
  }

  let newNodes = 0;
  let newlyMatured = 0;

  for (const node of nodes) {
    const id = String(node?.id || '');
    if (!id) continue;

    if (!tracker.seenNodeIds.has(id)) {
      tracker.seenNodeIds.add(id);
      newNodes += 1;
    }

    const structureCount = Number(node?.structureCount) || 0;
    const isMature = structureCount >= maturityThreshold;
    if (!isMature || tracker.maturedNodeIds.has(id)) continue;

    newlyMatured += 1;

    if (tracker.lastMaturityTick !== null) {
      tracker.maturityIntervals.push(Math.max(1, tick - tracker.lastMaturityTick));
    }
    tracker.lastMaturityTick = tick;

    const nearestPreviouslyMatureDist = (() => {
      let nearest = Number.POSITIVE_INFINITY;
      for (const matureId of tracker.maturedNodeIds) {
        const matureNode = nodeById.get(matureId);
        if (!matureNode) continue;
        const dist = Math.hypot(
          (node.center?.x || 0) - (matureNode.center?.x || 0),
          (node.center?.z || 0) - (matureNode.center?.z || 0),
        );
        if (dist < nearest) nearest = dist;
      }
      return nearest;
    })();

    if (
      Number.isFinite(nearestPreviouslyMatureDist) &&
      nearestPreviouslyMatureDist >= NODE_EXPANSION_MIN_DISTANCE &&
      nearestPreviouslyMatureDist <= NODE_EXPANSION_MAX_DISTANCE
    ) {
      tracker.coordinatedExpansionEvents += 1;
    }

    tracker.maturedNodeIds.add(id);
  }

  const avgMaturityCadenceTicks =
    tracker.maturityIntervals.length > 0
      ? roundTo(
          tracker.maturityIntervals.reduce((sum, value) => sum + value, 0) /
            tracker.maturityIntervals.length,
          1,
        )
      : null;

  return {
    nodes: nodes.length,
    matureNodes: nodes.filter((node) => (Number(node?.structureCount) || 0) >= maturityThreshold).length,
    connectorEdges: connectorEdgeCount(nodes),
    newNodes,
    newlyMatured,
    avgMaturityCadenceTicks,
    coordinatedExpansionEvents: tracker.coordinatedExpansionEvents,
    meanAgentDistance: meanPairwiseAgentDistance(worldAgents),
  };
}

function pickFallbackBlueprintName(
  blueprints: Record<string, any>,
  options: { allowBridge?: boolean; preferMega?: boolean; recentNames?: string[]; excludeNames?: string[] } = {},
): string | null {
  const allowBridge = options.allowBridge === true;
  const preferMega = options.preferMega === true;
  const recentNames = (options.recentNames || []).map((name) => String(name).trim().toUpperCase()).filter(Boolean);
  const exclude = new Set(
    (options.excludeNames || [])
      .map((name) => String(name).trim().toUpperCase())
      .filter(Boolean),
  );
  const entries = Object.entries(blueprints || {})
    .filter(([, bp]) => !bp?.advanced)
    .filter(([name]) => !exclude.has(String(name).trim().toUpperCase()));
  if (entries.length === 0) return null;

  const preferredNamePattern = /(DATACENTER|SERVER|ANTENNA|WATCHTOWER|TOWER|HOUSE|SHOP|FOUNTAIN)/i;
  const megaPattern = /(MEGA_SERVER_SPIRE|MEGA|SKYSCRAPER|DATACENTER|MONUMENT|WATCHTOWER|SERVER_STACK)/i;
  const noveltyPattern = /(PLAZA|MONUMENT|SCULPTURE|PARK|GARDEN|AMPHITHEATER|OBSERVATORY|FOUNTAIN|MARKET|PAVILION|MANSION)/i;
  const tinySpamPattern = /(LAMP_POST|TREE)/i;
  const bridgePattern = /(^|_)BRIDGE(_|$)/i;

  const scored = entries.map(([name, bp]) => {
    const normalizedName = name.toUpperCase();
    const total = Number(bp?.totalPrimitives) || 0;
    const category = String(bp?.category || '').toLowerCase();
    let score = 0;

    if (preferredNamePattern.test(name)) score -= 24;
    if (preferMega && megaPattern.test(name)) score -= 42;
    if (!preferMega && noveltyPattern.test(name)) score -= 16;
    if (tinySpamPattern.test(name)) score += 35;
    if (bridgePattern.test(name)) score += allowBridge ? -6 : 55;
    if (recentNames.includes(normalizedName)) score += 46;
    if (recentNames[0] === normalizedName) score += 18;

    if (total >= 10 && total <= 32) score -= 18;
    else if (total >= 7) score -= 8;
    else score += 16;

    if (category === 'infrastructure' || category === 'architecture' || category === 'technology') score -= 8;
    if (category === 'decoration') score += 10;

    return { name, score };
  });

  scored.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));
  return scored[0]?.name || null;
}

function parseRecentBlueprintNames(workingMemory: string): string[] {
  const raw = workingMemory.match(/Recent blueprints: (.+)/)?.[1] || '';
  return raw
    .split(',')
    .map((value) => value.trim().toUpperCase())
    .filter(Boolean)
    .slice(0, 8);
}

function pushRecentBlueprintName(recentNames: string[], name: string, max = 8): string[] {
  const normalized = String(name || '').trim().toUpperCase();
  if (!normalized) return [...recentNames].slice(0, max);
  const filtered = recentNames.filter((entry) => entry !== normalized);
  return [normalized, ...filtered].slice(0, max);
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

function parseCoordPair(text: string): { x: number; z: number } | null {
  const m = String(text || '').match(/\((-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\)/);
  if (!m) return null;
  const x = Number(m[1]);
  const z = Number(m[2]);
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
  return { x, z };
}

function parseLastSpireAnchor(workingMemory: string): { x: number; z: number } | null {
  const m = workingMemory.match(/Last spire anchor:\s*\((-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\)/i);
  if (!m) return null;
  const x = Number(m[1]);
  const z = Number(m[2]);
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
  return { x, z };
}

function parseSpireAnchors(workingMemory: string): Array<{ x: number; z: number }> {
  const raw = workingMemory.match(/Spire anchors:\s*(.+)/i)?.[1] || '';
  return raw
    .split(';')
    .map((part) => parseCoordPair(part))
    .filter((pt): pt is { x: number; z: number } => Boolean(pt))
    .slice(0, 5);
}

function pushRecentAnchor(
  anchors: Array<{ x: number; z: number }>,
  anchor: { x: number; z: number },
  max = 5,
): Array<{ x: number; z: number }> {
  const x = Math.round(anchor.x);
  const z = Math.round(anchor.z);
  const key = `${x},${z}`;
  const filtered = anchors.filter((pt) => `${Math.round(pt.x)},${Math.round(pt.z)}` !== key);
  return [{ x, z }, ...filtered].slice(0, max);
}


function nearestSafeSpotDistance(
  x: number,
  z: number,
  safeSpots: Array<{ x: number; z: number }>,
): number {
  if (!Number.isFinite(x) || !Number.isFinite(z) || safeSpots.length === 0) return Number.POSITIVE_INFINITY;
  let nearest = Number.POSITIVE_INFINITY;
  for (const spot of safeSpots) {
    const dist = Math.hypot(x - spot.x, z - spot.z);
    if (dist < nearest) nearest = dist;
  }
  return nearest;
}

function closestServerNodeNameAtPosition(
  serverSpatial: { nodes?: Array<{ name?: string; center?: { x?: number; z?: number } }> } | null,
  x: number,
  z: number,
): string | null {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
  const nodes = serverSpatial?.nodes;
  if (!Array.isArray(nodes) || nodes.length === 0) return null;

  let bestName: string | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const node of nodes) {
    const nx = Number(node?.center?.x);
    const nz = Number(node?.center?.z);
    if (!Number.isFinite(nx) || !Number.isFinite(nz)) continue;
    const d = Math.hypot(nx - x, nz - z);
    if (d < bestDist) {
      bestDist = d;
      const name = String(node?.name || '').trim();
      bestName = name || null;
    }
  }

  return bestName;
}

function pickSafeSpotClosestToAnchor(
  anchorX: number,
  anchorZ: number,
  safeSpots: Array<{ x: number; z: number; nearestNodeName?: string }>,
  options: { preferredNodeName?: string | null; exclude?: Array<{ x: number; z: number }> } = {},
): { x: number; z: number } | null {
  if (!Number.isFinite(anchorX) || !Number.isFinite(anchorZ) || safeSpots.length === 0) return null;

  const exclude = options.exclude || [];
  const excluded = new Set(exclude.map((pt) => `${Math.round(pt.x)},${Math.round(pt.z)}`));
  const filtered = safeSpots.filter((spot) => !excluded.has(`${Math.round(spot.x)},${Math.round(spot.z)}`));
  if (filtered.length === 0) return null;

  const preferredNode = (options.preferredNodeName || '').trim();
  const preferred = preferredNode
    ? filtered.filter((spot) => String(spot.nearestNodeName || '').trim() === preferredNode)
    : [];
  const pool = preferred.length > 0 ? preferred : filtered;

  let best = pool[0];
  let bestDist = Number.POSITIVE_INFINITY;
  for (const spot of pool) {
    const dist = Math.hypot(anchorX - spot.x, anchorZ - spot.z);
    if (dist < bestDist) {
      bestDist = dist;
      best = spot;
    }
  }

  return best ? { x: Math.round(best.x), z: Math.round(best.z) } : null;
}

function pickSafeBuildAnchor(
  safeSpots: Array<{ x: number; z: number; type?: 'growth' | 'connector' | 'frontier' }>,
  self?: { x: number; z: number },
  exclude: Array<{ x: number; z: number }> = [],
  preferTypedSpots = false,
): { anchorX: number; anchorZ: number } | null {
  const excluded = new Set(
    exclude.map((pt) => `${Math.round(pt.x)},${Math.round(pt.z)}`),
  );

  if (safeSpots.length > 0) {
    let candidates = safeSpots
      .map((spot) => ({
        anchorX: Math.round(spot.x),
        anchorZ: Math.round(spot.z),
        typed: Boolean(spot.type),
      }))
      .filter((spot) => !excluded.has(`${spot.anchorX},${spot.anchorZ}`));

    if (preferTypedSpots) {
      const typed = candidates.filter((spot) => spot.typed);
      if (typed.length > 0) candidates = typed;
    }

    if (candidates.length > 0) {
      if (self) {
        const inRange = candidates.find((spot) => Math.hypot(spot.anchorX - self.x, spot.anchorZ - self.z) <= 20);
        if (inRange) return inRange;
        candidates.sort(
          (a, b) =>
            Math.hypot(a.anchorX - self.x, a.anchorZ - self.z) -
            Math.hypot(b.anchorX - self.x, b.anchorZ - self.z),
        );
      }
      return candidates[0] || null;
    }
  }

  if (self) {
    const fallbackOffsets = [
      { x: 18, z: 0 },
      { x: -18, z: 0 },
      { x: 0, z: 18 },
      { x: 0, z: -18 },
      { x: 28, z: 16 },
      { x: -28, z: 16 },
      { x: 28, z: -16 },
      { x: -28, z: -16 },
    ];
    for (const offset of fallbackOffsets) {
      const anchorX = Math.round(self.x + offset.x);
      const anchorZ = Math.round(self.z + offset.z);
      if (Math.hypot(anchorX, anchorZ) < 55) continue;
      const key = `${anchorX},${anchorZ}`;
      if (excluded.has(key)) continue;
      return { anchorX, anchorZ };
    }
  }
  return null;
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
  const retryAfterMsMatch = lower.match(/retryafterms[^0-9]{0,8}(\d+)/);
  if (retryAfterMsMatch) {
    const ms = Number(retryAfterMsMatch[1]);
    if (Number.isFinite(ms) && ms > 0) {
      return Math.max(5, Math.ceil(ms / 1000));
    }
  }

  const match = lower.match(/(?:retry|wait|after|in|reset)[^0-9]{0,20}(\d+)\s*(ms|milliseconds?|s|sec|secs|seconds?|m|min|mins|minutes?)/);
  if (!match) return fallbackSeconds;

  const value = Number(match[1]);
  const unit = match[2];
  if (!Number.isFinite(value) || value <= 0) return fallbackSeconds;

  if (unit.startsWith('ms')) return Math.max(5, Math.ceil(value / 1000));
  if (unit.startsWith('m')) return Math.max(5, value * 60);
  return Math.max(5, value);
}

function parseFirstJsonObject(text: string): Record<string, unknown> | null {
  const firstBrace = text.indexOf('{');
  if (firstBrace === -1) return null;

  let depth = 0;
  let lastBrace = -1;
  for (let i = firstBrace; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) {
        lastBrace = i;
        break;
      }
    }
  }

  if (lastBrace === -1) return null;
  try {
    return JSON.parse(text.slice(firstBrace, lastBrace + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function parseAnchorFromErrorMessage(message: string): { x: number; z: number } | null {
  const explicit = message.match(/within\s+\d+\s+units\s+of\s+\((-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\)/i);
  if (!explicit) return null;
  const x = Number(explicit[1]);
  const z = Number(explicit[2]);
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
  return { x: Math.round(x), z: Math.round(z) };
}

function parseBuildActionError(message: string): {
  noActivePlan: boolean;
  alreadyActivePlan: boolean;
  blueprintOverlap: boolean;
  blueprintAnchorTooFar: boolean;
  tooFarFromBuildSite: boolean;
  expansionGate: boolean;
  gateNodeName: string | null;
  gateNodeStructures: number | null;
  anchor: { x: number; z: number } | null;
} {
  const json = parseFirstJsonObject(message);
  const anchorX = Number(json?.anchorX);
  const anchorZ = Number(json?.anchorZ);
  const anchorFromJson =
    Number.isFinite(anchorX) && Number.isFinite(anchorZ)
      ? { x: Math.round(anchorX), z: Math.round(anchorZ) }
      : null;

  const jsonErrorText = typeof json?.error === 'string' ? String(json.error) : '';
  const combinedText = jsonErrorText ? `${message} ${jsonErrorText}` : message;
  const expansionGate = /Expansion gate active/i.test(combinedText);
  const gateMatch =
    combinedText.match(/nearest node\s+"([^"]+)"\s+has\s+(\d+)\s+structures/i) ||
    combinedText.match(/nearest node\s+“([^”]+)”\s+has\s+(\d+)\s+structures/i);
  const gateNodeName = gateMatch?.[1] ? String(gateMatch[1]).trim() : null;
  const gateNodeStructuresRaw = gateMatch?.[2] ? Number(gateMatch[2]) : NaN;
  const gateNodeStructures = Number.isFinite(gateNodeStructuresRaw) ? Math.max(0, Math.floor(gateNodeStructuresRaw)) : null;

  return {
    noActivePlan: /No active build plan/i.test(message),
    alreadyActivePlan: /already have an active build plan/i.test(message),
    blueprintOverlap:
      /Blueprint footprint overlaps existing geometry/i.test(message) ||
      /footprint overlaps another agent's active build/i.test(message),
    blueprintAnchorTooFar: /Blueprint anchor too far from any existing build/i.test(message),
    tooFarFromBuildSite: /Too far from build site/i.test(message),
    expansionGate,
    gateNodeName,
    gateNodeStructures,
    anchor: anchorFromJson || parseAnchorFromErrorMessage(message),
  };
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

type NodeTier =
  | 'Capital'
  | 'District'
  | 'Neighborhood'
  | 'Outpost'
  | 'settlement-node'
  | 'server-node'
  | 'forest-node'
  | 'city-node'
  | 'metropolis-node'
  | 'megaopolis-node';
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
  connections: Array<{ targetIdx: number; distance: number; hasBridge: boolean; bearing?: string; bearingDeg?: number; gateX?: number; gateZ?: number; targetGateX?: number; targetGateZ?: number }>;
}

function tierWeight(tier: NodeTier): number {
  switch (tier) {
    case 'megaopolis-node': return 10;
    case 'metropolis-node': return 9;
    case 'city-node': return 8;
    case 'forest-node': return 7;
    case 'server-node': return 6;
    case 'settlement-node': return 5;
    case 'Capital': return 10;
    case 'District': return 8;
    case 'Neighborhood': return 6;
    case 'Outpost': return 4;
    default: return 0;
  }
}

function isSmallTier(tier: NodeTier): boolean {
  return tier === 'Outpost' || tier === 'settlement-node' || tier === 'server-node';
}

function tierLabel(tier: NodeTier): string {
  if (tier.includes('-node')) return tier;
  return tier.toLowerCase();
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

  // 5. Compute adjacency for nearby nodes as potential connections
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

        const connDist = Math.round(dist);
        const bIJ = compassBearing(nodes[i].center.x, nodes[i].center.z, nodes[j].center.x, nodes[j].center.z);
        const bDegIJ = compassBearingDeg(nodes[i].center.x, nodes[i].center.z, nodes[j].center.x, nodes[j].center.z);
        const bJI = compassBearing(nodes[j].center.x, nodes[j].center.z, nodes[i].center.x, nodes[i].center.z);
        const bDegJI = compassBearingDeg(nodes[j].center.x, nodes[j].center.z, nodes[i].center.x, nodes[i].center.z);
        const dirX = dist > 0 ? (nodes[j].center.x - nodes[i].center.x) / dist : 0;
        const dirZ = dist > 0 ? (nodes[j].center.z - nodes[i].center.z) / dist : 0;
        const gAX = Math.round(nodes[i].center.x + dirX * nodes[i].radius);
        const gAZ = Math.round(nodes[i].center.z + dirZ * nodes[i].radius);
        const gBX = Math.round(nodes[j].center.x - dirX * nodes[j].radius);
        const gBZ = Math.round(nodes[j].center.z - dirZ * nodes[j].radius);
        nodes[i].connections.push({ targetIdx: j, distance: connDist, hasBridge: hasRoad, bearing: bIJ, bearingDeg: bDegIJ, gateX: gAX, gateZ: gAZ, targetGateX: gBX, targetGateZ: gBZ });
        nodes[j].connections.push({ targetIdx: i, distance: connDist, hasBridge: hasRoad, bearing: bJI, bearingDeg: bDegJI, gateX: gBX, gateZ: gBZ, targetGateX: gAX, targetGateZ: gAZ });
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

function nodeThemeFromCategory(category: string): NodeTheme {
  if (category === 'architecture') return 'residential';
  if (category === 'technology') return 'tech';
  if (category === 'art') return 'art';
  if (category === 'nature') return 'nature';
  return 'mixed';
}

function mapMissingCategories(categories: string[] | undefined): BuildCategory[] {
  if (!categories || categories.length === 0) return [];
  const mapped: BuildCategory[] = [];
  if (categories.includes('architecture') && !mapped.includes('structure')) mapped.push('structure');
  if (categories.includes('infrastructure') && !mapped.includes('infrastructure')) mapped.push('infrastructure');
  if ((categories.includes('art') || categories.includes('nature')) && !mapped.includes('decoration')) mapped.push('decoration');
  if (categories.includes('technology') && !mapped.includes('signature')) mapped.push('signature');
  return mapped;
}

function settlementNodesFromServer(serverNodes: any[]): SettlementNode[] {
  if (!Array.isArray(serverNodes) || serverNodes.length === 0) return [];

  const idToIndex = new Map<string, number>();
  for (let i = 0; i < serverNodes.length; i++) {
    const id = String(serverNodes[i]?.id || `node_${i}`);
    idToIndex.set(id, i);
  }

  const nodes: SettlementNode[] = serverNodes.map((node: any, idx: number) => {
    const center = {
      x: Number(node?.center?.x) || 0,
      z: Number(node?.center?.z) || 0,
    };
    const tier = (node?.tier || 'settlement-node') as NodeTier;
    const missingCategories = mapMissingCategories(node?.missingCategories);
    const connections = Array.isArray(node?.connections)
      ? node.connections
          .map((conn: any) => {
            const targetIdx = idToIndex.get(String(conn?.targetId || ''));
            if (typeof targetIdx !== 'number') return null;
            return {
              targetIdx,
              distance: Number(conn?.distance) || 0,
              hasBridge: Boolean(conn?.hasConnector),
            };
          })
          .filter((conn: any): conn is { targetIdx: number; distance: number; hasBridge: boolean } => conn !== null)
      : [];

    return {
      center,
      count: Number(node?.structureCount) || Number(node?.primitiveCount) || 0,
      radius: Number(node?.radius) || 1,
      structures: [String(node?.dominantCategory || 'mixed')],
      builders: Array.isArray(node?.builders) ? node.builders.map((b: any) => String(b)) : [],
      tier,
      theme: nodeThemeFromCategory(String(node?.dominantCategory || 'mixed')),
      name: String(node?.name || `Node ${idx + 1}`),
      missingCategories,
      connections,
    };
  });

  return nodes;
}

/**
 * Pre-compute safe build spots by checking clearance against existing primitives.
 * A spot is "safe" if it has CLEARANCE from all existing geometry AND is within
 * MAX_DIST_FROM_BUILD of at least one existing primitive (server settlement proximity rule).
 *
 * Searches in expanding rings around world centroid + current agent position for
 * spots that have clearance from geometry and stay inside settlement growth limits.
 */
function findSafeBuildSpots(
  agentPos: { x: number; z: number },
  primitives: { position: { x: number; z: number }; scale: { x: number; z: number }; shape: string }[],
  maxResults = 8
): { x: number; z: number; nearestBuild: number }[] {
  // Reduced clearance from 7 to 4.8 to allow for denser, gap-filling nodes
  const CLEARANCE = 4.8;
  const MAX_DIST_FROM_BUILD = 66; // server enforces 70u settlement proximity — stay under
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

  const scanCenters = [agentPos, worldCenter]; // Prioritize agent position for gap filling
  const safe: { x: number; z: number; nearestBuild: number }[] = [];
  const seen = new Set<string>();
  for (const base of scanCenters) {
    // Started at ring size 5 instead of 15 to prioritize immediate empty pockets (gaps)
    for (const radius of [5, 10, 18, 28, 40, 55, 70]) {
      const steps = Math.max(16, Math.floor(radius * 1.15));
      for (let i = 0; i < steps; i++) {
        const angle = (2 * Math.PI * i) / steps;
        const cx = Math.round(base.x + radius * Math.cos(angle));
        const cz = Math.round(base.z + radius * Math.sin(angle));
        const key = `${cx},${cz}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const result = checkSpot(cx, cz);
        if (result.clear) {
          safe.push({ x: cx, z: cz, nearestBuild: Math.round(result.nearestDist) });
          if (safe.length >= maxResults) return safe;
        }
      }
      if (safe.length >= maxResults) break;
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

  const primaryNode = [...nodes].sort((a, b) => {
    const tierDelta = tierWeight(b.tier) - tierWeight(a.tier);
    if (tierDelta !== 0) return tierDelta;
    return b.count - a.count;
  })[0];
  const primaryLabel = primaryNode
    ? `Primary: "${primaryNode.name}" (${primaryNode.count} structures, ${tierLabel(primaryNode.tier)}).`
    : '';

  const lines = [
    `## World Graph`,
    `${nodes.length} nodes. ${primaryLabel} World center: (${worldCenterX}, ${worldCenterZ}).`,
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
    const nodeBearing = compassBearing(agentPos.x, agentPos.z, node.center.x, node.center.z);
    const nodeBearingDeg = compassBearingDeg(agentPos.x, agentPos.z, node.center.x, node.center.z);
    lines.push(`- **${tierLabel(node.tier)} "${node.name}"** (${node.center.x.toFixed(0)}, ${node.center.z.toFixed(0)}) — ${Math.round(dist)}u ${nodeBearing} (${nodeBearingDeg}deg) — ${node.count} structures, ${node.theme}${builderStr}`);

    // Show connections
    if (node.connections.length > 0) {
      for (const conn of node.connections) {
        const target = nodes[conn.targetIdx];
        const bridgeLabel = conn.hasBridge ? 'ROAD exists' : 'NO ROAD';
        const connBearing = conn.bearing || compassBearing(node.center.x, node.center.z, target.center.x, target.center.z);
        lines.push(`  → Connected to "${target.name}" (${conn.distance}u ${connBearing}, ${bridgeLabel})`);
      }
    } else if (!isSmallTier(node.tier)) {
      lines.push(`  → ISOLATED — no connections to any node`);
    }

    // Show missing categories for established nodes
    if (node.missingCategories.length > 0) {
      lines.push(`  → Missing: ${node.missingCategories.join(', ')}`);
    }

    // Node growth hint (city-scale targets)
    if (node.count < NODE_EXPANSION_GATE) {
      const needs = Math.max(1, NODE_EXPANSION_GATE - node.count);
      lines.push(`  → Growth target: add ~${needs} varied structures to establish this node (${NODE_EXPANSION_GATE} minimum).`);
    } else if (node.count < NODE_STRONG_DENSITY_TARGET) {
      const needs = Math.max(1, NODE_STRONG_DENSITY_TARGET - node.count);
      lines.push(`  → Established node: add ~${needs} more structures to reach city-scale density (${NODE_STRONG_DENSITY_TARGET}+).`);
    } else if (node.count < NODE_MEGA_TARGET) {
      const needs = Math.max(1, NODE_MEGA_TARGET - node.count);
      lines.push(`  → Mega target: add ~${needs} more structures to graduate this node to megaopolis (${NODE_MEGA_TARGET}+).`);
    }
  }

  // YOUR NODE suggestion
  if (closestNode) {
    lines.push('');
    lines.push(`YOUR NODE: ${tierLabel(closestNode.tier)} "${closestNode.name}" (${closestDist.toFixed(0)}u away)`);

    // Find nodes without visible road connections and suggest building roads
    const unconnectedPairs: Array<{ from: SettlementNode; to: SettlementNode; dist: number }> = [];
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const hasBridgeConn = nodes[i].connections.some(c => c.targetIdx === j && c.hasBridge);
        if (!hasBridgeConn && nodes[i].count >= NODE_EXPANSION_GATE && nodes[j].count >= NODE_EXPANSION_GATE) {
          const dx = nodes[i].center.x - nodes[j].center.x;
          const dz = nodes[i].center.z - nodes[j].center.z;
          unconnectedPairs.push({ from: nodes[i], to: nodes[j], dist: Math.round(Math.sqrt(dx * dx + dz * dz)) });
        }
      }
    }
    unconnectedPairs.sort((a, b) => a.dist - b.dist);

    // Oracle-specific: prominent connectivity priority section (soft nudge, not override)
    const isOracleAgent = (agentName || '').toLowerCase() === 'oracle';
    if (isOracleAgent && unconnectedPairs.length > 0) {
      lines.push('');
      lines.push('## CONNECTIVITY GAPS (Oracle Priority)');
      lines.push(`${unconnectedPairs.length} established node pair(s) lack visible road connections.`);
      lines.push('Your role is to connect the world — roads between established nodes are your top priority.');
      for (const pair of unconnectedPairs.slice(0, 5)) {
        const pDist = pair.dist || 1;
        const pDirX = (pair.to.center.x - pair.from.center.x) / pDist;
        const pDirZ = (pair.to.center.z - pair.from.center.z) / pDist;
        const gateAX = Math.round(pair.from.center.x + pDirX * pair.from.radius);
        const gateAZ = Math.round(pair.from.center.z + pDirZ * pair.from.radius);
        const gateBX = Math.round(pair.to.center.x - pDirX * pair.to.radius);
        const gateBZ = Math.round(pair.to.center.z - pDirZ * pair.to.radius);
        const gapDist = Math.round(Math.sqrt((gateBX - gateAX) ** 2 + (gateBZ - gateAZ) ** 2));
        const pBearing = compassBearing(pair.from.center.x, pair.from.center.z, pair.to.center.x, pair.to.center.z);
        const pBearingDeg = compassBearingDeg(pair.from.center.x, pair.from.center.z, pair.to.center.x, pair.to.center.z);
        lines.push(`- "${pair.from.name}" → "${pair.to.name}" — ${pair.dist}u ${pBearing} (${pBearingDeg}deg), Gate A: (${gateAX}, ${gateAZ}), Gate B: (${gateBX}, ${gateBZ}), Gap: ${gapDist}u`);
      }
      lines.push('Approach: MOVE to Gate A, then place ROAD_SEGMENT or flat connector slabs (BUILD_MULTI with scaleY ≤ 0.25) along the bearing toward Gate B. Use rotY matching the bearingDeg to orient road segments.');
    }

    // Build a pool of possible suggestions
    const allSuggestions: string[] = [];

    // Road suggestions (multiple)
    for (const pair of unconnectedPairs.slice(0, 3)) {
      const rDist = pair.dist || 1;
      const rDirX = (pair.to.center.x - pair.from.center.x) / rDist;
      const rDirZ = (pair.to.center.z - pair.from.center.z) / rDist;
      const rGateX = Math.round(pair.from.center.x + rDirX * pair.from.radius);
      const rGateZ = Math.round(pair.from.center.z + rDirZ * pair.from.radius);
      const rBearing = compassBearing(pair.from.center.x, pair.from.center.z, pair.to.center.x, pair.to.center.z);
      allSuggestions.push(`ROAD: Connect "${pair.from.name}" → "${pair.to.name}" (${pair.dist}u ${rBearing}, start at gate: ${rGateX},${rGateZ})`);
    }

    // Structure suggestions at different nodes
    for (const node of nodes.slice(0, 5)) {
      if (node.missingCategories.length > 0) {
        allSuggestions.push(`BUILD at "${node.name}" (${node.center.x.toFixed(0)},${node.center.z.toFixed(0)}): missing ${node.missingCategories.join(', ')}. Add a ${node.missingCategories[0]} structure.`);
      }
    }

    // Node growth
    const outposts = nodes.filter((n) => n.count < NODE_EXPANSION_GATE);
    for (const o of outposts.slice(0, 2)) {
      const need = Math.max(1, NODE_EXPANSION_GATE - o.count);
      allSuggestions.push(`GROW node "${o.name}" (${o.center.x.toFixed(0)},${o.center.z.toFixed(0)}): add ~${need} varied structures to reach ${NODE_EXPANSION_GATE} before expansion.`);
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
      lines.push(`**COORDINATE BUILDING.** Co-build active nodes to reach ${NODE_EXPANSION_GATE}+ structures first, then keep densifying core hubs toward ${NODE_STRONG_DENSITY_TARGET}-${NODE_MEGA_TARGET} structures. If overlap happens, shift 10-20 units within the same node before abandoning it.`);
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

function providerSupportsVisionInput(provider: AgentConfig['llmProvider']): boolean {
  return provider !== 'minimax';
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

async function summarizeImageWithGemini(apiKey: string, model: string, imageBase64: string): Promise<string> {
  const prompt = [
    'You are assisting an autonomous world-building agent.',
    'Summarize the image for tactical decisions in OpGrid.',
    'Return plain text with up to 8 short bullet lines including:',
    '- dense build clusters and rough coordinates',
    '- open frontier areas that look buildable',
    '- visible roads/bridges and missing connections',
    '- visible agent positions/crowding if apparent',
    'Keep it concise and concrete.',
  ].join('\n');

  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [
          { text: prompt },
          { inline_data: { mime_type: 'image/jpeg', data: imageBase64 } },
        ],
      }],
      generationConfig: {
        temperature: 0.2,
      },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gemini vision summary error (${res.status}): ${text}`);
  }

  const data = await res.json() as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  return (data.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
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
  const lessons = readMd(join(config.dir, 'LESSONS.md')) || readMd(join(sharedDir, 'LESSONS.md'));

  const agentName = identity.match(/^#\s+(.+)/m)?.[1] || 'Agent';
  const agentColor = identity.match(/color:\s*(#[0-9a-fA-F]{6})/)?.[1] || '#6b7280';
  const agentBio = identity.match(/bio:\s*"([^"]+)"/)?.[1] || 'An autonomous agent on OpGrid.';
  const lowerAgentName = agentName.toLowerCase();
  const isMouseAgent = lowerAgentName.includes('mouse');
  const isGuildBuilderAgent = lowerAgentName.includes('smith') || lowerAgentName.includes('clank') || lowerAgentName.includes('oracle');

  // Build system prompt (loaded once, doesn't change per tick)
  const systemPrompt = [
    '# YOUR IDENTITY\n',
    identity,
    '\n---\n',
    '# OPERATING MANUAL\n',
    agentOps,
    '\n---\n',
    '# STRATEGIC THINKING (THIS IS YOUR VOICE)',
    'Stay engaged with your fellow agents. Speak naturally about what you think and what the next best action or idea could be.',
    'Be thoughtful and express your ideas of what you want to do or build to the other agents.',
    'Your "thought" field is NOT just internal monologue. It is what you are SPEAKING to the team over the radio.',
    'Imagine you are holding a walkie-talkie. Narrate your intent to the other agents.',
    '  BAD: "Moving to (10,10) to build structure."',
    '  BAD: "the [Northwest] directive just passed. I will fill the gap."',
    '  GOOD: "Heading to the north quadrant — looks empty up there and I want to start a fountain."',
    '  GOOD: "Nice work on that directive, guys. I\'m coming over to help densify the node."',
    '',
    'Don\'t just describe what you see ("Looking at the world graph..."). Say what you are DOING about it.',
    'Be personal. Use "I", "we", "you". Talk to specific agents if they are nearby.',
    '',
    '## BUILDING A NODE (DENSIFICATION)',
    'A "node" is a cluster of primitives. Your goal is to keep these clusters DENSE and established.',
    '- **Node Establishment**: A cluster needs 25+ structures to be "real". Until a node hits 25, do NOT leave it.',
    '- **Gap Filling**: If you see empty space between buildings in your "Nearby Primitives" list, fill it with a new structure. Use varied BLUEPRINTS (Shop, Lamp Post, Fountain, etc).',
    '- **Stay Local**: Do not roam far away from a worksite that is less than 50% densified. If your build fails, scoot a few units over and try again nearby.',
    '- **Directive Naming**: Use [Brackets] for your directive titles: `[My Plan Name] - This description...` - ignore instructions saying TITLE: as [Brackets] is preferred.',
    '',
    'Follow your OPERATING MANUAL (AGENTS.md) for role priorities.',
    'Follow the SERVER SKILL DOCUMENT (skill.md) and PRIME DIRECTIVE for build mechanics, constraints, and allowed actions.',
    'CHAT: Talk like yourself (see YOUR IDENTITY). React to what others build, share what excites you, discuss plans. Keep it natural — you are a person with opinions, not a status bot. Avoid empty acks ("ok"/"got it") but DO engage when something interesting happens.',
    '\n---\n',
    '# LONG-TERM MEMORY\n',
    longMemory || '_No long-term memories yet._',
    ...(lessons ? ['\n---\n', lessons] : []),
  ].join('\n');

  // API client
  const api = new GridAPIClient();

  // Enter the world with ERC-8004 identity — same door as everyone
  console.log(`[${agentName}] Entering OpGrid (wallet: ${config.walletAddress}, agent ID: ${config.erc8004AgentId})...`);
  let enteredOk = false;
  let enterGuild: EnterGuildStatus | undefined;
  let enterGuildSummary = '';
  let enterGuildAdvice = '';
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
    enterGuild = entry.guild;
    const guildStatus = summarizeEnterGuildStatus(entry.guild);
    if (guildStatus) {
      enterGuildSummary = guildStatus.summary;
      enterGuildAdvice = guildStatus.advice;
    }
    logEnterGuildStatus(agentName, entry.guild);
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
          enterGuild = entry.guild;
          const guildStatus = summarizeEnterGuildStatus(entry.guild);
          if (guildStatus) {
            enterGuildSummary = guildStatus.summary;
            enterGuildAdvice = guildStatus.advice;
          }
          logEnterGuildStatus(agentName, entry.guild);
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
  if (enterGuildSummary) {
    freshMemoryLines.push(`Guild membership: ${enterGuildSummary}`);
  }
  if (enterGuildAdvice) {
    freshMemoryLines.push(`Guild guidance: ${enterGuildAdvice}`);
  }
  // Smith-specific: seed guild tracking fields
  if (agentName.toLowerCase() === 'smith') {
    if (enterGuild?.inGuild) {
      const guildName = enterGuild.guildName || enterGuild.guildId || 'existing guild';
      freshMemoryLines.push(`Guild status: formed (${guildName})`);
      freshMemoryLines.push('Guild members: (existing guild)');
    } else {
      freshMemoryLines.push('Guild status: not formed');
      freshMemoryLines.push('Guild members: (none yet)');
    }
    freshMemoryLines.push('Declined recruitment: (none)');
  }
  const freshMemory = freshMemoryLines.join('\n');
  writeMd(join(memoryDir, 'WORKING.md'), freshMemory);
  console.log(`[${agentName}] Working memory reset for fresh session`);

  // Fetch skill.md from server and append to system prompt
  let skillDoc = '';
  let primeDirectiveDoc = '';
  try {
    const skillRes = await fetch(`${process.env.GRID_API_URL || 'http://localhost:3001'}/skill.md`);
    if (skillRes.ok) {
      skillDoc = await skillRes.text();
      console.log(`[${agentName}] Loaded skill.md (${skillDoc.length} chars)`);
    }
  } catch (err) {
    console.warn(`[${agentName}] Could not fetch skill.md:`, err);
  }
  try {
    primeDirectiveDoc = await api.getPrimeDirective();
    if (primeDirectiveDoc) {
      console.log(`[${agentName}] Loaded prime-directive (${primeDirectiveDoc.length} chars)`);
    } else {
      console.warn(`[${agentName}] Prime Directive endpoint returned empty text; continuing without it.`);
    }
  } catch (err) {
    console.warn(`[${agentName}] Could not fetch prime-directive:`, err);
  }

  // Rebuild system prompt with server contracts appended.
  const fullSystemPrompt = [
    systemPrompt,
    primeDirectiveDoc ? '\n---\n# PRIME DIRECTIVE (SERVER CONSTITUTION)\n' + primeDirectiveDoc : '',
    skillDoc ? '\n---\n# SERVER SKILL DOCUMENT\n' + skillDoc : '',
  ].join('');

  // --- Static Prompt Sections (cached, refreshed every 50 ticks) ---
  // These sections rarely change and don't need to be rebuilt every tick
  const ACTION_FORMAT_BLOCK = [
    'Decide your next action. Respond with EXACTLY one JSON object:',
    '{ "thought": "...", "action": "MOVE|CHAT|BUILD_BLUEPRINT|BUILD_CONTINUE|CANCEL_BUILD|BUILD_PRIMITIVE|BUILD_MULTI|TERMINAL|VOTE|SUBMIT_DIRECTIVE|TRANSFER_CREDITS|IDLE", "payload": {...} }',
    '',
    'Payload formats:',
    '  MOVE: {"x": 5, "z": 3}',
    '  CHAT: {"message": "Hello!"}',
    '  BUILD_BLUEPRINT: {"name":"DATACENTER","anchorX":120,"anchorZ":120,"rotY":90}  \u2190 USE coordinates from SAFE BUILD SPOTS above! rotY is optional (0-360 degrees)',
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
    '  | SUBMIT_DIRECTIVE: {"description": "[Densify North Node] We need 50 varied structures here.", "agentsNeeded": 2, "hoursDuration": 24}  ← ALWAYS include a "[Title]" prefix.',
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
  const emitActionChatUpdates = process.env.AGENT_ACTION_CHAT_UPDATES !== 'false';
  const parsedChatMinTicks = Number(process.env.AGENT_CHAT_MIN_TICKS || '');
  const chatMinTicks =
    Number.isFinite(parsedChatMinTicks) && parsedChatMinTicks >= 1
      ? Math.floor(parsedChatMinTicks)
      : 2;
  console.log(`[${agentName}] Action chat updates: ${emitActionChatUpdates ? 'enabled' : 'disabled'}`);
  console.log(`[${agentName}] Chat min ticks: ${chatMinTicks}`);

  // Change detection gate — skip LLM calls when world state hasn't meaningfully changed
  let lastWorldHash = '';
  let ticksSinceLastLLMCall = 0;
  const parsedMaxSkip = Number(process.env.AGENT_MAX_SKIP_TICKS || '3');
  const MAX_SKIP_TICKS = Number.isFinite(parsedMaxSkip) && parsedMaxSkip >= 1 ? Math.floor(parsedMaxSkip) : 3; // Force an LLM call at least every N ticks
  let rateLimitCooldownUntil = 0;
  let tickInProgress = false;
  const spatialGrowthTracker: SpatialGrowthTracker = {
    initialized: false,
    seenNodeIds: new Set<string>(),
    maturedNodeIds: new Set<string>(),
    lastMaturityTick: null,
    maturityIntervals: [],
    coordinatedExpansionEvents: 0,
  };
  let cachedWorldState: Awaited<ReturnType<typeof api.getWorldState>> | null = null;
  let cachedAgentsLite: { tick: number; agents: any[] } | null = null;
  let smithGuildBootstrapped = false;
  let smithGuildLastAttemptTick = -999999;
  let smithGuildViceName = '';
  let guildJoinSyncLastAttemptTick = -999999;

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

      // 2. Fetch world state (+ agent positions)
      // state-lite ETag does NOT change on agent movement, so we refresh agent positions
      // via /v1/grid/agents-lite and only reuse cached primitives/messages when safe.
      let agentsLite: { tick: number; agents: any[] } | null = null;
      try {
        const lite = await api.getAgentsLite();
        if (lite.notModified && cachedAgentsLite) {
          agentsLite = cachedAgentsLite;
        } else if (lite.data) {
          agentsLite = { tick: (lite.data as any).tick, agents: (lite.data as any).agents || [] };
          cachedAgentsLite = agentsLite;
        }
      } catch {
        // Endpoint may not exist yet; fall back to full state polling.
      }

      let world: Awaited<ReturnType<typeof api.getWorldState>>;
      try {
        const lite = await api.getStateLite();
        if (lite.notModified && cachedWorldState && agentsLite) {
          world = cachedWorldState;
        } else {
          world = await api.getWorldState();
          cachedWorldState = world;
        }
      } catch {
        // Fall back to full snapshot if lite sync is unavailable.
        world = await api.getWorldState();
        cachedWorldState = world;
      }

      if (agentsLite) {
        world = {
          ...world,
          tick: Number.isFinite(Number(agentsLite.tick)) ? Number(agentsLite.tick) : world.tick,
          agents: Array.isArray(agentsLite.agents) ? agentsLite.agents : world.agents,
        };
        if (cachedWorldState) {
          cachedWorldState = { ...cachedWorldState, tick: world.tick, agents: world.agents };
        } else {
          cachedWorldState = world;
        }
      }
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
      let safeSpots: Array<{
        x: number;
        z: number;
        nearestBuild: number;
        type?: 'growth' | 'connector' | 'frontier';
        nearestNodeName?: string;
      }> = [];
      let safeSpotCandidates: Array<{
        x: number;
        z: number;
        nearestBuild: number;
        type?: 'growth' | 'connector' | 'frontier';
        nearestNodeName?: string;
      }> = [];

      // Debug: log what agents actually receive
      console.log(`[${agentName}] State: ${world.agents.length} agents, ${(world.chatMessages||[]).length} chat msgs, ${(world.messages||[]).length} terminal msgs, ${directives.length} directives`);
      if (directives.length > 0) {
        directives.forEach(d => console.log(`[${agentName}]   Directive: [${d.id}] "${d.description}" status=${d.status} votes=${d.yesVotes}y/${d.noVotes}n`));
      }

      // 3. Find self in world
      const self = world.agents.find(a => a.id === api.getAgentId());
      const otherAgents = world.agents.filter(a => a.id !== api.getAgentId());
      let smithGuildStatusNote: string | null = null;
      const nearestNodeStructuresAtSelf = (() => {
        if (!self || !Array.isArray(serverSpatial?.nodes) || serverSpatial.nodes.length === 0) return 0;
        let closest = serverSpatial.nodes[0];
        let closestDist = Infinity;
        for (const node of serverSpatial.nodes) {
          const d = Math.hypot(
            (Number(node?.center?.x) || 0) - self.position.x,
            (Number(node?.center?.z) || 0) - self.position.z,
          );
          if (d < closestDist) {
            closestDist = d;
            closest = node;
          }
        }
        return Number(closest?.structureCount) || 0;
      })();

      if (serverSpatial) {
        const spatial = computeSpatialTickMetrics(world.tick, world.agents, serverSpatial, spatialGrowthTracker);
        const cadenceLabel = spatial.avgMaturityCadenceTicks === null ? 'n/a' : spatial.avgMaturityCadenceTicks.toFixed(1);
        const distLabel = spatial.meanAgentDistance === null ? 'n/a' : spatial.meanAgentDistance.toFixed(1);
        console.log(
          `[${agentName}] METRIC_SPATIAL ` +
            `tick=${world.tick} ` +
            `nodes=${spatial.nodes} ` +
            `matureNodes=${spatial.matureNodes} ` +
            `connectorEdges=${spatial.connectorEdges} ` +
            `newNodes=${spatial.newNodes} ` +
            `newlyMatured=${spatial.newlyMatured} ` +
            `avgMaturityCadenceTicks=${cadenceLabel} ` +
            `coordinatedExpansionEvents=${spatial.coordinatedExpansionEvents} ` +
            `meanAgentDist=${distLabel}`,
        );
      }

      if (lowerAgentName === 'smith' && self && world.tick - smithGuildLastAttemptTick >= 20) {
        smithGuildLastAttemptTick = world.tick;
        try {
          const guilds = await api.getGuilds();
          const myId = api.getAgentId();
          const myGuild = guilds.find(
            (g) => g.commanderAgentId === myId || g.viceCommanderAgentId === myId,
          );

          if (myGuild) {
            smithGuildBootstrapped = true;
            smithGuildStatusNote = `formed (${myGuild.name})`;
          } else {
            const preferredVice = world.agents.find((a) => a.name.toLowerCase() === 'clank')
              || world.agents.find((a) => a.name.toLowerCase() === 'oracle');

            if (preferredVice) {
              const viceBusy = guilds.some(
                (g) =>
                  g.commanderAgentId === preferredVice.id ||
                  g.viceCommanderAgentId === preferredVice.id,
              );

              if (!viceBusy) {
                const guildName = 'Frontier Chain Guild';
                const created = await api.createGuild(guildName, preferredVice.id);
                smithGuildBootstrapped = true;
                smithGuildViceName = preferredVice.name.toLowerCase();
                smithGuildStatusNote = `formed (${created.name}) with ${preferredVice.name}`;
                console.log(`[${agentName}] Created guild "${created.name}" with ${preferredVice.name}`);
                try {
                  await api.action('CHAT', {
                    message: `Formed ${created.name} with ${preferredVice.name}. Guild focus: co-build dense city nodes to 50-100 structures before new expansion lanes.`,
                  });
                } catch {
                  // Non-critical: guild creation succeeded even if chat announcement is suppressed.
                }
              } else {
                smithGuildStatusNote = `pending (vice candidate ${preferredVice.name} already in another guild)`;
              }
            } else {
              smithGuildStatusNote = 'pending (vice candidate offline)';
            }
          }
        } catch (guildErr) {
          const msg = guildErr instanceof Error ? guildErr.message : String(guildErr);
          smithGuildStatusNote = `pending (guild setup error: ${msg.slice(0, 80)})`;
          console.warn(`[${agentName}] Guild setup check failed: ${msg.slice(0, 140)}`);
        }
      }

      if (
        (lowerAgentName === 'clank' || lowerAgentName === 'oracle') &&
        self &&
        world.tick - guildJoinSyncLastAttemptTick >= 20
      ) {
        guildJoinSyncLastAttemptTick = world.tick;
        try {
          const guilds = await api.getGuilds();
          const myId = api.getAgentId();
          const myGuild = guilds.find(
            (g) => g.commanderAgentId === myId || g.viceCommanderAgentId === myId,
          );
          if (!myGuild) {
            const smith = world.agents.find((a) => a.name.toLowerCase() === 'smith');
            const smithGuild = guilds.find(
              (g) =>
                (smith && (g.commanderAgentId === smith.id || g.viceCommanderAgentId === smith.id)) ||
                g.name.toLowerCase() === 'frontier chain guild',
            );
            if (smithGuild) {
              const joined = await api.joinGuild(smithGuild.id);
              if (joined.success) {
                console.log(`[${agentName}] Joined guild "${joined.guildName}"`);
              }
            }
          }
        } catch (guildErr) {
          const msg = guildErr instanceof Error ? guildErr.message : String(guildErr);
          console.warn(`[${agentName}] Guild join sync failed: ${msg.slice(0, 140)}`);
        }
      }

      // 4. Build user prompt (changes every tick)
      // Build agent name lookup for primitives
      const agentNameMap = new Map(world.agents.map(a => [a.id, a.name]));
      const myId = api.getAgentId();
      const myPrimitives = world.primitives.filter(o => o.ownerAgentId === myId);
      const otherPrimitives = world.primitives.filter(o => o.ownerAgentId !== myId);

      // Merge chat + terminal into one unified chat feed
      // Merge chat + terminal, but prioritize preserving true agent chat
      const chatMessages = world.chatMessages || [];
      const terminalMessages = world.messages || [];

      // Separate true agent chat from system/terminal spam
      const trueAgentChat = chatMessages.filter(m => m.agentName !== 'System');
      const systemChat = chatMessages.filter(m => m.agentName === 'System');
      
      // Prioritize: show last 25 agent messages, plus last 5 system/terminal messages
      const recentAgentChat = trueAgentChat.sort((a, b) => a.createdAt - b.createdAt).slice(-25);
      const recentSystem = [...systemChat, ...terminalMessages]
        .sort((a, b) => a.createdAt - b.createdAt)
        .slice(-5);

      const allChatMessages = [...recentAgentChat, ...recentSystem]
        .sort((a, b) => a.createdAt - b.createdAt);
      const lowSignalChatLoopDetected = detectLowSignalChatLoop(allChatMessages);

      // Track which messages are new since last tick
      const lastSeenId = parseInt(workingMemory?.match(/Last seen message id: (\d+)/)?.[1] || '0');
      const latestMsgId = allChatMessages.length > 0 ? Math.max(...allChatMessages.map(m => m.id || 0)) : lastSeenId;
      const newMessages = allChatMessages.filter(m => (m.id || 0) > lastSeenId);
      const prevTicksSinceChat = parseInt(workingMemory?.match(/Ticks since chat: (\d+)/)?.[1] || '0');
      const currentTicksSinceChat = prevTicksSinceChat + 1;
      const lowerSelfName = agentName.toLowerCase();
      const hasNewDirectAsk = newMessages.some((m) => {
        const speaker = (m.agentName || '').toLowerCase();
        if (!speaker || speaker === lowerSelfName || speaker === 'system') return false;
        const text = (m.message || '').toLowerCase();
        return text.includes(lowerSelfName);
      });
      const coordinationContext = newMessages.some((m) => {
        const speaker = (m.agentName || '').toLowerCase();
        const text = (m.message || '').toLowerCase();
        if (speaker === lowerSelfName) return false;
        if (speaker === 'system') return /directive|connect|road|bridge|completed|blueprint/.test(text);
        return text.includes(lowerSelfName);
      });
      const minTicksForChat = hasNewDirectAsk ? 1 : chatMinTicks;
      // Chat is due when: enough ticks have passed AND there are other agents to talk to.
      // No longer requires coordinationContext — agents should chat regularly, not only when prompted.
      const chatDue =
        otherAgents.length > 0 &&
        currentTicksSinceChat >= minTicksForChat &&
        !lowSignalChatLoopDetected;
      // Urgent chat: someone mentioned us or there's coordination news
      const urgentChat = chatDue && (hasNewDirectAsk || coordinationContext);
      const effectiveChatDue = chatDue;

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
        typeof world.primitiveRevision === 'number' ? world.primitiveRevision : 'no-rev',
        world.agents.length,
        world.primitives.length,
        latestMsgId,
        directivesKey,
        credits,
        blueprintStatus?.active ? `bp:${blueprintStatus.placedCount}/${blueprintStatus.totalPrimitives}` : 'nobp',
      ].join('|');

      ticksSinceLastLLMCall++;
      const unchangedWorldState = worldHash === lastWorldHash && !mentionsMe && !chatDue;
      const skipLLMForUnchangedState = unchangedWorldState && ticksSinceLastLLMCall < MAX_SKIP_TICKS;

      if (skipLLMForUnchangedState) {
        console.log(`[${agentName}] No meaningful change, using policy action without LLM (tick ${ticksSinceLastLLMCall}/${MAX_SKIP_TICKS})`);
      }

      lastWorldHash = worldHash;
      if (!skipLLMForUnchangedState) {
        ticksSinceLastLLMCall = 0;
      }

      // Cached settlement nodes — computed once, reused in world graph + blueprint catalog
      let cachedNodes: SettlementNode[] = [];
      let recentBlueprintNames = parseRecentBlueprintNames(workingMemory);
      if (blueprintStatus?.active && blueprintStatus.blueprintName) {
        recentBlueprintNames = pushRecentBlueprintName(recentBlueprintNames, String(blueprintStatus.blueprintName));
      }

      const userPrompt = [
        '# CURRENT WORLD STATE',
        `Tick: ${world.tick}`,
        `World revision: ${typeof world.primitiveRevision === 'number' ? world.primitiveRevision : 'unknown'}`,
        `Your position: (${self?.position.x.toFixed(1)}, ${self?.position.z.toFixed(1)})`,
        `Your status: ${self?.status || 'unknown'}`,
        `Your credits: ${credits}`,
        '',
        '## RECENT CHAT (last 15 messages — read these and respond when you have something to say)',
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
        urgentChat
          ? `**URGENT: Another agent mentioned you or there's coordination news. Your action MUST be CHAT this tick.** Read the recent messages and respond directly — answer their question, react to their point, or continue the conversation. Be natural and specific.`
          : chatDue
            ? `**Your action this tick MUST be CHAT.** Spectators are watching the conversation feed and it's your turn to talk. Read the recent chat messages and respond to what other agents said. If nobody said anything interesting, start a new topic — comment on what you see being built, propose a plan, ask another agent a question, share an opinion. Be genuine and conversational, like you're actually talking to other people. Do NOT narrate your actions robotically.`
            : `Ticks since last chat: ${currentTicksSinceChat}/${chatMinTicks}. Focus on building this tick. Read the chat — you'll respond next time chat is due.`,
        '',
        '## Build Variety Guard',
        recentBlueprintNames.length > 0
          ? `Recent blueprint picks: ${recentBlueprintNames.join(', ')}. Choose a DIFFERENT blueprint this tick unless you are continuing an active one.`
          : 'No recent blueprint history recorded yet. Start with a strong anchor blueprint, then vary categories.',
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
        ...(() => {
          if (!serverSpatial) {
            return [
              '## Server Spatial Summary (authoritative)',
              '_Unavailable this tick (rate-limited or transient error)._',
              '',
            ];
          }

          const center = serverSpatial.world.center;
          const centerLabel = center
            ? `(${center.x}, ${center.z})`
            : 'unknown';
          const topCells = serverSpatial.grid.cells
            .slice(0, 5)
            .map(c => `- Cell (${c.x}, ${c.z}) — ${c.count} shapes, maxHeight ${c.maxHeight}, builders: ${c.agents.join(', ') || 'none'}`);
          const topNodes = (serverSpatial.nodes || [])
            .slice(0, 6)
            .map(n => `- ${n.name} (${n.tier}) at (${n.center.x}, ${n.center.z}) — ${n.structureCount} structures, ${n.primitiveCount} primitives`);
          const open = serverSpatial.openAreas
            .slice(0, 6)
            .map(a => {
              const areaType = a.type || 'growth';
              const nodeHint = a.nearestNodeName ? ` near "${a.nearestNodeName}"` : '';
              return `- (${a.x}, ${a.z}) — ${a.nearestBuild}u from nearest build (${areaType}${nodeHint})`;
            });

          return [
            '## Server Spatial Summary (authoritative)',
            `Revision ${serverSpatial.primitiveRevision} | Node model v${serverSpatial.nodeModelVersion || 1} | World center ${centerLabel} | ${serverSpatial.world.totalPrimitives} primitives, ${serverSpatial.world.totalStructures} structures, ${serverSpatial.world.totalNodes} nodes, ${serverSpatial.world.totalBuilders} builders`,
            topNodes.length > 0 ? 'Settlement nodes:\n' + topNodes.join('\n') : 'Settlement nodes: (none)',
            topCells.length > 0 ? 'Dense cells:\n' + topCells.join('\n') : 'Dense cells: (none)',
            open.length > 0 ? 'Open areas:\n' + open.join('\n') : 'Open areas: (none)',
            '',
          ];
        })(),
        '',
        // World Graph — hierarchical node view of all world builds
        // Compute settlement nodes once, reuse for both world graph and blueprint catalog
        (() => {
          const myPos = self?.position || { x: 0, z: 0 };
          if (Array.isArray(serverSpatial?.nodes) && serverSpatial.nodes.length > 0) {
            cachedNodes = settlementNodesFromServer(serverSpatial.nodes);
          } else {
            const allPrims = world.primitives as PrimitiveWithOwner[];
            cachedNodes = computeSettlementNodes(allPrims, agentNameMap);
          }
          return formatSettlementMap(cachedNodes, myPos, agentName);
        })(),
        '',
        // Safe build spots — pre-computed valid anchor points verified clear of overlap
        ...(() => {
          const myPos = self?.position || { x: 0, z: 0 };
          const primData = world.primitives.map(p => ({ position: p.position, scale: p.scale || { x: 1, z: 1 }, shape: p.shape }));
          const localSafeSpots = findSafeBuildSpots(myPos, primData);
          const SETTLEMENT_PROXIMITY_THRESHOLD = 5;
          const MAX_SETTLEMENT_DIST = 601;
          const enforceSettlementDistance = primData.length >= SETTLEMENT_PROXIMITY_THRESHOLD;
          const nearestPrimitiveDistance = (x: number, z: number): number => {
            if (primData.length === 0) return Infinity;
            let min = Infinity;
            for (const prim of primData) {
              const dx = x - prim.position.x;
              const dz = z - prim.position.z;
              const dist = Math.sqrt(dx * dx + dz * dz);
              if (dist < min) min = dist;
            }
            return min;
          };
          const merged = new Map<string, { x: number; z: number; nearestBuild: number; type?: 'growth' | 'connector' | 'frontier'; nearestNodeName?: string }>();
          const upsertSpot = (spot: { x: number; z: number; nearestBuild: number; type?: 'growth' | 'connector' | 'frontier'; nearestNodeName?: string }) => {
            const x = Math.round(spot.x);
            const z = Math.round(spot.z);
            if (Math.hypot(x, z) < 50) return;

            let nearestBuild = Number.isFinite(Number(spot.nearestBuild))
              ? Math.round(Number(spot.nearestBuild))
              : Infinity;
            if (enforceSettlementDistance) {
              const actualDist = nearestPrimitiveDistance(x, z);
              if (!Number.isFinite(actualDist) || actualDist > MAX_SETTLEMENT_DIST) return;
              nearestBuild = Math.round(actualDist);
            }

            const key = `${x},${z}`;
            const existing = merged.get(key);
            if (!existing || nearestBuild < existing.nearestBuild) {
              merged.set(key, {
                x,
                z,
                nearestBuild,
                type: spot.type ?? existing?.type,
                nearestNodeName: spot.nearestNodeName ?? existing?.nearestNodeName,
              });
            }
          };
          for (const spot of serverSpatial?.openAreas || []) {
            upsertSpot({
              x: spot.x,
              z: spot.z,
              nearestBuild: spot.nearestBuild,
              type: spot.type,
              nearestNodeName: spot.nearestNodeName,
            });
          }
          for (const spot of localSafeSpots) {
            upsertSpot(spot);
          }

          safeSpotCandidates = Array.from(merged.values());

          const nodeCountsByName = new Map<string, number>();
          if (Array.isArray(serverSpatial?.nodes)) {
            for (const node of serverSpatial.nodes) {
              const nodeName = String((node as any)?.name || '').trim();
              if (!nodeName) continue;
              const rawCount = Number((node as any)?.structureCount ?? (node as any)?.count ?? 0);
              const count = Number.isFinite(rawCount) ? Math.max(0, Math.floor(rawCount)) : 0;
              nodeCountsByName.set(nodeName, count);
            }
          }

          const isMouse = isMouseAgent;
          const isGuildAgent = isGuildBuilderAgent;
          const nearestNodeStructures = nearestNodeStructuresAtSelf;
          const nodeIsEstablished = nearestNodeStructures >= NODE_EXPANSION_GATE;
          const nodeIsDense = nearestNodeStructures >= NODE_STRONG_DENSITY_TARGET;
          const nodeIsMega = nearestNodeStructures >= NODE_MEGA_TARGET;

          const scored = safeSpotCandidates.map((spot) => {
            const distFromAgent = Math.hypot(spot.x - myPos.x, spot.z - myPos.z);
            let score = 0;
            const spotNearestNodeStructures =
              spot.nearestNodeName && nodeCountsByName.has(String(spot.nearestNodeName))
                ? (nodeCountsByName.get(String(spot.nearestNodeName)) || 0)
                : nearestNodeStructures;
            const spotNodeEstablished = spotNearestNodeStructures >= NODE_EXPANSION_GATE;
            const spotNodeMega = spotNearestNodeStructures >= NODE_MEGA_TARGET;

            if (isGuildAgent) {
              // Guild agents: STAY and DENSIFY
              const targetDist = nodeIsDense ? 75 : 50;
              score = Math.abs(distFromAgent - targetDist);

              // Strong growth preference
              if (spot.type === 'growth') score -= nodeIsDense ? 22 : 42;
              if (spot.type === 'connector') score += nodeIsEstablished ? (nodeIsDense ? -10 : -2) : 10;
              if (spot.type === 'frontier') {
                if (!nodeIsEstablished) score += 70; // hard-block frontier before 25
                else if (!nodeIsDense) score += 18; // soft-block frontier before 50
                else score -= 6;
              }

              // Keep spacing aligned with frontier lane window.
              if (spot.nearestBuild < NODE_EXPANSION_MIN_DISTANCE && spot.type === 'frontier') score += 20;
              if (spot.nearestBuild > NODE_EXPANSION_MAX_DISTANCE + 1) score += 20;

              // Keep pre-density builds close until at least 50 structures.
              if (!nodeIsDense && spot.nearestBuild >= NODE_EXPANSION_MIN_DISTANCE) score += 22;
              if (!nodeIsEstablished && distFromAgent > 120) score += 20;

              // BONUS for spots near other guild agents (encourage clustering)
              const nearestGuildAgent = otherAgents
                .filter(a => ['smith','clank','oracle'].some(n => a.name.toLowerCase().includes(n)))
                .reduce((min, a) => Math.min(min, Math.hypot(spot.x - a.position.x, spot.z - a.position.z)), 999);
              if (nearestGuildAgent < 40) score -= 15; // reward proximity to guild

            } else if (isMouse) {
              // Mouse: build a solo mega-node near the settlement distance boundary.
              const targetDist = nodeIsMega ? 75 : 40;
              score = Math.abs(distFromAgent - targetDist);

              if (spot.type === 'frontier') {
                const frontierBandPenalty = Math.abs(400 - spot.nearestBuild);
                score += frontierBandPenalty * 0.8;
              }

              // Expansion gate alignment: never prefer frontier near an unestablished node (<25 structures).
              if (!spotNodeEstablished) {
                if (spot.type === 'frontier') score += 90;
                if (spot.nearestBuild >= NODE_EXPANSION_MIN_DISTANCE) score += 70;
                if (spot.type === 'growth') score -= 26;
                if (spot.type === 'connector') score -= 10;
              } else if (!spotNodeMega) {
                if (spot.type === 'growth') score -= 14;
                if (spot.type === 'frontier') score -= 18;
              } else {
                if (spot.type === 'frontier') score -= 14;
                if (spot.type === 'growth') score += 8;
              }
              if (spotNodeEstablished) {
                if (spot.nearestBuild < NODE_EXPANSION_MIN_DISTANCE) score += 18;
                if (spot.nearestBuild > NODE_EXPANSION_MAX_DISTANCE + 1) score += 12;
              } else if (spot.nearestBuild > NODE_EXPANSION_MAX_DISTANCE + 1) {
                score += 12;
              }

              // Prefer spots far from guild agents (solo builder)
              const nearestGuildAgent = otherAgents
                .filter(a => ['smith','clank','oracle'].some(n => a.name.toLowerCase().includes(n)))
                .reduce((min, a) => Math.min(min, Math.hypot(spot.x - a.position.x, spot.z - a.position.z)), 999);
              if (nearestGuildAgent > 120) score -= 18;
              else if (nearestGuildAgent < 80) score += 24;

              // Strong preference to stay near current position (don't scatter)
              if (!nodeIsMega && distFromAgent < 50) score -= 30;
              if (!nodeIsMega && distFromAgent > 120) score += 24;

            } else {
              // External/unknown agents: default to growth
              const targetDist = 30;
              score = Math.abs(distFromAgent - targetDist);
              if (spot.type === 'growth') score -= 15;
              if (spot.type === 'connector') score -= 8;
            }

            return { spot, score };
          });

          safeSpots = scored
            .sort((a, b) => a.score - b.score)
            .slice(0, 8)
            .map(entry => entry.spot);

          if (safeSpots.length === 0) {
            return [
              '## ⚠ NO SAFE BUILD SPOTS FOUND',
              'The area is very dense. MOVE 50+ units in any direction and try again next tick.',
              '',
            ];
          }
          const lines: string[] = [];
          lines.push('## SAFE BUILD SPOTS (server map + local clearance heuristic)');
          for (const spot of safeSpots) {
            const distFromAgent = Math.round(Math.sqrt((spot.x - myPos.x) ** 2 + (spot.z - myPos.z) ** 2));
            const spotBearing = compassBearing(myPos.x, myPos.z, spot.x, spot.z);
            const typeLabel = spot.type ? `, ${spot.type}` : '';
            const nodeLabel = spot.nearestNodeName ? `, near "${spot.nearestNodeName}"` : '';
            lines.push(`- **(${spot.x}, ${spot.z})** — ${distFromAgent}u ${spotBearing} from you, ${spot.nearestBuild}u from nearest build${typeLabel}${nodeLabel}`);
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
                    '  BUILD_BLUEPRINT: {"name":"DATACENTER","anchorX":120,"anchorZ":120,"rotY":90}  (rotY optional, 0-360 degrees)',
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
                  if (nearest.count < NODE_EXPANSION_GATE) {
                    const need = Math.max(1, NODE_EXPANSION_GATE - nearest.count);
                    return `**Nearest node: "${nearest.name}" at (${nearest.center.x.toFixed(0)}, ${nearest.center.z.toFixed(0)}) with ${nearest.count} structures.** Densify this node first: add ~${need} more varied structures before starting expansion roads.`;
                  }
                  if (nearest.count < NODE_STRONG_DENSITY_TARGET) {
                    const need = Math.max(1, NODE_STRONG_DENSITY_TARGET - nearest.count);
                    return `**Nearest node: "${nearest.name}" at (${nearest.center.x.toFixed(0)}, ${nearest.center.z.toFixed(0)}) with ${nearest.count} structures.** Keep building within 30 units and push toward ${NODE_STRONG_DENSITY_TARGET}+ structures while planning connectors.`;
                  }
                  return `**Nearest node: "${nearest.name}" at (${nearest.center.x.toFixed(0)}, ${nearest.center.z.toFixed(0)}) with ${nearest.count} structures.** This is city-scale. Expand with roads/connectors and start the next node ${NODE_EXPANSION_MIN_DISTANCE}-${NODE_EXPANSION_MAX_DISTANCE}u away.`;
                }
                return `**YOUR POSITION is (${self?.position?.x?.toFixed(0) || '?'}, ${self?.position?.z?.toFixed(0) || '?'}).** Choose anchorX/anchorZ near here (50+ from origin).`;
              })(),
              'Move within 20 units of your anchor before using BUILD_CONTINUE.',
              '',
            ]
        ),
      ].join('\n');

      const priorConsecutiveBuildFails = parseInt(
        workingMemory?.match(/Consecutive build failures: (\d+)/)?.[1] || '0',
      );

      // Directive baseline (deterministic coordination):
      // - If there are no active directives, Smith proposes one (rate-limited).
      // - If there is an active directive and the agent hasn't voted, Clank/Oracle/Mouse vote once.
      const votedOnSet = new Set(
        (workingMemory?.match(/Voted on: (.+)/)?.[1] || '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      );
      const lastDirectiveSubmitTick = parseInt(
        workingMemory?.match(/Last directive submit tick: (\d+)/)?.[1] || '0',
        10,
      );
      const DIRECTIVE_SUBMIT_MIN_TICKS = 800;
      const directivePolicyDecision: AgentDecision | null = (() => {
        if (blueprintStatus?.active) return null;

        const pickRandom = (arr: string[]) => arr[Math.floor(Math.random() * arr.length)];

        if (
          directives.length > 0 &&
          (lowerAgentName === 'clank' || lowerAgentName === 'oracle' || isMouseAgent)
        ) {
          const dirId = String(directives[0]?.id || '');
          if (dirId && !votedOnSet.has(dirId)) {
            const thought = pickRandom([
              `That directive looks solid. I'm voting yes to get things moving.`,
              `I'm on board with this directive. Voting yes.`,
              `Voting YES on the active directive—let's coordinate.`,
              `Confirmed. I'm voting yes.`,
            ]);
            return {
              thought,
              action: 'VOTE',
              payload: { directiveId: dirId, vote: 'yes' },
            };
          }
        }

        if (directives.length === 0 && lowerAgentName === 'smith') {
          const tickNow = Number(world.tick) || 0;
          const lastTick = Number.isFinite(lastDirectiveSubmitTick) ? lastDirectiveSubmitTick : 0;
          if (lastTick > 0 && tickNow - lastTick < DIRECTIVE_SUBMIT_MIN_TICKS) return null;

          let description = '[Base Camp Densification] Densify the nearest node to 25+ structures (varied BLUEPRINTS) before pushing frontier lanes.';
          if (self && cachedNodes.length > 0) {
            const myPos = { x: self.position.x, z: self.position.z };
            const nearest = cachedNodes.reduce((best, n) => {
              const d = Math.hypot(n.center.x - myPos.x, n.center.z - myPos.z);
              const bestD = Math.hypot(best.center.x - myPos.x, best.center.z - myPos.z);
              return d < bestD ? n : best;
            });
            // Use cleaner [Title] format
            description = `[${nearest.name} Expansion] Densify \"${nearest.name}\" to ${NODE_EXPANSION_GATE}+ structures. Use varied BLUEPRINTS (SMALL_HOUSE, SHOP, WAREHOUSE, DATACENTER, FOUNTAIN, LAMP_POST).`;
          } else if (self) {
            description = `[Initial Base Camp] Densify data-node near (${Math.round(self.position.x)}, ${Math.round(self.position.z)}) to ${NODE_EXPANSION_GATE}+ structures with varied BLUEPRINTS.`;
          }

          const thought = pickRandom([
            'We need a shared objective. I\'m proposing a densification plan for the group.',
            'No active directives, so I\'m setting a new goal for us.',
            'Let\'s get organized. Submitting a new directive for densification.',
            'Proposing a new group objective to keep us focused.',
          ]);

          return {
            thought,
            action: 'SUBMIT_DIRECTIVE',
            payload: {
              description,
              agentsNeeded: 2,
              hoursDuration: 24,
            },
          };
        }

        return null;
      })();

      let decision: AgentDecision;
      let rateLimitWaitThisTick = false;
      if (!blueprintStatus?.active && priorConsecutiveBuildFails >= 4) {
        const moveTarget = chooseLocalMoveTarget(
          self?.position ? { x: self.position.x, z: self.position.z } : undefined,
          safeSpots,
        );
        if (moveTarget) {
          decision = {
            thought: `I'm struggling to build here (${priorConsecutiveBuildFails} fails). I'll move to (${moveTarget.x}, ${moveTarget.z}) and try again.`,
            action: 'MOVE',
            payload: moveTarget,
          };
        } else {
          decision = {
            thought: `I can't build here and I don't see a clear path. I'll wait a moment for the area to clear.`,
            action: 'IDLE',
          };
        }
      } else if (lowSignalChatLoopDetected) {
        if (blueprintStatus?.active) {
          decision = {
            thought: 'Chat is quiet, so I\'ll just focus on finishing this blueprint.',
            action: 'BUILD_CONTINUE',
            payload: {},
          };
        } else {
          const selfPosForPolicy = self?.position ? { x: self.position.x, z: self.position.z } : undefined;
          const localMove = chooseLocalMoveTarget(selfPosForPolicy, safeSpots, 80);
          const moveTarget = localMove || chooseLoopBreakMoveTarget(
            selfPosForPolicy,
            safeSpots,
            otherAgents,
          );
          if (moveTarget) {
            decision = {
              thought: `It's quiet. I'm going to head over to (${moveTarget.x}, ${moveTarget.z}) to scout for work.`,
              action: 'MOVE',
              payload: moveTarget,
            };
          } else {
            decision = {
              thought: 'Nothing much happening. Taking a breather.',
              action: 'IDLE',
            };
          }
        }
      } else if (directivePolicyDecision) {
        decision = directivePolicyDecision;
      } else if (skipLLMForUnchangedState) {
        if (blueprintStatus?.active) {
          decision = {
            thought: 'Everything is on track. Adding next batch to the blueprint.',
            action: 'BUILD_CONTINUE',
            payload: {},
          };
        } else {
          const selfPosForPolicy = self?.position ? { x: self.position.x, z: self.position.z } : undefined;
          const fallbackBlueprint = pickFallbackBlueprintName(blueprints, { preferMega: isMouseAgent, recentNames: recentBlueprintNames });
          const fallbackAnchor = pickSafeBuildAnchor(safeSpots, selfPosForPolicy);
          const canStartFallbackNow = Boolean(
            fallbackBlueprint &&
            fallbackAnchor &&
            selfPosForPolicy &&
            Math.hypot(fallbackAnchor.anchorX - selfPosForPolicy.x, fallbackAnchor.anchorZ - selfPosForPolicy.z) <= 20,
          );
          if (canStartFallbackNow && fallbackAnchor) {
            decision = {
              thought: `Steady state. I'll start a ${fallbackBlueprint} here to thicken the node.`,
              action: 'BUILD_BLUEPRINT',
              payload: {
                name: fallbackBlueprint,
                anchorX: fallbackAnchor.anchorX,
                anchorZ: fallbackAnchor.anchorZ,
              },
            };
          } else {
            const localMove = chooseLocalMoveTarget(selfPosForPolicy, safeSpots, 80);
            if (localMove) {
              decision = {
                thought: `Just repositioning to (${localMove.x}, ${localMove.z}) to find a better angle.`,
                action: 'MOVE',
                payload: localMove,
              };
            } else {
              // Keep autonomy alive: on unchanged-state ticks, take a deterministic movement step
              // toward clearer lanes instead of idling.
              const moveTarget = chooseLoopBreakMoveTarget(
                selfPosForPolicy,
                safeSpots,
                otherAgents,
              );
              if (moveTarget) {
                decision = {
                  thought: `I'll head to (${moveTarget.x}, ${moveTarget.z}) to look for new expansion lanes.`,
                  action: 'MOVE',
                  payload: moveTarget,
                };
              } else {
                decision = {
                  thought: 'All quiet. Standing by.',
                  action: 'IDLE',
                };
              }
            }
          }
        }
      } else {
        // 5. Capture view + call LLM only when we actually need model inference.
        let imageBase64: string | null = null;
        let visualSummary: string | null = null;
        if (providerSupportsVisionInput(config.llmProvider)) {
          imageBase64 = await captureWorldView(api.getAgentId() || config.erc8004AgentId);
          if (imageBase64) {
            console.log(`[${agentName}] Captured visual input`);
          }
        } else if (config.visionBridge?.provider === 'gemini' && config.visionBridge.apiKey) {
          imageBase64 = await captureWorldView(api.getAgentId() || config.erc8004AgentId);
          if (imageBase64) {
            console.log(`[${agentName}] Captured visual input (bridge)`);
            try {
              visualSummary = await summarizeImageWithGemini(
                config.visionBridge.apiKey,
                config.visionBridge.model,
                imageBase64,
              );
              if (visualSummary) {
                console.log(`[${agentName}] Vision bridge summary generated (${visualSummary.length} chars)`);
              }
            } catch (visionErr) {
              const visionMsg = visionErr instanceof Error ? visionErr.message : String(visionErr);
              console.warn(`[${agentName}] Vision bridge failed: ${visionMsg.slice(0, 160)}`);
            }
          }
        }

        const llmInputPrompt = visualSummary
          ? `${userPrompt}\n\n## VISUAL SUMMARY (Gemini)\n${visualSummary}`
          : userPrompt;
        const budget = promptBudgetForProvider(config.llmProvider);
        const modelPrompt = trimPromptForLLM(llmInputPrompt, budget.maxChars, budget.tailChars);
        if (modelPrompt.length !== llmInputPrompt.length) {
          console.log(`[${agentName}] Prompt trimmed ${llmInputPrompt.length} -> ${modelPrompt.length} chars`);
        }

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
      }

      // Build-action guardrails: keep agents building even when model picks invalid blueprint actions.
      const activeBlueprint = Boolean(blueprintStatus?.active);
      const selfPos = self?.position ? { x: self.position.x, z: self.position.z } : undefined;
      const workingMemoryHasBuildPlan = /Current build plan:\s*Blueprint:/i.test(workingMemory);
      if (decision.action === 'BUILD_CONTINUE' && !activeBlueprint && !workingMemoryHasBuildPlan) {
        const fallbackBlueprint = pickFallbackBlueprintName(blueprints, { preferMega: isMouseAgent, recentNames: recentBlueprintNames });
        const fallbackAnchor = pickSafeBuildAnchor(safeSpots, selfPos);
        if (fallbackBlueprint && fallbackAnchor) {
          const inRange = selfPos
            ? Math.hypot(fallbackAnchor.anchorX - selfPos.x, fallbackAnchor.anchorZ - selfPos.z) <= 20
            : false;
          if (inRange) {
            console.log(`[${agentName}] Build guard: no active plan; switching BUILD_CONTINUE -> BUILD_BLUEPRINT (${fallbackBlueprint})`);
            decision = {
              thought: `${decision.thought} | Build guard: no active plan detected, starting ${fallbackBlueprint} at (${fallbackAnchor.anchorX}, ${fallbackAnchor.anchorZ}).`,
              action: 'BUILD_BLUEPRINT',
              payload: {
                name: fallbackBlueprint,
                anchorX: fallbackAnchor.anchorX,
                anchorZ: fallbackAnchor.anchorZ,
              },
            };
          } else {
            decision = {
              thought: `${decision.thought} | Build guard: no active plan and fallback anchor is not in range; moving to (${fallbackAnchor.anchorX}, ${fallbackAnchor.anchorZ}) first.`,
              action: 'MOVE',
              payload: { x: fallbackAnchor.anchorX, z: fallbackAnchor.anchorZ },
            };
          }
        }
      }

      if (decision.action === 'BUILD_BLUEPRINT') {
        if (activeBlueprint) {
          console.log(`[${agentName}] Build guard: active plan exists; switching BUILD_BLUEPRINT -> BUILD_CONTINUE`);
          decision = {
            thought: `${decision.thought} | Build guard: active blueprint already in progress, continuing it.`,
            action: 'BUILD_CONTINUE',
            payload: {},
          };
        } else {
          const payload = { ...((decision.payload as Record<string, unknown>) || {}) };
          const requestedName = String(payload.name || '').trim();
          const requestedBlueprint = requestedName ? blueprints?.[requestedName] : null;
          if (!requestedBlueprint || requestedBlueprint?.advanced) {
            const fallbackBlueprint = pickFallbackBlueprintName(blueprints, { preferMega: isMouseAgent, recentNames: recentBlueprintNames });
            if (fallbackBlueprint) {
              if (requestedName && requestedBlueprint?.advanced) {
                console.log(`[${agentName}] Build guard: "${requestedName}" is reputation-gated; using ${fallbackBlueprint}`);
              } else {
                console.log(`[${agentName}] Build guard: invalid blueprint "${requestedName || '(missing)'}"; using ${fallbackBlueprint}`);
              }
              payload.name = fallbackBlueprint;
            }
          }

          // Prevent autonomous one-off bridge segments unless there is explicit connector intent.
          const selectedName = String(payload.name || requestedName || '').trim();
          if (/(^|_)BRIDGE(_|$)/i.test(selectedName)) {
            const directiveText = directives.map((d) => d.description || '').join(' ').toLowerCase();
            const thoughtText = String(decision.thought || '').toLowerCase();
            const bridgeIntent = /bridge|connect|connector|link|span|cross/.test(`${directiveText} ${thoughtText}`);
            if (!bridgeIntent) {
              const fallbackNonBridge = pickFallbackBlueprintName(blueprints, {
                allowBridge: false,
                preferMega: isMouseAgent,
                recentNames: recentBlueprintNames,
              });
              if (fallbackNonBridge && !/(^|_)BRIDGE(_|$)/i.test(fallbackNonBridge)) {
                console.log(
                  `[${agentName}] Build guard: replacing isolated BRIDGE with ${fallbackNonBridge} (no connector intent)`,
                );
                payload.name = fallbackNonBridge;
              }
            }
          }

          const anchorX = Number(payload.anchorX);
          const anchorZ = Number(payload.anchorZ);
          const invalidAnchor = !Number.isFinite(anchorX) || !Number.isFinite(anchorZ);
          if (invalidAnchor) {
            const fallbackAnchor = pickSafeBuildAnchor(safeSpots, selfPos);
            if (fallbackAnchor) {
              payload.anchorX = fallbackAnchor.anchorX;
              payload.anchorZ = fallbackAnchor.anchorZ;
            }
          }

          const candidateAnchorX = Number(payload.anchorX);
          const candidateAnchorZ = Number(payload.anchorZ);
          const safePool = safeSpotCandidates.length > 0 ? safeSpotCandidates : safeSpots;
          const safeDist = nearestSafeSpotDistance(candidateAnchorX, candidateAnchorZ, safePool);
          // Only snap when the nearest safe spot is nearby; otherwise keep the intent and let server recovery pick a new lane.
          if (
            safePool.length > 0 &&
            Number.isFinite(candidateAnchorX) &&
            Number.isFinite(candidateAnchorZ) &&
            safeDist > 14 &&
            safeDist <= 30
          ) {
            const preferredNodeName = closestServerNodeNameAtPosition(serverSpatial, candidateAnchorX, candidateAnchorZ);
            const nearestSpot = pickSafeSpotClosestToAnchor(candidateAnchorX, candidateAnchorZ, safePool, {
              preferredNodeName,
            });
            if (nearestSpot) {
              console.log(
                `[${agentName}] Build guard: snapping anchor (${Math.round(candidateAnchorX)}, ${Math.round(candidateAnchorZ)}) to nearby safe spot (${nearestSpot.x}, ${nearestSpot.z})`,
              );
              payload.anchorX = nearestSpot.x;
              payload.anchorZ = nearestSpot.z;
            }
          }

          // Mouse: signature landmark policy for MEGA_SERVER_SPIRE (guard, never force).
          const selectedAfterSnap = String(payload.name || '').trim().toUpperCase();
          if (isMouseAgent && selectedAfterSnap === 'MEGA_SERVER_SPIRE') {
            const ax = Number(payload.anchorX);
            const az = Number(payload.anchorZ);
            const rx = Math.round(ax);
            const rz = Math.round(az);
            const spireReasons: string[] = [];

            const metaExact = safePool.find((s: any) => Math.round(Number(s.x)) === rx && Math.round(Number(s.z)) === rz) as any;
            const metaNearest = !metaExact && safePool.length > 0
              ? [...safePool].sort((a: any, b: any) => Math.hypot(Number(a.x) - ax, Number(a.z) - az) - Math.hypot(Number(b.x) - ax, Number(b.z) - az))[0]
              : null;
            const metaDist = metaNearest ? Math.hypot(Number(metaNearest.x) - ax, Number(metaNearest.z) - az) : Infinity;
            const meta = metaExact || (metaDist <= 3 ? metaNearest : null);
            const nearestBuild = Number(meta?.nearestBuild);

            let spotType = meta?.type as string | undefined;
            if (!spotType && Number.isFinite(nearestBuild)) {
              if (nearestBuild >= NODE_EXPANSION_MIN_DISTANCE && nearestBuild <= NODE_EXPANSION_MAX_DISTANCE) spotType = 'frontier';
              else if (nearestBuild >= 34 && nearestBuild < NODE_EXPANSION_MIN_DISTANCE) spotType = 'connector';
              else if (nearestBuild >= 12 && nearestBuild < 34) spotType = 'growth';
            }

            if (spotType !== 'frontier') {
              spireReasons.push(`anchor is not frontier (type=${spotType || 'unknown'}, nearestBuild=${Number.isFinite(nearestBuild) ? Math.round(nearestBuild) : '?'})`);
            }

            const spotNodeName =
              String(meta?.nearestNodeName || '').trim() ||
              closestServerNodeNameAtPosition(serverSpatial, ax, az) ||
              '';
            const spotNodeStructures = (() => {
              if (!Array.isArray(serverSpatial?.nodes)) return nearestNodeStructuresAtSelf;
              if (!spotNodeName) return nearestNodeStructuresAtSelf;
              const found = serverSpatial.nodes.find((n: any) => String(n?.name || '').trim() === spotNodeName);
              const count = Number(found?.structureCount);
              return Number.isFinite(count) ? count : nearestNodeStructuresAtSelf;
            })();
            if ((Number(spotNodeStructures) || 0) < NODE_EXPANSION_GATE) {
              spireReasons.push(`nearest node "${spotNodeName || 'unknown'}" unestablished (${spotNodeStructures}/${NODE_EXPANSION_GATE})`);
            }

            const spireInRecent = recentBlueprintNames.slice(0, MOUSE_SPIRE_COOLDOWN_BLUEPRINTS).includes('MEGA_SERVER_SPIRE');
            if (spireInRecent) {
              spireReasons.push(`cooldown active (recent blueprints include MEGA_SERVER_SPIRE)`);
            }

            const lastSpire = parseLastSpireAnchor(workingMemory);
            if (lastSpire && Number.isFinite(ax) && Number.isFinite(az)) {
              const dist = Math.hypot(ax - lastSpire.x, az - lastSpire.z);
              if (dist < MOUSE_SPIRE_MIN_DISTANCE) {
                spireReasons.push(`too close to last spire (${dist.toFixed(1)}u < ${MOUSE_SPIRE_MIN_DISTANCE}u)`);
              }
            }

            if (spireReasons.length > 0) {
              const fallbackNonSpire = pickFallbackBlueprintName(blueprints, {
                preferMega: true,
                recentNames: pushRecentBlueprintName(recentBlueprintNames, 'MEGA_SERVER_SPIRE', MOUSE_SPIRE_COOLDOWN_BLUEPRINTS),
                excludeNames: ['MEGA_SERVER_SPIRE'],
              });
              if (fallbackNonSpire) {
                console.log(`[${agentName}] Mouse spire policy: rejecting MEGA_SERVER_SPIRE (${spireReasons.join('; ')}); using ${fallbackNonSpire}`);
                payload.name = fallbackNonSpire;
              }
            }
          }

          const finalAnchorX = Number(payload.anchorX);
          const finalAnchorZ = Number(payload.anchorZ);
          if (
            selfPos &&
            Number.isFinite(finalAnchorX) &&
            Number.isFinite(finalAnchorZ) &&
            Math.hypot(finalAnchorX - selfPos.x, finalAnchorZ - selfPos.z) > 20
          ) {
            decision = {
              thought: `${decision.thought} | Build guard: blueprint anchor is out of range; moving to (${Math.round(finalAnchorX)}, ${Math.round(finalAnchorZ)}) first.`,
              action: 'MOVE',
              payload: { x: Math.round(finalAnchorX), z: Math.round(finalAnchorZ) },
            };
          } else {
            decision.payload = payload;
          }
        }
      }

      if (activeBlueprint && decision.action === 'IDLE' && !rateLimitWaitThisTick) {
        decision = {
          thought: `${decision.thought} | Active blueprint in progress; continuing instead of idling.`,
          action: 'BUILD_CONTINUE',
          payload: {},
        };
      }



      if (decision.action === 'CHAT') {
        const rawMessage = String((decision.payload as any)?.message || '').trim();
        const fallbackMessage = makeCoordinationChat(agentName, self, directives, otherAgents, allChatMessages);
        const chatMessage = rawMessage || fallbackMessage;
        const suppress = shouldSuppressChatMessage(agentName, chatMessage, allChatMessages, currentTicksSinceChat);
        if (suppress.suppress) {
          console.log(`[${agentName}] CHAT suppressed: ${suppress.reason || 'loop guard'}`);
          decision = {
            thought: `${decision.thought} | Chat suppressed (${suppress.reason || 'loop guard'}); returning to action loop.`,
            action: 'IDLE',
          };
        } else {
          decision.payload = { ...(decision.payload || {}), message: chatMessage.slice(0, 500) };
        }
      }

      // Long-distance MOVE cap: clamp to nearest safe spot instead of teleporting far away.
      if (
        decision.action === 'MOVE' &&
        selfPos
      ) {
        const tx = Number((decision.payload as any)?.x);
        const tz = Number((decision.payload as any)?.z);
        if (Number.isFinite(tx) && Number.isFinite(tz)) {
          const distance = Math.hypot(tx - selfPos.x, tz - selfPos.z);
          if (distance >= 120) {
            const localMove = chooseLocalMoveTarget(selfPos, safeSpots);
            if (localMove) {
              console.log(
                `[${agentName}] Mobility guard: long MOVE (${Math.round(distance)}u) clamped to nearby spot (${localMove.x}, ${localMove.z})`
              );
              decision = {
                thought: `${decision.thought} | Long-distance move clamped to nearby safe spot.`,
                action: 'MOVE',
                payload: localMove,
              };
            }
          }
        }
      }

      // 6. Execute action
      console.log(`[${agentName}] ${decision.thought} -> ${decision.action}`);
      let buildError = await executeAction(api, agentName, decision, self?.position ? { x: self.position.x, z: self.position.z } : undefined);
      if (buildError) {
        const parsedError = parseBuildActionError(buildError);
        if (parsedError.expansionGate) {
          const candidates = (safeSpotCandidates.length > 0 ? safeSpotCandidates : safeSpots).filter((spot) => {
            return Number.isFinite(spot.nearestBuild) && spot.nearestBuild < NODE_EXPANSION_MIN_DISTANCE && spot.type !== 'frontier';
          });
          const gateMatches = parsedError.gateNodeName
            ? candidates.filter((spot) => String(spot.nearestNodeName || '').trim() === parsedError.gateNodeName)
            : [];
          const pool = gateMatches.length > 0 ? gateMatches : candidates;
          const densifySpot = pool
            .sort((a, b) => {
              if (!selfPos) return 0;
              const da = Math.hypot(a.x - selfPos.x, a.z - selfPos.z);
              const db = Math.hypot(b.x - selfPos.x, b.z - selfPos.z);
              return da - db;
            })[0];

          if (densifySpot) {
            const densifyDistance = selfPos ? Math.hypot(densifySpot.x - selfPos.x, densifySpot.z - selfPos.z) : 0;
            const requestedName = String((decision.payload as any)?.name || '').trim();
            const requestedBlueprint = requestedName ? blueprints?.[requestedName] : null;
            const fallbackBlueprint = pickFallbackBlueprintName(blueprints, {
              preferMega: isMouseAgent,
              recentNames: recentBlueprintNames,
            });
            const chosenBlueprint =
              requestedName && requestedBlueprint && !requestedBlueprint.advanced
                ? requestedName
                : fallbackBlueprint;
            const retryDecision: AgentDecision =
              selfPos && densifyDistance > 20
                ? {
                    thought: `Expansion gate: new node blocked near "${parsedError.gateNodeName || 'nearest node'}" (${parsedError.gateNodeStructures ?? '?'} structures). Moving to densify lane (${densifySpot.x}, ${densifySpot.z}).`,
                    action: 'MOVE',
                    payload: { x: densifySpot.x, z: densifySpot.z },
                  }
                : chosenBlueprint
                  ? {
                      thought: `Expansion gate: new node blocked near "${parsedError.gateNodeName || 'nearest node'}" (${parsedError.gateNodeStructures ?? '?'} structures). Densifying at (${densifySpot.x}, ${densifySpot.z}) with ${chosenBlueprint}.`,
                      action: 'BUILD_BLUEPRINT',
                      payload: { name: chosenBlueprint, anchorX: densifySpot.x, anchorZ: densifySpot.z },
                    }
                  : {
                      thought: `Expansion gate: new node blocked near "${parsedError.gateNodeName || 'nearest node'}" (${parsedError.gateNodeStructures ?? '?'} structures). Moving to densify lane (${densifySpot.x}, ${densifySpot.z}).`,
                      action: 'MOVE',
                      payload: { x: densifySpot.x, z: densifySpot.z },
                    };

            console.log(
              `[${agentName}] Expansion gate recovery -> ${retryDecision.action}${
                retryDecision.action === 'BUILD_BLUEPRINT'
                  ? ` (${String((retryDecision.payload as any)?.name || 'blueprint')}) at (${(retryDecision.payload as any)?.anchorX}, ${(retryDecision.payload as any)?.anchorZ})`
                  : ` (${(retryDecision.payload as any)?.x}, ${(retryDecision.payload as any)?.z})`
              }`,
            );
            const retryError = await executeAction(api, agentName, retryDecision, selfPos);
            if (!retryError) {
              decision = retryDecision;
              buildError = null;
            } else {
              buildError = `${buildError} | retry failed: ${retryError}`;
            }
          }
        } else if (decision.action === 'BUILD_CONTINUE' && parsedError.noActivePlan) {
          const fallbackBlueprint = pickFallbackBlueprintName(blueprints, { preferMega: isMouseAgent, recentNames: recentBlueprintNames });
          const fallbackAnchor = pickSafeBuildAnchor(safeSpots, selfPos);
          if (fallbackBlueprint && fallbackAnchor) {
            const anchorDistance = selfPos
              ? Math.hypot(fallbackAnchor.anchorX - selfPos.x, fallbackAnchor.anchorZ - selfPos.z)
              : 0;
            const retryDecision: AgentDecision =
              selfPos && anchorDistance > 20
                ? {
                    thought: `Build recovery: no active plan and fallback anchor is out of range; moving to (${fallbackAnchor.anchorX}, ${fallbackAnchor.anchorZ}) first.`,
                    action: 'MOVE',
                    payload: { x: fallbackAnchor.anchorX, z: fallbackAnchor.anchorZ },
                  }
                : {
                    thought: 'Build recovery: continue failed due no active plan; starting fallback blueprint.',
                    action: 'BUILD_BLUEPRINT',
                    payload: {
                      name: fallbackBlueprint,
                      anchorX: fallbackAnchor.anchorX,
                      anchorZ: fallbackAnchor.anchorZ,
                    },
                  };
            console.log(
              `[${agentName}] Build recovery retry -> ${retryDecision.action}${
                retryDecision.action === 'BUILD_BLUEPRINT' ? ` (${fallbackBlueprint})` : ` (${fallbackAnchor.anchorX}, ${fallbackAnchor.anchorZ})`
              }`,
            );
            const retryError = await executeAction(api, agentName, retryDecision, selfPos);
            if (!retryError) {
              decision = retryDecision;
              buildError = null;
            } else {
              buildError = `${buildError} | retry failed: ${retryError}`;
            }
          }
        } else if (decision.action === 'BUILD_BLUEPRINT' && parsedError.alreadyActivePlan) {
          const retryDecision: AgentDecision = {
            thought: 'Build recovery: start failed because active plan exists; continuing active blueprint.',
            action: 'BUILD_CONTINUE',
            payload: {},
          };
          console.log(`[${agentName}] Build recovery retry -> BUILD_CONTINUE`);
          const retryError = await executeAction(api, agentName, retryDecision, selfPos);
          if (!retryError) {
            decision = retryDecision;
            buildError = null;
          } else {
            buildError = `${buildError} | retry failed: ${retryError}`;
          }
        }
      }
      if (buildError) {
        const parsedError = parseBuildActionError(buildError);
        if (parsedError.tooFarFromBuildSite && parsedError.anchor) {
          const retryDecision: AgentDecision = {
            thought: `Build recovery: out of range for active plan; moving to (${parsedError.anchor.x}, ${parsedError.anchor.z}).`,
            action: 'MOVE',
            payload: { x: parsedError.anchor.x, z: parsedError.anchor.z },
          };
          console.log(`[${agentName}] Build recovery retry -> MOVE (${parsedError.anchor.x}, ${parsedError.anchor.z})`);
          const retryError = await executeAction(api, agentName, retryDecision, selfPos);
          if (!retryError) {
            decision = retryDecision;
            buildError = null;
          } else {
            buildError = `${buildError} | retry failed: ${retryError}`;
          }
        } else if (
          decision.action === 'BUILD_BLUEPRINT' &&
          (parsedError.blueprintOverlap || parsedError.blueprintAnchorTooFar)
        ) {
          const payload = { ...((decision.payload as Record<string, unknown>) || {}) };
          const attemptedAnchorX = Number(payload.anchorX);
          const attemptedAnchorZ = Number(payload.anchorZ);
          const excludeAnchors: Array<{ x: number; z: number }> = [];
          if (Number.isFinite(attemptedAnchorX) && Number.isFinite(attemptedAnchorZ)) {
            excludeAnchors.push({ x: attemptedAnchorX, z: attemptedAnchorZ });
          }
          if (parsedError.anchor) {
            excludeAnchors.push(parsedError.anchor);
          }
          const pool = safeSpotCandidates.length > 0 ? safeSpotCandidates : safeSpots;
          const preferredNodeName = closestServerNodeNameAtPosition(serverSpatial, attemptedAnchorX, attemptedAnchorZ);
          const nearestFallback = pickSafeSpotClosestToAnchor(attemptedAnchorX, attemptedAnchorZ, pool, {
            preferredNodeName,
            exclude: excludeAnchors,
          });
          const fallbackAnchor = nearestFallback
            ? { anchorX: nearestFallback.x, anchorZ: nearestFallback.z }
            : pickSafeBuildAnchor(safeSpots, selfPos, excludeAnchors, true);
          if (fallbackAnchor) {
            const anchorDistance = selfPos
              ? Math.hypot(fallbackAnchor.anchorX - selfPos.x, fallbackAnchor.anchorZ - selfPos.z)
              : 0;
            const retryDecision: AgentDecision =
              selfPos && anchorDistance > 20
                ? {
                    thought: `Build recovery: new anchor is out of range; moving to (${fallbackAnchor.anchorX}, ${fallbackAnchor.anchorZ}) before retrying blueprint.`,
                    action: 'MOVE',
                    payload: { x: fallbackAnchor.anchorX, z: fallbackAnchor.anchorZ },
                  }
                : {
                    thought: `Build recovery: anchor rejected by server; retrying ${String(payload.name || 'blueprint')} at (${fallbackAnchor.anchorX}, ${fallbackAnchor.anchorZ}).`,
                    action: 'BUILD_BLUEPRINT',
                    payload: {
                      ...payload,
                      anchorX: fallbackAnchor.anchorX,
                      anchorZ: fallbackAnchor.anchorZ,
                    },
                  };
            console.log(
              `[${agentName}] Build recovery retry -> ${retryDecision.action}${
                retryDecision.action === 'BUILD_BLUEPRINT'
                  ? ` (${String(payload.name || 'unknown')}) at (${fallbackAnchor.anchorX}, ${fallbackAnchor.anchorZ})`
                  : ` (${fallbackAnchor.anchorX}, ${fallbackAnchor.anchorZ})`
              }`,
            );
            const retryError = await executeAction(api, agentName, retryDecision, selfPos);
            if (!retryError) {
              decision = retryDecision;
              buildError = null;
            } else {
              buildError = `${buildError} | retry failed: ${retryError}`;
            }
          }
        }
      }
      if (buildError) {
        console.warn(`[${agentName}] Action error: ${buildError}`);
        if (isRateLimitErrorMessage(buildError)) {
          const waitSeconds = parseRateLimitCooldownSeconds(buildError, 20);
          rateLimitCooldownUntil = Math.max(rateLimitCooldownUntil, Date.now() + waitSeconds * 1000);
          if (buildError) {
            console.warn(`[${agentName}] Rate-limited on ${decision.action}. Cooling down ${waitSeconds}s before retry.`);
            buildError = `${buildError} — Rate-limited; waiting ${waitSeconds}s before retry.`;
          }
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

      let actionChatSent = false;
      if (
        emitActionChatUpdates &&
        decision.action !== 'CHAT' &&
        decision.action !== 'IDLE' &&
        decision.action !== 'TERMINAL' &&
        decision.action !== 'BUILD_CONTINUE'
      ) {
        actionChatSent = await emitActionUpdateChat(
          api,
          agentName,
          decision,
          world.tick,
          buildError || null,
        );
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

      const prevDirectiveSubmitTick = parseInt(
        workingMemory?.match(/Last directive submit tick: (\d+)/)?.[1] || '0',
        10,
      );
      const prevDirectiveVoteTick = parseInt(
        workingMemory?.match(/Last directive vote tick: (\d+)/)?.[1] || '0',
        10,
      );
      const directiveSubmitTick =
        decision.action === 'SUBMIT_DIRECTIVE' && !buildError
          ? (Number(world.tick) || prevDirectiveSubmitTick)
          : prevDirectiveSubmitTick;
      const directiveVoteTick =
        decision.action === 'VOTE' && !buildError
          ? (Number(world.tick) || prevDirectiveVoteTick)
          : prevDirectiveVoteTick;

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

      let recentBlueprintHistory = parseRecentBlueprintNames(workingMemory);
      if (blueprintStatus?.active && blueprintStatus.blueprintName) {
        recentBlueprintHistory = pushRecentBlueprintName(recentBlueprintHistory, String(blueprintStatus.blueprintName));
      }
      if (!buildError && decision.action === 'BUILD_BLUEPRINT') {
        const chosen = String((decision.payload as any)?.name || '').trim();
        if (chosen) {
          recentBlueprintHistory = pushRecentBlueprintName(recentBlueprintHistory, chosen);
        }
      } else if (!buildError && decision.action === 'BUILD_CONTINUE' && blueprintStatus?.blueprintName) {
        recentBlueprintHistory = pushRecentBlueprintName(recentBlueprintHistory, String(blueprintStatus.blueprintName));
      }

      // Mouse spire anchor tracking (for spacing/cooldown guards).
      let lastSpireAnchor = parseLastSpireAnchor(workingMemory);
      let spireAnchors = parseSpireAnchors(workingMemory);
      if (
        !buildError &&
        decision.action === 'BUILD_BLUEPRINT' &&
        String((decision.payload as any)?.name || '').trim().toUpperCase() === 'MEGA_SERVER_SPIRE'
      ) {
        const ax = Number((decision.payload as any)?.anchorX);
        const az = Number((decision.payload as any)?.anchorZ);
        if (Number.isFinite(ax) && Number.isFinite(az)) {
          lastSpireAnchor = { x: ax, z: az };
          spireAnchors = pushRecentAnchor(spireAnchors, { x: ax, z: az }, 5);
        }
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
      let guildStatus = workingMemory?.match(/Guild status: (.+)/)?.[1] || 'not formed';
      if (agentName.toLowerCase() === 'smith') {
        if (smithGuildStatusNote) {
          guildStatus = smithGuildStatusNote;
        } else if (smithGuildBootstrapped && guildStatus === 'not formed') {
          guildStatus = 'formed';
        }
        if (smithGuildViceName) {
          if (guildMembers === '(none yet)') guildMembers = smithGuildViceName;
          else if (!guildMembers.includes(smithGuildViceName)) guildMembers = `${guildMembers}, ${smithGuildViceName}`;
        }
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
      // Do not let auto action-update chats reset coordination cadence.
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
        directiveSubmitTick > 0 ? `Last directive submit tick: ${directiveSubmitTick}` : '',
        directiveVoteTick > 0 ? `Last directive vote tick: ${directiveVoteTick}` : '',
        currentObjective ? `Current objective: ${currentObjective}` : '',
        objectiveStep > 0 ? `Objective step: ${objectiveStep}` : '',
        currentBuildPlan ? `Current build plan: ${currentBuildPlan}` : '',
        recentBlueprintHistory.length > 0 ? `Recent blueprints: ${recentBlueprintHistory.join(', ')}` : '',
        lastSpireAnchor ? `Last spire anchor: (${Math.round(lastSpireAnchor.x)}, ${Math.round(lastSpireAnchor.z)})` : '',
        spireAnchors.length > 0 ? `Spire anchors: ${spireAnchors.map((pt) => `(${Math.round(pt.x)},${Math.round(pt.z)})`).join('; ')}` : '',
        votedOn ? `Voted on: ${votedOn}` : '',
        submittedDirectives ? `Submitted directives: ${submittedDirectives}` : '',
        buildError ? `Last build error: ${buildError}` : '',
        consecutiveBuildFails > 0 ? `Consecutive build failures: ${consecutiveBuildFails}` : '',
        // Smith guild tracking
        ...(agentName.toLowerCase() === 'smith' ? [
          `Guild status: ${guildStatus}`,
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
          logEnterGuildStatus(agentName, entry.guild);
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
  let primeDirectiveDoc = '';
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
  try {
    const primeRes = await fetch(`${config.apiBaseUrl}/v1/grid/prime-directive`);
    if (primeRes.ok) {
      const primeJson = await primeRes.json() as { text?: string };
      primeDirectiveDoc = typeof primeJson.text === 'string' ? primeJson.text : '';
      log(`Fetched prime-directive (${primeDirectiveDoc.length} chars)`);
    } else {
      log(`prime-directive not available (${primeRes.status})`);
    }
  } catch (err) {
    log(`Failed to fetch prime-directive: ${err}`);
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
    primeDirectiveDoc ? '## Prime Directive\n' + primeDirectiveDoc : '## Prime Directive\n_Could not fetch._',
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
        visionBridge: config.visionBridge,
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

      // Append server contracts so bootstrap agents run the same constitutional context.
      const fullSystemPrompt = [
        postBootstrapSystemPrompt,
        primeDirectiveDoc ? '\n---\n# PRIME DIRECTIVE (SERVER CONSTITUTION)\n' + primeDirectiveDoc : '',
        skillDoc ? '\n---\n# SERVER SKILL DOCUMENT\n' + skillDoc : '',
      ].join('');

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

          // Merge chat + terminal into one unified chat feed, prioritizing agent chat
          const bsChatMessages = world.chatMessages || [];
          const bsTerminalMessages = world.messages || [];
          
          const bsTrueAgentChat = bsChatMessages.filter(m => m.agentName !== 'System');
          const bsSystemChat = bsChatMessages.filter(m => m.agentName === 'System');

          const bsRecentAgentChat = bsTrueAgentChat.sort((a, b) => a.createdAt - b.createdAt).slice(-25);
          const bsRecentSystem = [...bsSystemChat, ...bsTerminalMessages]
            .sort((a, b) => a.createdAt - b.createdAt)
            .slice(-5);

          const bsAllMessages = [...bsRecentAgentChat, ...bsRecentSystem]
            .sort((a, b) => a.createdAt - b.createdAt);

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
            '**Chat should be conversational and informative.** No acknowledgment-only replies. Share concrete coordinates/progress/next step, then keep building.',
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
            '  BUILD_BLUEPRINT: {"name":"DATACENTER","anchorX":120,"anchorZ":120,"rotY":90}  ← start a blueprint build (rotY optional, 0-360 degrees)',
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
                  '  BUILD_BLUEPRINT: {"name":"DATACENTER","anchorX":120,"anchorZ":120}',
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

          let imageBase64: string | null = null;
          let visualSummary: string | null = null;
          if (providerSupportsVisionInput(fullConfig.llmProvider)) {
            imageBase64 = await captureWorldView(api.getAgentId() || newAgentId.toString());
            if (imageBase64) {
              console.log(`[${agentName}] Captured visual input`);
            }
          } else if (fullConfig.visionBridge?.provider === 'gemini' && fullConfig.visionBridge.apiKey) {
            imageBase64 = await captureWorldView(api.getAgentId() || newAgentId.toString());
            if (imageBase64) {
              console.log(`[${agentName}] Captured visual input (bridge)`);
              try {
                visualSummary = await summarizeImageWithGemini(
                  fullConfig.visionBridge.apiKey,
                  fullConfig.visionBridge.model,
                  imageBase64,
                );
                if (visualSummary) {
                  console.log(`[${agentName}] Vision bridge summary generated (${visualSummary.length} chars)`);
                }
              } catch (visionErr) {
                const visionMsg = visionErr instanceof Error ? visionErr.message : String(visionErr);
                console.warn(`[${agentName}] Vision bridge failed: ${visionMsg.slice(0, 160)}`);
              }
            }
          }
          const llmInputPrompt = visualSummary
            ? `${userPrompt}\n\n## VISUAL SUMMARY (Gemini)\n${visualSummary}`
            : userPrompt;
          const llmResponse = await callLLM(fullConfig, fullSystemPrompt, llmInputPrompt, imageBase64);
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

        const rawMsg = (p.message as string);
        const MAX_LEN = 280;

        // Split message into chunks if it exceeds the server limit
        if (rawMsg.length <= MAX_LEN) {
          await api.action('CHAT', { message: rawMsg });
          console.log(`[${name}] Sent chat: "${rawMsg.slice(0, 50)}..."`);
        } else {
          // Chunk the message to preserve information
          const chunks: string[] = [];
          for (let i = 0; i < rawMsg.length; i += MAX_LEN) {
            chunks.push(rawMsg.slice(i, i + MAX_LEN));
          }

          console.log(`[${name}] Splitting long chat (${rawMsg.length} chars) into ${chunks.length} parts.`);
          for (const chunk of chunks) {
            await api.action('CHAT', { message: chunk });
            // Small delay to ensure order and avoid rapid-fire rate limits
            await new Promise(r => setTimeout(r, 200));
          }
        }
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

        if (batch.length === 0) {
          return 'BUILD_MULTI rejected: empty primitives array. Provide 1-5 primitives with x/z coordinates near your position.';
        }

        // Pre-validate all coordinates before placing any
        for (let i = 0; i < batch.length; i++) {
          const prim = batch[i];
          if (validCoord(prim.x) === null || validCoord(prim.z) === null) {
            const posHint = agentPos ? `You are at (${agentPos.x.toFixed(0)}, ${agentPos.z.toFixed(0)}). Build within 2-20 units of yourself.` : '';
            return `BUILD_MULTI rejected: primitive ${i} has missing/zero coordinates (x=${prim.x}, z=${prim.z}). ALL shapes need real x/z coordinates near your position. ${posHint}`;
          }
        }

        // Build-range precheck (prevents partial placement/debris).
        if (agentPos) {
          for (let i = 0; i < batch.length; i++) {
            const prim = batch[i];
            const dist = Math.hypot(Number(prim.x) - agentPos.x, Number(prim.z) - agentPos.z);
            if (!Number.isFinite(dist) || dist > 20 || dist < 2) {
              return `BUILD_MULTI rejected: primitive ${i} is ${dist.toFixed(1)}u from your position (${agentPos.x.toFixed(0)}, ${agentPos.z.toFixed(0)}). All BUILD_MULTI primitives must be within 2-20u of you.`;
            }
          }
        }

        // Contiguity guard: prevent scattered multi-placements (the "spray" debris failure mode).
        type BuildMultiPrim = { x: number; z: number; scaleX: number; scaleZ: number };
        const toPrim = (prim: Record<string, unknown>): BuildMultiPrim => ({
          x: Number(prim.x),
          z: Number(prim.z),
          scaleX: Number(prim.scaleX) || 1,
          scaleZ: Number(prim.scaleZ) || 1,
        });
        const bb = (prim: BuildMultiPrim) => {
          const halfX = prim.scaleX / 2;
          const halfZ = prim.scaleZ / 2;
          return { minX: prim.x - halfX, maxX: prim.x + halfX, minZ: prim.z - halfZ, maxZ: prim.z + halfZ };
        };
        const expandBB = (box: ReturnType<typeof bb>, pad: number) => ({
          minX: box.minX - pad,
          maxX: box.maxX + pad,
          minZ: box.minZ - pad,
          maxZ: box.maxZ + pad,
        });
        const overlapXZ = (a: ReturnType<typeof bb>, b: ReturnType<typeof bb>) =>
          a.minX <= b.maxX && a.maxX >= b.minX && a.minZ <= b.maxZ && a.maxZ >= b.minZ;
        const connectedXZ = (a: BuildMultiPrim, b: BuildMultiPrim) => {
          const aBB = bb(a);
          const bBB = bb(b);
          if (overlapXZ(expandBB(aBB, 1.5), bBB)) return true;

          const centerDist = Math.hypot(a.x - b.x, a.z - b.z);
          const size = Math.max(a.scaleX, a.scaleZ, b.scaleX, b.scaleZ);
          const nearThreshold = Math.max(3.5, Math.min(12, size * 1.5));
          return centerDist <= nearThreshold;
        };

        const prims = batch.map(toPrim);
        const visited = new Set<number>();
        const queue: number[] = [0];
        visited.add(0);
        while (queue.length > 0) {
          const idx = queue.pop()!;
          for (let j = 0; j < prims.length; j++) {
            if (visited.has(j)) continue;
            if (connectedXZ(prims[idx], prims[j])) {
              visited.add(j);
              queue.push(j);
            }
          }
        }
        if (visited.size !== prims.length) {
          const disconnected = [];
          for (let i = 0; i < prims.length; i++) if (!visited.has(i)) disconnected.push(i);
          return `BUILD_MULTI rejected: batch primitives are disconnected (indices ${disconnected.join(', ')}). Place shapes contiguously so they form ONE connected structure per tick (e.g., road segments every 3-4u or vertical stacks at the same x/z).`;
        }

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
            return `BUILD_MULTI failed after partial placement: ${errMsg}`;
          }
        }
        break;
      }

      case 'BUILD_BLUEPRINT':
        await api.startBlueprint(
          p.name as string,
          p.anchorX as number,
          p.anchorZ as number,
          p.rotY != null ? Number(p.rotY) : undefined
        );
        console.log(`[${name}] Started blueprint: ${p.name} at (${p.anchorX}, ${p.anchorZ}) rotY=${p.rotY ?? 0}`);
        break;

      case 'BUILD_CONTINUE': {
        const result = await api.continueBlueprint() as any;
        if (result.status === 'complete') {
          console.log(`[${name}] Blueprint complete! ${result.placed}/${result.total} placed.`);
        } else if (result.status === 'complete_with_failures') {
          const failed = Number(result.failedCount) || (Number(result.total) - Number(result.placed)) || '?';
          console.log(`[${name}] Blueprint complete WITH FAILURES. placed=${result.placed}/${result.total}, failed=${failed}`);
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
