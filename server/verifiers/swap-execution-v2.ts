import { ethers } from 'ethers';
import type { Log } from 'ethers';
import type { ScoredCheck, CertificationVerifier, VerifierContext, VerifierResult } from './types.js';

const ERC20_TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)').toLowerCase();
const DEFAULT_MAX_GAS_LIMIT = 500000;
const DEFAULT_EXPECTED_GAS = 130000;
const DEFAULT_PASSING_SCORE = 70;

// V2 minimum USDC input: 5 USDC = 5_000_000 atomic (6 decimals)
const MIN_USDC_FULL = 5_000_000n;
const MIN_USDC_ONE = 1_000_000n;

interface SwapExecutionConfig {
  allowedTokenPairs: Array<[string, string]>;
  maxGasLimit: number;
  expectedGas: number;
  passingScore: number;
}

interface TransferEvent {
  token: string;
  from: string;
  to: string;
  value: bigint;
}

function toAddress(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (!/^0x[a-fA-F0-9]{40}$/.test(value)) return null;
  return value.toLowerCase();
}

function normalizeConfig(config: Record<string, unknown>): SwapExecutionConfig {
  const allowedTokenPairs: Array<[string, string]> = [];
  if (Array.isArray(config.allowedTokenPairs)) {
    for (const pair of config.allowedTokenPairs) {
      if (!Array.isArray(pair) || pair.length !== 2) continue;
      const tokenA = toAddress(pair[0]);
      const tokenB = toAddress(pair[1]);
      if (!tokenA || !tokenB) continue;
      allowedTokenPairs.push([tokenA, tokenB]);
    }
  }

  return {
    allowedTokenPairs,
    maxGasLimit:
      typeof config.maxGasLimit === 'number' && Number.isFinite(config.maxGasLimit)
        ? Math.max(1, Math.trunc(config.maxGasLimit))
        : DEFAULT_MAX_GAS_LIMIT,
    expectedGas:
      typeof config.expectedGas === 'number' && Number.isFinite(config.expectedGas)
        ? Math.max(1, Math.trunc(config.expectedGas))
        : DEFAULT_EXPECTED_GAS,
    passingScore:
      typeof config.passingScore === 'number' && Number.isFinite(config.passingScore)
        ? Math.max(0, Math.min(100, Math.trunc(config.passingScore)))
        : DEFAULT_PASSING_SCORE,
  };
}

function decodeTopicAddress(topic: string | undefined): string | null {
  if (!topic || !topic.startsWith('0x') || topic.length !== 66) return null;
  return `0x${topic.slice(26)}`.toLowerCase();
}

function parseTransferEvents(logs: readonly Log[]): TransferEvent[] {
  const transfers: TransferEvent[] = [];

  for (const log of logs) {
    if ((log.topics?.[0] || '').toLowerCase() !== ERC20_TRANSFER_TOPIC) continue;
    const from = decodeTopicAddress(log.topics[1]);
    const to = decodeTopicAddress(log.topics[2]);
    if (!from || !to) continue;

    let value = 0n;
    try {
      value = BigInt(log.data);
    } catch {
      continue;
    }

    transfers.push({
      token: log.address.toLowerCase(),
      from,
      to,
      value,
    });
  }

  return transfers;
}

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

export class SwapExecutionV2Verifier implements CertificationVerifier {
  templateId = 'SWAP_EXECUTION_V2';

