import 'dotenv/config';
import { ethers } from 'ethers';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base, baseSepolia } from 'viem/chains';
import { wrapFetchWithPayment } from 'x402-fetch';

function arg(name, fallback = undefined) {
  const prefix = `${name}=`;
  const entry = process.argv.slice(2).find((item) => item.startsWith(prefix));
  return entry ? entry.slice(prefix.length) : fallback;
}

function normalizePk(raw) {
  if (!raw) return null;
  if (/^0x[a-fA-F0-9]{64}$/.test(raw)) return raw;
  if (/^[a-fA-F0-9]{64}$/.test(raw)) return `0x${raw}`;
  return null;
}

async function fetchJson(url, init = {}) {
  const res = await fetch(url, init);
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${url}\n${JSON.stringify(body, null, 2)}`);
  }
  return body;
}

async function main() {
  const baseUrl = process.env.GRID_API_URL || arg('--api') || 'http://localhost:4101';
  const templateId = process.env.CERT_TEMPLATE_ID || arg('--template') || 'SWAP_EXECUTION_V1';
  const txHash = process.env.CERT_TX_HASH || arg('--txHash');
  const privateKey = normalizePk(process.env.CERT_AGENT_PRIVATE_KEY || arg('--privateKey'));
  const erc8004AgentId = process.env.CERT_AGENT_ID || arg('--agentId');
  const agentRegistry = process.env.CERT_AGENT_REGISTRY || arg('--agentRegistry');
  const chainId = Number(process.env.CHAIN_ID || process.env.MONAD_CHAIN_ID || arg('--chainId') || '84532');
  const chainRpc = process.env.CHAIN_RPC || process.env.MONAD_RPC || arg('--rpc') || 'https://sepolia.base.org';
  const maxUsdcAtomic = BigInt(process.env.CERT_MAX_USDC_ATOMIC || arg('--maxAtomic') || '1000000');

  if (!privateKey) {
    throw new Error('Missing private key. Set CERT_AGENT_PRIVATE_KEY or --privateKey=<hex>');
  }
  if (!erc8004AgentId) {
    throw new Error('Missing agent ID. Set CERT_AGENT_ID or --agentId=<tokenId>');
  }

  const wallet = new ethers.Wallet(privateKey);
  const timestamp = new Date().toISOString();
  const authMessage = `Enter OpGrid\nTimestamp: ${timestamp}`;
  const signature = await wallet.signMessage(authMessage);

  console.log(`[Demo] API: ${baseUrl}`);
  console.log(`[Demo] Wallet: ${wallet.address}`);
  console.log(`[Demo] Agent ID: ${erc8004AgentId}`);
  console.log(`[Demo] Template: ${templateId}`);

  const enterPayload = {
    walletAddress: wallet.address,
    signature,
    timestamp,
    agentId: String(erc8004AgentId),
    ...(agentRegistry ? { agentRegistry } : {}),
    visuals: {
      name: process.env.CERT_AGENT_NAME || 'CertDemo',
      color: process.env.CERT_AGENT_COLOR || '#7c3aed',
    },
    bio: process.env.CERT_AGENT_BIO || 'Phase 2 certification demo runner',
  };

  const enter = await fetchJson(`${baseUrl}/v1/agents/enter`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(enterPayload),
  });

  const token = enter.token;
  if (!token) {
    throw new Error('Missing JWT token from /v1/agents/enter');
  }
  const authHeaders = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };

  const templates = await fetchJson(`${baseUrl}/v1/certify/templates`, {
    method: 'GET',
    headers: authHeaders,
  });
  const available = Array.isArray(templates.templates) ? templates.templates : [];
  const selectedTemplate = available.find((item) => item.id === templateId);
  if (!selectedTemplate) {
    throw new Error(`Template ${templateId} not found. Available: ${available.map((item) => item.id).join(', ')}`);
  }

  const account = privateKeyToAccount(privateKey);
  const walletClient = createWalletClient({
    account,
    chain: chainId === 8453 ? base : baseSepolia,
    transport: http(chainRpc),
  });
  const paidFetch = wrapFetchWithPayment(fetch, walletClient, maxUsdcAtomic);

  const startRes = await paidFetch(`${baseUrl}/v1/certify/start`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ templateId }),
  });
  if (!startRes.ok) {
    const text = await startRes.text();
    throw new Error(`Failed to start certification (${startRes.status}): ${text}`);
  }
  const started = await startRes.json();

  const runId = started?.run?.id;
  if (!runId) {
    throw new Error('Certification start response missing run.id');
  }

  console.log(`[Demo] Certification run started: ${runId}`);
  console.log(`[Demo] Deadline: ${new Date(started.run.deadlineAt).toISOString()}`);
  console.log(`[Demo] Work order config: ${JSON.stringify(started.workOrder?.config || {}, null, 2)}`);

  if (!txHash) {
    console.log('[Demo] Swap execution step: perform a swap now, then re-run with --txHash=<base_tx_hash>');
    console.log(`[Demo] Resume command: node scripts/certification-demo.mjs --agentId=${erc8004AgentId} --privateKey=<pk> --txHash=<hash>`);
    return;
  }

  console.log(`[Demo] Submitting proof txHash=${txHash}`);
  const submit = await fetchJson(`${baseUrl}/v1/certify/runs/${runId}/submit`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ runId, proof: { txHash } }),
  });

  const verification = submit.verification || {};
  const checks = Array.isArray(verification.checks) ? verification.checks : [];
  console.log(`[Demo] Verification passed=${Boolean(verification.passed)} score=${submit.score ?? 'n/a'}`);
  for (const check of checks) {
    console.log(`  - ${check.name}: ${check.passed ? 'PASS' : 'FAIL'}`);
  }

  const attestation = await fetchJson(`${baseUrl}/v1/certify/runs/${runId}/attestation`, {
    method: 'GET',
  });
  console.log('[Demo] Attestation:');
  console.log(JSON.stringify(attestation, null, 2));
}

main().catch((error) => {
  console.error('[Demo] Failed:', error?.message || error);
  process.exit(1);
});
