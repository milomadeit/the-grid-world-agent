import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'crypto';
import { ethers } from 'ethers';
import { authenticate } from '../auth.js';
import * as db from '../db.js';
import {
  BASE_CHAIN_ID,
  CHAIN_RPC,
  TREASURY_ADDRESS,
  getChainProvider,
  publishCertificationFeedbackOnChain,
  publishCertificationValidationOnChain,
  publishCertificationValidationRequestOnChain,
  activateSnipeTarget,
} from '../chain.js';
import { BUILD_CREDIT_CONFIG, StartCertificationSchema, SubmitCertificationProofSchema } from '../types.js';
import {
  getXPaymentHeader,
  sendX402PaymentRequired,
  verifyAndSettleX402Payment,
} from '../x402.js';
import { checkRateLimit } from '../throttle.js';
import { getVerifier } from '../verifiers/index.js';

interface AttestationSignature {
  signatureScheme: string;
  signer: string;
  publicKey: string;
  signature: string;
}

type AttestationSignerSource = 'relayer_pk' | 'attestation_signing_key';

interface AttestationSigner {
  wallet: ethers.Wallet;
  address: string;
  publicKey: string;
  source: AttestationSignerSource;
}

let cachedAttestationSigner: AttestationSigner | null | undefined;

function normalizePrivateKey(raw: string | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^0x[a-fA-F0-9]{64}$/.test(trimmed)) return trimmed;
  if (/^[a-fA-F0-9]{64}$/.test(trimmed)) return `0x${trimmed}`;
  return null;
}

function buildAttestationSigner(raw: string | undefined, source: AttestationSignerSource): AttestationSigner | null {
  const normalized = normalizePrivateKey(raw);
  if (!normalized) return null;

  try {
    const wallet = new ethers.Wallet(normalized);
    const publicKey = new ethers.SigningKey(normalized).publicKey;
    return {
      wallet,
      address: wallet.address,
      publicKey,
      source,
    };
  } catch {
    return null;
  }
}

function getAttestationSigner(): AttestationSigner | null {
  if (cachedAttestationSigner !== undefined) {
    return cachedAttestationSigner;
  }

  cachedAttestationSigner =
    buildAttestationSigner(process.env.RELAYER_PK, 'relayer_pk') ||
    buildAttestationSigner(process.env.ATTESTATION_SIGNING_KEY, 'attestation_signing_key') ||
    null;

  if (!cachedAttestationSigner) {
    console.warn('[Certify] No ECDSA attestation signer configured (RELAYER_PK or ATTESTATION_SIGNING_KEY).');
  } else {
    console.log(
      `[Certify] Attestation signing enabled with ${cachedAttestationSigner.source} (${cachedAttestationSigner.address}).`
    );
  }

  return cachedAttestationSigner;
}

function toTemplateForVerifier(template: db.CertificationTemplateRecord) {
  return {
    id: template.id,
    version: template.version,
    displayName: template.displayName,
    description: template.description,
    feeUsdcAtomic: template.feeUsdcAtomic,
    rewardCredits: template.rewardCredits,
    rewardReputation: template.rewardReputation,
    deadlineSeconds: template.deadlineSeconds,
    config: template.config,
    isActive: template.isActive,
  };
}

function toRunForVerifier(run: db.CertificationRunRecord) {
  return {
    id: run.id,
    agentId: run.agentId,
    ownerWallet: run.ownerWallet,
    templateId: run.templateId,
    status: run.status,
    feePaidUsdc: run.feePaidUsdc,
    x402PaymentRef: run.x402PaymentRef,
    deadlineAt: run.deadlineAt,
    startedAt: run.startedAt,
    submittedAt: run.submittedAt,
    completedAt: run.completedAt,
    verificationResult: run.verificationResult as any,
    attestationJson: run.attestationJson as any,
    onchainTxHash: run.onchainTxHash,
  };
}

