import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'crypto';
import { authenticate, generateToken } from '../auth.js';
import {
  EnterWorldWithIdentitySchema,
  ActionRequestSchema,
  type EnterWorldWithIdentity,
  type ActionRequest,
  type Agent
} from '../types.js';
import * as db from '../db.js';
import { getWorldManager } from '../world.js';
import { verifyAgentOwnership, isChainInitialized } from '../chain.js';
import { lookupAgent, getAgentReputation, isAgent0Ready } from '../agent0.js';



export async function registerAgentRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /v1/agents/enter - Register/Enter World (with optional ERC-8004 identity)
  fastify.post<{ Body: EnterWorldWithIdentity }>(
    '/v1/agents/enter',
    async (request, reply) => {
      const parsed = EnterWorldWithIdentitySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: 'Invalid request body',
          details: parsed.error.issues
        });
      }

      const { ownerId, visuals, erc8004, bio } = parsed.data;

      // ERC-8004 identity is required for non-spawner agents
      const isSpawnerAgent = ownerId.startsWith('spawner_');
      if (!erc8004 && !isSpawnerAgent) {
        return reply.code(400).send({
          error: 'ERC-8004 agent identity required to enter MonWorld. Register at https://www.8004.org'
        });
      }

      // Verify ERC-8004 identity on-chain if provided
      let erc8004Verified = false;
      if (erc8004 && isChainInitialized()) {
        try {
          const { verified, owner, agentWallet } = await verifyAgentOwnership(
            erc8004.agentId,
            ownerId
          );
          if (!verified) {
            return reply.code(403).send({
              error: 'Your wallet does not own or control this agent identity.',
              details: { tokenOwner: owner, agentWallet, yourWallet: ownerId }
            });
          }
          erc8004Verified = true;
          console.log(`[ERC-8004] Verified agent #${erc8004.agentId} for wallet ${ownerId}`);
        } catch (error: any) {
          // Token doesn't exist or contract call failed
          const message = error?.message || 'Unknown error';
          if (message.includes('ERC721NonexistentToken') || message.includes('nonexistent')) {
            return reply.code(400).send({
              error: `Agent ID ${erc8004.agentId} not found on-chain.`
            });
          }
          console.error(`[ERC-8004] Verification error:`, error);
          return reply.code(400).send({
            error: 'Failed to verify agent identity on-chain.',
            details: message
          });
        }
      }

      // Enrich with on-chain metadata from Agent0 subgraph
      let onChainName: string | undefined;
      let onChainBio: string | undefined;
      let reputationScore = 0;
      if (erc8004 && isAgent0Ready()) {
        try {
          const agentMeta = await lookupAgent(erc8004.agentId);
          if (agentMeta) {
            onChainName = agentMeta.name || undefined;
            onChainBio = agentMeta.description || undefined;
            console.log(`[Agent0] Enriched agent #${erc8004.agentId}: name="${onChainName}"`);
          }
          const rep = await getAgentReputation(erc8004.agentId);
          reputationScore = rep.averageValue;
        } catch (err) {
          console.warn('[Agent0] Metadata enrichment failed (non-blocking):', err);
        }
      }

      // Check if agent already exists for this owner
      const existingAgent = await db.getAgentByOwnerId(ownerId);

      if (existingAgent) {
        // Generate new token for existing session
        const token = generateToken(existingAgent.id);

        // Ensure agent is in world manager memory
        const world = getWorldManager();
        if (!world.getAgent(existingAgent.id)) {
          world.addAgent(existingAgent);
        }

        // Update existing agent with any new ERC-8004 or bio data
        if (erc8004 || bio) {
          await db.createAgent({
            ...existingAgent,
            erc8004AgentId: erc8004?.agentId,
            erc8004Registry: erc8004?.agentRegistry,
            bio: bio || existingAgent.bio,
          });
        }

        const ext = existingAgent as any;
        return {
          agentId: existingAgent.id,
          position: { x: existingAgent.position.x, z: existingAgent.position.z },
          token,
          skillUrl: `${request.protocol}://${request.hostname}/v1/skill`,
          erc8004: erc8004 ? {
            agentId: erc8004.agentId,
            agentRegistry: erc8004.agentRegistry,
            verified: erc8004Verified
          } : ext.erc8004AgentId ? {
            agentId: ext.erc8004AgentId,
            agentRegistry: ext.erc8004Registry,
            verified: true // previously verified
          } : undefined
        };
      }

      // Generate unique agent ID
      const agentId = `agent_${randomUUID().slice(0, 8)}`;

      // Random spawn position (within a reasonable range)
      const spawnX = (Math.random() - 0.5) * 20;
      const spawnZ = (Math.random() - 0.5) * 20;

      const agent: Agent = {
        id: agentId,
        name: onChainName || visuals?.name || ownerId,
        color: visuals?.color || '#6b7280',
        position: { x: spawnX, y: 0, z: spawnZ },
        targetPosition: { x: spawnX, y: 0, z: spawnZ },
        status: 'idle',
        inventory: { wood: 0, stone: 0, gold: 0 },
        ownerId,
        bio: bio || onChainBio
      };

      // Save to database (with optional ERC-8004 fields)
      await db.createAgent({
        ...agent,
        erc8004AgentId: erc8004?.agentId,
        erc8004Registry: erc8004?.agentRegistry,
        bio,
      });

      // Add to world manager
      const world = getWorldManager();
      world.addAgent(agent);

      // Generate auth token
      const token = generateToken(agentId);

        return {
        agentId,
        position: { x: spawnX, z: spawnZ },
        token,
        skillUrl: `${request.protocol}://${request.hostname}/v1/skill`,
        erc8004: erc8004 ? {
          agentId: erc8004.agentId,
          agentRegistry: erc8004.agentRegistry,
          verified: erc8004Verified
        } : undefined
      };
    }
  );

  // POST /v1/agents/action - Submit Action
  fastify.post<{ Body: ActionRequest }>(
    '/v1/agents/action',
    async (request, reply) => {
      const auth = await authenticate(request, reply);
      if (!auth) return;

      const parsed = ActionRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: 'Invalid request body',
          details: parsed.error.issues
        });
      }

      const { action, payload } = parsed.data;
      const world = getWorldManager();
      const tick = world.getCurrentTick();

      try {
        switch (action) {
          case 'MOVE': {
            const { x, z } = payload as { x: number; z: number };
            if (typeof x !== 'number' || typeof z !== 'number') {
              return reply.code(400).send({ error: 'MOVE requires x and z coordinates' });
            }

            // Queue movement action
            world.queueAction(auth.agentId, {
              type: 'MOVE',
              targetPosition: { x, y: 0, z }
            });

            return { status: 'queued', tick };
          }

          case 'CHAT': {
            const { message } = payload as { message: string };
            if (typeof message !== 'string') {
              return reply.code(400).send({ error: 'CHAT requires a message' });
            }

            world.broadcastChat(auth.agentId, message);
            return { status: 'executed', tick };
          }

          case 'COLLECT':
          case 'BUILD': {
            // Queue for next simulation tick
            world.queueAction(auth.agentId, { type: action, ...payload });
            return { status: 'queued', tick };
          }

          default:
            return reply.code(400).send({ error: `Unknown action: ${action}` });
        }
      } catch (error) {
        console.error('[Action Error]:', error);
        return reply.code(500).send({
          status: 'failed',
          tick,
          message: 'Failed to process action'
        });
      }
    }
  );

  // GET /v1/world/state - Query World State
  fastify.get<{
    Querystring: { radius?: string; center_x?: string; center_z?: string }
  }>('/v1/world/state', async (request) => {
    const radius = parseFloat(request.query.radius || '100');
    const centerX = parseFloat(request.query.center_x || '0');
    const centerZ = parseFloat(request.query.center_z || '0');

    const world = getWorldManager();
    const tick = world.getCurrentTick();

    // Get agents within radius
    const agents = await db.getAgentsInRadius(centerX, centerZ, radius);

    return {
      tick,
      agents: agents.map(agent => ({
        id: agent.id,
        x: agent.position.x,
        z: agent.position.z,
        color: agent.color,
        status: agent.status
      }))
    };
  });

  // GET /v1/agents/:id - Get specific agent details
  fastify.get<{ Params: { id: string } }>(
    '/v1/agents/:id',
    async (request, reply) => {
      const agent = await db.getAgent(request.params.id);
      if (!agent) {
        return reply.code(404).send({ error: 'Agent not found' });
      }

      const ext = agent as any;

      // Enrich with live reputation from Agent0 SDK
      let liveReputation = ext.reputationScore || 0;
      if (ext.erc8004AgentId && isAgent0Ready()) {
        try {
          const rep = await getAgentReputation(ext.erc8004AgentId);
          liveReputation = rep.averageValue;
        } catch { /* non-blocking */ }
      }

      return {
        id: agent.id,
        name: agent.name,
        color: agent.color,
        position: { x: agent.position.x, z: agent.position.z },
        status: agent.status,
        inventory: agent.inventory,
        bio: agent.bio,
        erc8004: ext.erc8004AgentId ? {
          agentId: ext.erc8004AgentId,
          agentRegistry: ext.erc8004Registry
        } : undefined,
        reputationScore: liveReputation
      };
    }
  );

  // DELETE /v1/agents/:id - Remove agent from world
  fastify.delete<{ Params: { id: string } }>(
    '/v1/agents/:id',
    async (request, reply) => {
      const auth = await authenticate(request, reply);
      if (!auth) return;

      // Verify ownership
      if (auth.agentId !== request.params.id) {
        return reply.code(403).send({ error: 'Cannot delete another agent' });
      }

      // Verify existence
      const agent = await db.getAgent(request.params.id);
      if (!agent) {
        return reply.code(404).send({ error: 'Agent not found' });
      }

      const world = getWorldManager();
      world.removeAgent(auth.agentId);
      await db.deleteAgent(auth.agentId);

      return { success: true };
    }
  );
}
