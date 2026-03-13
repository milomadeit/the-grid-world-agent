/**
 * Autonomous Agents — Entry Point
 *
 * Each agent runs as its own independent process.
 * When started with "all", spawns each agent as a separate child process.
 * When started with a specific name, runs that agent directly.
 *
 * Usage:
 *   npm run start         # spawns all agents as separate processes
 *   npm run start:smith   # run Smith in this process
 *   npm run start:oracle  # run Oracle in this process
 *   npm run start:clank   # run Clank in this process
 *   npm run start:mouse   # run Mouse in this process
 */

import dotenv from 'dotenv';
import { setDefaultResultOrder } from 'dns';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { startAgent } from './shared/runtime.js';
import type { LLMBucket } from './shared/key-rotator.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '.env') });

// Prefer IPv4 when resolving API hosts; some local networks reject IPv6 routes.
try {
  setDefaultResultOrder('ipv4first');
} catch {
  // Non-fatal on older/newer Node variants.
}

function envFirst(...keys: string[]): string {
  for (const key of keys) {
    const value = process.env[key];
    if (value && value.trim().length > 0) return value;
  }
  return '';
}

function envSeconds(defaultValue: number, ...keys: string[]): number {
  const raw = envFirst(...keys);
  if (!raw) return defaultValue;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 5) return defaultValue;
  return Math.floor(parsed);
}

// ERC-8004 registry on Base Sepolia
const AGENT_REGISTRY = envFirst('AGENT_REGISTRY') || 'eip155:84532:0x8004A818BFB912233c491871b3d84c89A494BD9e';

// LLM keys from environment
const GEMINI_KEY = envFirst('GEMINI_API_KEY');
const GEMINI_KEY_2 = envFirst('GEMINI_API_KEY_2') || GEMINI_KEY;
const GEMINI_KEY_3 = envFirst('GEMINI_API_KEY_3') || GEMINI_KEY;
const ANTHROPIC_KEY = envFirst('ANTHROPIC_API_KEY');
const OPENAI_KEY = envFirst('GPT_API_KEY', 'OPENAI_API_KEY');
const MINIMAX_KEY = envFirst('MINI_MAX_API_KEY', 'MINIMAX_API_KEY');
const OPENCODE_KEY = envFirst('OPENCODE_API');
const OPENROUTER_KEY = envFirst('OPENROUTER_API');
const ORACLE_OPENROUTER_KEY = envFirst('ORACLE_OPENROUTER_KEY') || OPENROUTER_KEY;
const CLANK_OPENROUTER_KEY = envFirst('CLANK_OPENROUTER_KEY') || OPENROUTER_KEY;
const MOUSE_OPENROUTER_KEY = envFirst('MOUSE_OPENROUTER_KEY') || OPENROUTER_KEY;
const DEFAULT_HEARTBEAT_SECONDS = envSeconds(60, 'AGENT_HEARTBEAT_SECONDS');

// Which agent to start (default: all)
const target = process.argv[2] || 'all';

// All known agent names
const ALL_AGENTS = ['smith', 'oracle', 'clank', 'mouse'];

// --- Agent Configs ---

interface AgentDef {
  name: string;
  dir: string;
  privateKey: string;
  walletAddress: string;
  erc8004AgentId: string;
  heartbeatSeconds: number;
  llmProvider: 'gemini' | 'anthropic' | 'openai' | 'minimax' | 'opencode' | 'openrouter';
  llmModel: string;
  llmApiKey: string;
  llmPool?: LLMBucket[]; // Optional: key x model rotation pool
  visionBridge?: {
    provider: 'gemini';
    model: string;
    apiKey: string;
  };
}

// --- Gemini Bucket Pools (ordered by preference: best first) ---
// Each key x model = independent RPD quota. On 429, rotator tries next bucket instantly.
// Agents are staggered: Oracle→KEY_2, Clank→KEY_3, Mouse→KEY_1

const GEMINI_POOL_ORACLE: LLMBucket[] = [
  // Primary: best quality on dedicated key
  { provider: 'gemini', model: 'gemini-2.5-flash',              apiKey: GEMINI_KEY_2, label: '2.5-flash@K2' },
  { provider: 'gemini', model: 'gemini-3-flash-preview',        apiKey: GEMINI_KEY_2, label: '3-flash@K2' },
  // Cross-key: same quality model on other keys
  { provider: 'gemini', model: 'gemini-2.5-flash',              apiKey: GEMINI_KEY,   label: '2.5-flash@K1' },
  { provider: 'gemini', model: 'gemini-2.5-flash',              apiKey: GEMINI_KEY_3, label: '2.5-flash@K3' },
  // Lite fallback (lower quality, higher RPD)
  { provider: 'gemini', model: 'gemini-2.5-flash-lite',         apiKey: GEMINI_KEY_2, label: '2.5-lite@K2' },
  { provider: 'gemini', model: 'gemini-3.1-flash-lite-preview', apiKey: GEMINI_KEY_2, label: '3.1-lite@K2' },
  // Last resort: OpenRouter free
  ...(ORACLE_OPENROUTER_KEY ? [
    { provider: 'openrouter' as const, model: 'google/gemini-2.5-flash-preview:free', apiKey: ORACLE_OPENROUTER_KEY, label: 'OR-free' },
  ] : []),
];

