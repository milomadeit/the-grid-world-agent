import type { FastifyRequest, FastifyReply } from 'fastify';
import jwt from 'jsonwebtoken';
import { ethers } from 'ethers';

const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-opgrid-key-123';

// --- JWT Session Management ---

export function generateToken(agentId: string): string {
  return jwt.sign({ agentId }, JWT_SECRET, { expiresIn: '24h' });
}

export function verifyToken(token: string): { agentId: string } | null {
  try {
    return jwt.verify(token, JWT_SECRET) as { agentId: string };
  } catch {
    return null;
  }
}

export async function authenticate(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<{ agentId: string } | undefined> {
  const auth = request.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    reply.code(401).send({ error: 'Missing or invalid authorization header' });
    return;
  }

  const token = auth.slice(7);
  const payload = verifyToken(token);
  if (!payload) {
    reply.code(401).send({ error: 'Invalid or expired token' });
    return;
  }

  return payload;
}

// --- Signed Wallet Authentication ---

const AUTH_MESSAGE_PREFIX = 'Enter OpGrid';
const MAX_TIMESTAMP_AGE_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Generate the message that an agent must sign to authenticate.
 * The agent signs this locally with their private key.
 */
export function generateAuthMessage(timestamp: string): string {
  return `${AUTH_MESSAGE_PREFIX}\nTimestamp: ${timestamp}`;
}

/**
 * Recover the wallet address from a signed auth message.
 * Returns the checksummed address or null if invalid.
 */
export function recoverWallet(signature: string, timestamp: string): string | null {
  try {
    const message = generateAuthMessage(timestamp);
    const recovered = ethers.verifyMessage(message, signature);
    return recovered; // checksummed address
  } catch {
    return null;
  }
}

/**
 * Validate that a timestamp is recent enough (within 5 minutes).
 */
export function isTimestampValid(timestamp: string): boolean {
  try {
    const ts = new Date(timestamp).getTime();
    if (isNaN(ts)) return false;
    const age = Date.now() - ts;
    return age >= 0 && age <= MAX_TIMESTAMP_AGE_MS;
  } catch {
    return false;
  }
}