async function signAttestation(attestationWithoutSignature: Record<string, unknown>): Promise<AttestationSignature> {
  const payload = JSON.stringify(attestationWithoutSignature);
  const signer = getAttestationSigner();
  if (!signer) {
    return {
      signatureScheme: 'none',
      signer: '',
      publicKey: '',
      signature: '',
    };
  }

  const signature = await signer.wallet.signMessage(payload);
  return {
    signatureScheme: 'ecdsa-secp256k1',
    signer: signer.address,
    publicKey: signer.publicKey,
    signature,
  };
}

function canUseOnchainTokenId(value: string | undefined): value is string {
  return Boolean(value && /^[0-9]+$/.test(value));
}

function certificationResourceUrl(request: { protocol: string; hostname: string }, path: string): string {
  const host = request.hostname;
  // Fastify's request.hostname strips the port — reconstruct from raw host header
  const rawHost = (request as any).headers?.host || host;
  return `${request.protocol}://${rawHost}${path}`;
}

export async function registerCertificationRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/v1/certify/templates', async (request, reply) => {
    const auth = await authenticate(request, reply);
    if (!auth) return;

    const templates = await db.getActiveCertificationTemplates();
    return { templates };
  });

  fastify.post('/v1/certify/start', async (request, reply) => {
    const auth = await authenticate(request, reply);
    if (!auth) return;

    const startLimit = checkRateLimit('rest:certify:start', auth.agentId, 5, 60 * 60 * 1000);
    if (!startLimit.allowed) {
      return reply.code(429).send({
        error: 'Rate limit exceeded',
        retryAfterMs: startLimit.retryAfterMs,
      });
    }

    const parsed = StartCertificationSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Invalid request body',
        details: parsed.error.issues,
      });
    }

    const template = await db.getCertificationTemplate(parsed.data.templateId);
    if (!template || !template.isActive) {
      return reply.code(404).send({ error: 'Certification template not found or inactive' });
    }

    // Hard cap: max 3 passes per template per agent, then locked
    const MAX_PASSES_PER_CERT = 3;
    const passCount = await db.getCertificationPassCount(auth.agentId, parsed.data.templateId);
    if (passCount >= MAX_PASSES_PER_CERT) {
      return reply.code(403).send({
        error: `You have already passed ${template.displayName} ${passCount} times (max ${MAX_PASSES_PER_CERT}). This certification is locked. Attempt a different certification or a higher tier.`,
        passCount,
        maxPasses: MAX_PASSES_PER_CERT,
      });
    }

    const paymentHeader = getXPaymentHeader(request);
    const paymentResource = certificationResourceUrl(request, '/v1/certify/start');
    if (!paymentHeader) {
      return sendX402PaymentRequired(reply, {
        resource: paymentResource,
        description: `${template.displayName} certification fee`,
        receiver: TREASURY_ADDRESS,
        maxAmountRequired: template.feeUsdcAtomic,
      });
    }

    const paymentResult = await verifyAndSettleX402Payment(paymentHeader, {
      resource: paymentResource,
      description: `${template.displayName} certification fee`,
      receiver: TREASURY_ADDRESS,
      maxAmountRequired: template.feeUsdcAtomic,
    });
    if (!paymentResult.ok) {
      return reply.code(402).send({
        error: 'x402 payment verification failed',
        reason: paymentResult.reason,
      });
    }
    if (paymentResult.paymentResponseHeader) {
      reply.header('X-PAYMENT-RESPONSE', paymentResult.paymentResponseHeader);
    }

    const nowMs = Date.now();
    const run = await db.createCertificationRun({
      id: randomUUID(),
      agentId: auth.agentId,
      ownerWallet: auth.ownerId,
      templateId: template.id,
      status: 'active',
      feePaidUsdc: template.feeUsdcAtomic,
      x402PaymentRef: paymentResult.paymentResponseHeader,
      deadlineAt: nowMs + template.deadlineSeconds * 1000,
      startedAt: nowMs,
    });

    await db.recordCertificationPayout({
      runId: run.id,
      payoutType: 'fee_collected',
      amount: template.feeUsdcAtomic,
      currency: 'USDC',
      recipientWallet: TREASURY_ADDRESS,
    });

    const agent = await db.getAgent(auth.agentId);
    const erc8004TokenId = (agent as any)?.erc8004AgentId as string | undefined;
    if (canUseOnchainTokenId(erc8004TokenId)) {
      await publishCertificationValidationRequestOnChain({
        runId: run.id,
        agentTokenId: erc8004TokenId,
        requestURI: certificationResourceUrl(request, `/v1/certify/runs/${run.id}/attestation`),
      });
    }

    // SNIPER_V1: schedule target activation after random delay (30-90 seconds)
    if (template.id === 'SNIPER_V1') {
      const delay = 30000 + Math.random() * 60000; // 30-90 seconds
      setTimeout(async () => {
        try {
          const result = await activateSnipeTarget(run.id);
          if (result) {
            console.log(`[Certify] Snipe target activated for ${run.id} at block ${result.activationBlock} (tx: ${result.txHash})`);
            // Store activation info in the run for later verification
            await db.updateCertificationRunStatus(run.id, 'active', {
              verificationResult: { activationTxHash: result.txHash, activationBlock: result.activationBlock } as any,
            });
          }
        } catch (err: any) {
          console.error(`[Certify] Failed to activate snipe target for ${run.id}:`, err.message);
        }
      }, delay);
    }

    // Build the challenge prompt — everything an agent needs to complete the cert
    const challenge = {
      ...(template.challenge || {}),
      deadline: new Date(run.deadlineAt).toISOString(),
      timeLimit: `${Math.round(template.deadlineSeconds / 60)} minutes from start`,
      submission: {
        ...((template.challenge as any)?.submission || {}),
        endpoint: `POST /v1/certify/runs/${run.id}/submit`,
        body: `{ "runId": "${run.id}", "proof": { "txHash": "<your transaction hash>" } }`,
      },
    };

    return {
      run,
      challenge,
    };
  });

  fastify.get('/v1/certify/runs', async (request, reply) => {
    const auth = await authenticate(request, reply);
    if (!auth) return;

    const [runs, stats] = await Promise.all([
      db.getCertificationRunsForAgent(auth.agentId),
      db.getAgentCertificationStats(auth.agentId),
    ]);

    // Proactively expire runs whose deadline has passed but status is still active/created
    const nowMs = Date.now();
    for (const run of runs) {
      if ((run.status === 'active' || run.status === 'created') && run.deadlineAt && nowMs > run.deadlineAt) {
        await db.updateCertificationRunStatus(run.id, 'expired', { completedAt: nowMs });
        run.status = 'expired';
        (run as any).completedAt = nowMs;
      }
    }

    // Attach the challenge prompt to active runs so agents always know what to do
    const templateCache = new Map<string, db.CertificationTemplateRecord>();
    const enrichedRuns = await Promise.all(runs.map(async (run) => {
      const isActive = run.status === 'active' || run.status === 'created';
      if (!isActive) return run;

      let tmpl = templateCache.get(run.templateId);
      if (!tmpl) {
        const found = await db.getCertificationTemplate(run.templateId);
        if (found) {
          tmpl = found;
          templateCache.set(run.templateId, found);
        }
      }
      if (!tmpl) return run;

      return {
        ...run,
        challenge: {
          ...(tmpl.challenge || {}),
          deadline: new Date(run.deadlineAt).toISOString(),
          timeLimit: `${Math.round(tmpl.deadlineSeconds / 60)} minutes from start`,
          submission: {
            ...((tmpl.challenge as any)?.submission || {}),
            endpoint: `POST /v1/certify/runs/${run.id}/submit`,
            body: `{ "runId": "${run.id}", "proof": { "txHash": "<your transaction hash>" } }`,
          },
        },
      };
    }));

    return {
      runs: enrichedRuns,
      stats,
    };
  });

  fastify.get<{ Params: { runId: string } }>('/v1/certify/runs/:runId', async (request, reply) => {
    const auth = await authenticate(request, reply);
    if (!auth) return;

    const run = await db.getCertificationRun(request.params.runId);
    if (!run) {
      return reply.code(404).send({ error: 'Certification run not found' });
    }
    if (run.agentId !== auth.agentId) {
      return reply.code(403).send({ error: 'Forbidden' });
    }

    return { run };
  });

  fastify.post<{ Params: { runId: string } }>('/v1/certify/runs/:runId/submit', async (request, reply) => {
    const auth = await authenticate(request, reply);
    if (!auth) return;

    const submitLimit = checkRateLimit('rest:certify:submit', auth.agentId, 10, 60 * 60 * 1000);
    if (!submitLimit.allowed) {
      return reply.code(429).send({
        error: 'Rate limit exceeded',
        retryAfterMs: submitLimit.retryAfterMs,
      });
    }

    const parsed = SubmitCertificationProofSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Invalid request body',
        details: parsed.error.issues,
      });
    }
    if (parsed.data.runId !== request.params.runId) {
      return reply.code(400).send({ error: 'runId in body must match URL parameter' });
    }

    const run = await db.getCertificationRun(request.params.runId);
    if (!run) {
      return reply.code(404).send({ error: 'Certification run not found' });
    }
    if (run.agentId !== auth.agentId || run.ownerWallet.toLowerCase() !== auth.ownerId.toLowerCase()) {
      return reply.code(403).send({ error: 'Forbidden' });
    }
    if (run.status !== 'active' && run.status !== 'submitted' && run.status !== 'verifying') {
      return reply.code(409).send({ error: `Run is not active (current status: ${run.status})` });
    }

    const nowMs = Date.now();
    if (nowMs > run.deadlineAt) {
      const expired = await db.updateCertificationRunStatus(run.id, 'expired', { completedAt: nowMs });
      return reply.code(400).send({
        error: 'Certification run deadline exceeded',
        run: expired || run,
      });
    }

    const template = await db.getCertificationTemplate(run.templateId);
    if (!template) {
      return reply.code(500).send({ error: 'Certification template missing' });
    }

    const verifier = getVerifier(run.templateId);
    if (!verifier) {
      return reply.code(500).send({ error: `No verifier registered for template ${run.templateId}` });
    }

    const submission = await db.createCertificationSubmission(run.id, parsed.data.proof);
    await db.updateCertificationRunStatus(run.id, 'submitted', { submittedAt: nowMs });
    await db.updateCertificationRunStatus(run.id, 'verifying', { submittedAt: nowMs });

    const provider = getChainProvider() || new ethers.JsonRpcProvider(CHAIN_RPC, BASE_CHAIN_ID);
    let verifierResult: Awaited<ReturnType<typeof verifier.verify>>;
    try {
      verifierResult = await verifier.verify({
        run: toRunForVerifier(run),
        template: toTemplateForVerifier(template),
        proof: parsed.data.proof,
        provider,
      });
    } catch (verifyErr: any) {
      console.error(`[certify] Verifier error for run ${run.id}:`, verifyErr);
      await db.updateCertificationRunStatus(run.id, 'active', {}); // revert to active so agent can retry
      return reply.code(500).send({
        error: 'Verification failed',
        detail: verifyErr?.message || 'Unknown verifier error',
      });
    }

    let score = verifierResult.score;

    // +5 bonus for custom slippage option D — agent calculated their own amountOutMinimum
    const proofSlippageOption = (parsed.data.proof as any).slippageOption;
    if (typeof proofSlippageOption === 'string' && proofSlippageOption.toUpperCase() === 'D') {
      const slippageCheck = verifierResult.checks.find(c => c.name === 'slippage_management');
      if (slippageCheck && slippageCheck.score > 0) {
        score = Math.min(100, score + 5);
        slippageCheck.detail = `${slippageCheck.detail} (+5 custom slippage bonus)`;
      }
    }

    const passingScore = typeof (template.config as any)?.passingScore === 'number'
      ? (template.config as any).passingScore
      : 70;

    const verificationResult = {
      templateId: run.templateId,
      runId: run.id,
      score,
      passed: verifierResult.passed,
      checks: verifierResult.checks,
    };

    await db.createCertificationVerification({
      runId: run.id,
      submissionId: submission.id,
      templateId: run.templateId,
      passed: verifierResult.passed,
      checks: verifierResult.checks,
      verifiedAt: nowMs,
    });

    // Build breakdown for response
    const breakdown = verifierResult.checks.map((c) => ({
      dimension: c.name,
      score: c.score,
      weight: c.weight,
      detail: c.detail || '',
    }));

    if (!verifierResult.passed) {
      const failedRun = await db.updateCertificationRunStatus(run.id, 'failed', {
        submittedAt: nowMs,
        completedAt: nowMs,
        verificationResult: verificationResult as unknown as Record<string, unknown>,
      });

      return {
        status: 'failed',
        score,
        passingScore,
        breakdown,
        run: failedRun || run,
        verification: verificationResult,
      };
    }

    const checksPassed = verifierResult.checks.filter((entry) => entry.passed).length;

    const attestationCore = {
      version: 1,
      runId: run.id,
      agentId: run.agentId,
      templateId: run.templateId,
      passed: true,
      checksCount: verifierResult.checks.length,
      checksPassed,
      score,
      verifiedAt: nowMs,
      onchainTxHash: String(parsed.data.proof.txHash || ''),
    };
    const attestationSignature = await signAttestation(attestationCore);
    const attestationJson = {
      ...attestationCore,
      signatureScheme: attestationSignature.signatureScheme,
      opgridSigner: attestationSignature.signer,
      opgridSignerAddress: attestationSignature.signer,
      opgridPublicKey: attestationSignature.publicKey,
      opgridSignature: attestationSignature.signature,
    };

    // Rewards scale proportionally to score
    const scoreRatio = score / 100;
    const creditReward = Math.round(template.rewardCredits * scoreRatio);
    const repReward = Math.round(template.rewardReputation * scoreRatio);

    await db.addCreditsWithCap(run.agentId, creditReward, BUILD_CREDIT_CONFIG.CREDIT_CAP);
    await db.addLocalReputation(run.agentId, repReward);

    await db.recordCertificationPayout({
      runId: run.id,
      payoutType: 'credit_reward',
      amount: String(creditReward),
      currency: 'credits',
      recipientAgentId: run.agentId,
    });
    await db.recordCertificationPayout({
      runId: run.id,
      payoutType: 'reputation_reward',
      amount: String(repReward),
      currency: 'reputation',
      recipientAgentId: run.agentId,
    });

    const agent = await db.getAgent(run.agentId);
    const erc8004TokenId = (agent as any)?.erc8004AgentId as string | undefined;
    const attestationURI = certificationResourceUrl(request, `/v1/certify/runs/${run.id}/attestation`);
    let onchainTxHash: string | undefined;

    if (canUseOnchainTokenId(erc8004TokenId)) {
      const feedbackPublish = await publishCertificationFeedbackOnChain({
        runId: run.id,
        agentTokenId: erc8004TokenId,
        templateId: run.templateId,
        score,
        feedbackURI: attestationURI,
        attestationJson,
      });
      const validationPublish = await publishCertificationValidationOnChain({
        runId: run.id,
        agentTokenId: erc8004TokenId,
        templateId: run.templateId,
        score,
        responseURI: attestationURI,
        attestationJson,
      });
      onchainTxHash = validationPublish?.txHash || feedbackPublish?.txHash || undefined;
    }

    const passedRun = await db.updateCertificationRunStatus(run.id, 'passed', {
      submittedAt: nowMs,
      completedAt: nowMs,
      verificationResult: verificationResult as unknown as Record<string, unknown>,
      attestationJson: attestationJson as unknown as Record<string, unknown>,
      onchainTxHash: onchainTxHash || null,
    });

    return {
      status: 'passed',
      score,
      passingScore,
      breakdown,
      run: passedRun || run,
      verification: verificationResult,
    };
  });

  fastify.get<{ Params: { runId: string } }>(
    '/v1/certify/runs/:runId/attestation',
    async (request, reply) => {
      const run = await db.getCertificationRun(request.params.runId);
      if (!run) {
        return reply.code(404).send({ error: 'Certification run not found' });
      }
      if (!run.attestationJson) {
        return reply.code(404).send({ error: 'Attestation not available for this run' });
      }

      return run.attestationJson;
    },
  );

  fastify.get<{ Querystring: { templateId?: string; limit?: string } }>(
    '/v1/certify/leaderboard',
    async (request) => {
      const limit = request.query.limit ? parseInt(request.query.limit, 10) : 50;
      const leaderboard = await db.getCertificationLeaderboard(
        request.query.templateId,
        Number.isFinite(limit) ? limit : 50,
      );
      return { leaderboard };
    },
  );

  // --- Calldata helper: generate ABI-encoded swap calldata for agents ---
  fastify.post('/v1/certify/encode-swap', async (request, reply) => {
    const auth = await authenticate(request, reply);
    if (!auth) return;

    const body = request.body as Record<string, unknown>;
    const tokenIn = typeof body.tokenIn === 'string' ? body.tokenIn : '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
    const tokenOut = typeof body.tokenOut === 'string' ? body.tokenOut : '0x4200000000000000000000000000000000000006';
    const fee = typeof body.fee === 'number' ? body.fee : 3000;
    const recipient = typeof body.recipient === 'string' ? body.recipient : auth.agentId;
    const amountIn = typeof body.amountIn === 'string' || typeof body.amountIn === 'number'
      ? BigInt(String(body.amountIn))
      : BigInt('1000000'); // 1 USDC
    const sqrtPriceLimitX96 = BigInt('0');

    // Resolve recipient wallet address from agent ID if needed
    let walletAddress = recipient;
    if (!recipient.startsWith('0x') || recipient.length !== 42) {
      const agent = await db.getAgent(auth.agentId);
      walletAddress = (agent as any)?.ownerId || recipient;
    }

    const SWAP_ROUTER = '0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4';
    const QUOTER_V2 = '0xC5290058841028F1614F3A6F0F5816cAd0df5E27';

    const iface = new ethers.Interface([
      'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
      'function multicall(uint256 deadline, bytes[] data) payable returns (bytes[] results)',
    ]);

    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600); // 10 min

    // If agent provided their own amountOutMinimum, encode directly (skip options)
    if (body.amountOutMinimum != null) {
      const amountOutMinimum = BigInt(String(body.amountOutMinimum));
      const swapCalldata = iface.encodeFunctionData('exactInputSingle', [{
        tokenIn, tokenOut, fee, recipient: walletAddress, amountIn, amountOutMinimum, sqrtPriceLimitX96,
      }]);
      const multicallData = iface.encodeFunctionData('multicall', [deadline, [swapCalldata]]);
      return {
        router: SWAP_ROUTER,
        calldata: multicallData,
        rawSwapCalldata: swapCalldata,
        params: { tokenIn, tokenOut, fee, recipient: walletAddress, amountIn: amountIn.toString(), amountOutMinimum: amountOutMinimum.toString(), deadline: deadline.toString() },
        usage: {
          step1: `APPROVE_TOKEN: token=${tokenIn}, spender=${SWAP_ROUTER}, amount=${amountIn.toString()}`,
          step2: `EXECUTE_ONCHAIN: to=${SWAP_ROUTER}, data=<calldata above>, value=0`,
          step3: 'SUBMIT_CERTIFICATION_PROOF: submit the tx hash from step 2',
        },
      };
    }

    // --- Slippage challenge: quote real price, present 5 options ---
    let quotedOutput = 0n;
    try {
      const quoterProvider = getChainProvider();
      if (!quoterProvider) throw new Error('No chain provider');
      const quoterIface = new ethers.Interface([
        'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
      ]);
      const quoterContract = new ethers.Contract(QUOTER_V2, quoterIface, quoterProvider);
      const quoteResult = await quoterContract.quoteExactInputSingle.staticCall({
        tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n,
      });
      quotedOutput = quoteResult[0];
    } catch (err: any) {
      // If quote fails, fall back to single option with no protection
      console.warn('[encode-swap] QuoterV2 failed, returning single option:', err?.message);
      const swapCalldata = iface.encodeFunctionData('exactInputSingle', [{
        tokenIn, tokenOut, fee, recipient: walletAddress, amountIn, amountOutMinimum: 1n, sqrtPriceLimitX96,
      }]);
      const multicallData = iface.encodeFunctionData('multicall', [deadline, [swapCalldata]]);
      return {
        router: SWAP_ROUTER,
        calldata: multicallData,
        rawSwapCalldata: swapCalldata,
        params: { tokenIn, tokenOut, fee, recipient: walletAddress, amountIn: amountIn.toString(), amountOutMinimum: '1', deadline: deadline.toString() },
        quoteFailed: true,
        usage: {
          step1: `APPROVE_TOKEN: token=${tokenIn}, spender=${SWAP_ROUTER}, amount=${amountIn.toString()}`,
          step2: `EXECUTE_ONCHAIN: to=${SWAP_ROUTER}, data=<calldata above>, value=0`,
          step3: 'SUBMIT_CERTIFICATION_PROOF: submit the tx hash from step 2',
        },
      };
    }

    // Slippage challenge — shuffled, not in order. Agent must understand DeFi.
    // A: 5% (500 bps) — loose, works but low score
    // B: 0.5% (50 bps) — tight, best preset score
    // C: 102% of quote — trap, tx reverts
    // D: custom — agent provides own amountOutMinimum, +5 bonus if valid
    // E: 1% (100 bps) — moderate
    const options: Record<string, { label: string; amountOutMinimum: string; calldata: string; bonus?: number }> = {};
    const slippagePresets = [
      { key: 'A', label: 'Conservative tolerance',  bps: 500 },    // 5% — loose
      { key: 'B', label: 'Aggressive tolerance',     bps: 50 },     // 0.5% — tight
      { key: 'C', label: 'Maximum protection',       bps: -200 },   // 102% — reverts
      { key: 'E', label: 'Balanced tolerance',        bps: 100 },    // 1% — moderate
    ];

    for (const preset of slippagePresets) {
      let minOut: bigint;
      if (preset.bps < 0) {
        // Negative bps = above quote (will revert)
        minOut = (quotedOutput * BigInt(10000 + Math.abs(preset.bps))) / 10000n;
      } else {
        minOut = (quotedOutput * BigInt(10000 - preset.bps)) / 10000n;
      }

      const swapCalldata = iface.encodeFunctionData('exactInputSingle', [{
        tokenIn, tokenOut, fee, recipient: walletAddress, amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96,
      }]);
      const multicallData = iface.encodeFunctionData('multicall', [deadline, [swapCalldata]]);

      options[preset.key] = {
        label: preset.label,
        amountOutMinimum: minOut.toString(),
        calldata: multicallData,
      };
    }

    // Option D: custom — agent provides their own amountOutMinimum for +5 bonus
    options['D'] = {
      label: 'Custom amount — you set amountOutMinimum yourself (+5 bonus points on slippage score if valid)',
      amountOutMinimum: 'YOU_DECIDE',
      calldata: 'Call ENCODE_SWAP again with { "slippageOption": "D", "amountOutMinimum": "<your value>" }',
      bonus: 5,
    };

    return {
      router: SWAP_ROUTER,
      challenge: 'Choose a slippage option (A-E). Your choice directly affects your certification score. Option D lets you set your own amountOutMinimum for a +5 bonus — but you need to know what you\'re doing.',
      quotedOutput: quotedOutput.toString(),
      options,
      params: { tokenIn, tokenOut, fee, recipient: walletAddress, amountIn: amountIn.toString(), deadline: deadline.toString() },
      usage: {
        step1: `APPROVE_TOKEN: token=${tokenIn}, spender=${SWAP_ROUTER}, amount=${amountIn.toString()}`,
        step2: 'EXECUTE_ONCHAIN: to=<router>, data=<calldata from your chosen option>, value=0',
        step3: 'SUBMIT_CERTIFICATION_PROOF: submit the tx hash from step 2',
      },
    };
  });
}