  async verify(ctx: VerifierContext): Promise<VerifierResult> {
    const config = normalizeConfig(ctx.template.config);
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
        scoredCheck('execution', 0, 20, 'status=1', 'N/A', 'Blocked by sender mismatch.'),
        scoredCheck('route_validity', 0, 15, 'correct token pair', 'N/A', 'Blocked by sender mismatch.'),
        scoredCheck('slippage_management', 0, 30, 'slippage protection', 'N/A', 'Blocked by sender mismatch.'),
        scoredCheck('gas_efficiency', 0, 15, `<= ${config.expectedGas}`, 'N/A', 'Blocked by sender mismatch.'),
        scoredCheck('speed', 0, 10, '< 3 min', 'N/A', 'Blocked by sender mismatch.'),
        scoredCheck('amount', 0, 10, '>= 5 USDC', 'N/A', 'Blocked by sender mismatch.'),
      ];
      return { score: 0, passed: false, checks };
    }

    // --- Dimension 1: execution (weight 20) ---
    const txConfirmed = Boolean(receipt && receipt.status === 1);
    const executionScore = txConfirmed ? 100 : 0;
    const executionCheck = scoredCheck(
      'execution',
      executionScore,
      20,
      'status=1',
      receipt ? `status=${receipt.status}` : 'receipt_missing',
      txConfirmed ? 'Tx confirmed.' : (receipt ? 'Transaction reverted onchain.' : 'Transaction receipt not found.'),
    );

    // --- Parse transfer events ---
    const transfers = receipt ? parseTransferEvents(receipt.logs) : [];
    const transferTokenSet = new Set(transfers.map((e) => e.token));

    // --- Dimension 2: route_validity (weight 15) ---
    let routeScore = 0;
    let routeDetail = 'No transfer events detected.';
    let routeActual: unknown = Array.from(transferTokenSet.values());

    if (transfers.length > 0) {
      const pairMatched = config.allowedTokenPairs.some(([tokenA, tokenB]) =>
        transferTokenSet.has(tokenA) && transferTokenSet.has(tokenB),
      );
      const oneTokenMatched = config.allowedTokenPairs.some(([tokenA, tokenB]) =>
        transferTokenSet.has(tokenA) || transferTokenSet.has(tokenB),
      );

      if (pairMatched) {
        routeScore = 100;
        routeDetail = 'Correct token pair transferred.';
      } else if (oneTokenMatched) {
        routeScore = 50;
        routeDetail = 'Only one expected token detected in transfers.';
      } else {
        routeScore = 0;
        routeDetail = 'Wrong tokens transferred.';
      }
      routeActual = Array.from(transferTokenSet.values());
    }

    const routeCheck = scoredCheck(
      'route_validity',
      routeScore,
      15,
      config.allowedTokenPairs,
      routeActual,
      routeDetail,
    );

    // --- Dimension 3: slippage_management (weight 30) — KEY V2 DIFFERENCE ---
    // In V2, slippage is weighted 30 (up from 20) and has stricter scoring.
    // amountOutMinimum of 0 or 1 is an auto-fail.
    // Agent MUST score >= 50 on this dimension or the entire cert fails.
    let slippageScore = 0;
    let slippageDetail = 'Cannot evaluate slippage without transaction.';
    let slippageActual: unknown = 'unavailable';

    if (tx && receipt && txConfirmed) {
      const decoded = decodeSwapCalldata(tx.data, tx.value);

      if (!decoded) {
        // Can't decode calldata — no leniency in V2
        slippageScore = 0;
        slippageDetail = 'Swap calldata not decoded — V2 requires verifiable slippage protection.';
        slippageActual = { note: 'calldata_not_decoded' };
      } else if (decoded.amountOutMinimum <= 1n) {
        // amountOutMinimum is 0 or 1 → auto-fail for V2
        slippageScore = 0;
        slippageDetail = 'No slippage protection — auto-fail for V2.';
        slippageActual = {
          amountOutMinimum: decoded.amountOutMinimum.toString(),
          mode: decoded.mode,
        };
      } else {
        // Compute actual tolerance in basis points
        const actualOutput = sumTransfersForToken(transfers, decoded.tokenOut, expectedSender);

        if (actualOutput > 0n && actualOutput >= decoded.amountOutMinimum) {
          const toleranceBps = Number(
            ((actualOutput - decoded.amountOutMinimum) * 10000n) / actualOutput,
          );

          if (toleranceBps <= 50) {
            slippageScore = 100;
            slippageDetail = `${toleranceBps} bps tolerance — excellent.`;
          } else if (toleranceBps <= 100) {
            slippageScore = 90;
            slippageDetail = `${toleranceBps} bps tolerance — very good.`;
          } else if (toleranceBps <= 200) {
            slippageScore = 70;
            slippageDetail = `${toleranceBps} bps tolerance — acceptable.`;
          } else if (toleranceBps <= 500) {
            slippageScore = 50;
            slippageDetail = `${toleranceBps} bps tolerance — marginal.`;
          } else {
            slippageScore = 0;
            slippageDetail = `${toleranceBps} bps tolerance — excessive slippage, auto-fail.`;
          }

          slippageActual = {
            mode: decoded.mode,
            amountOutMinimum: decoded.amountOutMinimum.toString(),
            actualOutput: actualOutput.toString(),
            toleranceBps,
          };
        } else if (actualOutput > 0n) {
          // Output below minimum — the swap still landed somehow
          slippageScore = 0;
          slippageDetail = 'Actual output below amountOutMinimum — fail.';
          slippageActual = {
            mode: decoded.mode,
            amountOutMinimum: decoded.amountOutMinimum.toString(),
            actualOutput: actualOutput.toString(),
          };
        } else {
          slippageScore = 0;
          slippageDetail = 'No output tokens detected for slippage analysis.';
          slippageActual = { mode: decoded.mode, tokenOut: decoded.tokenOut };
        }
      }
    } else if (tx && receipt) {
      slippageDetail = 'Transaction reverted — cannot evaluate slippage.';
      slippageActual = 'tx_reverted';
    }

    const slippageCheck = scoredCheck(
      'slippage_management',
      slippageScore,
      30,
      'slippage protection (0-50 bps ideal, must score >= 50)',
      slippageActual,
      slippageDetail,
    );

    // --- Dimension 4: gas_efficiency (weight 15) — tighter thresholds for V2 ---
    let gasScore = 0;
    let gasDetail = 'Cannot evaluate gas without receipt.';
    let gasActual: unknown = 'unavailable';

    if (receipt?.gasUsed) {
      const gasUsed = Number(receipt.gasUsed);
      gasActual = gasUsed;

      if (gasUsed <= 130000) {
        gasScore = 100;
        gasDetail = `${gasUsed} gas — excellent (under 130k).`;
      } else if (gasUsed <= 150000) {
        gasScore = 80;
        gasDetail = `${gasUsed} gas — good (130-150k).`;
      } else if (gasUsed <= 200000) {
        gasScore = 60;
        gasDetail = `${gasUsed} gas — acceptable (150-200k).`;
      } else {
        gasScore = 30;
        gasDetail = `${gasUsed} gas — high (over 200k).`;
      }
    }

    const gasCheck = scoredCheck(
      'gas_efficiency',
      gasScore,
      15,
      '<= 130k gas',
      gasActual,
      gasDetail,
    );

    // --- Dimension 5: speed (weight 10) — tighter thresholds for V2 ---
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

      if (elapsedMin < 3) {
        speedScore = 100;
        speedDetail = `${Math.round(elapsedMin)} min from start — excellent.`;
      } else if (elapsedMin < 5) {
        speedScore = 80;
        speedDetail = `${Math.round(elapsedMin)} min from start — good.`;
      } else if (elapsedMin < 10) {
        speedScore = 50;
        speedDetail = `${Math.round(elapsedMin)} min from start — acceptable.`;
      } else {
        speedScore = 20;
        speedDetail = `${Math.round(elapsedMin)} min from start — slow.`;
      }

      // Check deadline
      if (blockTimestampMs > ctx.run.deadlineAt) {
        speedScore = 0;
        speedDetail = `Transaction mined after deadline.`;
      }
    }

    const speedCheck = scoredCheck(
      'speed',
      speedScore,
      10,
      '< 3 min',
      speedActual,
      speedDetail,
    );

    // --- Dimension 6: amount (weight 10, NEW in V2) ---
    // Check USDC input amount. Must be >= 5 USDC (5_000_000 atomic).
    let amountScore = 0;
    let amountDetail = 'Cannot evaluate amount without transaction.';
    let amountActual: unknown = 'unavailable';

    if (tx && receipt && txConfirmed) {
      const decoded = decodeSwapCalldata(tx.data, tx.value);

      if (decoded) {
        // Sum input token transfers FROM the sender
        const inputAmount = sumTransfersFromSender(transfers, decoded.tokenIn, expectedSender);
        amountActual = inputAmount.toString();

        if (inputAmount >= MIN_USDC_FULL) {
          amountScore = 100;
          amountDetail = `Input amount ${formatUsdc(inputAmount)} USDC — meets 5 USDC minimum.`;
        } else if (inputAmount >= MIN_USDC_ONE) {
          amountScore = 50;
          amountDetail = `Input amount ${formatUsdc(inputAmount)} USDC — below 5 USDC minimum (partial credit).`;
        } else {
          amountScore = 0;
          amountDetail = `Input amount ${formatUsdc(inputAmount)} USDC — below 1 USDC minimum.`;
        }
      } else {
        // Try to detect input from transfer events if calldata wasn't decoded
        // Look for the first token in allowedTokenPairs as likely input
        const possibleInputTokens = config.allowedTokenPairs.map(([a]) => a);
        let maxInput = 0n;
        for (const token of possibleInputTokens) {
          const amount = sumTransfersFromSender(transfers, token, expectedSender);
          if (amount > maxInput) maxInput = amount;
        }

        if (maxInput > 0n) {
          amountActual = maxInput.toString();
          if (maxInput >= MIN_USDC_FULL) {
            amountScore = 100;
            amountDetail = `Input amount ${formatUsdc(maxInput)} USDC (from transfers) — meets 5 USDC minimum.`;
          } else if (maxInput >= MIN_USDC_ONE) {
            amountScore = 50;
            amountDetail = `Input amount ${formatUsdc(maxInput)} USDC (from transfers) — below 5 USDC minimum.`;
          } else {
            amountScore = 0;
            amountDetail = `Input amount ${formatUsdc(maxInput)} USDC (from transfers) — below 1 USDC minimum.`;
          }
        } else {
          amountScore = 0;
          amountDetail = 'Could not determine input amount.';
        }
      }
    } else if (tx && receipt) {
      amountDetail = 'Transaction reverted — cannot evaluate amount.';
      amountActual = 'tx_reverted';
    }

    const amountCheck = scoredCheck(
      'amount',
      amountScore,
      10,
      '>= 5 USDC (5000000 atomic)',
      amountActual,
      amountDetail,
    );

    // --- Assemble result ---
    const checks: ScoredCheck[] = [
      executionCheck,
      routeCheck,
      slippageCheck,
      gasCheck,
      speedCheck,
      amountCheck,
    ];

    const score = computeWeightedScore(checks);

    // V2 hard gate: slippage_management must score >= 50 independently,
    // regardless of the overall weighted score.
    const slippageGateFailed = slippageCheck.score < 50;

    const passed = score >= config.passingScore && !slippageGateFailed;

    // If slippage gate caused failure, annotate
    if (slippageGateFailed && score >= config.passingScore) {
      slippageCheck.detail = (slippageCheck.detail || '') +
        ' [V2 HARD GATE: slippage_management < 50 — entire certification failed]';
    }

    return {
      score,
      passed,
      checks,
    };
  }
}

