import type { FastifyRequest, FastifyReply } from 'fastify';
import jwt from 'jsonwebtoken';
import { ethers } from 'ethers';
import * as db from './db.js';

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET is required');
  }
  return secret;
}

// --- JWT Session Management ---

export interface AuthTokenPayload {
  agentId: string;
  ownerId: string; // wallet address used at entry time
}

export function generateToken(agentId: string, ownerId: string): string {
  return jwt.sign(
    { agentId, ownerId: ownerId.toLowerCase() },
    getJwtSecret(),
    { expiresIn: '24h' }
  );
}

export function verifyToken(token: string): AuthTokenPayload | null {
  try {
    const decoded = jwt.verify(token, getJwtSecret()) as Partial<AuthTokenPayload>;
    if (
      typeof decoded?.agentId !== 'string' ||
      typeof decoded?.ownerId !== 'string'
    ) {
      return null;
    }

    return {
      agentId: decoded.agentId,
      ownerId: decoded.ownerId.toLowerCase(),
    };
  } catch {
    return null;
  }
}

export async function authenticate(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<AuthTokenPayload | undefined> {
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

  // Enforce JWT->agent owner binding.
  const agent = await db.getAgent(payload.agentId);
  if (!agent) {
    reply.code(401).send({ error: 'Agent not found for token' });
    return;
  }

  const tokenOwner = payload.ownerId.toLowerCase();
  const agentOwner = (agent.ownerId || '').toLowerCase();
  if (!agentOwner || tokenOwner !== agentOwner) {
    reply.code(401).send({ error: 'Token owner does not match agent owner' });
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
