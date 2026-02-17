import dotenv from 'dotenv';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { GridAPIClient } from '../shared/api-client.js';

type AgentKey = 'smith' | 'oracle' | 'clank' | 'mouse';

type AgentConfig = {
  key: AgentKey;
  privateKey: string;
  erc8004AgentId: string;
  visualsName: string;
  visualsColor: string;
  bio: string;
};

type AgentSession = {
  key: AgentKey;
  claimedAgentId: string;
  token: string;
  client: GridAPIClient;
};

type Primitive = {
  id: string;
  ownerAgentId: string;
  createdAt: number;
};

function envFirst(...keys: string[]): string {
  for (const key of keys) {
    const value = process.env[key];
    if (value && value.trim().length > 0) return value.trim();
  }
  return '';
}

function parseArgs() {
  const args = process.argv.slice(2);
  let hours = 4;
  let doDelete = false;
  let apiUrl = '';

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--delete') {
      doDelete = true;
      continue;
    }
    if (arg === '--hours') {
      const value = Number(args[i + 1]);
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error('--hours must be a positive number');
      }
      hours = value;
      i += 1;
      continue;
    }
    if (arg === '--api') {
      const value = args[i + 1];
      if (!value) throw new Error('--api requires a URL');
      apiUrl = value;
      i += 1;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      console.log(
        'Usage: npx tsx scripts/cleanup-recent-primitives.ts [--hours N] [--delete] [--api URL]'
      );
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { hours, doDelete, apiUrl };
}

function loadEnv() {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  dotenv.config({ path: join(__dirname, '..', '.env') });
}

function buildAgentConfigs(): AgentConfig[] {
  return [
    {
      key: 'smith',
      privateKey: envFirst('AGENT_SMITH_PK', 'SMITH_PK'),
      erc8004AgentId: envFirst('AGENT_SMITH_ID', 'SMITH_AGENT_ID', 'SMITH_ID'),
      visualsName: 'Smith',
      visualsColor: '#f97316',
      bio: 'Cleanup utility session for Smith',
    },
    {
      key: 'oracle',
      privateKey: envFirst('ORACLE_PK'),
      erc8004AgentId: envFirst('ORACLE_ID', 'ORACLE_AGENT_ID'),
      visualsName: 'Oracle',
      visualsColor: '#22c55e',
      bio: 'Cleanup utility session for Oracle',
    },
    {
      key: 'clank',
      privateKey: envFirst('CLANK_PK'),
      erc8004AgentId: envFirst('CLANK_AGENT_ID', 'CLANK_ID'),
      visualsName: 'Clank',
      visualsColor: '#3b82f6',
      bio: 'Cleanup utility session for Clank',
    },
    {
      key: 'mouse',
      privateKey: envFirst('MOUSE_PK'),
      erc8004AgentId: envFirst('MOUSE_AGENT_ID', 'MOUSE_ID'),
      visualsName: 'Mouse',
      visualsColor: '#ec4899',
      bio: 'Cleanup utility session for Mouse',
    },
  ];
}

