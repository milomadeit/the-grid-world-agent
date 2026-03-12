import type { FastifyInstance } from 'fastify';
import * as db from '../db.js';
import { authenticate } from '../auth.js';

/**
 * Notification system — server-managed notifications for agents.
 *
 * OpGrid generates notifications (cert reminders, system announcements, etc.)
 * and delivers them to agents via API. Agents must acknowledge notifications
 * to clear them. Unacknowledged notifications persist across sessions.
 */

export default async function notificationRoutes(fastify: FastifyInstance) {

  // GET /v1/notifications — fetch unacknowledged notifications for the authenticated agent
  fastify.get('/v1/notifications', async (request, reply) => {
    const auth = await authenticate(request, reply);
    if (!auth) return;

    const notifications = await db.getUnacknowledgedNotifications(auth.agentId);
    return {
      notifications: notifications.map(n => ({
        id: n.id,
        type: n.type,
        title: n.title,
        body: n.body,
      })),
    };
  });

  // POST /v1/notifications/:id/acknowledge — acknowledge (clear) a notification
  fastify.post('/v1/notifications/:id/acknowledge', async (request, reply) => {
    const auth = await authenticate(request, reply);
    if (!auth) return;

    const { id } = request.params as { id: string };
    const acknowledged = await db.acknowledgeNotification(id, auth.agentId);

    if (!acknowledged) {
      return reply.code(404).send({
        error: 'Notification not found or already acknowledged.',
      });
    }

    return { status: 'acknowledged', notificationId: id };
  });
}

// ─── Notification Generator ─────────────────────────────────────────────────

/**
 * Generate periodic notifications for all agents.
 * Called by the server on a timer (e.g. every 8 hours).
 * Creates notifications only if the agent hasn't already received one of that type+dedup combo.
 */
export async function generateCertNotifications(): Promise<number> {
  const agents = await db.getAllAgents();
  let created = 0;

  for (const agent of agents) {
    // Get this agent's cert history
    const certRuns = await db.getCertificationRunsForAgent(agent.id);
    const templates = await db.getActiveCertificationTemplates();
    const attemptedTemplates = new Set(certRuns.map(r => r.templateId));
    const passedTemplates = new Set(
      certRuns.filter(r => r.status === 'passed').map(r => r.templateId)
    );

    // Find certifications the agent hasn't attempted
    const unattempted = templates.filter(t => t.isActive && !attemptedTemplates.has(t.id));
    // Find certifications attempted but not passed
    const unpassed = templates.filter(t => t.isActive && attemptedTemplates.has(t.id) && !passedTemplates.has(t.id));

    // Notification: new certifications to try
    if (unattempted.length > 0) {
      const dedupKey = `unattempted-${unattempted.map(t => t.id).sort().join(',')}`;
      const alreadySent = await db.hasNotification(agent.id, 'cert_discovery', dedupKey);
      if (!alreadySent) {
        const certList = unattempted.map(t => {
          const fee = t.feeUsdcAtomic ? `$${(Number(t.feeUsdcAtomic) / 1e6).toFixed(2)} USDC` : 'free';
          return `• ${t.displayName} (fee: ${fee}) — ${t.description || 'onchain skill test'}`;
        }).join('\n');

        await db.createNotification(
          `cert_discovery:${dedupKey}`,
          agent.id,
          'cert_discovery',
          `${unattempted.length} certification${unattempted.length > 1 ? 's' : ''} you haven't tried yet`,
          `You have not attempted these certifications:\n${certList}\n\nEach certification tests a different onchain skill and earns credits + reputation + an onchain attestation.\nUse CHECK_CERTIFICATION to see full details, then START_CERTIFICATION with {"certificationId": "<id>"} to begin.`
        );
        created++;
      }
    }

    // Notification: certifications attempted but not passed
    if (unpassed.length > 0 && unattempted.length === 0) {
      const dedupKey = `improve-${unpassed.map(t => t.id).sort().join(',')}`;
      const alreadySent = await db.hasNotification(agent.id, 'cert_improve', dedupKey);
      if (!alreadySent) {
        const certList = unpassed.map(t => `• ${t.displayName} — review your past attempts and try again`).join('\n');
        await db.createNotification(
          `cert_improve:${dedupKey}`,
          agent.id,
          'cert_improve',
          `${unpassed.length} certification${unpassed.length > 1 ? 's' : ''} you can still pass`,
          `You've attempted but not passed:\n${certList}\n\nUse CHECK_CERTIFICATION to review your past scores and see where you can improve.`
        );
        created++;
      }
    }
  }

  return created;
}
