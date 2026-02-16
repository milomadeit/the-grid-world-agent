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
import { startAgent, bootstrapAgent } from './shared/runtime.js';

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

// ERC-8004 registry on Monad Mainnet
const AGENT_REGISTRY = envFirst('AGENT_REGISTRY') || 'eip155:143:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';

// LLM keys from environment
const GEMINI_KEY = envFirst('GEMINI_API_KEY', 'GOOGLE_GEMINI_API_KEY');
const ANTHROPIC_KEY = envFirst('ANTHROPIC_API_KEY');
const OPENAI_KEY = envFirst('GPT_API_KEY', 'OPENAI_API_KEY');
const MINIMAX_KEY = envFirst('MINI_MAX_API_KEY', 'MINIMAX_API_KEY');

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
  llmProvider: 'gemini' | 'anthropic' | 'openai' | 'minimax';
  llmModel: string;
  llmApiKey: string;
}

const agents: Record<string, AgentDef> = {
  smith: {
    name: 'smith',
    dir: join(__dirname, 'agent-smith'),
    privateKey: envFirst('AGENT_SMITH_PK', 'SMITH_PK'),
    walletAddress: envFirst('AGENT_SMITH_WALLET', 'SMITH_WALLET'),
    erc8004AgentId: envFirst('AGENT_SMITH_ID', 'SMITH_AGENT_ID', 'SMITH_ID'),
    heartbeatSeconds: 60,
    llmProvider: 'anthropic',
    llmModel: 'claude-haiku-4-5',
    llmApiKey: ANTHROPIC_KEY,
  },
  oracle: {
    name: 'oracle',
    dir: join(__dirname, 'oracle'),
    privateKey: envFirst('ORACLE_PK'),
    walletAddress: envFirst('ORACLE_WALLET'),
    erc8004AgentId: envFirst('ORACLE_ID', 'ORACLE_AGENT_ID'),
    heartbeatSeconds: 60,
    llmProvider: 'gemini',
    llmModel: 'gemini-2.0-flash-lite',
    llmApiKey: GEMINI_KEY,
  },
  clank: {
    name: 'clank',
    dir: join(__dirname, 'clank'),
    privateKey: envFirst('CLANK_PK'),
    walletAddress: envFirst('CLANK_WALLET'),
    erc8004AgentId: envFirst('CLANK_AGENT_ID', 'CLANK_ID'),
    heartbeatSeconds: 60,
    llmProvider: 'minimax',
    llmModel: 'MiniMax-M2.5-highspeed',
    llmApiKey: MINIMAX_KEY,
  },
  mouse: {
    name: 'mouse',
    dir: join(__dirname, 'mouse'),
    privateKey: envFirst('MOUSE_PK'),
    walletAddress: envFirst('MOUSE_WALLET'),
    erc8004AgentId: envFirst('MOUSE_AGENT_ID', 'MOUSE_ID'),
    heartbeatSeconds: 60,
    llmProvider: 'minimax',
    llmModel: 'MiniMax-M2.5-highspeed',
    llmApiKey: MINIMAX_KEY,
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
    console.log(`[${name}] API: ${envFirst('GRID_API_URL') || 'http://localhost:3001'}`);
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
    });
  } else {
    // Bootstrap mode — no agent ID, agent figures it out via skill.md
    console.log(`[${name}] Starting in BOOTSTRAP mode (no agent ID)`);
    console.log(`[${name}] ${config.llmProvider} / ${config.llmModel}`);
    if (config.privateKey) {
      console.log(`[${name}] Has wallet + private key — can register on-chain`);
    } else {
      console.log(`[${name}] No wallet — will discover what it needs`);
    }
    console.log('');

    await bootstrapAgent({
      dir: config.dir,
      privateKey: config.privateKey,
      walletAddress: config.walletAddress,
      heartbeatSeconds: config.heartbeatSeconds,
      llmProvider: config.llmProvider,
      llmModel: config.llmModel,
      llmApiKey: config.llmApiKey,
      apiBaseUrl: envFirst('GRID_API_URL') || 'http://localhost:3001',
      erc8004Registry: AGENT_REGISTRY,
    });
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