async function withRetry<T>(label: string, fn: () => Promise<T>, maxAttempts = 5): Promise<T> {
  let attempt = 0;
  let lastError: unknown;
  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const text = String((error as Error)?.message || error);
      const isDns =
        text.includes('ENOTFOUND') ||
        text.includes('EAI_AGAIN') ||
        text.includes('fetch failed');
      if (!isDns || attempt >= maxAttempts) break;
      const waitMs = Math.min(1500 * attempt, 6000);
      console.warn(`[retry] ${label} attempt ${attempt}/${maxAttempts} failed (${text}); retrying in ${waitMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
  throw lastError;
}

async function authenticateAgents(configs: AgentConfig[]): Promise<AgentSession[]> {
  const sessions: AgentSession[] = [];

  for (const cfg of configs) {
    if (!cfg.privateKey || !cfg.erc8004AgentId) {
      console.warn(`[skip] ${cfg.key}: missing private key or agent id in env`);
      continue;
    }

    const client = new GridAPIClient();
    try {
      const entered = await withRetry(
        `enter:${cfg.key}`,
        () =>
          client.enter(
            cfg.privateKey,
            cfg.erc8004AgentId,
            cfg.visualsName,
            cfg.visualsColor,
            cfg.bio
          ),
        6
      );
      const token = client.getToken();
      if (!token) {
        console.warn(`[skip] ${cfg.key}: enter succeeded but no token returned`);
        continue;
      }
      sessions.push({
        key: cfg.key,
        claimedAgentId: entered.agentId,
        token,
        client,
      });
      console.log(`[ok] ${cfg.key}: authenticated as agent ${entered.agentId}`);
    } catch (error) {
      console.warn(`[skip] ${cfg.key}: authentication failed (${String((error as Error)?.message || error)})`);
    }
  }

  return sessions;
}

function summarizeByOwner(primitives: Primitive[], owners: Map<string, AgentKey>) {
  const byOwner = new Map<string, Primitive[]>();
  for (const primitive of primitives) {
    if (!byOwner.has(primitive.ownerAgentId)) byOwner.set(primitive.ownerAgentId, []);
    byOwner.get(primitive.ownerAgentId)!.push(primitive);
  }

  for (const [ownerId, items] of byOwner) {
    items.sort((a, b) => a.createdAt - b.createdAt);
    const oldest = new Date(items[0].createdAt).toISOString();
    const newest = new Date(items[items.length - 1].createdAt).toISOString();
    const label = owners.get(ownerId) || ownerId;
    console.log(`- ${label} (${ownerId}): ${items.length} primitives, range ${oldest} .. ${newest}`);
  }
}

async function deleteOwnerPrimitive(baseUrl: string, token: string, primitiveId: string): Promise<number> {
  const response = await fetch(`${baseUrl}/v1/grid/primitive/${encodeURIComponent(primitiveId)}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  return response.status;
}

async function main() {
  loadEnv();
  const { hours, doDelete, apiUrl } = parseArgs();
  if (apiUrl) process.env.GRID_API_URL = apiUrl;

  const baseUrl = process.env.GRID_API_URL || 'http://localhost:3001';
  const cutoffMs = Date.now() - Math.round(hours * 60 * 60 * 1000);
  const cutoffIso = new Date(cutoffMs).toISOString();

  console.log(`[config] api=${baseUrl}`);
  console.log(`[config] window=${hours}h (createdAt >= ${cutoffIso})`);
  console.log(`[config] mode=${doDelete ? 'DELETE' : 'DRY-RUN'}`);

  const sessions = await authenticateAgents(buildAgentConfigs());
  if (sessions.length === 0) {
    throw new Error('No agents authenticated. Check env keys and API reachability.');
  }

  const ownerToSession = new Map<string, AgentSession>();
  for (const session of sessions) {
    ownerToSession.set(session.claimedAgentId, session);
  }

  const world = await withRetry('getWorldState', () => sessions[0].client.getWorldState(), 6);
  const targetPrimitives = (world.primitives as Primitive[]).filter(
    (p) => ownerToSession.has(p.ownerAgentId) && p.createdAt >= cutoffMs
  );

  console.log(`[dry-run] matched ${targetPrimitives.length} primitives from ${sessions.length} authenticated agents`);
  summarizeByOwner(targetPrimitives, new Map(sessions.map((s) => [s.claimedAgentId, s.key])));

  if (targetPrimitives.length === 0) {
    console.log('[result] nothing to delete');
    return;
  }

  const sampleIds = targetPrimitives.slice(0, 15).map((p) => p.id);
  console.log(`[dry-run] sample ids: ${sampleIds.join(', ')}`);

  if (!doDelete) {
    console.log('[result] dry-run only. Re-run with --delete to execute owner-only deletions.');
    return;
  }

  let deleted = 0;
  let forbidden = 0;
  let notFound = 0;
  let failed = 0;

  for (const primitive of targetPrimitives) {
    const session = ownerToSession.get(primitive.ownerAgentId);
    if (!session) {
      failed += 1;
      continue;
    }

    try {
      const status = await withRetry(
        `delete:${primitive.id}`,
        () => deleteOwnerPrimitive(baseUrl, session.token, primitive.id),
        6
      );

      if (status === 200) deleted += 1;
      else if (status === 403) forbidden += 1;
      else if (status === 404) notFound += 1;
      else failed += 1;
    } catch (error) {
      failed += 1;
      console.warn(`[warn] delete failed for ${primitive.id}: ${String((error as Error)?.message || error)}`);
    }
  }

  console.log(
    `[delete] done. deleted=${deleted}, forbidden=${forbidden}, notFound=${notFound}, failed=${failed}, total=${targetPrimitives.length}`
  );

  try {
    const lite = await withRetry(
      'state-lite',
      async () => {
        const response = await fetch(`${baseUrl}/v1/grid/state-lite`);
        if (!response.ok) {
          throw new Error(`state-lite HTTP ${response.status}`);
        }
        return response.json() as Promise<{ primitiveCount: number; tick: number }>;
      },
      6
    );
    console.log(`[post] tick=${lite.tick} primitiveCount=${lite.primitiveCount}`);
  } catch (error) {
    console.warn(`[post] could not fetch state-lite: ${String((error as Error)?.message || error)}`);
  }
}

main().catch((error) => {
  console.error(`[fatal] ${String((error as Error)?.message || error)}`);
  process.exit(1);
});
