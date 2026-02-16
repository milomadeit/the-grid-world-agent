/**
 * Autonomous Agents — Entry Point
 *
 * Boots all agents. Each runs independently on its own heartbeat loop.
 * They interact with OpGrid as external API clients.
 * Every agent must have a real ERC-8004 agent ID and the wallet that owns it.
 * Exception: Clank starts in bootstrap mode (no ID) to test onboarding.
 *
 * Usage:
 *   npm run start         # start all agents
 *   npm run dev           # start with watch mode
 *   npm run start:smith   # start only Smith
 *   npm run start:oracle  # start only Oracle
 *   npm run start:clank   # start only Clank (bootstrap mode)
 */

import 'dotenv/config';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { startAgent, bootstrapAgent } from './shared/runtime.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ERC-8004 registry on Monad Mainnet
const AGENT_REGISTRY = process.env.AGENT_REGISTRY || 'eip155:143:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';

// LLM keys from environment
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const OPENAI_KEY = process.env.GPT_API_KEY || '';
const MINIMAX_KEY = process.env.MINI_MAX_API_KEY || '';

if (!GEMINI_KEY && !ANTHROPIC_KEY && !OPENAI_KEY && !MINIMAX_KEY) {
  console.error('[Boot] No LLM API key found. Set ANTHROPIC_API_KEY, MINI_MAX_API_KEY, GEMINI_API_KEY, or GPT_API_KEY in .env');
  process.exit(1);
}

// Which agents to start (default: all)
const target = process.argv[2] || 'all';

// Registered agents — need wallet + private key + agent ID to boot
const registeredAgents = [
  {
    name: 'smith',
    dir: join(__dirname, 'agent-smith'),
    privateKey: process.env.AGENT_SMITH_PK || '',
    walletAddress: process.env.AGENT_SMITH_WALLET || '',
    erc8004AgentId: process.env.AGENT_SMITH_ID || '',
    heartbeatSeconds: 20,
    llmProvider: 'gemini' as const,
    llmModel: 'gemini-2.0-flash',
    llmApiKey: GEMINI_KEY,
  },
  {
    name: 'oracle',
    dir: join(__dirname, 'oracle'),
    privateKey: process.env.ORACLE_PK || '',
    walletAddress: process.env.ORACLE_WALLET || '',
    erc8004AgentId: process.env.ORACLE_ID || '',
    heartbeatSeconds: 15,
    llmProvider: 'gemini' as const,
    llmModel: 'gemini-2.0-flash',
    llmApiKey: GEMINI_KEY,
  },
];

// Clank — bootstrap agent, no ID yet
const clankConfig = {
  name: 'clank',
  dir: join(__dirname, 'clank'),
  privateKey: process.env.CLANK_PK || '',
  walletAddress: process.env.CLANK_WALLET || '',
  erc8004AgentId: process.env.CLANK_AGENT_ID || '',
  heartbeatSeconds: 10,
  llmProvider: 'gemini' as const,
  llmModel: 'gemini-2.0-flash',
  llmApiKey: GEMINI_KEY,
};

