import type { FastifyRequest, FastifyReply } from 'fastify';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-The Grid-key-123';

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
