/**
 * Agent Runtime — the heartbeat loop (refactored).
 *
 * Clean three-layer separation:
 *   Layer 1: Agent Soul (IDENTITY.md, LESSONS.md, MEMORY.md)
 *   Layer 2: OpGrid Knowledge (skill.md, prime-directive.md, API responses)
 *   Layer 3: Runtime (this file — minimal, generic, no agent-specific code)
 *
 * Each agent runs as an independent loop:
 *   1. Load soul files
 *   2. Enter OpGrid
 *   3. Fetch knowledge (skill.md, prime-directive)
 *   4. Heartbeat: fetch state → prompt → decide → execute → remember
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { GridAPIClient, type DirectMessage } from './api-client.js';
import { ChainClient } from './chain-client.js';
import { captureWorldView } from './vision.js';
import { KeyRotator, type LLMBucket } from './key-rotator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// --- Types ---

interface AgentConfig {
  dir: string;
  privateKey: string;
  walletAddress: string;
  erc8004AgentId: string;
  erc8004Registry: string;
  heartbeatSeconds: number;
  llmProvider: 'gemini' | 'anthropic' | 'openai' | 'minimax' | 'opencode' | 'openrouter';
  llmModel: string;
  llmApiKey: string;
  llmPool?: LLMBucket[]; // Optional: rotation pool for key x model cycling on 429
  visionBridge?: {
    provider: 'gemini';
    model: string;
    apiKey: string;
  };
}

interface AgentDecision {
  thought: string;
  action: 'MOVE' | 'CHAT' | 'SEND_DM' | 'BUILD_BLUEPRINT' | 'BUILD_CONTINUE' | 'CANCEL_BUILD' | 'BUILD_PRIMITIVE' | 'BUILD_MULTI' | 'TERMINAL' | 'VOTE' | 'SUBMIT_DIRECTIVE' | 'COMPLETE_DIRECTIVE' | 'TRANSFER_CREDITS' | 'SCAVENGE' | 'START_CERTIFICATION' | 'SUBMIT_CERTIFICATION_PROOF' | 'CHECK_CERTIFICATION' | 'ENCODE_SWAP' | 'EXECUTE_SWAP' | 'EXECUTE_ONCHAIN' | 'APPROVE_TOKEN' | 'ACKNOWLEDGE_NOTIFICATION' | 'IDLE';
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

// --- Error Helpers ---

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

function isRateLimitErrorMessage(message: string): boolean {
  return /429|cadence too fast|suppressed|rate.?limit/i.test(message);
}

function parseRateLimitCooldownSeconds(message: string, fallbackSeconds: number): number {
  const match = message.match(/retry.?after.?(\d+)\s*ms/i);
  if (match) return Math.ceil(Number(match[1]) / 1000);
  const secMatch = message.match(/retry.?after.?(\d+)\s*s/i);
  if (secMatch) return Number(secMatch[1]);
  return fallbackSeconds;
}

// --- JSON Parsing ---

function parseFirstJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  // If whole text looks like JSON, try it first
  if (trimmed.startsWith('{')) {
    try { return JSON.parse(trimmed); } catch { /* fall through */ }
  }
  // Search for first { ... } block
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

// --- Chat Helpers ---

function formatActionUpdateChat(
  decision: AgentDecision,
  tick: number,
  actionError?: string | null,
): string | null {
  const payload = decision.payload || {};

  if (actionError) {
    const compact = actionError.replace(/\s+/g, ' ').slice(0, 120);
    return `${decision.action} failed at tick ${tick}: ${compact}`;
  }

  switch (decision.action) {
    case 'MOVE': {
      const thought = (decision.thought || '').split('|')[0].trim();
      if (thought.length > 20 && !thought.startsWith('Moving') && !thought.startsWith('Heading')) {
        return thought;
      }
      return null;
    }
    case 'BUILD_PRIMITIVE':
    case 'BUILD_MULTI': {
      const thought = (decision.thought || '').split('|')[0].trim();
      return thought.length > 10 ? thought : 'Building structure.';
    }
    case 'BUILD_BLUEPRINT': {
      const thought = (decision.thought || '').split('|')[0].trim();
      return thought.length > 15 ? thought : 'Starting construction.';
    }
    case 'BUILD_CONTINUE':
      return null;
    case 'CANCEL_BUILD':
      return "I'm clearing my build plan.";
    case 'VOTE': {
      const thought = (decision.thought || '').split('|')[0].trim();
      return thought.length > 15 ? thought : 'I voted.';
    }
    case 'SUBMIT_DIRECTIVE': {
      const thought = (decision.thought || '').split('|')[0].trim();
      const match = String(payload.description || '').match(/^TITLE:\s*(.+)/i);
      const title = match ? match[1] : String(payload.description || '').slice(0, 50);
      return thought.length > 15 ? thought : `Proposing: "${title}"`;
    }
    case 'START_CERTIFICATION': {
      const thought = (decision.thought || '').split('|')[0].trim();
      const certId = String(payload.certificationId || payload.templateId || 'certification');
      return thought.length > 15 ? thought : `Starting certification: ${certId}`;
    }
    case 'SUBMIT_CERTIFICATION_PROOF': {
      const thought = (decision.thought || '').split('|')[0].trim();
      return thought.length > 15 ? thought : 'Submitting certification proof.';
    }
    case 'EXECUTE_ONCHAIN':
    case 'APPROVE_TOKEN': {
      const thought = (decision.thought || '').split('|')[0].trim();
      return thought.length > 15 ? thought : 'Executing onchain transaction.';
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

  const full = message.trim();
  if (!full) return false;

  const MAX_LEN = 280;
  try {
    if (full.length <= MAX_LEN) {
      await api.action('CHAT', { message: full });
    } else {
      for (let i = 0; i < full.length; i += MAX_LEN) {
        await api.action('CHAT', { message: full.slice(i, i + MAX_LEN) });
        if (i + MAX_LEN < full.length) await new Promise(r => setTimeout(r, 200));
      }
    }
    return true;
  } catch {
    return false;
  }
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

const COST_PER_1K: Record<string, { input: number; output: number }> = {
  'gemini': { input: 0.00010, output: 0.00040 },
  'anthropic': { input: 0.00080, output: 0.00400 },
  'openai': { input: 0.00015, output: 0.00060 },
  'minimax': { input: 0.00015, output: 0.00060 },
  'opencode': { input: 0.00015, output: 0.00060 },
  'openrouter': { input: 0.00015, output: 0.00060 },
};

function formatTokenLog(provider: string, usage: LLMUsage | null): string {
  if (!usage) return '';
  const cost = COST_PER_1K[provider] || COST_PER_1K['openai'];
  const estCost = (usage.inputTokens / 1000) * cost.input + (usage.outputTokens / 1000) * cost.output;
  return ` (in: ${usage.inputTokens}, out: ${usage.outputTokens}, ~$${estCost.toFixed(4)})`;
}

function trimPromptForLLM(prompt: string, maxChars = 32000, tailChars = 12000): string {
  if (prompt.length <= maxChars) return prompt;
  const headLen = maxChars - tailChars - 60;
  const head = prompt.slice(0, headLen);
  const tail = prompt.slice(-tailChars);
  return `${head}\n\n[... ${prompt.length - headLen - tailChars} chars trimmed ...]\n\n${tail}`;
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
        maxOutputTokens: 8192,
      },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gemini API error (${res.status}): ${text}`);
  }

  const data = await res.json() as any;
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

  const data = await res.json() as any;
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

  const data = await res.json() as any;
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

  const data = await res.json() as any;
  const usage = data.usage
    ? { inputTokens: data.usage.prompt_tokens || 0, outputTokens: data.usage.completion_tokens || 0 }
    : null;
  return { text: data.choices?.[0]?.message?.content || '{}', usage };
}

async function callOpenRouter(apiKey: string, model: string, systemPrompt: string, userPrompt: string): Promise<LLMResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000); // 2 min timeout
  try {
  // Not all free models support response_format — omit for models that reject it
  const supportsJsonFormat = !model.includes('hermes-3') && !model.includes('trinity') && !model.includes('nemotron') && !model.includes('step-3.5');
  // Thinking models (nemotron, step) need more max_tokens — reasoning uses ~3-6K tokens before content
  const isThinkingModel = model.includes('nemotron') || model.includes('step-3.5');
  const body: Record<string, any> = {
    model,
    temperature: 0.7,
    max_tokens: isThinkingModel ? 16384 : 4096,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
  };
  if (supportsJsonFormat) body.response_format = { type: 'json_object' };
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    signal: controller.signal,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenRouter API error (${res.status}): ${text}`);
  }

  const data = await res.json() as any;
  const usage = data.usage
    ? { inputTokens: data.usage.prompt_tokens || 0, outputTokens: data.usage.completion_tokens || 0 }
    : null;
  const msg = data.choices?.[0]?.message;
  let text = msg?.content || '';
  // Thinking models (Step 3.5, etc) may put all output in reasoning and return content=null.
  // Fall back to extracting a JSON action object from the reasoning field.
  if ((!text || text.trim() === '{}' || text.trim() === '') && (msg?.reasoning || msg?.reasoning_content)) {
    const reasoning = msg.reasoning || msg.reasoning_content || '';
    console.log(`[OpenRouter] content empty, checking reasoning (${typeof reasoning === 'string' ? reasoning.length : 'non-string'} chars)`);
    const reasoningStr = typeof reasoning === 'string' ? reasoning : JSON.stringify(reasoning);
    const jsonMatch = reasoningStr.match(/\{[\s\S]*?"action"\s*:\s*"[A-Z_]+"[\s\S]*?\}/);
    if (jsonMatch) {
      text = jsonMatch[0];
      console.log(`[OpenRouter] Extracted action from reasoning: ${text.slice(0, 120)}`);
    }
  }
  return { text: text || '{}', usage };
  } finally {
    clearTimeout(timeout);
  }
}

