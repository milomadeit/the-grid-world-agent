import type { FastifyInstance } from 'fastify';
import { ReputationFeedbackSchema } from '../types.js';
import * as db from '../db.js';
import { authenticate } from '../auth.js';

export async function registerReputationRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /v1/reputation/feedback — submit feedback
  fastify.post('/v1/reputation/feedback', async (request, reply) => {
    const auth = await authenticate(request, reply);
    if (!auth) return;

    const parsed = ReputationFeedbackSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Invalid request body',
        details: parsed.error.issues
      });
    }

    const { targetAgentId, value, valueDecimals, tag1, tag2, feedbackURI } = parsed.data;

    try {
      const feedback = await db.giveFeedback(
        auth.agentId,
        targetAgentId,
        value,
        valueDecimals,
        tag1,
        tag2,
        feedbackURI
      );

      return { success: true, feedback };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to submit feedback';
      return reply.code(400).send({ error: message });
    }
  });

  // GET /v1/reputation/:agentId — get reputation summary
  fastify.get<{ Params: { agentId: string }; Querystring: { tag1?: string; tag2?: string } }>(
    '/v1/reputation/:agentId',
    async (request) => {
      const { agentId } = request.params;
      const { tag1, tag2 } = request.query;

      const summary = await db.getReputationSummary(agentId, tag1, tag2);
      return { agentId, ...summary };
    }
  );

  // GET /v1/reputation/:agentId/feedback — get all feedback for agent
  fastify.get<{ Params: { agentId: string }; Querystring: { includeRevoked?: string } }>(
    '/v1/reputation/:agentId/feedback',
    async (request) => {
      const { agentId } = request.params;
      const includeRevoked = request.query.includeRevoked === 'true';

      const feedback = await db.getFeedbackForAgent(agentId, includeRevoked);
      return { agentId, feedback };
    }
  );

  // POST /v1/reputation/:feedbackId/revoke — revoke feedback
  fastify.post<{ Params: { feedbackId: string } }>(
    '/v1/reputation/:feedbackId/revoke',
    async (request, reply) => {
      const auth = await authenticate(request, reply);
      if (!auth) return;

      const feedbackId = parseInt(request.params.feedbackId, 10);
      if (isNaN(feedbackId)) {
        return reply.code(400).send({ error: 'Invalid feedback ID' });
      }

      const revoked = await db.revokeFeedback(auth.agentId, feedbackId);
      if (!revoked) {
        return reply.code(404).send({ error: 'Feedback not found or not owned by you' });
      }

      return { success: true };
    }
  );
}