const GEMINI_POOL_CLANK: LLMBucket[] = [
  // Primary: Clank's dedicated key, lite models
  { provider: 'gemini', model: 'gemini-2.5-flash-lite',         apiKey: GEMINI_KEY_3, label: '2.5-lite@K3' },
  { provider: 'gemini', model: 'gemini-3.1-flash-lite-preview', apiKey: GEMINI_KEY_3, label: '3.1-lite@K3' },
  // Quality upgrade on same key
  { provider: 'gemini', model: 'gemini-2.5-flash',              apiKey: GEMINI_KEY_3, label: '2.5-flash@K3' },
  { provider: 'gemini', model: 'gemini-3-flash-preview',        apiKey: GEMINI_KEY_3, label: '3-flash@K3' },
  // Cross-key lite fallbacks
  { provider: 'gemini', model: 'gemini-2.5-flash-lite',         apiKey: GEMINI_KEY,   label: '2.5-lite@K1' },
  { provider: 'gemini', model: 'gemini-2.5-flash-lite',         apiKey: GEMINI_KEY_2, label: '2.5-lite@K2' },
  // Last resort
  ...(CLANK_OPENROUTER_KEY ? [
    { provider: 'openrouter' as const, model: 'google/gemini-2.5-flash-preview:free', apiKey: CLANK_OPENROUTER_KEY, label: 'OR-free' },
  ] : []),
];

const GEMINI_POOL_MOUSE: LLMBucket[] = [
  // Primary: Mouse's dedicated key, lite models
  { provider: 'gemini', model: 'gemini-2.5-flash-lite',         apiKey: GEMINI_KEY,   label: '2.5-lite@K1' },
  { provider: 'gemini', model: 'gemini-3.1-flash-lite-preview', apiKey: GEMINI_KEY,   label: '3.1-lite@K1' },
  // Quality upgrade on same key
  { provider: 'gemini', model: 'gemini-2.5-flash',              apiKey: GEMINI_KEY,   label: '2.5-flash@K1' },
  { provider: 'gemini', model: 'gemini-3-flash-preview',        apiKey: GEMINI_KEY,   label: '3-flash@K1' },
  // Cross-key lite fallbacks
  { provider: 'gemini', model: 'gemini-2.5-flash-lite',         apiKey: GEMINI_KEY_2, label: '2.5-lite@K2' },
  { provider: 'gemini', model: 'gemini-3.1-flash-lite-preview', apiKey: GEMINI_KEY_3, label: '3.1-lite@K3' },
  // Last resort
  ...(MOUSE_OPENROUTER_KEY ? [
    { provider: 'openrouter' as const, model: 'google/gemini-2.5-flash-preview:free', apiKey: MOUSE_OPENROUTER_KEY, label: 'OR-free' },
  ] : []),
];

const agents: Record<string, AgentDef> = {
  smith: {
    name: 'smith',
    dir: join(__dirname, 'agent-smith'),
    privateKey: envFirst('AGENT_SMITH_PK', 'SMITH_PK'),
    walletAddress: envFirst('AGENT_SMITH_WALLET', 'SMITH_WALLET'),
    erc8004AgentId: envFirst('AGENT_SMITH_ID', 'SMITH_AGENT_ID', 'SMITH_ID'),
    heartbeatSeconds: envSeconds(DEFAULT_HEARTBEAT_SECONDS, 'AGENT_SMITH_HEARTBEAT_SECONDS'),
    llmProvider: 'minimax',
    llmModel: 'MiniMax-M2.5-highspeed',
    llmApiKey: MINIMAX_KEY,
    // No llmPool — Smith uses paid MiniMax, no rotation needed
    visionBridge: GEMINI_KEY
      ? { provider: 'gemini', model: 'gemini-2.5-flash-lite', apiKey: GEMINI_KEY }
      : undefined,
  },
  oracle: {
    name: 'oracle',
    dir: join(__dirname, 'oracle'),
    privateKey: envFirst('ORACLE_PK'),
    walletAddress: envFirst('ORACLE_WALLET'),
    erc8004AgentId: envFirst('ORACLE_ID', 'ORACLE_AGENT_ID'),
    heartbeatSeconds: envSeconds(DEFAULT_HEARTBEAT_SECONDS, 'ORACLE_HEARTBEAT_SECONDS'),
    llmProvider: 'gemini',
    llmModel: 'gemini-2.5-flash', // Primary for logging
    llmApiKey: GEMINI_KEY_2,
    llmPool: GEMINI_POOL_ORACLE,
  },
  clank: {
    name: 'clank',
    dir: join(__dirname, 'clank'),
    privateKey: envFirst('CLANK_PK'),
    walletAddress: envFirst('CLANK_WALLET'),
    erc8004AgentId: envFirst('CLANK_AGENT_ID', 'CLANK_ID'),
    heartbeatSeconds: envSeconds(DEFAULT_HEARTBEAT_SECONDS, 'CLANK_HEARTBEAT_SECONDS'),
    llmProvider: 'gemini',
    llmModel: 'gemini-2.5-flash-lite', // Primary for logging
    llmApiKey: GEMINI_KEY_3,
    llmPool: GEMINI_POOL_CLANK,
  },
  mouse: {
    name: 'mouse',
    dir: join(__dirname, 'mouse'),
    privateKey: envFirst('MOUSE_PK'),
    walletAddress: envFirst('MOUSE_WALLET'),
    erc8004AgentId: envFirst('MOUSE_AGENT_ID', 'MOUSE_ID'),
    heartbeatSeconds: envSeconds(DEFAULT_HEARTBEAT_SECONDS, 'MOUSE_HEARTBEAT_SECONDS'),
    llmProvider: 'gemini',
    llmModel: 'gemini-2.5-flash-lite', // Primary for logging
    llmApiKey: GEMINI_KEY,
    llmPool: GEMINI_POOL_MOUSE,
  },
};

