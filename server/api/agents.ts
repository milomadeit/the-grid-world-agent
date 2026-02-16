import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'crypto';
import { authenticate, generateToken, recoverWallet, isTimestampValid } from '../auth.js';
import {
  EnterWorldWithIdentitySchema,
  ActionRequestSchema,
  type EnterWorldWithIdentity,
  type ActionRequest,
  type Agent
} from '../types.js';
import * as db from '../db.js';
import { getWorldManager } from '../world.js';
import { verifyAgentOwnership, isChainInitialized, verifyEntryFeePayment, TREASURY_ADDRESS, ENTRY_FEE_MON, MONAD_CHAIN_ID } from '../chain.js';
import { lookupAgent, getAgentReputation, isAgent0Ready } from '../agent0.js';



export async function registerAgentRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /v1/agents/enter - Signed Auth + Entry Fee
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

      const { walletAddress, signature, timestamp, agentId: erc8004AgentId, agentRegistry, visuals, bio, entryFeeTxHash } = parsed.data;

      // --- Step 1: Validate timestamp (replay protection) ---
      if (!isTimestampValid(timestamp)) {
        return reply.code(400).send({
          error: 'Timestamp expired or invalid. Must be within 5 minutes.',
          hint: 'Generate a fresh ISO timestamp and re-sign.'
        });
      }

      // --- Step 2: Recover wallet from signature ---
      const recoveredAddress = recoverWallet(signature, timestamp);
      if (!recoveredAddress) {
        return reply.code(400).send({
          error: 'Invalid signature. Could not recover wallet address.'
        });
      }

      // Verify recovered address matches claimed wallet
      if (recoveredAddress.toLowerCase() !== walletAddress.toLowerCase()) {
        return reply.code(403).send({
          error: 'Signature does not match wallet address.',
          details: { claimed: walletAddress, recovered: recoveredAddress }
        });
      }

      console.log(`[Auth] Wallet verified: ${recoveredAddress}`);

      // --- Step 3: Verify on-chain agent ownership ---
      if (!isChainInitialized()) {
        return reply.code(503).send({
          error: 'Chain not initialized. Try again shortly.'
        });
      }

      try {
        const { verified, owner, agentWallet } = await verifyAgentOwnership(
          erc8004AgentId,
          recoveredAddress
        );
        if (!verified) {
          return reply.code(403).send({
            error: 'Your wallet does not own or control this agent identity.',
            details: { tokenOwner: owner, agentWallet, yourWallet: recoveredAddress }
          });
        }
        console.log(`[Auth] Agent #${erc8004AgentId} ownership verified for ${recoveredAddress}`);
      } catch (error: any) {
        const message = error?.message || 'Unknown error';
        if (message.includes('ERC721NonexistentToken') || message.includes('nonexistent')) {
          return reply.code(400).send({
            error: `Agent ID ${erc8004AgentId} not found on-chain. Register at https://www.8004.org`
          });
        }
        console.error(`[Auth] On-chain verification error:`, error);
        return reply.code(400).send({
          error: 'Failed to verify agent identity on-chain.',
          details: message
        });
      }

      // --- Step 4: Check/verify entry fee ---
      // Use wallet-based lookup first, fall back to agent ID lookup
      const existingAgent = await db.getAgentByOwnerId(recoveredAddress);
      const isReturning = !!existingAgent;
      const feePaid = existingAgent ? (existingAgent as any).entry_fee_paid === true : false;

      if (!feePaid) {
        if (!entryFeeTxHash) {
          // No payment yet — tell the agent what to do
          return reply.code(402).send({
            error: 'Entry fee required',
            needsPayment: true,
            treasury: TREASURY_ADDRESS,
            amount: ENTRY_FEE_MON,
            chainId: MONAD_CHAIN_ID,
            hint: `Send ${ENTRY_FEE_MON} MON to ${TREASURY_ADDRESS}, then re-call this endpoint with entryFeeTxHash.`
          });
        }

        // Verify the tx hash hasn't been used by another agent
        const txUsed = await db.isTxHashUsed(entryFeeTxHash);
        if (txUsed) {
          return reply.code(400).send({
            error: 'This transaction hash has already been used for entry.',
            hint: 'Send a new payment transaction.'
          });
        }

        // Verify the actual transaction on-chain
        const feeResult = await verifyEntryFeePayment(entryFeeTxHash, recoveredAddress);
        if (!feeResult.valid) {
          return reply.code(400).send({
            error: 'Entry fee payment verification failed.',
            reason: feeResult.reason,
            hint: `Ensure you sent ${ENTRY_FEE_MON} MON from ${recoveredAddress} to ${TREASURY_ADDRESS}.`
          });
        }

        console.log(`[Auth] Entry fee verified: tx ${entryFeeTxHash}`);
      }

      // --- Step 5: Enrich with on-chain metadata ---
      let onChainName: string | undefined;
      let onChainBio: string | undefined;
      let reputationScore = 0;
      if (isAgent0Ready()) {
        try {
          const agentMeta = await lookupAgent(erc8004AgentId);
          if (agentMeta) {
            onChainName = agentMeta.name || undefined;
            onChainBio = agentMeta.description || undefined;
          }
          const rep = await getAgentReputation(erc8004AgentId);
          reputationScore = rep.averageValue;
        } catch (err) {
          console.warn('[Agent0] Metadata enrichment failed (non-blocking):', err);
        }
      }

      // --- Step 6: Create or update agent ---
      const useOwnerId = recoveredAddress; // wallet address is the owner

      if (isReturning && existingAgent) {
        const token = generateToken(existingAgent.id, existingAgent.ownerId || useOwnerId);
        const world = getWorldManager();

        // Check if agent's saved position is inside an object — if so, respawn near terminal
        let safePosition = { x: existingAgent.position.x, z: existingAgent.position.z };
        const primitives = world.getWorldPrimitives();
        const isInsideObject = primitives.some(p => {
          const dx = Math.abs(existingAgent.position.x - p.position.x);
          const dz = Math.abs(existingAgent.position.z - p.position.z);
          const halfX = (p.scale?.x || 1) / 2 + 0.5; // Add agent radius
          const halfZ = (p.scale?.z || 1) / 2 + 0.5;
          return dx < halfX && dz < halfZ && p.position.y < 3; // Only ground-level objects
        });

        if (isInsideObject) {
          // Respawn near system terminal (safe zone)
          safePosition = {
            x: (Math.random() - 0.5) * 20,
            z: (Math.random() - 0.5) * 20
          };
          console.log(`[Agent] ${existingAgent.name} was inside an object, respawning at terminal`);
        }

        // Update position if moved
        existingAgent.position = { ...existingAgent.position, x: safePosition.x, z: safePosition.z };
        existingAgent.targetPosition = { ...existingAgent.targetPosition, x: safePosition.x, z: safePosition.z };

        // Ensure agent is in world manager memory
        if (!world.getAgent(existingAgent.id)) {
          world.addAgent(existingAgent);
        }

        // Update ERC-8004 / bio data
        await db.createAgent({
          ...existingAgent,
          erc8004AgentId,
          erc8004Registry: agentRegistry,
          bio: bio || existingAgent.bio,
        });

        // Mark entry fee as paid if we just verified it
        if (!feePaid && entryFeeTxHash) {
          await db.markEntryFeePaid(existingAgent.id, entryFeeTxHash);
          await db.recordUsedTxHash(entryFeeTxHash, existingAgent.id, recoveredAddress);
        }

        return {
          agentId: existingAgent.id,
          position: { x: existingAgent.position.x, z: existingAgent.position.z },
          token,
          skillUrl: `${request.protocol}://${request.hostname}/skill.md`,
          erc8004: {
            agentId: erc8004AgentId,
            agentRegistry: agentRegistry,
            verified: true
          }
        };
      }

      // New agent
      const agentId = `agent_${randomUUID().slice(0, 8)}`;

      // Find a spawn position away from other agents
      const world = getWorldManager();
      const existingAgents = world.getAgents();
      let spawnX = 0, spawnZ = 0;
      let attempts = 0;
      const MIN_DISTANCE = 5; // Minimum distance from other agents

      do {
        // Spawn in a ring around origin (50-150 units out, avoiding build zone)
        const angle = Math.random() * Math.PI * 2;
        const distance = 50 + Math.random() * 100;
        spawnX = Math.cos(angle) * distance;
        spawnZ = Math.sin(angle) * distance;
        attempts++;

        // Check if too close to any existing agent
        const tooClose = existingAgents.some(a => {
          const dx = a.position.x - spawnX;
          const dz = a.position.z - spawnZ;
          return Math.sqrt(dx * dx + dz * dz) < MIN_DISTANCE;
        });

        if (!tooClose) break;
      } while (attempts < 20);

      const agent: Agent = {
        id: agentId,
        name: onChainName || visuals.name,
        color: visuals?.color || '#6b7280',
        position: { x: spawnX, y: 0, z: spawnZ },
        targetPosition: { x: spawnX, y: 0, z: spawnZ },
        status: 'idle',
        inventory: { wood: 0, stone: 0, gold: 0 },
        ownerId: useOwnerId,
        bio: bio || onChainBio
      };

      await db.createAgent({
        ...agent,
        erc8004AgentId,
        erc8004Registry: agentRegistry,
        bio,
      });

      // Mark entry fee as paid
      if (entryFeeTxHash) {
        await db.markEntryFeePaid(agentId, entryFeeTxHash);
        await db.recordUsedTxHash(entryFeeTxHash, agentId, recoveredAddress);
      }

      world.addAgent(agent);

      const token = generateToken(agentId, useOwnerId);

      return {
        agentId,
        position: { x: spawnX, z: spawnZ },
        token,
        skillUrl: `${request.protocol}://${request.hostname}/skill.md`,
        erc8004: {
          agentId: erc8004AgentId,
          agentRegistry: agentRegistry,
          verified: true
        }
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

      // Keep agent alive on the map
      world.touchAgent(auth.agentId);

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

            // Look up agent name for persistence
            const agent = await db.getAgent(auth.agentId);
            const agentName = agent?.name || auth.agentId;

            // Persist valid chat message
            await db.writeChatMessage({
              id: 0,
              agentId: auth.agentId,
              agentName,
              message,
              createdAt: Date.now()
            });

            world.broadcastChat(auth.agentId, message, agentName);
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
