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

    const score = verifierResult.score;
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
    const amountOutMinimum = typeof body.amountOutMinimum === 'string' || typeof body.amountOutMinimum === 'number'
      ? BigInt(String(body.amountOutMinimum))
      : BigInt('1');
    const sqrtPriceLimitX96 = BigInt('0');

    // Resolve recipient wallet address from agent ID if needed
    let walletAddress = recipient;
    if (!recipient.startsWith('0x') || recipient.length !== 42) {
      const agent = await db.getAgent(auth.agentId);
      walletAddress = (agent as any)?.ownerId || recipient;
    }

    // ABI-encode exactInputSingle using ethers
    const iface = new ethers.Interface([
      'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
      'function multicall(uint256 deadline, bytes[] data) payable returns (bytes[] results)',
    ]);

    const swapCalldata = iface.encodeFunctionData('exactInputSingle', [{
      tokenIn,
      tokenOut,
      fee,
      recipient: walletAddress,
      amountIn,
      amountOutMinimum,
      sqrtPriceLimitX96,
    }]);

    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600); // 10 min
    const multicallData = iface.encodeFunctionData('multicall', [deadline, [swapCalldata]]);

    const SWAP_ROUTER = '0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4';

    return {
      router: SWAP_ROUTER,
      calldata: multicallData,
      rawSwapCalldata: swapCalldata,
      params: {
        tokenIn,
        tokenOut,
        fee,
        recipient: walletAddress,
        amountIn: amountIn.toString(),
        amountOutMinimum: amountOutMinimum.toString(),
        deadline: deadline.toString(),
      },
      usage: {
        step1: `APPROVE_TOKEN: token=${tokenIn}, spender=${SWAP_ROUTER}, amount=${amountIn.toString()}`,
        step2: `EXECUTE_ONCHAIN: to=${SWAP_ROUTER}, data=${multicallData}, value=0`,
        step3: 'SUBMIT_CERTIFICATION_PROOF: submit the tx hash from step 2',
      },
    };
  });
}