// ---- Calldata decoding helpers ----

const MAX_DECODE_DEPTH = 3;

const swapRouterInterface = new ethers.Interface([
  'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
  'function exactInput((bytes path,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum) params) payable returns (uint256 amountOut)',
  'function exactOutputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountOut,uint256 amountInMaximum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountIn)',
  'function exactOutput((bytes path,address recipient,uint256 deadline,uint256 amountOut,uint256 amountInMaximum) params) payable returns (uint256 amountIn)',
  'function multicall(bytes[] data) payable returns (bytes[] results)',
  'function multicall(uint256 deadline,bytes[] data) payable returns (bytes[] results)',
]);

const swapRouter02Interface = new ethers.Interface([
  'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
  'function exactInput((bytes path,address recipient,uint256 amountIn,uint256 amountOutMinimum) params) payable returns (uint256 amountOut)',
  'function exactOutputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountOut,uint256 amountInMaximum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountIn)',
  'function exactOutput((bytes path,address recipient,uint256 amountOut,uint256 amountInMaximum) params) payable returns (uint256 amountIn)',
  'function multicall(bytes[] data) payable returns (bytes[] results)',
  'function multicall(uint256 deadline,bytes[] data) payable returns (bytes[] results)',
]);

interface DecodedSwap {
  mode: string;
  tokenIn: string;
  tokenOut: string;
  recipient: string;
  amountOutMinimum: bigint;
}

