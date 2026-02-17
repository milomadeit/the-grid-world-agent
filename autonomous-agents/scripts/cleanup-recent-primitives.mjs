import dotenv from 'dotenv';
import { ethers } from 'ethers';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

function envFirst(...keys) {
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
  let allTime = false;
  const agentFilters = new Set();
  let maxDelete = 0;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--delete') {
      doDelete = true;
      continue;
    }
    if (arg === '--all-time') {
      allTime = true;
      continue;
    }
    if (arg === '--agent' || arg === '--agents') {
      const value = args[i + 1];
      if (!value) throw new Error(`${arg} requires a value (smith|oracle|clank|mouse or comma-separated list)`);
      for (const part of value.split(',')) {
        const key = part.trim().toLowerCase();
        if (!key) continue;
        if (!['smith', 'oracle', 'clank', 'mouse'].includes(key)) {
          throw new Error(`Unknown agent filter: ${key}`);
        }
        agentFilters.add(key);
      }
      i += 1;
      continue;
    }
    if (arg === '--hours') {
      const value = Number(args[i + 1]);
      if (!Number.isFinite(value) || value <= 0) throw new Error('--hours must be positive');
      hours = value;
      i += 1;
      continue;
    }
    if (arg === '--max-delete') {
      const value = Number(args[i + 1]);
      if (!Number.isFinite(value) || value <= 0) throw new Error('--max-delete must be a positive number');
      maxDelete = Math.floor(value);
      i += 1;
      continue;
    }
    if (arg === '--api') {
      const value = args[i + 1];
      if (!value) throw new Error('--api requires URL');
      apiUrl = value;
      i += 1;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      console.log(
        'Usage: node scripts/cleanup-recent-primitives.mjs [--hours N | --all-time] [--agent mouse|smith|oracle|clank|a,b] [--delete] [--max-delete N] [--api URL]'
      );
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (allTime && args.includes('--hours')) {
    throw new Error('Use either --hours or --all-time, not both');
  }
  return { hours, doDelete, apiUrl, allTime, agentFilters, maxDelete };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry(label, fn, maxAttempts = 6) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const text = String(error?.message || error);
      const transient =
        text.includes('ENOTFOUND') ||
        text.includes('EAI_AGAIN') ||
        text.includes('fetch failed') ||
        text.includes('ETIMEDOUT') ||
        text.includes('Could not resolve host');
      if (!transient || attempt === maxAttempts) break;
      const waitMs = Math.min(1500 * attempt, 7000);
      console.warn(`[retry] ${label} failed (${text}); attempt ${attempt}/${maxAttempts}, wait ${waitMs}ms`);
      await sleep(waitMs);
    }
  }
  throw lastError;
}

async function enterAgent(baseUrl, cfg) {
  const wallet = new ethers.Wallet(cfg.privateKey);
  const walletAddress = wallet.address;
  const timestamp = new Date().toISOString();
  const message = `Enter OpGrid\nTimestamp: ${timestamp}`;
  const signature = await wallet.signMessage(message);

  const response = await curlJsonRequest({
    method: 'POST',
    url: `${baseUrl}/v1/agents/enter`,
    headers: [],
    body: {
      walletAddress,
      signature,
      timestamp,
      agentId: cfg.erc8004AgentId,
      visuals: { name: cfg.visualsName, color: cfg.visualsColor },
      bio: cfg.bio,
    },
  });
  const json = response.json;

  if (response.status === 402 && json?.needsPayment) {
    throw new Error(`entry fee required for ${cfg.key}; cleanup script will not auto-pay`);
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`enter ${cfg.key} failed (${response.status}): ${response.bodyText}`);
  }
  if (!json?.token || !json?.agentId) {
    throw new Error(`enter ${cfg.key} missing token/agentId`);
  }

  return { token: json.token, agentId: String(json.agentId) };
}