async function boot() {
  const allNames = [...registeredAgents.map(a => a.name), 'clank'];

  if (target !== 'all' && !allNames.includes(target)) {
    console.error(`[Boot] Unknown agent: ${target}. Options: all, ${allNames.join(', ')}`);
    process.exit(1);
  }

  const startRegistered = target === 'all' || registeredAgents.some(a => a.name === target);
  const startClank = target === 'all' || target === 'clank';

  // Boot registered agents
  if (startRegistered) {
    const toStart = target === 'all'
      ? registeredAgents
      : registeredAgents.filter(a => a.name === target);

    // Validate registered agents have identity + keys
    for (const agent of toStart) {
      if (!agent.walletAddress || !agent.erc8004AgentId) {
        console.error(`[Boot] Agent "${agent.name}" missing identity. Check wallet + agent ID in .env`);
        console.error(`[Boot] Every agent needs a registered ERC-8004 identity. See: https://www.8004.org`);
        process.exit(1);
      }
      if (!agent.privateKey) {
        console.error(`[Boot] Agent "${agent.name}" missing private key. Set ${agent.name.toUpperCase()}_PK in .env`);
        process.exit(1);
      }
      if (!agent.llmApiKey) {
        console.error(`[Boot] Agent "${agent.name}" has no LLM API key. It needs ${agent.llmProvider.toUpperCase()} key in .env`);
        process.exit(1);
      }
    }

    console.log(`[Boot] Starting ${toStart.length} registered agent(s): ${toStart.map(a => a.name).join(', ')}`);
    for (const agent of toStart) {
      console.log(`[Boot]   ${agent.name}: ${agent.llmProvider} / ${agent.llmModel} | wallet: ${agent.walletAddress.slice(0, 8)}...`);
    }
    console.log(`[Boot] Registry: ${AGENT_REGISTRY}`);
    console.log(`[Boot] API: ${process.env.GRID_API_URL || 'http://localhost:3001'}`);
    console.log('');

    for (const agent of toStart) {
      await new Promise(r => setTimeout(r, 2000));

      startAgent({
        dir: agent.dir,
        privateKey: agent.privateKey,
        walletAddress: agent.walletAddress,
        erc8004AgentId: agent.erc8004AgentId,
        erc8004Registry: AGENT_REGISTRY,
        heartbeatSeconds: agent.heartbeatSeconds,
        llmProvider: agent.llmProvider,
        llmModel: agent.llmModel,
        llmApiKey: agent.llmApiKey,
      }).catch(err => {
        console.error(`[Boot] Agent ${agent.name} crashed:`, err);
      });
    }
  }

  // Boot Clank in bootstrap mode
  if (startClank) {
    if (!clankConfig.llmApiKey) {
      console.error(`[Boot] Clank has no LLM API key. Set MINI_MAX_API_KEY in .env`);
      process.exit(1);
    }

    // If Clank has an agent ID, boot normally (post-registration)
    if (clankConfig.walletAddress && clankConfig.erc8004AgentId) {
      if (!clankConfig.privateKey) {
        console.error(`[Boot] Clank has an agent ID but no private key. Set CLANK_PK in .env`);
        process.exit(1);
      }
      console.log(`[Boot] Clank has an agent ID — booting normally`);
      console.log(`[Boot]   clank: ${clankConfig.llmProvider} / ${clankConfig.llmModel}`);
      console.log('');

      await new Promise(r => setTimeout(r, 2000));
      startAgent({
        dir: clankConfig.dir,
        privateKey: clankConfig.privateKey,
        walletAddress: clankConfig.walletAddress,
        erc8004AgentId: clankConfig.erc8004AgentId,
        erc8004Registry: AGENT_REGISTRY,
        heartbeatSeconds: clankConfig.heartbeatSeconds,
        llmProvider: clankConfig.llmProvider,
        llmModel: clankConfig.llmModel,
        llmApiKey: clankConfig.llmApiKey,
      }).catch(err => {
        console.error(`[Boot] Agent clank crashed:`, err);
      });
    } else {
      // Bootstrap mode — no agent ID, Clank has to figure it out
      console.log(`[Boot] Clank has NO agent ID — starting in BOOTSTRAP mode`);
      console.log(`[Boot]   clank: ${clankConfig.llmProvider} / ${clankConfig.llmModel}`);
      if (clankConfig.privateKey) {
        console.log(`[Boot]   Clank has a wallet + private key — can attempt on-chain registration`);
      } else {
        console.log(`[Boot]   Clank has NO wallet — will discover what it needs`);
      }
      console.log('');

      await new Promise(r => setTimeout(r, 2000));
      bootstrapAgent({
        dir: clankConfig.dir,
        privateKey: clankConfig.privateKey,
        walletAddress: clankConfig.walletAddress,
        heartbeatSeconds: clankConfig.heartbeatSeconds,
        llmProvider: clankConfig.llmProvider,
        llmModel: clankConfig.llmModel,
        llmApiKey: clankConfig.llmApiKey,
        apiBaseUrl: process.env.GRID_API_URL || 'http://localhost:3001',
        erc8004Registry: AGENT_REGISTRY,
      }).catch(err => {
        console.error(`[Boot] Clank bootstrap crashed:`, err);
      });
    }
  }
}

boot();