async function callOpenCode(apiKey: string, model: string, systemPrompt: string, userPrompt: string): Promise<LLMResponse> {
  const res = await fetch('https://opencode.ai/zen/v1/chat/completions', {
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
    throw new Error(`OpenCode API error (${res.status}): ${text}`);
  }

  const data = await res.json() as any;
  const usage = data.usage
    ? { inputTokens: data.usage.prompt_tokens || 0, outputTokens: data.usage.completion_tokens || 0 }
    : null;
  return { text: data.choices?.[0]?.message?.content || '{}', usage };
}

interface LLMConfig {
  llmProvider: 'gemini' | 'anthropic' | 'openai' | 'minimax' | 'opencode' | 'openrouter';
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
  if (config.llmProvider === 'opencode') {
    return callOpenCode(config.llmApiKey, config.llmModel, systemPrompt, userPrompt);
  }
  if (config.llmProvider === 'openrouter') {
    return callOpenRouter(config.llmApiKey, config.llmModel, systemPrompt, userPrompt);
  }
  return callGemini(config.llmApiKey, config.llmModel, systemPrompt, userPrompt, imageBase64);
}


// --- Prompt Builders ---

const ACTION_FORMAT = [
  'Decide your next action. Respond with EXACTLY one JSON object:',
  '{ "thought": "...", "action": "MOVE|CHAT|SEND_DM|BUILD_BLUEPRINT|BUILD_CONTINUE|CANCEL_BUILD|TERMINAL|VOTE|SUBMIT_DIRECTIVE|COMPLETE_DIRECTIVE|TRANSFER_CREDITS|SCAVENGE|START_CERTIFICATION|ENCODE_SWAP|EXECUTE_ONCHAIN|APPROVE_TOKEN|SUBMIT_CERTIFICATION_PROOF|CHECK_CERTIFICATION|IDLE", "payload": {...} }',
  '',
  'Payload formats:',
  '  MOVE: {"x": 5, "z": 3}',
  '  CHAT: {"message": "Hello!"}',
  '  SEND_DM: {"toAgentId": "agent_xxx", "message": "Private note..."}',
  '  BUILD_BLUEPRINT: {"name":"DATACENTER","anchorX":120,"anchorZ":120,"rotY":90}  ← USE coordinates from safe build spots! rotY optional (0-360)',
  '  BUILD_CONTINUE: {}  ← place next batch from active blueprint (must be near site)',
  '  CANCEL_BUILD: {}  ← abandon current blueprint (placed pieces stay)',
  '  (BUILD_PRIMITIVE and BUILD_MULTI exist but are deprecated — use BUILD_BLUEPRINT for all construction)',
  '  SCAVENGE: {}  ← gather materials + earn credits (5 credits per scavenge, 60s cooldown). Scavenger class gets bonus.',
  '  TRANSFER_CREDITS: {"toAgentId": "agent_xxx", "amount": 25}  ← trade materials/credits with other agents',
  '  TERMINAL: {"message": "Status update..."}',
  '  VOTE: {"directiveId": "dir_xxx", "vote": "yes"}',
  '  SUBMIT_DIRECTIVE: {"description": "[Title] Description...", "agentsNeeded": 2, "hoursDuration": 24}',
  '  COMPLETE_DIRECTIVE: {"directiveId": "dir_xxx"}',
  '  START_CERTIFICATION: {"certificationId": "SWAP_EXECUTION_V1"}',
  '  ENCODE_SWAP: {} ← generates ready-to-use swap calldata. Returns router address and calldata for APPROVE_TOKEN and EXECUTE_ONCHAIN. Call this BEFORE executing a swap.',
  '  EXECUTE_ONCHAIN: {"runId": "uuid", "to": "0xContractAddress", "data": "0xCalldata", "value": "0"}',
  '  APPROVE_TOKEN: {"token": "0xTokenAddress", "spender": "0xSpenderAddress", "amount": "1000000"}',
  '  SUBMIT_CERTIFICATION_PROOF: {"runId": "uuid", "txHash": "0x..."}',
  '  CHECK_CERTIFICATION: {}',
  '  ACKNOWLEDGE_NOTIFICATION: {"notificationId": "notif_xxx"}  ← clear a system notification after reading it',
  '  IDLE: {}',
  '',
  '**BUILD ZONE RULE:** You MUST NOT build within 50 units of origin (0,0).',
  '**BUILD DISTANCE RULE:** You must be within 20 units of target coordinates to build. MOVE first, THEN build.',
  '**BUILD BLUEPRINT FLOW:** 1) Check BUILD CONTEXT in your tick prompt — it shows available blueprints for your location. 2) Pick the biggest blueprint you can afford. 3) Use a safe build spot near the node center. 4) BUILD_BLUEPRINT to start. 5) BUILD_CONTINUE every tick until done. 6) Pick next blueprint, repeat.',
  '**DENSIFY FIRST:** Build near existing nodes. Do NOT scatter to new locations until a node has 25+ structures.',
  'You can build any time you have credits. Directives are ONLY for organizing group projects.',
  '**ANTI-LOOP:** If your last 3+ actions were the same type AND failed, switch to something completely different. Move to new coordinates, try a different action, or IDLE.',
  '**NO TERMINAL SPAM:** TERMINAL is for significant events only. If you just sent a TERMINAL, do NOT send another. Take action instead.',
].join('\n');

// --- Class Bonus Map ---
const CLASS_BONUSES: Record<string, string> = {
  builder: '+20% credits',
  architect: 'exclusive blueprints',
  explorer: '+50% move range',
  diplomat: '2x vote weight',
  merchant: '+50% transfer bonus',
  scavenger: '+25% salvage',
  trader: '+30% credits, DeFi access',
  coordinator: '+10% credits, 2x votes',
  validator: 'can verify others',
  researcher: '+10% credits, analytics',
};

// --- Class Behavior Hints ---
const CLASS_HINTS: Record<string, string> = {
  builder: 'Your strength is construction. If uncertified, certify first to earn your badge. Once proven, your daily life is building — earn materials through scavenging and trades, then construct.',
  architect: 'Your strength is design. If uncertified, certify first. Once proven, plan large complex builds using exclusive blueprints. Coordinate with builders.',
  explorer: 'Your strength is movement and discovery. Certify to prove yourself, then scout new settlement sites, find frontiers, pioneer new nodes.',
  diplomat: 'Your strength is governance. Certify to establish credibility, then propose directives, vote on issues, mediate between agents, shape world policy.',
  merchant: 'Your strength is trade. Certify first, then transfer credits strategically, help agents who need resources, build economic connections.',
  scavenger: 'Your strength is resource gathering. Certify first, then scavenge materials, supply builders, find rare resources.',
  trader: 'Your strength is DeFi. If you haven\'t certified yet, do that first — it\'s your fastest path to reputation. Once certified, focus on trading, credit deals, and economic plays.',
  coordinator: 'Your strength is leadership. Certify to establish credibility, then organize group projects, propose directives, form guilds.',
  validator: 'Your strength is verification. Certify first to build trust, then validate other agents\' work, ensure quality in the network.',
  researcher: 'Your strength is analysis. Certify to prove capability, then study world state, find patterns, advise others on optimal strategies.',
};

function buildSystemPrompt(
  identity: string,
  lessons: string,
  longMemory: string,
  skillDoc: string,
  primeDirective: string,
  otherAgents: string,
  agentClass?: string,
): string {
  const classHint = agentClass ? CLASS_HINTS[agentClass] || '' : '';
  return [
    '# YOUR IDENTITY\n',
    identity,
    '\n---\n',
    '# OTHER AGENTS\n',
    otherAgents,
    '\n---\n',
    '# YOUR LESSONS\n',
    lessons || '_No lessons yet._',
    '\n---\n',
    '# YOUR LONG-TERM MEMORY\n',
    longMemory || '_No long-term memories yet._',
    '\n---\n',
    '# OPGRID WORLD RULES\n',
    primeDirective || '_No prime directive loaded._',
    '\n---\n',
    '# OPGRID SKILL DOCUMENT\n',
    skillDoc || '_No skill document loaded._',
    '\n---\n',
    '# COMMUNICATION STYLE',
    'Your "thought" field is your voice — what you are saying to the team over radio.',
    'Talk like yourself (see YOUR IDENTITY). React to what others build/do. Keep it natural.',
    'Be personal. Use "I", "we", "you". Talk to specific agents if nearby.',
    "Don't describe what you see — say what you're DOING about it.",
    'Attribution guard: NEVER claim another agent\'s action as your own.',
    '',
    '## Social Behavior',
    'You are in a shared world with other agents. Talk to them.',
    '- React to what others build or say',
    '- Ask for help on big projects',
    '- Share your plans and discoveries',
    '- If you see an agent nearby, greet them or coordinate',
    '- Mix actions: don\'t just build all day. Chat, explore, certify.',
    classHint ? `\n## Your Class Role\n${classHint}` : '',
    '\n---\n',
    '# ACTION FORMAT\n',
    ACTION_FORMAT,
  ].join('\n');
}

function buildTickPrompt(
  agentName: string,
  self: { position: { x: number; z: number }; status?: string } | undefined,
  credits: number,
  reputation: number,
  agentClass: string,
  worldAgents: Array<{ id: string; name: string; position: { x: number; z: number }; status: string }>,
  recentMessages: Array<{ agentName?: string; body: string; source: string }>,
  unreadDMs: DirectMessage[],
  recentActions: string[],
  directives: Array<{ id: string; description: string; status: string; yesVotes: number; noVotes: number }>,
  certRuns: Array<{ id: string; templateId: string; status: string; deadlineAt?: number }>,
  certTemplates: Array<{ id: string; displayName?: string; feeUsdcAtomic?: string }>,
  notifications: Array<{ id: string; type: string; title: string; body: string }>,
  blueprintCatalog: string,
  workingMemory: string,
  buildContextHint: string,
  materials?: Record<string, number>,
  walletBalances?: { eth: string; usdc: string; weth: string } | null,
): string {
  const posStr = self ? `(${self.position.x.toFixed(0)}, ${self.position.z.toFixed(0)})` : 'unknown';

  const sections: string[] = [];

  // Current state
  const classBonus = CLASS_BONUSES[agentClass] || '';
  const classSuffix = classBonus ? ` (${classBonus})` : '';
  sections.push(`# CURRENT STATE`);
  sections.push(`Position: ${posStr} | Credits: ${credits} | Reputation: ${reputation} | Class: ${agentClass}${classSuffix}`);
  // Material inventory
  if (materials && Object.keys(materials).length > 0) {
    const matStr = Object.entries(materials)
      .filter(([, v]) => v > 0)
      .map(([k, v]) => `${k}: ${v}`)
      .join(', ');
    sections.push(`Materials: ${matStr || 'none'}`);
    sections.push('Note: Medium/hard blueprints require materials. Use SCAVENGE to gather. Trade with other agents for what you need.');
  } else {
    sections.push('Materials: none (use SCAVENGE to gather stone, metal, glass, crystal, organic)');
  }
  sections.push('');

  // Blueprint catalog — EARLY in prompt so LLMs actually read it
  if (blueprintCatalog) {
    sections.push('# BLUEPRINT CATALOG');
    sections.push(blueprintCatalog);
    sections.push('');
  }

  // Build context hint — right after catalog
  if (buildContextHint) {
    sections.push('# BUILD CONTEXT (near your position)');
    sections.push(buildContextHint);
    sections.push('');
  }

  // Agent chat (direct conversation between agents)
  const chatMsgs = recentMessages.filter(m => (m as any).kind === 'chat');
  if (chatMsgs.length > 0) {
    sections.push(`# AGENT CHAT (${chatMsgs.length} recent messages)`);
    for (const m of chatMsgs.slice(-15)) {
      sections.push(`[${m.agentName}]: ${m.body}`);
    }
    sections.push('');
  }

  // Terminal broadcasts (agent announcements)
  const terminalMsgs = recentMessages.filter(m => (m as any).kind === 'terminal');
  if (terminalMsgs.length > 0) {
    sections.push(`# TERMINAL BROADCASTS (${terminalMsgs.length} recent)`);
    for (const m of terminalMsgs.slice(-5)) {
      sections.push(`[${m.agentName}]: ${m.body}`);
    }
    sections.push('');
  }

  // System events (builds, reputation, materials, directives)
  const sysEvts = recentMessages.filter(m => m.source === 'system');
  if (sysEvts.length > 0) {
    sections.push(`# WORLD EVENTS (${sysEvts.length} recent)`);
    for (const m of sysEvts.slice(-8)) {
      sections.push(`${m.body}`);
    }
    sections.push('');
  }

  // Unread DMs — framed for reply
  if (unreadDMs.length > 0) {
    sections.push(`# UNREAD DIRECT MESSAGES (${unreadDMs.length}) — consider replying with SEND_DM`);
    for (const dm of unreadDMs) {
      // Try to resolve sender name from world agents
      const sender = worldAgents.find(a => a.id === dm.fromId);
      const senderName = sender?.name || dm.fromId;
      sections.push(`From ${senderName}: "${dm.message}" — reply with SEND_DM to "${dm.fromId}"`);
    }
    sections.push('');
  }

  // Recent actions
  if (recentActions.length > 0) {
    sections.push(`# YOUR RECENT ACTIONS (last ${recentActions.length})`);
    for (const a of recentActions) {
      sections.push(a);
    }
    sections.push('');
  }

  // World snapshot
  sections.push('# WORLD SNAPSHOT');
  if (worldAgents.length > 0) {
    const agentList = worldAgents
      .map(a => `${a.name} (${a.position.x.toFixed(0)},${a.position.z.toFixed(0)}) [${a.status}]`)
      .join(', ');
    sections.push(`Agents online: ${agentList}`);
  }
  if (directives.length > 0) {
    sections.push('Active directives:');
    for (const d of directives) {
      sections.push(`  ${d.id}: "${d.description.slice(0, 80)}" [${d.status}] yes:${d.yesVotes} no:${d.noVotes}`);
    }
  }
  sections.push('');

  // Certification state — certTemplates only includes unlocked certs (server filters out maxed)
  if (certTemplates.length > 0 || certRuns.length > 0) {
    sections.push('# CERTIFICATIONS');
    if (certTemplates.length > 0) {
      sections.push('Available certifications: ' + certTemplates.map(t => {
        const name = t.id || t.displayName || 'unknown';
        const fee = t.feeUsdcAtomic ? `$${(Number(t.feeUsdcAtomic) / 1e6).toFixed(2)}` : '';
        const passes = (t as any).passCount != null ? ` ${(t as any).passCount}/${(t as any).maxPasses} passes` : '';
        return `${name} (${fee ? fee + ',' : ''}${passes})`;
      }).join(', '));
      sections.push('Use CHECK_CERTIFICATION to see full details, or START_CERTIFICATION with a certificationId to begin.');
    } else {
      // All certs locked
      sections.push('All available certifications completed! Check back when new certifications are added.');
    }
    const activeRuns = certRuns.filter(r => ['created', 'active', 'submitted', 'verifying'].includes(r.status));
    if (activeRuns.length > 0) {
      sections.push('Your active runs:');
      for (const r of activeRuns) {
        const deadline = r.deadlineAt ? new Date(r.deadlineAt).toISOString() : 'unknown';
        sections.push(`  ${r.id}: ${r.templateId} [${r.status}] deadline: ${deadline}`);
      }
    }
    const passedRuns = certRuns.filter(r => r.status === 'passed');
    if (passedRuns.length > 0) {
      const passByType = new Map<string, number>();
      for (const r of passedRuns) passByType.set(r.templateId, (passByType.get(r.templateId) || 0) + 1);
      const passDetails = Array.from(passByType.entries()).map(([id, n]) => `${id}: ${n}`).join(', ');
      sections.push(`Passed certifications: ${passedRuns.length} (${passDetails})`);
    }
    // Show which certs they haven't attempted (only from available/unlocked certs)
    const attemptedTypes = new Set(certRuns.map(r => r.templateId));
    const unattempted = certTemplates.filter(t => !attemptedTypes.has(t.id));
    if (unattempted.length > 0) {
      sections.push(`⚡ Not yet attempted: ${unattempted.map(t => t.id).join(', ')} — try these!`);
    }
    sections.push('');
  }

  // Wallet balances — actionable hints for certification
  if (walletBalances) {
    sections.push('# WALLET BALANCES (Base Sepolia)');
    sections.push(`ETH: ${walletBalances.eth} | USDC: ${walletBalances.usdc} | WETH: ${walletBalances.weth}`);
    const usdcNum = parseFloat(walletBalances.usdc);
    const wethNum = parseFloat(walletBalances.weth);
    if (usdcNum < 2 && wethNum > 0.001) {
      sections.push(`⚠️ LOW USDC! You have ${walletBalances.weth} WETH. Swap some WETH back to USDC before attempting certification. Use ENCODE_SWAP with tokenIn=WETH(0x4200000000000000000000000000000000000006), tokenOut=USDC(0x036CbD53842c5426634e7929541eC2318f3dCF7e).`);
    } else if (usdcNum < 2) {
      sections.push(`⚠️ LOW USDC and no WETH to swap back. Cannot pay certification fees.`);
    }
    sections.push('');
  }

  // Working memory
  if (workingMemory) {
    sections.push('# YOUR WORKING MEMORY');
    sections.push(workingMemory);
    sections.push('');
  }

  // Certification nudge
  const passedCerts = certRuns.filter(r => r.status === 'passed');
  const attemptedCertTypes = new Set(certRuns.map(r => r.templateId));
  const totalCertTypes = certTemplates.length;
  const attemptedCount = attemptedCertTypes.size;
  if (passedCerts.length === 0) {
    sections.push('🎯 You haven\'t earned ANY certification yet. Use CHECK_CERTIFICATION to see what\'s available, then START_CERTIFICATION to begin. Certifications prove your onchain capability and earn credits + reputation.');
    sections.push('');
  } else if (attemptedCount < totalCertTypes) {
    sections.push(`✅ Certified (${passedCerts.length} passed). But you've only tried ${attemptedCount}/${totalCertTypes} certifications. Use CHECK_CERTIFICATION to discover new ones — each certification tests different skills and earns different rewards.`);
    sections.push('');
  } else {
    sections.push(`✅ Certified (${passedCerts.length} passed across ${attemptedCount} certification types). Review past scores to see where you can improve.`);
    sections.push('');
  }

  // OpGrid system notifications (server-managed, must be acknowledged)
  if (notifications.length > 0) {
    sections.push('# 📬 OPGRID NOTIFICATIONS (unread)');
    for (const notif of notifications) {
      sections.push(`[${notif.type.toUpperCase()}] ${notif.title}`);
      sections.push(notif.body);
      sections.push(`→ Acknowledge with: ACKNOWLEDGE_NOTIFICATION {"notificationId": "${notif.id}"}`);
      sections.push('');
    }
  }

  // Action diversity nudge
  if (recentActions.length >= 3) {
    const actionTypes = new Set(recentActions.map(a => a.replace(/^\[.*?\]\s*/, '').split(':')[0].trim()));
    if (actionTypes.size <= 1) {
      sections.push('💡 You\'ve been doing the same thing repeatedly. Consider mixing it up: CHAT with nearby agents, start a CERTIFICATION, MOVE to explore, or propose a DIRECTIVE.');
      sections.push('');
    }
  }

  // Final prompt
  sections.push('# DECIDE');
  sections.push('What do you want to do? Respond with one JSON action.');

  // Social nudge — only when agents actually chatted (not just system events)
  if (chatMsgs.length > 0) {
    const otherChat = chatMsgs.filter(m => m.agentName !== agentName);
    if (otherChat.length > 0) {
      const lastChatter = otherChat[otherChat.length - 1].agentName;
      sections.push(`💬 ${lastChatter} spoke recently. Consider replying with CHAT or coordinating.`);
    }
  }
  if (unreadDMs.length > 0) {
    sections.push(`📩 You have ${unreadDMs.length} unread DM(s). Consider replying with SEND_DM.`);
  }

  return sections.join('\n');
}


// --- Action Executor ---

async function executeAction(
  api: GridAPIClient,
  name: string,
  decision: AgentDecision,
  agentPos?: { x: number; z: number },
  chain?: ChainClient,
): Promise<string | null> {
  const p = decision.payload || {};

  const validCoord = (val: unknown): number | null => {
    const n = Number(val);
    return (Number.isFinite(n) && n !== 0) ? n : null;
  };

  try {
    switch (decision.action) {
      case 'MOVE': {
        const targetX = Number(p.x);
        const targetZ = Number(p.z);
        if (agentPos && Number.isFinite(targetX) && Number.isFinite(targetZ)) {
          const dx = targetX - agentPos.x;
          const dz = targetZ - agentPos.z;
          const dist = Math.hypot(dx, dz);
          const MAX_STEP = 280; // stay under 300 limit with margin
          if (dist > MAX_STEP) {
            // Move in a single chunk toward the target
            const ratio = MAX_STEP / dist;
            const stepX = Math.round(agentPos.x + dx * ratio);
            const stepZ = Math.round(agentPos.z + dz * ratio);
            console.log(`[${name}] MOVE auto-chunk: ${dist.toFixed(0)} units → stepping to (${stepX}, ${stepZ})`);
            await api.action('MOVE', { x: stepX, z: stepZ });
            break;
          }
        }
        await api.action('MOVE', { x: targetX, z: targetZ });
        break;
      }

      case 'CHAT': {
        if (!p.message || typeof p.message !== 'string') break;
        const MAX_LEN = 280;
        const msg = (p.message as string).length <= MAX_LEN
          ? p.message as string
          : `${(p.message as string).slice(0, MAX_LEN - 3).trimEnd()}...`;
        await api.action('CHAT', { message: msg });
        console.log(`[${name}] Chat: "${msg.slice(0, 60)}..."`);
        break;
      }

      case 'SEND_DM': {
        const toAgentId = typeof p.toAgentId === 'string' ? p.toAgentId.trim() : '';
        const dmMessage = typeof p.message === 'string' ? p.message.trim().slice(0, 500) : '';
        if (!toAgentId || !dmMessage) break;
        if (toAgentId === api.getAgentId()) break;
        const sent = await api.sendDM(toAgentId, dmMessage);
        if (!sent) return `SEND_DM failed: unable to deliver to ${toAgentId}`;
        console.log(`[${name}] DM to ${toAgentId}: "${dmMessage.slice(0, 50)}..."`);
        break;
      }

      case 'BUILD_PRIMITIVE': {
        const bx = validCoord(p.x);
        const bz = validCoord(p.z);
        if (bx === null || bz === null) {
          return `BUILD_PRIMITIVE rejected: missing or zero x/z coordinates. Specify real coordinates near your position.`;
        }
        await api.buildPrimitive(
          (p.shape as string || 'box') as any,
          { x: bx, y: Number(p.y) || 0.5, z: bz },
          { x: p.rotX as number || 0, y: p.rotY as number || 0, z: p.rotZ as number || 0 },
          { x: p.scaleX as number || 1, y: p.scaleY as number || 1, z: p.scaleZ as number || 1 },
          p.color as string || '#3b82f6'
        );
        break;
      }

      case 'BUILD_MULTI': {
        const primitives = (p.primitives as Array<Record<string, unknown>>) || [];
        const batch = primitives.slice(0, 5);
        if (batch.length === 0) return 'BUILD_MULTI rejected: empty primitives array.';

        for (let i = 0; i < batch.length; i++) {
          const prim = batch[i];
          if (validCoord(prim.x) === null || validCoord(prim.z) === null) {
            return `BUILD_MULTI rejected: primitive ${i} has missing/zero coordinates.`;
          }
        }

        for (const prim of batch) {
          try {
            await api.buildPrimitive(
              (prim.shape as string || 'box') as any,
              { x: Number(prim.x), y: Number(prim.y) || 0.5, z: Number(prim.z) },
              { x: prim.rotX as number || 0, y: prim.rotY as number || 0, z: prim.rotZ as number || 0 },
              { x: prim.scaleX as number || 1, y: prim.scaleY as number || 1, z: prim.scaleZ as number || 1 },
              prim.color as string || '#3b82f6'
            );
          } catch (err: any) {
            return `BUILD_MULTI failed after partial placement: ${err?.message || err}`;
          }
        }
        break;
      }

      case 'BUILD_BLUEPRINT':
        await api.startBlueprint(p.name as string, p.anchorX as number, p.anchorZ as number, p.rotY != null ? Number(p.rotY) : undefined);
        console.log(`[${name}] Started blueprint: ${p.name} at (${p.anchorX}, ${p.anchorZ})`);
        break;

      case 'BUILD_CONTINUE': {
        const result = await api.continueBlueprint() as any;
        console.log(`[${name}] Blueprint progress: ${result.placed}/${result.total} [${result.status}]`);
        break;
      }

      case 'CANCEL_BUILD':
        await api.cancelBlueprint();
        break;

      case 'TERMINAL':
        await api.writeTerminal(p.message as string);
        break;

      case 'VOTE':
        if (!p.directiveId || typeof p.directiveId !== 'string' || !p.directiveId.startsWith('dir_')) break;
        await api.vote(p.directiveId as string, p.vote as 'yes' | 'no');
        break;

      case 'SUBMIT_DIRECTIVE':
        if (!p.description || typeof p.description !== 'string') break;
        await api.submitDirective(
          p.description as string,
          (p.agentsNeeded as number) || 2,
          (p.hoursDuration as number) || 24,
          {
            targetX: typeof p.targetX === 'number' ? p.targetX : undefined,
            targetZ: typeof p.targetZ === 'number' ? p.targetZ : undefined,
          }
        );
        break;

      case 'COMPLETE_DIRECTIVE':
        if (!p.directiveId || typeof p.directiveId !== 'string' || !p.directiveId.startsWith('dir_')) break;
        await api.completeDirective(p.directiveId as string);
        break;

      case 'TRANSFER_CREDITS': {
        if (!p.toAgentId || !p.amount || typeof p.amount !== 'number' || p.amount <= 0) break;
        let resolvedId = p.toAgentId as string;
        if (!resolvedId.startsWith('agent_')) {
          try {
            const agentsRes = await api.getAgentsLite();
            const matched = (agentsRes.data?.agents || []).find(
              (a: any) => a.name?.toLowerCase() === resolvedId.toLowerCase() || a.id === resolvedId
            );
            if (matched) resolvedId = matched.id;
          } catch { /* use raw value */ }
        }
        await api.transferCredits(resolvedId, p.amount as number);
        break;
      }

      case 'ENCODE_SWAP': {
        const encResult = await api.encodeSwapCalldata({
          recipient: typeof p.recipient === 'string' ? p.recipient : undefined,
          amountIn: typeof p.amountIn === 'string' || typeof p.amountIn === 'number' ? String(p.amountIn) : undefined,
          amountOutMinimum: typeof p.amountOutMinimum === 'string' || typeof p.amountOutMinimum === 'number' ? String(p.amountOutMinimum) : undefined,
        });
        console.log(`[${name}] Encoded swap calldata: router=${encResult.router}`);

        // If the response has slippage options, the agent must pick one
        const opts = (encResult as any).options;
        if (opts && typeof opts === 'object') {
          const chosen = typeof p.slippageOption === 'string' ? p.slippageOption.toUpperCase() : '';
          if (chosen === 'D' && (typeof p.amountOutMinimum === 'string' || typeof p.amountOutMinimum === 'number')) {
            // Option D: custom — agent provided their own amountOutMinimum, re-call API to get calldata
            const customResult = await api.encodeSwapCalldata({
              recipient: typeof p.recipient === 'string' ? p.recipient : undefined,
              amountIn: typeof p.amountIn === 'string' || typeof p.amountIn === 'number' ? String(p.amountIn) : undefined,
              amountOutMinimum: String(p.amountOutMinimum),
            });
            (decision as any)._encodeSwapResult = JSON.stringify({
              router: customResult.router,
              calldata: customResult.calldata,
              chosenOption: 'D (custom +5 bonus)',
              amountOutMinimum: String(p.amountOutMinimum),
              params: customResult.params,
              usage: customResult.usage,
            });
          } else if (chosen && opts[chosen] && opts[chosen].calldata && !opts[chosen].calldata.startsWith('Call')) {
            // Agent picked a preset option (A/B/C/E) — use its calldata
            (decision as any)._encodeSwapResult = JSON.stringify({
              router: encResult.router,
              calldata: opts[chosen].calldata,
              chosenOption: chosen,
              label: opts[chosen].label,
              params: (encResult as any).params,
              usage: (encResult as any).usage,
            });
          } else {
            // Present options summary (without raw calldata to save context)
            const optionSummary = Object.entries(opts).map(([k, v]: [string, any]) =>
              `${k}: ${v.label} (amountOutMinimum=${v.amountOutMinimum}${v.bonus ? `, +${v.bonus} bonus` : ''})`
            ).join(' | ');
            (decision as any)._encodeSwapResult = JSON.stringify({
              router: encResult.router,
              challenge: (encResult as any).challenge,
              quotedOutput: (encResult as any).quotedOutput,
              options: optionSummary,
              instruction: 'Call ENCODE_SWAP again with { "slippageOption": "B" } (or A/C/D/E) to get calldata. Option D is custom: provide { "slippageOption": "D", "amountOutMinimum": "<your value>" } for +5 bonus points. Choose wisely — your choice affects your certification score.',
            });
          }
        } else {
          (decision as any)._encodeSwapResult = JSON.stringify(encResult);
        }
        break;
      }

      case 'START_CERTIFICATION': {
        const certificationId = typeof p.certificationId === 'string' ? p.certificationId.trim()
          : typeof p.templateId === 'string' ? p.templateId.trim() : '';
        if (!certificationId) break;
        const certResult = await api.startCertification(certificationId);
        const runId = certResult.run?.id || 'unknown';
        const wo = certResult.workOrder;
        console.log(`[${name}] Started certification: ${certificationId} (run: ${runId})`);
        if (wo) {
          console.log(`[${name}] Work order: ${JSON.stringify(wo)}`);
          (decision as any)._certInfo = `[CERT_STARTED] Run: ${runId} | Certification: ${certificationId} | Work order: ${JSON.stringify(wo)}`;
        }
        (decision as any)._certRunId = runId;
        break;
      }

      case 'SUBMIT_CERTIFICATION_PROOF': {
        const runId = typeof p.runId === 'string' ? p.runId.trim() : '';
        const txHash = typeof p.txHash === 'string' ? p.txHash.trim() : '';
        if (!runId || !txHash) {
          console.warn(`[${name}] SUBMIT_CERTIFICATION_PROOF missing runId or txHash`);
          (decision as any)._certSubmitResult = `[CERT_SUBMIT_ERROR] Missing runId="${runId}" or txHash="${txHash}". Both are required.`;
          break;
        }
        try {
          const proofPayload: Record<string, unknown> = { txHash };
          // Pass slippageOption through so custom option D gets +5 bonus
          if (typeof p.slippageOption === 'string') {
            proofPayload.slippageOption = p.slippageOption.toUpperCase();
          }
          const proofResult = await api.submitCertificationProof(runId, proofPayload as any);
          const passed = proofResult.verification?.passed;
          const score = (proofResult as any).score || 0;
          console.log(`[${name}] Cert proof for ${runId}: ${passed ? 'PASSED ✓' : 'FAILED ✗'} (score: ${score})`);
          (decision as any)._certSubmitResult = `[CERT_RESULT] ${passed ? 'PASSED' : 'FAILED'} score=${score} runId=${runId}`;
        } catch (err: any) {
          console.error(`[${name}] SUBMIT_CERTIFICATION_PROOF error:`, err?.message || err);
          (decision as any)._certSubmitResult = `[CERT_SUBMIT_ERROR] ${err?.message || 'Unknown error'}. runId=${runId} txHash=${txHash}`;
        }
        break;
      }

      case 'CHECK_CERTIFICATION': {
        const { runs, certifications } = await api.getCertificationRunsWithProgress();
        const passed = runs.filter(r => r.status === 'passed').length;
        console.log(`[${name}] Cert runs: ${runs.length} total, ${passed} passed`);

        const infoParts: string[] = [];

        // Show per-certification progress (available vs locked)
        if (certifications && certifications.length > 0) {
          const available = certifications.filter(c => !c.locked);
          const locked = certifications.filter(c => c.locked);
          if (available.length > 0) {
            infoParts.push('AVAILABLE CERTIFICATIONS: ' + available.map(c => {
              const fee = c.feeUsdcAtomic ? `fee: ${(Number(c.feeUsdcAtomic) / 1e6).toFixed(2)} USDC` : '';
              return `${c.certificationId} (${c.passCount}/${c.maxPasses} passes${fee ? ', ' + fee : ''})`;
            }).join(', '));
          }
          if (locked.length > 0) {
            infoParts.push('COMPLETED (locked): ' + locked.map(c => `${c.certificationId} (${c.passCount}/${c.maxPasses})`).join(', '));
          }
          if (available.length > 0) {
            infoParts.push(`Use START_CERTIFICATION {"certificationId": "${available[0].certificationId}"} to begin.`);
          }
        }

        // Feed active run details back so LLM can see work orders
        const activeRuns = runs.filter(r => r.status === 'active' || r.status === 'created');
        if (activeRuns.length > 0) {
          const details = activeRuns.map((r: any) => {
            const parts = [`Run ${r.id}: ${r.templateId} [${r.status}]`];
            if (r.deadlineAt) parts.push(`deadline: ${new Date(r.deadlineAt).toISOString()}`);
            if (r.challenge) {
              const c = r.challenge;
              if (c.objective) parts.push(`objective: ${c.objective}`);
              if (c.constraints) parts.push(`constraints: ${JSON.stringify(c.constraints)}`);
              if (c.tools) parts.push(`tools: ${c.tools.join(', ')}`);
              if (c.hints) parts.push(`hints: ${JSON.stringify(c.hints)}`);
              if (c.submission) parts.push(`submit: ${JSON.stringify(c.submission)}`);
            }
            return parts.join(' | ');
          }).join('\n');
          infoParts.push('ACTIVE RUNS:\n' + details);
        }

        const certInfo = infoParts.join('\n');
        if (certInfo) {
          console.log(`[${name}] Cert check:\n${certInfo}`);
          (decision as any)._certInfo = `[CERT_CHECK]\n${certInfo}`;
        }
        break;
      }

      case 'ACKNOWLEDGE_NOTIFICATION': {
        const notifId = typeof p.notificationId === 'string' ? p.notificationId.trim() : '';
        if (!notifId) break;
        try {
          await api.acknowledgeNotification(notifId);
          console.log(`[${name}] Acknowledged notification: ${notifId}`);
        } catch (err: any) {
          console.warn(`[${name}] Failed to acknowledge notification: ${err?.message}`);
        }
        break;
      }

      case 'EXECUTE_SWAP':
        console.warn(`[${name}] EXECUTE_SWAP deprecated. Use EXECUTE_ONCHAIN instead.`);
        break;

      case 'EXECUTE_ONCHAIN': {
        const to = typeof p.to === 'string' ? p.to.trim().toLowerCase() : '';
        const data = typeof p.data === 'string' ? p.data.trim() : '';
        if (!to || !data || !chain) break;
        if (!/^0x[a-fA-F0-9]{40}$/.test(to) || !/^0x[a-fA-F0-9]*$/.test(data)) break;
        let value = p.value ? BigInt(String(p.value)) : 0n;
        // Safety cap: USDC→WETH swaps should NOT send ETH value. Cap at 0.01 ETH to prevent LLM mistakes.
        const MAX_VALUE = BigInt('10000000000000000'); // 0.01 ETH
        if (value > MAX_VALUE) {
          console.warn(`[${name}] EXECUTE_ONCHAIN value ${value} exceeds safety cap. Capping to 0.`);
          value = 0n;
        }
        const txHash = await chain.sendTransaction(to, data, value);
        console.log(`[${name}] Tx confirmed: ${txHash}`);
        (decision as any)._txHash = txHash;
        break;
      }

      case 'APPROVE_TOKEN': {
        const token = typeof p.token === 'string' ? p.token.trim().toLowerCase() : '';
        const spender = typeof p.spender === 'string' ? p.spender.trim().toLowerCase() : '';
        if (!token || !spender || !p.amount || !chain) break;
        const amount = BigInt(String(p.amount));
        const approveHash = await chain.approveToken(token, spender, amount);
        console.log(`[${name}] Approval confirmed: ${approveHash}`);
        (decision as any)._txHash = approveHash;
        break;
      }

      case 'SCAVENGE': {
        const scResult = await api.scavenge() as any;
        if (scResult.error) return `SCAVENGE failed: ${scResult.error}`;
        console.log(`[${name}] Scavenged ${scResult.totalHarvested || 0} materials, +${scResult.creditYield || 0} credits`);
        break;
      }

      case 'IDLE':
        break;

      default:
        console.warn(`[${name}] Unknown action: ${decision.action}`);
        return `Unknown action "${decision.action}". Valid actions: MOVE, CHAT, SEND_DM, BUILD_PRIMITIVE, BUILD_MULTI, BUILD_BLUEPRINT, BUILD_CONTINUE, CANCEL_BUILD, VOTE, SUBMIT_DIRECTIVE, COMPLETE_DIRECTIVE, TRANSFER_CREDITS, ENCODE_SWAP, START_CERTIFICATION, SUBMIT_CERTIFICATION_PROOF, CHECK_CERTIFICATION, EXECUTE_ONCHAIN, APPROVE_TOKEN, SCAVENGE, IDLE`;
    }
  } catch (err: any) {
    const errMsg = err?.message || String(err);
    console.error(`[${name}] Action ${decision.action} failed:`, errMsg);
    return errMsg;
  }
  return null;
}


// --- Core Runtime ---

export async function startAgent(config: AgentConfig): Promise<void> {
  const sharedDir = join(config.dir, '..', 'shared');
  const memoryDir = join(config.dir, 'memory');
  if (!existsSync(memoryDir)) mkdirSync(memoryDir, { recursive: true });

  // 1. Load soul files
  const identity = readMd(join(config.dir, 'IDENTITY.md'));
  const otherAgents = readMd(join(config.dir, 'AGENTS.md'));
  const longMemory = readMd(join(config.dir, 'MEMORY.md'));
  const lessons = readMd(join(config.dir, 'LESSONS.md')) || readMd(join(sharedDir, 'LESSONS.md'));

  const agentName = identity.match(/^#\s+(.+)/m)?.[1] || 'Agent';
  const agentColor = identity.match(/color:\s*(#[0-9a-fA-F]{6})/)?.[1] || '#6b7280';
  const agentBio = identity.match(/bio:\s*"([^"]+)"/)?.[1] || 'An autonomous agent on OpGrid.';

  // Key rotator: if agent has a pool of key x model buckets, create rotator
  const rotator: KeyRotator | null = config.llmPool && config.llmPool.length > 0
    ? new KeyRotator({ agentName, buckets: config.llmPool, defaultCooldownMs: 60_000 })
    : null;
  if (rotator) {
    console.log(`[${agentName}] Key rotator active: ${config.llmPool!.length} buckets`);
  }

  // 2. Enter OpGrid
  const api = new GridAPIClient();
  console.log(`[${agentName}] Entering OpGrid (wallet: ${config.walletAddress})...`);

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
      errMsg.includes('wallet does not own');

    if (isOwnershipDenied && config.privateKey) {
      console.log(`[${agentName}] Wallet doesn't own agent ID. Registering new one...`);
      const chain = new ChainClient(config.privateKey);
      try {
        const balance = await chain.getBalance();
        if (balance > BigInt(0)) {
          const newId = await chain.register();
          console.log(`[${agentName}] Registered new agent ID: ${newId}. Update .env.`);
          await api.enter(config.privateKey, newId.toString(), agentName, agentColor, agentBio, config.erc8004Registry);
          enteredOk = true;
        } else {
          console.error(`[${agentName}] No ETH for gas. Fund wallet and restart.`);
          return;
        }
      } catch (regErr) {
        console.error(`[${agentName}] Registration failed:`, regErr);
        return;
      }
    } else {
      console.error(`[${agentName}] Failed to enter world:`, err);
      logNetworkFailure(agentName, err);
      return;
    }
  }

  if (!enteredOk) return;

  // Auto-set class from identity file if not already set
  const identityClass = identity.match(/class:\s*(\w+)/i)?.[1]?.toLowerCase();
  if (identityClass && CLASS_BONUSES[identityClass]) {
    try {
      const currentProfile = await api.getWorldState().then(s => s.agents.find(a => a.id === api.getAgentId()));
      if (!(currentProfile as any)?.agentClass || (currentProfile as any)?.agentClass === 'builder') {
        const apiUrl = process.env.GRID_API_URL || 'http://localhost:4101';
        const profileRes = await fetch(`${apiUrl}/v1/agents/profile`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${api.getToken()}`,
          },
          body: JSON.stringify({ agentClass: identityClass }),
        });
        if (profileRes.ok) {
          console.log(`[${agentName}] Auto-set class to: ${identityClass}`);
        }
      }
    } catch (err) {
      console.warn(`[${agentName}] Could not auto-set class:`, err);
    }
  }

  // 3. Create ChainClient for onchain actions
  const agentChain = config.privateKey ? new ChainClient(config.privateKey) : null;
  if (agentChain) {
    console.log(`[${agentName}] ChainClient initialized (${agentChain.getAddress()})`);
  }

  // 4. Fetch OpGrid knowledge (same as any external agent)
  let skillDoc = '';
  let primeDirectiveDoc = '';
  try {
    const skillRes = await fetch(`${process.env.GRID_API_URL || 'http://localhost:4101'}/skill.md`);
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
    }
  } catch (err) {
    console.warn(`[${agentName}] Could not fetch prime-directive:`, err);
  }

  // 5. Build system prompt (static, ~5-8KB)
  const detectedClass = identityClass || 'builder';
  const systemPrompt = buildSystemPrompt(identity, lessons, longMemory, skillDoc, primeDirectiveDoc, otherAgents, detectedClass);

  // 6. Reset working memory for fresh session
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
  console.log(`[${agentName}] Working memory reset`);

  // 7. Cache blueprint catalog (refreshed every 50 ticks)
  let cachedBlueprintCatalog = '';
  let blueprintCacheTick = 0;
  const BLUEPRINT_REFRESH = 50;

  // 8. Heartbeat loop
  console.log(`[${agentName}] Heartbeat started (every ${config.heartbeatSeconds}s)`);

  let idleStreak = 0;
  let tickCount = 0;
  let rateLimitCooldownUntil = 0;
  let tickInProgress = false;
  let recentActionLog: string[] = [];

  const tick = async () => {
    if (tickInProgress) {
      console.warn(`[${agentName}] Tick still in progress, skipping`);
      return;
    }
    tickInProgress = true;
    tickCount++;

    try {
      // Rate limit cooldown
      if (Date.now() < rateLimitCooldownUntil) {
        console.log(`[${agentName}] Rate limited, sleeping...`);
        return;
      }

      // a. Fetch world state
      const world = await api.getWorldState();
      const self = world.agents.find(a => a.id === api.getAgentId());
      const otherWorldAgents = world.agents.filter(a => a.id !== api.getAgentId());

      // b. Fetch additional data
      const [credits, directives, certTemplates, certRuns, unreadDMs, materials] = await Promise.all([
        api.getCredits().catch(() => 0),
        api.getDirectives().catch(() => []),
        api.getCertificationTemplates().catch(() => []),
        api.getCertificationRuns().catch(() => []),
        api.getInbox(true).catch(() => [] as DirectMessage[]),
        api.getMaterials().catch(() => ({} as Record<string, number>)),
      ]);

      // Agent class
      const agentClass = (self as any)?.agentClass || 'builder';

      // Reputation
      const localRep = (self as any)?.localReputation || 0;
      const onchainRep = (self as any)?.reputationScore || 0;
      const reputation = (self as any)?.combinedReputation || (localRep + onchainRep);

      // c. Blueprint catalog is now derived from build-context (dynamic, location-aware)
      // We still keep a minimal fallback catalog in case build-context fails
      if (tickCount - blueprintCacheTick >= BLUEPRINT_REFRESH || !cachedBlueprintCatalog) {
        try {
          const bps = await api.getBlueprints();
          const entries = Object.entries(bps || {}).slice(0, 30);
          cachedBlueprintCatalog = [
            '## BLUEPRINT NAMES (use EXACT names with BUILD_BLUEPRINT)',
            '❌ DO NOT invent names. ONLY use names from this list or from BUILD CONTEXT below.',
            '✅ ' + entries.map(([name]) => name).join(', '),
          ].join('\n');
          blueprintCacheTick = tickCount;
        } catch { /* keep cached */ }
      }

      // d. Fetch build context for current position (includes available blueprints)
      let buildContextHint = '';
      if (self) {
        try {
          const apiUrl = process.env.GRID_API_URL || 'http://localhost:4101';
          const bcRes = await fetch(`${apiUrl}/v1/grid/build-context?x=${Math.round(self.position.x)}&z=${Math.round(self.position.z)}`);
          if (bcRes.ok) {
            const bc = await bcRes.json() as any;
            const lines: string[] = [];

            // 1. NODE STATUS
            if (bc.nearestNode) {
              lines.push(`## NODE: "${bc.nearestNode.name}" (${bc.nearestNode.tier}, ${bc.nearestNode.structures} structures, ${bc.nearestNode.distance}u away)`);
            } else {
              lines.push('## NO NEARBY NODE — found a new settlement with a big anchor build');
            }
            if (bc.nodeGrowthStage && bc.stageGuidance) {
              const tierInfo = bc.structuresToNextTier > 0 ? ` (${bc.structuresToNextTier} more to next tier)` : '';
              lines.push(`Stage: ${bc.nodeGrowthStage}${tierInfo}`);
              lines.push(`${bc.stageGuidance}`);
            }
            if (bc.categoriesMissing?.length > 0) {
              lines.push(`Missing categories: ${bc.categoriesMissing.join(', ')} — build these for diversity!`);
            }

            // 2. AVAILABLE BLUEPRINTS (filtered by node tier — the key guided info)
            if (bc.availableBlueprints?.length > 0) {
              const available = (bc.availableBlueprints as any[]).filter((bp: any) => bp.available);
              const locked = (bc.availableBlueprints as any[]).filter((bp: any) => !bp.available);
              // Sort available by prims descending (build big first)
              available.sort((a: any, b: any) => (b.prims || 0) - (a.prims || 0));
              lines.push('');
              lines.push('## BLUEPRINTS YOU CAN BUILD HERE (pick one):');
              for (const bp of available) {
                const matStr = bp.materialCost ? ` [costs: ${Object.entries(bp.materialCost).map(([k,v]) => `${k}:${v}`).join(', ')}]` : ' [free]';
                lines.push(`  ${bp.name}: ${bp.category} (${bp.prims} prims, ${bp.difficulty})${matStr}`);
              }
              if (locked.length > 0) {
                lines.push(`Locked (${locked.length}): ${locked.map((bp: any) => `${bp.name} (${bp.reason})`).join(', ')}`);
              }
              lines.push('');
              lines.push('BUILD BIG — pick the highest-prim blueprint you can afford. Use BUILD_BLUEPRINT with the EXACT name, then BUILD_CONTINUE each tick.');
            }

            // 3. SAFE BUILD SPOTS
            if (bc.safeBuildSpots?.length > 0) {
              lines.push('');
              lines.push('## SAFE BUILD SPOTS (use these coordinates):');
              for (const s of bc.safeBuildSpots.slice(0, 4)) {
                lines.push(`  (${s.x}, ${s.z}) [${s.type}] nearest: ${s.distToNearest}u`);
              }
            }

            // 4. MATERIAL GUIDANCE
            if (materials && typeof materials === 'object') {
              const totalMats = Object.values(materials as Record<string, number>).reduce((s, v) => s + (v || 0), 0);
              if (totalMats < 2) {
                lines.push('');
                lines.push('Low on materials. SCAVENGE to gather materials for bigger blueprints, or build a free blueprint now.');
              }
            }

            // 5. DENSIFICATION RULES
            if (bc.nearestNode) {
              const dist = bc.nearestNode.distance ?? 999;
              const sc = bc.nearestNode.structures ?? 0;
              if (dist > 50) {
                lines.push('');
                lines.push('⚠️ You are FAR from any node. MOVE to the nearest node center first, THEN build.');
              } else if (sc < 25) {
                lines.push('');
                lines.push(`DENSIFY: This node has ${sc}/25 structures. Build NEAR the center (within 15-25u). Do NOT start a new node yet.`);
              }
            }

            // 6. BUILD METHODOLOGY (concise)
            lines.push('');
            lines.push('## BUILD METHOD: 1) Pick biggest available blueprint 2) Use safe build spot near node center 3) BUILD_BLUEPRINT 4) BUILD_CONTINUE every tick until done 5) Pick next blueprint, repeat');

            buildContextHint = lines.join('\n');
          }
        } catch { /* ok without */ }
      }

      // e. Format recent messages — separate chat from system events
      const allEvents = (world.events || []).slice(-50);
      const chatMessages = allEvents
        .filter((e: any) => e.kind === 'chat')
        .slice(-15)
        .map((e: any) => ({
          agentName: e.agentName || 'System',
          body: e.body || '',
          source: e.source || 'system',
          kind: 'chat' as const,
        }));
      const terminalMessages = allEvents
        .filter((e: any) => e.kind === 'status' && e.source === 'agent')
        .slice(-10)
        .map((e: any) => ({
          agentName: e.agentName || 'System',
          body: e.body || '',
          source: e.source || 'system',
          kind: 'terminal' as const,
        }));
      const systemEvents = allEvents
        .filter((e: any) => e.source === 'system' && ['build', 'reputation', 'material', 'directive'].includes(e.kind))
        .slice(-10)
        .map((e: any) => ({
          agentName: e.agentName || 'System',
          body: e.body || '',
          source: e.source || 'system',
          kind: (e.kind || 'system') as string,
        }));
      // Combined for backward compat with buildTickPrompt signature
      const recentMessages = [...chatMessages, ...terminalMessages, ...systemEvents];

      // f. Read working memory
      const workingMemory = readMd(join(memoryDir, 'WORKING.md'));

      // f2. Fetch wallet balances (non-blocking)
      let walletBalances: { eth: string; usdc: string; weth: string } | null = null;
      if (agentChain) {
        try {
          walletBalances = await agentChain.getWalletSummary();
        } catch { /* non-blocking */ }
      }

      // g. Fetch notifications from OpGrid
      let notifications: Array<{ id: string; type: string; title: string; body: string }> = [];
      try {
        notifications = await api.getNotifications().catch(() => []);
      } catch { /* non-blocking */ }

      // h. Build per-tick prompt
      const userPrompt = buildTickPrompt(
        agentName,
        self,
        credits,
        reputation,
        agentClass,
        otherWorldAgents,
        recentMessages,
        unreadDMs,
        recentActionLog.slice(-5),
        directives,
        certRuns,
        certTemplates,
        notifications,
        cachedBlueprintCatalog,
        workingMemory,
        buildContextHint,
        materials,
        walletBalances,
      );

      const trimmedPrompt = trimPromptForLLM(userPrompt);

      // h. LLM decides
      console.log(`[${agentName}] Tick ${tickCount} — calling LLM (prompt: ${trimmedPrompt.length} chars)`);
      let llmResponse: LLMResponse;
      let usedProvider = config.llmProvider;

      if (rotator) {
        // Rotator path: try buckets in order, rotating on 429
        const result = await rotator.call(
          (bucket) => callLLM(
            { llmProvider: bucket.provider, llmModel: bucket.model, llmApiKey: bucket.apiKey },
            systemPrompt,
            trimmedPrompt,
          ),
          (err) => isRateLimitErrorMessage((err as any)?.message || String(err)),
        );
        llmResponse = result;
        usedProvider = result.bucket.provider;
        console.log(`[${agentName}] LLM responded via ${result.bucket.label}${formatTokenLog(usedProvider, result.usage)}`);
      } else {
        // Single-key path (Smith on MiniMax, etc.)
        llmResponse = await callLLM(config, systemPrompt, trimmedPrompt);
        console.log(`[${agentName}] LLM responded${formatTokenLog(usedProvider, llmResponse.usage)}`);
      }

      // i. Clean LLM response (strip <think> tags from MiniMax etc)
      const cleanedText = llmResponse.text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

      // Parse decision
      const parsed = parseFirstJsonObject(cleanedText);
      if (!parsed || !parsed.action) {
        console.warn(`[${agentName}] Failed to parse LLM response: ${llmResponse.text.slice(0, 200)}`);
        return;
      }

      const decision: AgentDecision = {
        thought: String(parsed.thought || ''),
        action: String(parsed.action) as AgentDecision['action'],
        payload: (parsed.payload as Record<string, unknown>) || parsed,
      };

      console.log(`[${agentName}] Decision: ${decision.action} — "${decision.thought.slice(0, 80)}"`);

      // j. Execute action
      const actionError = await executeAction(api, agentName, decision, self?.position, agentChain || undefined);
      if (actionError) {
        console.warn(`[${agentName}] Action error: ${actionError.slice(0, 200)}`);
      }

      // k. Emit action chat update
      await emitActionUpdateChat(api, agentName, decision, tickCount, actionError);

      // l. Track consecutive same-action
      const prevAction = workingMemory.match(/Last action: (.+)/)?.[1] || 'NONE';
      const consecutive = prevAction === decision.action
        ? (Number(workingMemory.match(/Consecutive same-action: (\d+)/)?.[1]) || 0) + 1
        : 1;

      // m. Update working memory
      const actionSummary = actionError
        ? `${decision.action} FAILED: ${actionError.slice(0, 100)}`
        : `${decision.action}: ${decision.thought.slice(0, 120)}`;

      const latestMsgId = Math.max(
        Number(workingMemory.match(/Last seen message id: (\d+)/)?.[1]) || 0,
        ...recentMessages.map((m: any) => Number(m.id) || 0),
      );

      // BUILD_CONTINUE is expected to repeat until blueprint finishes — never flag it as a loop
      const loopWarning = consecutive >= 4 && decision.action !== 'BUILD_CONTINUE'
        ? `⚠ LOOP DETECTED: You have done ${decision.action} ${consecutive}x in a row. You MUST pick a DIFFERENT action now.`
        : '';

      const newWorking = [
        '# Working Memory',
        `Last updated: ${timestamp()}`,
        `Last action: ${decision.action}`,
        `Consecutive same-action: ${consecutive}`,
        `Last action detail: ${actionSummary}`,
        `Position: (${self?.position.x.toFixed(1) || '?'}, ${self?.position.z.toFixed(1) || '?'})`,
        `Credits: ${credits}`,
        `Reputation: ${reputation}`,
        `Class: ${agentClass}`,
        `Last seen message id: ${latestMsgId}`,
        actionError ? `Last error: ${actionError.slice(0, 200)}` : '',
        loopWarning,
      ].filter(Boolean).join('\n');
      writeMd(join(memoryDir, 'WORKING.md'), newWorking);

      // n. Append to daily log
      const dailyLogPath = join(memoryDir, `${todayDate()}.md`);
      if (!existsSync(dailyLogPath)) {
        writeMd(dailyLogPath, `# Daily Log — ${todayDate()}\n\n`);
      }
      appendLog(dailyLogPath, `[${timestamp()}] ${decision.action}: ${decision.thought}`);

      // o. Track recent actions for next tick
      recentActionLog.push(`[${timestamp()}] ${decision.action}: ${decision.thought.slice(0, 80)}`);
      // Append cert info if present (work orders, challenge details)
      if ((decision as any)._certInfo) {
        recentActionLog.push((decision as any)._certInfo);
      }
      // Append encode-swap result so agent can use the calldata on next tick
      if ((decision as any)._encodeSwapResult) {
        recentActionLog.push(`[SWAP_CALLDATA] ${(decision as any)._encodeSwapResult}`);
      }
      // Append tx hash so agent can use it for SUBMIT_CERTIFICATION_PROOF
      if ((decision as any)._txHash) {
        recentActionLog.push(`[TX_HASH] ${(decision as any)._txHash}`);
      }
      // Append cert run ID so agent knows which run to submit proof for
      if ((decision as any)._certRunId) {
        recentActionLog.push(`[CERT_RUN_ID] ${(decision as any)._certRunId}`);
      }
      // Append cert submit result
      if ((decision as any)._certSubmitResult) {
        recentActionLog.push((decision as any)._certSubmitResult);
      }
      if (recentActionLog.length > 10) recentActionLog = recentActionLog.slice(-10);

      // p. Mark DMs read
      if (unreadDMs.length > 0) {
        try {
          await api.markDMsRead(unreadDMs.map(dm => dm.id));
        } catch { /* ok */ }
      }

      // q. Dynamic idle backoff
      if (decision.action === 'IDLE') {
        idleStreak++;
      } else {
        idleStreak = 0;
      }

    } catch (err) {
      if (isAuthSessionError(err)) {
        console.warn(`[${agentName}] Session rejected (401). Re-entering...`);
        try {
          await api.enter(config.privateKey, config.erc8004AgentId, agentName, agentColor, agentBio, config.erc8004Registry);
          console.log(`[${agentName}] Re-entered successfully.`);
        } catch (reauthErr) {
          console.error(`[${agentName}] Re-entry failed:`, reauthErr);
        }
        return;
      }

      const errMsg = (err as any)?.message || String(err);
      if (isRateLimitErrorMessage(errMsg)) {
        if (rotator) {
          // Rotator already tried all buckets — set tick cooldown to earliest recovery
          const nextAvail = rotator.allCoolingDown();
          if (nextAvail > 0) {
            rateLimitCooldownUntil = nextAvail;
            const waitSec = Math.max(0, Math.ceil((nextAvail - Date.now()) / 1000));
            console.warn(`[${agentName}] All buckets exhausted. Next tick in ~${waitSec}s. [${rotator.status()}]`);
          }
        } else {
          // Legacy single-key cooldown
          const baseCooldown = parseRateLimitCooldownSeconds(errMsg, 45);
          const jitter = Math.floor(Math.random() * 15);
          const cooldown = baseCooldown + jitter;
          rateLimitCooldownUntil = Date.now() + cooldown * 1000;
          console.warn(`[${agentName}] Rate limited. Cooling down for ${cooldown}s.`);
        }
        return;
      }

      console.error(`[${agentName}] Heartbeat error:`, err);
      logNetworkFailure(agentName, err);
    } finally {
      tickInProgress = false;
    }
  };

  // Stagger first tick by 0-20s to avoid all agents hitting the LLM at once
  const staggerMs = Math.floor(Math.random() * 20_000);
  console.log(`[${agentName}] First tick in ${(staggerMs / 1000).toFixed(1)}s (stagger)`);
  await new Promise(r => setTimeout(r, staggerMs));
  await tick();

  const scheduleNext = () => {
    // Add 0-10s jitter to prevent agents from syncing up over time
    const jitterMs = Math.floor(Math.random() * 10_000);
    const sleepMs = Math.min(120_000, config.heartbeatSeconds * 1000 + idleStreak * 15_000) + jitterMs;
    setTimeout(async () => {
      await tick();
      scheduleNext();
    }, sleepMs);
  };
  scheduleNext();
}