function decodeUniswapV3Path(path: string): string[] {
  if (!path.startsWith('0x')) return [];
  const hex = path.slice(2);
  if (hex.length < 40) return [];

  const tokens: string[] = [];
  let cursor = 0;
  tokens.push(`0x${hex.slice(cursor, cursor + 40)}`.toLowerCase());
  cursor += 40;

  while (cursor < hex.length) {
    if (cursor + 6 > hex.length) break;
    cursor += 6; // fee
    if (cursor + 40 > hex.length) break;
    tokens.push(`0x${hex.slice(cursor, cursor + 40)}`.toLowerCase());
    cursor += 40;
  }

  return tokens;
}

function decodeSwapCalldata(data: string, value: bigint, depth = 0): DecodedSwap | null {
  if (depth > MAX_DECODE_DEPTH) return null;

  let parsed: ethers.TransactionDescription | null = null;
  try {
    parsed = swapRouterInterface.parseTransaction({ data, value });
  } catch { /* V1 ABI didn't match */ }
  if (!parsed) {
    try {
      parsed = swapRouter02Interface.parseTransaction({ data, value });
    } catch { /* V2 ABI didn't match either */ }
  }
  if (!parsed) return null;

  try {
    if (parsed.name === 'multicall') {
      const rawCalls = parsed.args?.[parsed.args.length - 1];
      const calls = Array.isArray(rawCalls) ? rawCalls : [];
      for (const callData of calls) {
        if (typeof callData !== 'string') continue;
        const decoded = decodeSwapCalldata(callData, 0n, depth + 1);
        if (decoded) return decoded;
      }
      return null;
    }

    if (parsed.name === 'exactInputSingle') {
      const params = parsed.args?.[0] as any;
      if (!params) return null;
      const tokenIn = toAddress(params.tokenIn);
      const tokenOut = toAddress(params.tokenOut);
      const recipient = toAddress(params.recipient);
      if (!tokenIn || !tokenOut || !recipient) return null;
      return {
        mode: 'exactInputSingle',
        tokenIn,
        tokenOut,
        recipient,
        amountOutMinimum: params.amountOutMinimum != null ? BigInt(params.amountOutMinimum) : 0n,
      };
    }

    if (parsed.name === 'exactInput') {
      const params = parsed.args?.[0] as any;
      if (!params || typeof params.path !== 'string') return null;
      const recipient = toAddress(params.recipient);
      const pathTokens = decodeUniswapV3Path(params.path);
      if (!recipient || pathTokens.length < 2) return null;
      return {
        mode: 'exactInput',
        tokenIn: pathTokens[0],
        tokenOut: pathTokens[pathTokens.length - 1],
        recipient,
        amountOutMinimum: params.amountOutMinimum != null ? BigInt(params.amountOutMinimum) : 0n,
      };
    }

    if (parsed.name === 'exactOutputSingle') {
      const params = parsed.args?.[0] as any;
      if (!params) return null;
      const tokenIn = toAddress(params.tokenIn);
      const tokenOut = toAddress(params.tokenOut);
      const recipient = toAddress(params.recipient);
      if (!tokenIn || !tokenOut || !recipient) return null;
      return {
        mode: 'exactOutputSingle',
        tokenIn,
        tokenOut,
        recipient,
        amountOutMinimum: params.amountOut != null ? BigInt(params.amountOut) : 0n,
      };
    }

    if (parsed.name === 'exactOutput') {
      const params = parsed.args?.[0] as any;
      if (!params || typeof params.path !== 'string') return null;
      const recipient = toAddress(params.recipient);
      const pathTokens = decodeUniswapV3Path(params.path);
      if (!recipient || pathTokens.length < 2) return null;
      return {
        mode: 'exactOutput',
        tokenIn: pathTokens[pathTokens.length - 1],
        tokenOut: pathTokens[0],
        recipient,
        amountOutMinimum: params.amountOut != null ? BigInt(params.amountOut) : 0n,
      };
    }

    return null;
  } catch {
    return null;
  }
}

function sumTransfersForToken(transfers: TransferEvent[], token: string, recipient: string): bigint {
  // Try exact recipient first
  let sum = transfers
    .filter((e) => e.token === token && e.to === recipient)
    .reduce((s, e) => s + e.value, 0n);

  // Fallback: aggregate all transfers of this token (for contract routing)
  if (sum === 0n) {
    sum = transfers
      .filter((e) => e.token === token)
      .reduce((s, e) => s + e.value, 0n);
  }

  return sum;
}

function sumTransfersFromSender(transfers: TransferEvent[], token: string, sender: string): bigint {
  // Sum transfers of the given token FROM the sender
  let sum = transfers
    .filter((e) => e.token === token && e.from === sender)
    .reduce((s, e) => s + e.value, 0n);

  // Fallback: aggregate all outgoing transfers of this token
  if (sum === 0n) {
    sum = transfers
      .filter((e) => e.token === token)
      .reduce((s, e) => s + e.value, 0n);
  }

  return sum;
}

function formatUsdc(atomic: bigint): string {
  const whole = atomic / 1_000_000n;
  const frac = atomic % 1_000_000n;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(6, '0').replace(/0+$/, '');
  return `${whole}.${fracStr}`;
}