function agentConfigs() {
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

function printSummary(targetPrimitives, sessionsById) {
  const byOwner = new Map();
  for (const p of targetPrimitives) {
    if (!byOwner.has(p.ownerAgentId)) byOwner.set(p.ownerAgentId, []);
    byOwner.get(p.ownerAgentId).push(p);
  }
  for (const [ownerId, list] of byOwner.entries()) {
    list.sort((a, b) => a.createdAt - b.createdAt);
    const session = sessionsById.get(ownerId);
    const ownerLabel = session ? session.key : ownerId;
    const oldest = new Date(list[0].createdAt).toISOString();
    const newest = new Date(list[list.length - 1].createdAt).toISOString();
    console.log(`- ${ownerLabel} (${ownerId}): ${list.length} primitives, ${oldest} .. ${newest}`);
  }
}

async function fetchWorldState(baseUrl, token) {
  const response = await curlJsonRequest({
    method: 'GET',
    url: `${baseUrl}/v1/grid/state`,
    headers: [`Authorization: Bearer ${token}`],
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`state fetch failed (${response.status}): ${response.bodyText}`);
  }
  return response.json;
}

async function deletePrimitive(baseUrl, token, primitiveId) {
  const url = `${baseUrl}/v1/grid/primitive/${encodeURIComponent(primitiveId)}`;
  const response = await curlJsonRequest({
    method: 'DELETE',
    url,
    headers: [`Authorization: Bearer ${token}`],
  });

  if (response.status === 429) {
    const retryAfterHeader = response.headers['retry-after'];
    const retrySeconds = Number(retryAfterHeader || '0');
    const waitMs = Number.isFinite(retrySeconds) && retrySeconds > 0 ? retrySeconds * 1000 : 1200;
    await sleep(waitMs);
    const retryRes = await curlJsonRequest({
      method: 'DELETE',
      url,
      headers: [`Authorization: Bearer ${token}`],
    });
    return retryRes.status;
  }
  return response.status;
}

async function curlJsonRequest({ method, url, headers = [], body }) {
  const statusMarker = '__HTTP_STATUS__';
  const args = [
    '-sS',
    '-m',
    '30',
    '-D',
    '-',
    '-X',
    method,
    '-w',
    `\n${statusMarker}:%{http_code}`,
  ];

  const allHeaders = ['Accept: application/json', ...headers];
  const hasContentType = allHeaders.some((h) => h.toLowerCase().startsWith('content-type:'));
  if (body !== undefined && !hasContentType) allHeaders.push('Content-Type: application/json');
  for (const header of allHeaders) {
    args.push('-H', header);
  }
  if (body !== undefined) {
    args.push('--data', JSON.stringify(body));
  }
  args.push(url);

  let stdout = '';
  try {
    const result = await execFileAsync('curl', args, { maxBuffer: 20 * 1024 * 1024 });
    stdout = result.stdout;
  } catch (error) {
    const stderr = typeof error?.stderr === 'string' ? error.stderr.trim() : '';
    const text = stderr || String(error?.message || error);
    throw new Error(`curl failed: ${text}`);
  }
  const markerIndex = stdout.lastIndexOf(`\n${statusMarker}:`);
  if (markerIndex === -1) {
    throw new Error(`curl response parse failed for ${method} ${url}`);
  }

  const preStatus = stdout.slice(0, markerIndex);
  const statusText = stdout.slice(markerIndex + statusMarker.length + 2).trim();
  const status = Number(statusText);
  if (!Number.isFinite(status)) {
    throw new Error(`curl status parse failed for ${method} ${url}: ${statusText}`);
  }

  const headerBodySplit = preStatus.indexOf('\r\n\r\n') >= 0 ? '\r\n\r\n' : '\n\n';
  const splitIndex = preStatus.lastIndexOf(headerBodySplit);
  const headerText = splitIndex >= 0 ? preStatus.slice(0, splitIndex) : '';
  const bodyText = (splitIndex >= 0 ? preStatus.slice(splitIndex + headerBodySplit.length) : preStatus).trim();

  const responseHeaders = {};
  for (const line of headerText.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (!key) continue;
    responseHeaders[key] = value;
  }

  let json = null;
  if (bodyText) {
    try {
      json = JSON.parse(bodyText);
    } catch {
      json = null;
    }
  }

  return {
    status,
    headers: responseHeaders,
    bodyText,
    json,
  };
}

async function main() {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  dotenv.config({ path: join(__dirname, '..', '.env') });

  const { hours, doDelete, apiUrl, allTime, agentFilters, maxDelete } = parseArgs();
  if (apiUrl) process.env.GRID_API_URL = apiUrl;
  const baseUrl = process.env.GRID_API_URL || 'http://localhost:3001';
  const cutoffMs = allTime ? 0 : Date.now() - Math.round(hours * 60 * 60 * 1000);

  let configs = agentConfigs();
  if (agentFilters.size > 0) {
    configs = configs.filter((cfg) => agentFilters.has(cfg.key));
  }
  if (configs.length === 0) {
    throw new Error('No matching agent configs selected');
  }

  console.log(`[config] api=${baseUrl}`);
  console.log(`[config] mode=${doDelete ? 'DELETE' : 'DRY-RUN'} window=${allTime ? 'all-time' : `${hours}h`}`);
  if (!allTime) {
    console.log(`[config] cutoff=${new Date(cutoffMs).toISOString()}`);
  }
  console.log(`[config] agents=${configs.map((cfg) => cfg.key).join(',')}`);

  const sessions = [];
  for (const cfg of configs) {
    if (!cfg.privateKey || !cfg.erc8004AgentId) {
      console.warn(`[skip] ${cfg.key}: missing private key or agent id`);
      continue;
    }
    try {
      const entered = await withRetry(`enter:${cfg.key}`, () => enterAgent(baseUrl, cfg));
      sessions.push({ key: cfg.key, token: entered.token, agentId: entered.agentId });
      console.log(`[ok] ${cfg.key}: authenticated as agent ${entered.agentId}`);
    } catch (error) {
      console.warn(`[skip] ${cfg.key}: ${String(error?.message || error)}`);
    }
  }

  if (sessions.length === 0) throw new Error('no authenticated sessions');

  const sessionsById = new Map(sessions.map((s) => [s.agentId, s]));
  const world = await withRetry('state', () => fetchWorldState(baseUrl, sessions[0].token));
  const allPrimitives = Array.isArray(world?.primitives) ? world.primitives : [];
  const matchedPrimitives = allPrimitives.filter(
    (p) => sessionsById.has(String(p.ownerAgentId)) && (allTime || Number(p.createdAt) >= cutoffMs)
  );
  matchedPrimitives.sort((a, b) => Number(a.createdAt) - Number(b.createdAt));

  const targetPrimitives =
    doDelete && maxDelete > 0 ? matchedPrimitives.slice(0, maxDelete) : matchedPrimitives;

  console.log(`[dry-run] total matched = ${matchedPrimitives.length}`);
  if (doDelete && maxDelete > 0) {
    console.log(`[delete] max-delete=${maxDelete}, deleting=${targetPrimitives.length} (oldest first)`);
  }
  if (targetPrimitives.length > 0) {
    printSummary(matchedPrimitives, sessionsById);
    console.log(`[dry-run] sample IDs: ${targetPrimitives.slice(0, 20).map((p) => p.id).join(', ')}`);
  } else {
    console.log('[dry-run] no recent primitives found for authenticated agents');
  }

  if (!doDelete || targetPrimitives.length === 0) {
    console.log(doDelete ? '[result] nothing deleted' : '[result] dry run complete');
    return;
  }

  let deleted = 0;
  let forbidden = 0;
  let notFound = 0;
  let failed = 0;

  for (const primitive of targetPrimitives) {
    const ownerSession = sessionsById.get(String(primitive.ownerAgentId));
    if (!ownerSession) {
      failed += 1;
      continue;
    }
    try {
      const status = await withRetry(`delete:${primitive.id}`, () =>
        deletePrimitive(baseUrl, ownerSession.token, primitive.id)
      );
      if (status === 200) deleted += 1;
      else if (status === 403) forbidden += 1;
      else if (status === 404) notFound += 1;
      else failed += 1;
    } catch (error) {
      failed += 1;
      console.warn(`[warn] delete ${primitive.id} failed: ${String(error?.message || error)}`);
    }
  }

  console.log(`[delete] deleted=${deleted} forbidden=${forbidden} notFound=${notFound} failed=${failed}`);
  try {
    const lite = await withRetry('state-lite', async () => {
      const response = await curlJsonRequest({
        method: 'GET',
        url: `${baseUrl}/v1/grid/state-lite`,
      });
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`state-lite ${response.status}`);
      }
      return response.json;
    });
    console.log(`[post] tick=${lite.tick} primitiveCount=${lite.primitiveCount}`);
  } catch (error) {
    console.warn(`[post] unable to fetch state-lite: ${String(error?.message || error)}`);
  }
}

main().catch((error) => {
  console.error(`[fatal] ${String(error?.message || error)}`);
  process.exit(1);
});
