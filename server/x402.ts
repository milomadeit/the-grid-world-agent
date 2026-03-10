import type { FastifyReply, FastifyRequest } from 'fastify';
import { decodePayment } from 'x402/schemes';
import { useFacilitator } from 'x402/verify';
import type { PaymentRequirements } from 'x402/types';
import { BASE_CHAIN_ID, TREASURY_ADDRESS } from './chain.js';

const X402_VERSION = 1;
const FACILITATOR_URL =
  (process.env.X402_FACILITATOR || 'https://x402.org/facilitator') as `${string}://${string}`;

const USDC_BASE_MAINNET = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const USDC_BASE_SEPOLIA = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

const entryFeeUsdc = Number(process.env.ENTRY_FEE_USDC || '0.10');
const entryFeeAtomic = BigInt(Math.max(1, Math.round(entryFeeUsdc * 1_000_000))).toString();
const facilitator = useFacilitator({ url: FACILITATOR_URL });

export interface X402Context {
  resource: string;
  description?: string;
  mimeType?: string;
  receiver?: string;
  maxAmountRequired?: string;
}

function x402Network(chainId: number): 'base' | 'base-sepolia' {
  return chainId === 8453 ? 'base' : 'base-sepolia';
}

function usdcByChain(chainId: number): string {
  return chainId === 8453
    ? (process.env.USDC_TOKEN || USDC_BASE_MAINNET)
    : (process.env.USDC_TOKEN || USDC_BASE_SEPOLIA);
}

export function getEntryFeeUsdcAtomic(): string {
  return entryFeeAtomic;
}

export function getXPaymentHeader(request: FastifyRequest): string | null {
  const value = request.headers['x-payment'];
  if (typeof value === 'string' && value.trim().length > 0) {
    return value;
  }
  if (Array.isArray(value) && value.length > 0) {
    return value[0] || null;
  }
  return null;
}

export function buildPaymentRequirements(ctx: X402Context): PaymentRequirements {
  return {
    scheme: 'exact',
    network: x402Network(BASE_CHAIN_ID),
    maxAmountRequired: ctx.maxAmountRequired || entryFeeAtomic,
    resource: ctx.resource,
    description: ctx.description || 'OpGrid entry fee',
    mimeType: ctx.mimeType || 'application/json',
    payTo: ctx.receiver || TREASURY_ADDRESS,
    maxTimeoutSeconds: 300,
    asset: usdcByChain(BASE_CHAIN_ID),
    extra: {
      name: BASE_CHAIN_ID === 8453 ? 'USD Coin' : 'USDC',
      version: '2',
    },
  };
}

export function paymentRequiredBody(ctx: X402Context): { x402Version: number; accepts: PaymentRequirements[] } {
  return {
    x402Version: X402_VERSION,
    accepts: [buildPaymentRequirements(ctx)],
  };
}

export async function sendX402PaymentRequired(
  reply: FastifyReply,
  ctx: X402Context
): Promise<FastifyReply> {
  const body = paymentRequiredBody(ctx);
  return reply
    .code(402)
    .header('X-PAYMENT-REQUIRED', JSON.stringify(body))
    .send(body);
}

export async function verifyAndSettleX402Payment(
  paymentHeader: string,
  ctx: X402Context
): Promise<{ ok: boolean; reason?: string; payer?: string; paymentResponseHeader?: string }> {
  try {
    const requirements = buildPaymentRequirements(ctx);
    const payload = decodePayment(paymentHeader);

    // Reject payments signed for a different network or scheme.
    if (payload.scheme !== requirements.scheme || payload.network !== requirements.network) {
      return { ok: false, reason: 'x402 payload network/scheme mismatch' };
    }

    const verifyResult = await facilitator.verify(payload, requirements);
    if (!verifyResult.isValid) {
      return { ok: false, reason: verifyResult.invalidReason || 'invalid_x402_payment', payer: verifyResult.payer };
    }

    const settleResult = await facilitator.settle(payload, requirements);
    if (!settleResult.success) {
      return { ok: false, reason: settleResult.errorReason || 'x402_settlement_failed', payer: settleResult.payer };
    }

    const paymentResponseHeader = Buffer.from(JSON.stringify(settleResult)).toString('base64');
    return { ok: true, payer: settleResult.payer, paymentResponseHeader };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: message };
  }
}
