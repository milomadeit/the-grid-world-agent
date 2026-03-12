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
  visionBridge?: {
    provider: 'gemini';
    model: string;
    apiKey: string;
  };
}

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
    visionBridge: GEMINI_KEY
      ? { provider: 'gemini', model: 'gemini-2.0-flash-lite', apiKey: GEMINI_KEY }
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
    llmModel: 'gemini-2.5-flash', // Key 2 — own fresh quota
    llmApiKey: GEMINI_KEY_2,
  },
  clank: {
    name: 'clank',
    dir: join(__dirname, 'clank'),
    privateKey: envFirst('CLANK_PK'),
    walletAddress: envFirst('CLANK_WALLET'),
    erc8004AgentId: envFirst('CLANK_AGENT_ID', 'CLANK_ID'),
    heartbeatSeconds: envSeconds(DEFAULT_HEARTBEAT_SECONDS, 'CLANK_HEARTBEAT_SECONDS'),
    llmProvider: 'gemini',
    llmModel: 'gemini-2.5-flash', // Key 3 — own fresh quota
    llmApiKey: GEMINI_KEY_3,
  },
  mouse: {
    name: 'mouse',
    dir: join(__dirname, 'mouse'),
    privateKey: envFirst('MOUSE_PK'),
    walletAddress: envFirst('MOUSE_WALLET'),
    erc8004AgentId: envFirst('MOUSE_AGENT_ID', 'MOUSE_ID'),
    heartbeatSeconds: envSeconds(DEFAULT_HEARTBEAT_SECONDS, 'MOUSE_HEARTBEAT_SECONDS'),
    llmProvider: 'openrouter',
    llmModel: 'arcee-ai/trinity-large-preview:free', // Arcee AI — Key 1 burned today, use free OR model
    llmApiKey: OPENCODE_KEY,
  },
};

// --- Spawn All: each agent gets its own process ---

function spawnAgent(name: string) {
  const child = spawn('npx', ['tsx', 'index.ts', name], {
    cwd: __dirname,
    stdio: ['ignore', 'inherit', 'inherit'],
    env: process.env,
  });

  child.on('exit', (code) => {
    console.error(`[Boot] Agent "${name}" exited (code ${code}). Restarting in 5s...`);
    setTimeout(() => spawnAgent(name), 5000);
  });

  console.log(`[Boot] Spawned "${name}" (pid ${child.pid})`);
}

function spawnAll() {
  console.log(`[Boot] Spawning ${ALL_AGENTS.length} agents as separate processes...`);
  for (const name of ALL_AGENTS) {
    spawnAgent(name);
  }
  console.log(`[Boot] All agents spawned. Each runs independently.`);
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
