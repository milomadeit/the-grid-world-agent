/**
 * Phase 2 Certification Demo — end-to-end walkthrough for Base Batches narrative.
 *
 * Flow:
 *   1. Authenticate with OpGrid (signed wallet auth)
 *   2. Fetch certification templates
 *   3. Start a certification run (x402 payment)
 *   4. Execute a Uniswap V3 swap on Base Sepolia using the work order config
 *   5. Submit the swap tx hash as proof
 *   6. Display verification result (8 checks)
 *   7. Fetch and display the signed attestation
 *   8. Show the certification leaderboard
 *
 * Usage:
 *   npx tsx scripts/demo-certification.ts
 *
 * Required env vars (or CLI flags):
 *   CERT_AGENT_PRIVATE_KEY / --privateKey    Agent wallet private key (hex)
 *   CERT_AGENT_ID          / --agentId       ERC-8004 token ID
 *
 * Optional:
 *   GRID_API_URL           / --api           Server URL (default: http://localhost:4101)
 *   CERT_TEMPLATE_ID       / --template      Template ID (default: SWAP_EXECUTION_V1)
 *   CERT_TX_HASH           / --txHash        Pre-existing swap tx hash (skip swap execution)
 *   CHAIN_RPC                                RPC URL (default: https://sepolia.base.org)
 *   CHAIN_ID                                 Chain ID (default: 84532)
 *   CERT_MAX_USDC_ATOMIC                     Max USDC for x402 payment (default: 1000000)
 */

import 'dotenv/config';
import { ethers } from 'ethers';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base, baseSepolia } from 'viem/chains';
import { wrapFetchWithPayment } from 'x402-fetch';

// ---------------------------------------------------------------------------
// CLI helpers
// ---------------------------------------------------------------------------

function arg(name: string, fallback?: string): string | undefined {
  const prefix = `${name}=`;
  const entry = process.argv.slice(2).find((item) => item.startsWith(prefix));
  return entry ? entry.slice(prefix.length) : fallback;
}

function normalizePk(raw: string | undefined): `0x${string}` | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (/^0x[a-fA-F0-9]{64}$/.test(trimmed)) return trimmed as `0x${string}`;
  if (/^[a-fA-F0-9]{64}$/.test(trimmed)) return `0x${trimmed}` as `0x${string}`;
  return null;
}

