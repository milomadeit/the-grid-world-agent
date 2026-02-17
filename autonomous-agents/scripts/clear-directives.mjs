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
        text.includes('Could not resolve host') ||
        text.includes('timed out') ||
        text.includes('Connection reset');
      if (!transient || attempt === maxAttempts) break;
      const waitMs = Math.min(1500 * attempt, 7000);
      console.warn(`[retry] ${label} failed (${text}); attempt ${attempt}/${maxAttempts}, waiting ${waitMs}ms`);
      await sleep(waitMs);
    }
  }
  throw lastError;
}

async function curlJsonRequest({ method, url, headers = [], body }) {
  const statusMarker = '__HTTP_STATUS__';
  const args = ['-sS', '-m', '30', '-D', '-', '-X', method, '-w', `\n${statusMarker}:%{http_code}`];
  const allHeaders = ['Accept: application/json', ...headers];
  const hasContentType = allHeaders.some((h) => h.toLowerCase().startsWith('content-type:'));
  if (body !== undefined && !hasContentType) allHeaders.push('Content-Type: application/json');
  for (const header of allHeaders) args.push('-H', header);
  if (body !== undefined) args.push('--data', JSON.stringify(body));
  args.push(url);

  let stdout = '';
  try {
    const result = await execFileAsync('curl', args, { maxBuffer: 20 * 1024 * 1024 });
    stdout = result.stdout;
  } catch (error) {
    const stderr = typeof error?.stderr === 'string' ? error.stderr.trim() : '';
    throw new Error(`curl failed: ${stderr || String(error?.message || error)}`);
  }

  const markerIndex = stdout.lastIndexOf(`\n${statusMarker}:`);
  if (markerIndex === -1) throw new Error(`curl parse failed for ${method} ${url}`);
  const preStatus = stdout.slice(0, markerIndex);
  const statusText = stdout.slice(markerIndex + statusMarker.length + 2).trim();
  const status = Number(statusText);
  if (!Number.isFinite(status)) throw new Error(`curl status parse failed: ${statusText}`);

  const splitToken = preStatus.includes('\r\n\r\n') ? '\r\n\r\n' : '\n\n';
  const splitIndex = preStatus.lastIndexOf(splitToken);
  const bodyText = (splitIndex >= 0 ? preStatus.slice(splitIndex + splitToken.length) : preStatus).trim();
  let json = null;
  if (bodyText) {
    try {
      json = JSON.parse(bodyText);
    } catch {
      json = null;
    }
  }
  return { status, bodyText, json };
}

function agentConfigs() {
  return [
    {
      key: 'smith',
      privateKey: envFirst('AGENT_SMITH_PK', 'SMITH_PK'),
      erc8004AgentId: envFirst('AGENT_SMITH_ID', 'SMITH_AGENT_ID', 'SMITH_ID'),
      visualsName: 'Smith',
      visualsColor: '#f97316',
      bio: 'Directive reset session for Smith',
    },
    {
      key: 'oracle',
      privateKey: envFirst('ORACLE_PK'),
      erc8004AgentId: envFirst('ORACLE_ID', 'ORACLE_AGENT_ID'),
      visualsName: 'Oracle',
      visualsColor: '#22c55e',
      bio: 'Directive reset session for Oracle',
    },
    {
      key: 'clank',
      privateKey: envFirst('CLANK_PK'),
      erc8004AgentId: envFirst('CLANK_AGENT_ID', 'CLANK_ID'),
      visualsName: 'Clank',
      visualsColor: '#3b82f6',
      bio: 'Directive reset session for Clank',
    },
    {
      key: 'mouse',
      privateKey: envFirst('MOUSE_PK'),
      erc8004AgentId: envFirst('MOUSE_AGENT_ID', 'MOUSE_ID'),
      visualsName: 'Mouse',
      visualsColor: '#ec4899',
      bio: 'Directive reset session for Mouse',
    },
  ];
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
    body: {
      walletAddress,
      signature,
      timestamp,
      agentId: cfg.erc8004AgentId,
      visuals: { name: cfg.visualsName, color: cfg.visualsColor },
      bio: cfg.bio,
    },
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`enter ${cfg.key} failed (${response.status}): ${response.bodyText}`);
  }
  if (!response.json?.token || !response.json?.agentId) {
    throw new Error(`enter ${cfg.key} missing token/agentId`);
  }
  return {
    key: cfg.key,
    token: response.json.token,
    agentId: String(response.json.agentId),
  };
}

async function listActiveDirectives(baseUrl) {
  const response = await curlJsonRequest({
    method: 'GET',
    url: `${baseUrl}/v1/grid/directives`,
  });
  if (response.status < 200 || response.status >= 300 || !Array.isArray(response.json)) {
    throw new Error(`GET directives failed (${response.status}): ${response.bodyText}`);
  }
  return response.json;
}

async function voteYes(baseUrl, directiveId, token) {
  const response = await curlJsonRequest({
    method: 'POST',
    url: `${baseUrl}/v1/grid/directives/${encodeURIComponent(directiveId)}/vote`,
    headers: [`Authorization: Bearer ${token}`],
    body: { vote: 'yes' },
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`vote failed (${response.status}): ${response.bodyText}`);
  }
}

async function main() {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  dotenv.config({ path: join(__dirname, '..', '.env') });
  const baseUrl = process.env.GRID_API_URL || 'http://localhost:3001';

  console.log(`[config] api=${baseUrl}`);

  const sessions = [];
  for (const cfg of agentConfigs()) {
    if (!cfg.privateKey || !cfg.erc8004AgentId) {
      console.warn(`[skip] ${cfg.key}: missing private key or agent id`);
      continue;
    }
    try {
      const session = await withRetry(`enter:${cfg.key}`, () => enterAgent(baseUrl, cfg));
      sessions.push(session);
      console.log(`[ok] ${cfg.key}: authenticated as ${session.agentId}`);
    } catch (error) {
      console.warn(`[skip] ${cfg.key}: ${String(error?.message || error)}`);
    }
  }

  if (sessions.length === 0) {
    throw new Error('No authenticated agents available to vote directives');
  }

  const before = await withRetry('directives:list:before', () => listActiveDirectives(baseUrl));
  console.log(`[before] active directives=${before.length}`);
  if (before.length === 0) {
    console.log('[result] no directives to clear');
    return;
  }

  for (const directive of before) {
    const needed = Math.max(0, Number(directive.agentsNeeded || 0) - Number(directive.yesVotes || 0));
    const voterCount = Math.max(needed, 1);
    const voters = sessions.slice(0, Math.min(voterCount, sessions.length));

    console.log(
      `[directive] ${directive.id} needs ${directive.agentsNeeded}, current yes=${directive.yesVotes}. Voting yes with ${voters.length} agent(s).`
    );

    for (const voter of voters) {
      await withRetry(`vote:${directive.id}:${voter.key}`, () =>
        voteYes(baseUrl, directive.id, voter.token)
      );
      console.log(`[vote] ${voter.key} -> yes on ${directive.id}`);
    }
  }

  const after = await withRetry('directives:list:after', () => listActiveDirectives(baseUrl));
  console.log(`[after] active directives=${after.length}`);
  if (after.length > 0) {
    console.log(`[after] remaining IDs: ${after.map((d) => d.id).join(', ')}`);
  } else {
    console.log('[result] directives cleared');
  }
}

main().catch((error) => {
  console.error(`[fatal] ${String(error?.message || error)}`);
  process.exit(1);
});