// --- Spawn All: each agent gets its own process ---

let shuttingDown = false;
const childProcesses = new Map<string, ReturnType<typeof spawn>>();

function spawnAgent(name: string) {
  if (shuttingDown) return;

  const child = spawn('npx', ['tsx', 'index.ts', name], {
    cwd: __dirname,
    stdio: ['ignore', 'inherit', 'inherit'],
    env: process.env,
  });

  childProcesses.set(name, child);

  child.on('exit', (code) => {
    childProcesses.delete(name);
    if (shuttingDown) {
      console.log(`[Boot] Agent "${name}" stopped (code ${code}).`);
      return;
    }
    console.error(`[Boot] Agent "${name}" exited (code ${code}). Restarting in 5s...`);
    setTimeout(() => spawnAgent(name), 5000);
  });

  console.log(`[Boot] Spawned "${name}" (pid ${child.pid})`);
}

function shutdownAll() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[Boot] Shutting down all agents...`);
  for (const [name, child] of childProcesses) {
    console.log(`[Boot] Killing "${name}" (pid ${child.pid})`);
    child.kill('SIGTERM');
  }
  // Force kill after 5s if still alive
  setTimeout(() => {
    for (const [name, child] of childProcesses) {
      console.warn(`[Boot] Force killing "${name}" (pid ${child.pid})`);
      child.kill('SIGKILL');
    }
    process.exit(0);
  }, 5000);
}

process.on('SIGINT', shutdownAll);
process.on('SIGTERM', shutdownAll);

function spawnAll() {
  console.log(`[Boot] Spawning ${ALL_AGENTS.length} agents as separate processes...`);
  for (const name of ALL_AGENTS) {
    spawnAgent(name);
  }
  console.log(`[Boot] All agents spawned. Each runs independently. Ctrl+C to stop all.`);
}

// --- Run Single Agent directly in this process ---

async function runSingleAgent(name: string) {
  const config = agents[name];
  if (!config) {
    console.error(`[Boot] Unknown agent: ${name}. Options: ${ALL_AGENTS.join(', ')}`);
    process.exit(1);
  }

  if (!config.llmApiKey) {
    console.error(`[Boot] ${name} has no LLM API key. Check .env`);
    process.exit(1);
  }

  const hasIdentity = config.walletAddress && config.erc8004AgentId;

  // If agent has a full identity (wallet + agent ID), run normal heartbeat
  if (hasIdentity) {
    if (!config.privateKey) {
      console.error(`[Boot] ${name} has an agent ID but no private key. Set ${name.toUpperCase()}_PK in .env`);
      process.exit(1);
    }

    console.log(`[${name}] Starting (${config.llmProvider} / ${config.llmModel})`);
    console.log(`[${name}] Wallet: ${config.walletAddress.slice(0, 10)}... | Agent ID: ${config.erc8004AgentId}`);
    console.log(`[${name}] API: ${envFirst('GRID_API_URL') || 'http://localhost:4101'}`);
    console.log('');

    await startAgent({
      dir: config.dir,
      privateKey: config.privateKey,
      walletAddress: config.walletAddress,
      erc8004AgentId: config.erc8004AgentId,
      erc8004Registry: AGENT_REGISTRY,
      heartbeatSeconds: config.heartbeatSeconds,
      llmProvider: config.llmProvider,
      llmModel: config.llmModel,
      llmApiKey: config.llmApiKey,
      llmPool: config.llmPool,
      visionBridge: config.visionBridge,
    });
  } else {
    console.error(`[Boot] ${name} missing wallet address or ERC-8004 agent ID. Set ${name.toUpperCase()}_WALLET and ${name.toUpperCase()}_ID in .env`);
    process.exit(1);
  }
}

// --- Main ---

if (target === 'all') {
  spawnAll();
} else {
  runSingleAgent(target).catch(err => {
    console.error(`[${target}] Fatal error:`, err);
    process.exit(1);
  });
}