function step(n: number, label: string): void {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  Step ${n}: ${label}`);
  console.log('='.repeat(60));
}

// ---------------------------------------------------------------------------
// Typed fetch helper
// ---------------------------------------------------------------------------

async function fetchJson<T = unknown>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, init);
  const text = await res.text();
  let body: T;
  try {
    body = text ? JSON.parse(text) : ({} as T);
  } catch {
    throw new Error(`Non-JSON response from ${url}: ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${url}\n${JSON.stringify(body, null, 2)}`);
  }
  return body;
}

// ---------------------------------------------------------------------------
// Uniswap V3 swap execution on Base Sepolia
// ---------------------------------------------------------------------------

const UNISWAP_SWAP_ROUTER_02 = '0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4'; // Base Sepolia SwapRouter02

const swapRouterAbi = [
  'function multicall(uint256 deadline, bytes[] data) payable returns (bytes[] results)',
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
];

const erc20Abi = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
];

async function executeSwap(
  signer: ethers.Wallet,
  config: Record<string, unknown>,
): Promise<string> {
  const allowedTokenPairs = (config.allowedTokenPairs || []) as string[][];
  if (allowedTokenPairs.length === 0) {
    throw new Error('Work order config has no allowedTokenPairs');
  }

  const [tokenIn, tokenOut] = allowedTokenPairs[0];
  const tokenInContract = new ethers.Contract(tokenIn, erc20Abi, signer);

  const symbol: string = await tokenInContract.symbol();
  const decimals: number = await tokenInContract.decimals();
  const balance: bigint = await tokenInContract.balanceOf(signer.address);

  console.log(`  Token In: ${symbol} (${tokenIn})`);
  console.log(`  Token Out: ${tokenOut}`);
  console.log(`  Balance: ${ethers.formatUnits(balance, decimals)} ${symbol}`);

  // Use a small amount — 0.001 USDC (1000 atomic units for 6 decimals) or 1% of balance
  const swapAmount = balance > 0n
    ? (balance < 10n ** BigInt(decimals) ? balance / 2n : 10n ** BigInt(decimals) / 1000n)
    : 0n;

  if (swapAmount === 0n) {
    throw new Error(`No ${symbol} balance to swap. Fund ${signer.address} with test tokens on Base Sepolia.`);
  }

  console.log(`  Swap Amount: ${ethers.formatUnits(swapAmount, decimals)} ${symbol}`);

  // Approve router
  const currentAllowance: bigint = await tokenInContract.allowance(signer.address, UNISWAP_SWAP_ROUTER_02);
  if (currentAllowance < swapAmount) {
    console.log('  Approving SwapRouter02...');
    const approveTx = await tokenInContract.approve(UNISWAP_SWAP_ROUTER_02, ethers.MaxUint256);
    await approveTx.wait();
    console.log(`  Approved: ${approveTx.hash}`);
  }

  // Build exactInputSingle calldata
  const router = new ethers.Contract(UNISWAP_SWAP_ROUTER_02, swapRouterAbi, signer);
  const iface = new ethers.Interface(swapRouterAbi);

  const swapParams = {
    tokenIn,
    tokenOut,
    fee: 3000, // 0.3% fee tier
    recipient: signer.address,
    amountIn: swapAmount,
    amountOutMinimum: 0n, // accept any output for demo
    sqrtPriceLimitX96: 0n,
  };

  const innerCalldata = iface.encodeFunctionData('exactInputSingle', [swapParams]);
  const deadline = Math.floor(Date.now() / 1000) + 300; // 5 min deadline

  console.log('  Executing multicall swap...');
  const tx = await router.multicall(deadline, [innerCalldata]);
  console.log(`  Tx sent: ${tx.hash}`);

  const receipt = await tx.wait();
  console.log(`  Confirmed in block ${receipt.blockNumber} (gas: ${receipt.gasUsed.toString()})`);

  return tx.hash as string;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const baseUrl = process.env.GRID_API_URL || arg('--api') || 'http://localhost:4101';
  const templateId = process.env.CERT_TEMPLATE_ID || arg('--template') || 'SWAP_EXECUTION_V1';
  const existingTxHash = process.env.CERT_TX_HASH || arg('--txHash');
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

  const provider = new ethers.JsonRpcProvider(chainRpc, chainId);
  const wallet = new ethers.Wallet(privateKey, provider);

  console.log('OpGrid Certification Demo');
  console.log('-'.repeat(40));
  console.log(`  API:       ${baseUrl}`);
  console.log(`  Wallet:    ${wallet.address}`);
  console.log(`  Agent ID:  ${erc8004AgentId}`);
  console.log(`  Template:  ${templateId}`);
  console.log(`  Chain:     ${chainId} (${chainRpc})`);

  // -----------------------------------------------------------------------
  // Step 1: Authenticate
  // -----------------------------------------------------------------------
  step(1, 'Authenticate with OpGrid');

  const timestamp = new Date().toISOString();
  const authMessage = `Enter OpGrid\nTimestamp: ${timestamp}`;
  const signature = await wallet.signMessage(authMessage);

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

  const enter = await fetchJson<{ token: string; agentId: string }>(
    `${baseUrl}/v1/agents/enter`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(enterPayload),
    },
  );

  const token = enter.token;
  if (!token) throw new Error('Missing JWT from /v1/agents/enter');
  console.log(`  Authenticated as ${enter.agentId}`);

  const authHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };

  // -----------------------------------------------------------------------
  // Step 2: Fetch templates
  // -----------------------------------------------------------------------
  step(2, 'Fetch certification templates');

  const templatesResp = await fetchJson<{ templates: Array<{ id: string; displayName: string; feeUsdcAtomic: string; deadlineSeconds: number; config: Record<string, unknown> }> }>(
    `${baseUrl}/v1/certify/templates`,
    { method: 'GET', headers: authHeaders },
  );

  const templates = templatesResp.templates || [];
  for (const t of templates) {
    console.log(`  [${t.id}] ${t.displayName} — fee: ${t.feeUsdcAtomic} atomic USDC, deadline: ${t.deadlineSeconds}s`);
  }

  const selected = templates.find((t) => t.id === templateId);
  if (!selected) {
    throw new Error(`Template ${templateId} not found. Available: ${templates.map((t) => t.id).join(', ')}`);
  }

  // -----------------------------------------------------------------------
  // Step 3: Start certification run (x402 payment)
  // -----------------------------------------------------------------------
  step(3, 'Start certification run (x402 payment)');

  const account = privateKeyToAccount(privateKey);
  const walletClient = createWalletClient({
    account,
    chain: chainId === 8453 ? base : baseSepolia,
    transport: http(chainRpc),
  });
  const paidFetch = wrapFetchWithPayment(fetch as any, walletClient as any, maxUsdcAtomic);

  const startRes = await paidFetch(`${baseUrl}/v1/certify/start`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ templateId }),
  } as any);

  if (!startRes.ok) {
    const text = await startRes.text();
    throw new Error(`Failed to start certification (${startRes.status}): ${text}`);
  }

  const started = (await startRes.json()) as {
    run: { id: string; deadlineAt: number };
    workOrder: { templateId: string; deadlineAt: number; config: Record<string, unknown> };
  };

  const runId = started.run.id;
  console.log(`  Run ID:   ${runId}`);
  console.log(`  Deadline: ${new Date(started.run.deadlineAt).toISOString()}`);
  console.log(`  Config:   ${JSON.stringify(started.workOrder.config, null, 2)}`);

  // -----------------------------------------------------------------------
  // Step 4: Execute swap
  // -----------------------------------------------------------------------
  step(4, 'Execute Uniswap V3 swap on Base Sepolia');

  let txHash: string;

  if (existingTxHash) {
    console.log(`  Using pre-existing tx: ${existingTxHash}`);
    txHash = existingTxHash;
  } else {
    txHash = await executeSwap(wallet, started.workOrder.config);
  }

  console.log(`  Swap tx hash: ${txHash}`);

  // -----------------------------------------------------------------------
  // Step 5: Submit proof
  // -----------------------------------------------------------------------
  step(5, 'Submit proof to verifier');

  const submitResult = await fetchJson<{
    run: { id: string; status: string };
    verification: { passed: boolean; checks: Array<{ name: string; passed: boolean; detail?: string }> };
    score?: number;
  }>(`${baseUrl}/v1/certify/runs/${runId}/submit`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ runId, proof: { txHash } }),
  });

  // -----------------------------------------------------------------------
  // Step 6: Display verification result
  // -----------------------------------------------------------------------
  step(6, 'Verification result');

  const verification = submitResult.verification;
  const checks = verification?.checks || [];
  console.log(`  Passed: ${verification?.passed ? 'YES' : 'NO'}`);
  console.log(`  Score:  ${submitResult.score ?? 'n/a'}`);
  console.log();

  for (const c of checks) {
    const icon = c.passed ? '[PASS]' : '[FAIL]';
    console.log(`  ${icon} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
  }

  // -----------------------------------------------------------------------
  // Step 7: Fetch attestation
  // -----------------------------------------------------------------------
  step(7, 'Signed attestation');

  try {
    const attestation = await fetchJson<Record<string, unknown>>(
      `${baseUrl}/v1/certify/runs/${runId}/attestation`,
      { method: 'GET' },
    );

    console.log(JSON.stringify(attestation, null, 2));

    // Verify signature if ECDSA
    if (attestation.signatureScheme === 'ecdsa-secp256k1' && attestation.opgridSignature && attestation.opgridSignerAddress) {
      const { version, runId: aRunId, agentId: aAgentId, templateId: aTplId, passed, checksCount, checksPassed, verifiedAt, onchainTxHash: aTxHash } = attestation;
      const corePayload = JSON.stringify({ version, runId: aRunId, agentId: aAgentId, templateId: aTplId, passed, checksCount, checksPassed, verifiedAt, onchainTxHash: aTxHash });
      const recovered = ethers.verifyMessage(corePayload, attestation.opgridSignature as string);
      const matches = recovered.toLowerCase() === (attestation.opgridSignerAddress as string).toLowerCase();
      console.log(`\n  Signature verification: ${matches ? 'VALID' : 'INVALID'}`);
      console.log(`    Recovered: ${recovered}`);
      console.log(`    Expected:  ${attestation.opgridSignerAddress}`);
    }
  } catch (err) {
    console.log(`  Attestation not available (run may have failed): ${err instanceof Error ? err.message : String(err)}`);
  }

  // -----------------------------------------------------------------------
  // Step 8: Leaderboard
  // -----------------------------------------------------------------------
  step(8, 'Certification leaderboard');

  const leaderboardResp = await fetchJson<{ leaderboard: Array<{ agentName: string; templateId: string; passCount: number; totalRuns: number; passRate: number }> }>(
    `${baseUrl}/v1/certify/leaderboard?limit=10`,
    { method: 'GET' },
  );

  const lb = leaderboardResp.leaderboard || [];
  if (lb.length === 0) {
    console.log('  No certifications yet.');
  } else {
    console.log('  Rank  Agent              Template               Pass  Runs  Rate');
    console.log('  ' + '-'.repeat(70));
    for (let i = 0; i < lb.length; i++) {
      const e = lb[i];
      console.log(
        `  ${String(i + 1).padStart(4)}  ${e.agentName.padEnd(18).slice(0, 18)} ${e.templateId.padEnd(22).slice(0, 22)} ${String(e.passCount).padStart(4)}  ${String(e.totalRuns).padStart(4)}  ${e.passRate.toFixed(1)}%`,
      );
    }
  }

  console.log('\nDemo complete.');
}

main().catch((error) => {
  console.error('\n[Demo] FAILED:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
