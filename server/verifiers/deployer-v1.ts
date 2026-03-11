import { ethers } from 'ethers';
import type { ScoredCheck, CertificationVerifier, VerifierContext, VerifierResult } from './types.js';

const DEFAULT_PASSING_SCORE = 70;

const ERC20_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address,uint256) returns (bool)',
  'function approve(address,uint256) returns (bool)',
];

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

export class DeployerV1Verifier implements CertificationVerifier {
  templateId = 'DEPLOYER_V1';

  async verify(ctx: VerifierContext): Promise<VerifierResult> {
    const txHash = String(ctx.proof.txHash || '');

    const tx = txHash ? await ctx.provider.getTransaction(txHash) : null;
    const receipt = tx ? await ctx.provider.getTransactionReceipt(txHash) : null;

    // --- Gate: correct_sender ---
    const expectedSender = ctx.run.ownerWallet.toLowerCase();
    const actualSender = tx?.from ? tx.from.toLowerCase() : null;
    const senderMatch = Boolean(actualSender && actualSender === expectedSender);

    if (!senderMatch) {
      const checks: ScoredCheck[] = [
        scoredCheck('correct_sender', 0, 0, expectedSender, actualSender, 'Sender does not match. Entire score = 0.'),
        scoredCheck('deployment', 0, 25, 'status=1, contractAddress present', 'N/A', 'Blocked by sender mismatch.'),
        scoredCheck('spec_compliance', 0, 25, 'valid ERC-20 interface', 'N/A', 'Blocked by sender mismatch.'),
        scoredCheck('code_quality', 0, 20, 'bytecode > 200 bytes, transfer works', 'N/A', 'Blocked by sender mismatch.'),
        scoredCheck('gas_efficiency', 0, 15, '< 1M gas', 'N/A', 'Blocked by sender mismatch.'),
        scoredCheck('speed', 0, 15, '< 5 min', 'N/A', 'Blocked by sender mismatch.'),
      ];
      return { score: 0, passed: false, checks };
    }

    // --- Dimension 1: deployment (weight 25) ---
    const txConfirmed = Boolean(receipt && receipt.status === 1);
    const contractAddress = receipt?.contractAddress || null;

    let codeExists = false;
    if (contractAddress) {
      try {
        const code = await ctx.provider.getCode(contractAddress);
        codeExists = code !== '0x' && code.length > 2;
      } catch { /* RPC failure */ }
    }

    const deploymentAllPass = txConfirmed && !!contractAddress && codeExists;
    const deploymentScore = deploymentAllPass ? 100 : 0;

    let deploymentDetail: string;
    if (!txConfirmed) {
      deploymentDetail = receipt ? 'Transaction reverted onchain.' : 'Transaction receipt not found.';
    } else if (!contractAddress) {
      deploymentDetail = 'No contractAddress in receipt — not a deployment tx.';
    } else if (!codeExists) {
      deploymentDetail = 'Contract address has no code (self-destructed or empty).';
    } else {
      deploymentDetail = `Contract deployed at ${contractAddress}.`;
    }

    const deploymentCheck = scoredCheck(
      'deployment',
      deploymentScore,
      25,
      'status=1, contractAddress present, code exists',
      { status: receipt?.status ?? 'missing', contractAddress, codeExists },
      deploymentDetail,
    );

    // --- Dimension 2: spec_compliance (weight 25) ---
    let specScore = 0;
    let specDetail = 'Cannot evaluate spec without a deployed contract.';
    let specActual: Record<string, unknown> = {};

    if (contractAddress && codeExists) {
      const contract = new ethers.Contract(contractAddress, ERC20_ABI, ctx.provider);

      // name() — non-empty string = 25 pts
      try {
        const name: string = await contract.name();
        specActual['name'] = name;
        if (typeof name === 'string' && name.length > 0) {
          specScore += 25;
        }
      } catch {
        specActual['name'] = 'call_failed';
      }

      // symbol() — 3-6 characters = 25 pts
      try {
        const symbol: string = await contract.symbol();
        specActual['symbol'] = symbol;
        if (typeof symbol === 'string' && symbol.length >= 3 && symbol.length <= 6) {
          specScore += 25;
        }
      } catch {
        specActual['symbol'] = 'call_failed';
      }

      // decimals() — must be 18 = 25 pts
      try {
        const decimals: number = Number(await contract.decimals());
        specActual['decimals'] = decimals;
        if (decimals === 18) {
          specScore += 25;
        }
      } catch {
        specActual['decimals'] = 'call_failed';
      }

      // totalSupply() — between 1M * 10^18 and 100M * 10^18 = 25 pts
      try {
        const totalSupply: bigint = await contract.totalSupply();
        specActual['totalSupply'] = totalSupply.toString();
        const minSupply = 1_000_000n * (10n ** 18n);
        const maxSupply = 100_000_000n * (10n ** 18n);
        if (totalSupply >= minSupply && totalSupply <= maxSupply) {
          specScore += 25;
        }
      } catch {
        specActual['totalSupply'] = 'call_failed';
      }

      specDetail = `Spec sub-checks scored ${specScore}/100.`;
    }

    const specCheck = scoredCheck(
      'spec_compliance',
      specScore,
      25,
      'name non-empty, symbol 3-6 chars, decimals=18, totalSupply 1M-100M tokens',
      specActual,
      specDetail,
    );

    // --- Dimension 3: code_quality (weight 20) ---
    let codeQualityScore = 0;
    let codeQualityDetail = 'Cannot evaluate code quality without a deployed contract.';
    let codeQualityActual: Record<string, unknown> = {};

    if (contractAddress && codeExists) {
      // Bytecode > 200 bytes = 50 pts
      try {
        const code = await ctx.provider.getCode(contractAddress);
        const bytecodeLength = (code.length - 2) / 2; // subtract '0x', hex chars / 2
        codeQualityActual['bytecodeLength'] = bytecodeLength;
        if (bytecodeLength > 200) {
          codeQualityScore += 50;
        }
      } catch {
        codeQualityActual['bytecodeLength'] = 'check_failed';
      }

      // transfer(address,uint256) with 0 amount to self doesn't revert = 50 pts
      try {
        const contract = new ethers.Contract(contractAddress, ERC20_ABI, ctx.provider);
        // Use staticCall to simulate without sending a tx
        await contract.transfer.staticCall(expectedSender, 0n, { from: expectedSender });
        codeQualityScore += 50;
        codeQualityActual['transferWorks'] = true;
      } catch {
        codeQualityActual['transferWorks'] = false;
      }

      codeQualityDetail = `Code quality sub-checks scored ${codeQualityScore}/100.`;
    }

    const codeQualityCheck = scoredCheck(
      'code_quality',
      codeQualityScore,
      20,
      'bytecode > 200 bytes, transfer(0) succeeds',
      codeQualityActual,
      codeQualityDetail,
    );

    // --- Dimension 4: gas_efficiency (weight 15) ---
    let gasScore = 0;
    let gasDetail = 'Cannot evaluate gas without receipt.';
    let gasActual: unknown = 'unavailable';

    if (receipt?.gasUsed) {
      const gasUsed = Number(receipt.gasUsed);
      gasActual = gasUsed;

      if (gasUsed < 1_000_000) {
        gasScore = 100;
        gasDetail = `${gasUsed} gas — excellent (under 1M).`;
      } else if (gasUsed < 2_000_000) {
        gasScore = 80;
        gasDetail = `${gasUsed} gas — good (1M-2M).`;
      } else if (gasUsed < 3_000_000) {
        gasScore = 60;
        gasDetail = `${gasUsed} gas — acceptable (2M-3M).`;
      } else {
        gasScore = 30;
        gasDetail = `${gasUsed} gas — heavy (over 3M).`;
      }
    }

    const gasCheck = scoredCheck(
      'gas_efficiency',
      gasScore,
      15,
      '< 1M gas',
      gasActual,
      gasDetail,
    );

    // --- Dimension 5: speed (weight 15) ---
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
      const elapsedMin = elapsedMs / 60000;
      speedActual = `${Math.round(elapsedMin)} min`;

      if (elapsedMin < 5) {
        speedScore = 100;
        speedDetail = `${Math.round(elapsedMin)} min from start — excellent.`;
      } else if (elapsedMin < 15) {
        speedScore = 80;
        speedDetail = `${Math.round(elapsedMin)} min from start — good.`;
      } else if (elapsedMin < 30) {
        speedScore = 50;
        speedDetail = `${Math.round(elapsedMin)} min from start — acceptable.`;
      } else {
        speedScore = 20;
        speedDetail = `${Math.round(elapsedMin)} min from start — slow.`;
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
      15,
      '< 5 min',
      speedActual,
      speedDetail,
    );

    // --- Assemble result ---
    const checks: ScoredCheck[] = [
      deploymentCheck,
      specCheck,
      codeQualityCheck,
      gasCheck,
      speedCheck,
    ];

    const score = computeWeightedScore(checks);
    const passingScore = DEFAULT_PASSING_SCORE;

    return {
      score,
      passed: score >= passingScore,
      checks,
    };
  }
}
