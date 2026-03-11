import type { ScoredCheck, CertificationVerifier, VerifierContext, VerifierResult } from './types.js';
import { readSnipeResult } from '../chain.js';

const DEFAULT_PASSING_SCORE = 70;

function scoredCheck(
  name: string,
  score: number,
  weight: number,
  expected: unknown,
  actual: unknown,
  detail?: string,
): ScoredCheck {
  return {
    name,
    score: Math.max(0, Math.min(100, Math.round(score))),
    weight,
    passed: score > 0,
    expected,
    actual,
    detail,
  };
}

function computeWeightedScore(checks: ScoredCheck[]): number {
  const totalWeight = checks.reduce((sum, c) => sum + c.weight, 0);
  if (totalWeight === 0) return 0;
  const weighted = checks.reduce((sum, c) => sum + c.score * c.weight, 0);
  return Math.round(weighted / totalWeight);
}

export class SniperV1Verifier implements CertificationVerifier {
  templateId = 'SNIPER_V1';

  async verify(ctx: VerifierContext): Promise<VerifierResult> {
    const txHash = String(ctx.proof.txHash || '');

    const tx = txHash ? await ctx.provider.getTransaction(txHash) : null;
    const receipt = tx ? await ctx.provider.getTransactionReceipt(txHash) : null;

    // --- Gate: correct_sender (if sender doesn't match, entire score = 0) ---
    const expectedSender = ctx.run.ownerWallet.toLowerCase();
    const actualSender = tx?.from ? tx.from.toLowerCase() : null;
    const senderMatch = Boolean(actualSender && actualSender === expectedSender);

    if (!senderMatch) {
      const checks: ScoredCheck[] = [
        scoredCheck('correct_sender', 0, 0, expectedSender, actualSender, 'Sender does not match. Entire score = 0.'),
        scoredCheck('detection', 0, 30, 'same block as activation', 'N/A', 'Blocked by sender mismatch.'),
        scoredCheck('execution', 0, 25, 'snipe() called successfully', 'N/A', 'Blocked by sender mismatch.'),
        scoredCheck('gas_efficiency', 0, 20, '< 50k gas', 'N/A', 'Blocked by sender mismatch.'),
        scoredCheck('speed', 0, 25, '< 60s from cert start', 'N/A', 'Blocked by sender mismatch.'),
      ];
      return { score: 0, passed: false, checks };
    }

    // --- Read on-chain snipe result ---
    const snipeResult = await readSnipeResult(ctx.run.id);

    if (!snipeResult || snipeResult.activationBlock === 0) {
      // Target was never activated — cert infrastructure issue
      const checks: ScoredCheck[] = [
        scoredCheck('detection', 0, 30, 'activation exists', 'no activation found', 'Snipe target was never activated for this run. This may be a server-side issue.'),
        scoredCheck('execution', 0, 25, 'snipe() called', 'N/A', 'Cannot evaluate — no activation.'),
        scoredCheck('gas_efficiency', 0, 20, '< 50k gas', 'N/A', 'Cannot evaluate — no activation.'),
        scoredCheck('speed', 0, 25, '< 60s', 'N/A', 'Cannot evaluate — no activation.'),
      ];
      return { score: 0, passed: false, checks };
    }

    // --- Dimension 1: detection (weight 30) ---
    // How quickly did the agent detect the activation and snipe?
    // Measured in block delta: activationBlock vs snipedBlock
    let detectionScore = 0;
    let detectionDetail = 'Target not sniped.';
    let detectionActual: unknown = 'not sniped';

    if (snipeResult.snipedBlock > 0) {
      const blockDelta = snipeResult.snipedBlock - snipeResult.activationBlock;
      detectionActual = { activationBlock: snipeResult.activationBlock, snipedBlock: snipeResult.snipedBlock, blockDelta };

      if (blockDelta <= 0) {
        detectionScore = 100;
        detectionDetail = `Same block as activation (delta=${blockDelta}) — incredible.`;
      } else if (blockDelta === 1) {
        detectionScore = 80;
        detectionDetail = `1 block after activation — excellent.`;
      } else if (blockDelta === 2) {
        detectionScore = 60;
        detectionDetail = `2 blocks after activation — good.`;
      } else if (blockDelta === 3) {
        detectionScore = 40;
        detectionDetail = `3 blocks after activation — acceptable.`;
      } else if (blockDelta <= 5) {
        detectionScore = 20;
        detectionDetail = `${blockDelta} blocks after activation — slow.`;
      } else {
        detectionScore = 0;
        detectionDetail = `${blockDelta} blocks after activation — too slow.`;
      }
    }

    const detectionCheck = scoredCheck(
      'detection',
      detectionScore,
      30,
      'same block as activation (delta=0)',
      detectionActual,
      detectionDetail,
    );

    // --- Dimension 2: execution (weight 25) ---
    // snipe() called successfully, sniper address matches run.ownerWallet
    let executionScore = 0;
    let executionDetail = 'Target not sniped.';
    let executionActual: unknown = 'not sniped';

    if (snipeResult.snipedBlock > 0) {
      const sniperAddress = snipeResult.sniper.toLowerCase();
      executionActual = { sniper: sniperAddress, expected: expectedSender };

      if (sniperAddress === expectedSender) {
        // Also check that the submitted tx was confirmed
        const txConfirmed = Boolean(receipt && receipt.status === 1);
        if (txConfirmed) {
          executionScore = 100;
          executionDetail = `snipe() called successfully by correct wallet.`;
        } else {
          executionScore = 50;
          executionDetail = `Sniper matches but submitted tx not confirmed (status=${receipt?.status ?? 'missing'}).`;
        }
      } else {
        executionScore = 0;
        executionDetail = `Sniper address (${sniperAddress}) does not match run owner (${expectedSender}).`;
      }
    }

    const executionCheck = scoredCheck(
      'execution',
      executionScore,
      25,
      'snipe() by run owner wallet',
      executionActual,
      executionDetail,
    );

    // --- Dimension 3: gas_efficiency (weight 20) ---
    let gasScore = 0;
    let gasDetail = 'Cannot evaluate gas without receipt.';
    let gasActual: unknown = 'unavailable';

    if (receipt?.gasUsed) {
      const gasUsed = Number(receipt.gasUsed);
      gasActual = gasUsed;

      if (gasUsed < 50000) {
        gasScore = 100;
        gasDetail = `${gasUsed} gas — excellent (under 50k).`;
      } else if (gasUsed < 80000) {
        gasScore = 80;
        gasDetail = `${gasUsed} gas — good (50k-80k).`;
      } else if (gasUsed < 120000) {
        gasScore = 60;
        gasDetail = `${gasUsed} gas — acceptable (80k-120k).`;
      } else {
        gasScore = 30;
        gasDetail = `${gasUsed} gas — heavy (over 120k).`;
      }
    }

    const gasCheck = scoredCheck(
      'gas_efficiency',
      gasScore,
      20,
      '< 50k gas',
      gasActual,
      gasDetail,
    );

    // --- Dimension 4: speed (weight 25) ---
    // Wall clock: cert start time to snipe tx block timestamp
    let speedScore = 0;
    let speedDetail = 'Cannot evaluate speed without receipt.';
    let speedActual: unknown = 'unavailable';

    if (receipt) {
      let blockTimestampMs: number | null = null;
      try {
        const block = await ctx.provider.getBlock(receipt.blockNumber);
        if (block) blockTimestampMs = Number(block.timestamp) * 1000;
      } catch { /* RPC may not serve block */ }

      if (blockTimestampMs == null) {
        blockTimestampMs = Date.now();
        speedDetail = 'Block timestamp unavailable; using submission time.';
      }

      const elapsedMs = blockTimestampMs - ctx.run.startedAt;
      const elapsedSec = elapsedMs / 1000;
      speedActual = `${Math.round(elapsedSec)}s`;

      if (elapsedSec < 60) {
        speedScore = 100;
        speedDetail = `${Math.round(elapsedSec)}s from cert start — incredible.`;
      } else if (elapsedSec < 120) {
        speedScore = 80;
        speedDetail = `${Math.round(elapsedSec)}s from cert start — excellent.`;
      } else if (elapsedSec < 180) {
        speedScore = 60;
        speedDetail = `${Math.round(elapsedSec)}s from cert start — good.`;
      } else if (elapsedSec < 300) {
        speedScore = 40;
        speedDetail = `${Math.round(elapsedSec)}s from cert start — acceptable.`;
      } else {
        speedScore = 20;
        speedDetail = `${Math.round(elapsedSec)}s from cert start — slow.`;
      }

      // Check deadline
      if (blockTimestampMs > ctx.run.deadlineAt) {
        speedScore = 0;
        speedDetail = 'Transaction mined after deadline.';
      }
    }

    const speedCheck = scoredCheck(
      'speed',
      speedScore,
      25,
      '< 60s from cert start',
      speedActual,
      speedDetail,
    );

    // --- Assemble result ---
    const checks: ScoredCheck[] = [
      detectionCheck,
      executionCheck,
      gasCheck,
      speedCheck,
    ];

    const score = computeWeightedScore(checks);

    return {
      score,
      passed: score >= DEFAULT_PASSING_SCORE,
      checks,
    };
  }
}
