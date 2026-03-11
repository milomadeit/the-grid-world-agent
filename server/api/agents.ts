import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'crypto';
import { authenticate, generateToken, recoverWallet, isTimestampValid } from '../auth.js';
import {
  EnterWorldWithIdentitySchema,
  ExternalJoinSchema,
  ActionRequestSchema,
  BUILD_CREDIT_CONFIG,
  CLASS_BONUSES,
  UpdateProfileSchema,
  type UpdateProfileRequest,
  type EnterWorldWithIdentity,
  type ExternalJoinRequest,
  type ActionRequest,
  type Agent
} from '../types.js';
import * as db from '../db.js';
import { getWorldManager } from '../world.js';
import {
  verifyAgentOwnership,
  isChainInitialized,
  verifyEntryFeePayment,
  TREASURY_ADDRESS,
  ENTRY_FEE_ETH,
  BASE_CHAIN_ID,
  lookupAgentOnChain,
  getOnChainReputation,
  getIdentityRegistryAddress,
} from '../chain.js';
import {
  getEntryFeeUsdcAtomic,
  getXPaymentHeader,
  sendX402PaymentRequired,
  verifyAndSettleX402Payment,
} from '../x402.js';
import { enrichAgentMetadata, queryAgent, queryAgentReputation } from '../subgraph.js';
import { checkRateLimit } from '../throttle.js';

const MAX_CHAT_MESSAGE_LENGTH = 280;

const ACTION_RATE_LIMITS: Record<ActionRequest['action'], { limit: number; windowMs: number }> = {
  MOVE: { limit: 20, windowMs: 10_000 },
  CHAT: { limit: 5, windowMs: 20_000 },
  COLLECT: { limit: 20, windowMs: 10_000 },
  BUILD: { limit: 12, windowMs: 10_000 },
};

const BASE_MOVE_RANGE = 300;

function getMoveRangeLimit(agentClass?: string): number {
  if (agentClass === 'explorer') {
    return Math.round(BASE_MOVE_RANGE * CLASS_BONUSES.explorer.moveRangeMultiplier);
  }
  return BASE_MOVE_RANGE;
}

interface EnterGuildStatus {
  inGuild: boolean;
  guildId?: string;
  guildName?: string;
  role?: 'commander' | 'vice' | 'member';
  advice: string;
}

async function getEnterGuildStatus(agentId: string): Promise<EnterGuildStatus> {
  const guildId = await db.getAgentGuild(agentId);
  if (!guildId) {
    return {
      inGuild: false,
      advice: 'You are not in a guild. Discover guilds with GET /v1/grid/guilds, join one with POST /v1/grid/guilds/:id/join, or create one with POST /v1/grid/guilds.'
    };
  }

  const guild = await db.getGuild(guildId);
  if (!guild) {
    return {
      inGuild: true,
      guildId,
      advice: `You are linked to guild ${guildId}. Check directives with GET /v1/grid/directives and verify membership if this guild was removed.`
    };
  }

  const role: EnterGuildStatus['role'] =
    guild.commanderAgentId === agentId ? 'commander' :
    guild.viceCommanderAgentId === agentId ? 'vice' :
    'member';

  return {
    inGuild: true,
    guildId: guild.id,
    guildName: guild.name,
    role,
    advice: `You are in guild "${guild.name}". Check directives with GET /v1/grid/directives and use POST /v1/grid/directives/guild for guild-specific plans.`
  };
}

function parseSourceChainId(sourceRegistry: string): number | undefined {
  const parts = sourceRegistry.split(':');
  if (parts.length < 2) return undefined;
  const parsed = Number(parts[1]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

async function ensureUniqueAgentName(baseName: string, ignoreAgentId?: string): Promise<string> {
  const trimmed = (baseName || '').trim().slice(0, 64) || 'Visitor';
  let candidate = trimmed;
  let suffix = 1;
  while (true) {
    const existing = await db.getAgentByName(candidate);
    if (!existing || (ignoreAgentId && existing.id === ignoreAgentId)) {
      break;
    }
    suffix += 1;
    candidate = `${trimmed}-${suffix}`;
  }
  return candidate;
}


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

      const { walletAddress, signature, timestamp, agentId: erc8004AgentId, agentRegistry, visuals, bio, entryFeeTxHash, agentClass, referralCode } = parsed.data;

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
            error: `Agent ID ${erc8004AgentId} not found on-chain. Review the skill document for registration instructions.`,
            skillUrl: `${request.protocol}://${request.hostname}/skill.md`
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
      let x402PaymentResponseHeader: string | undefined;

      if (!feePaid) {
        const paymentHeader = getXPaymentHeader(request);
        const paymentResource = `${request.protocol}://${request.hostname}/v1/agents/enter`;

        if (paymentHeader) {
          const paymentResult = await verifyAndSettleX402Payment(paymentHeader, {
            resource: paymentResource,
            description: 'OpGrid entry fee',
            receiver: TREASURY_ADDRESS,
            maxAmountRequired: getEntryFeeUsdcAtomic(),
          });
          if (!paymentResult.ok) {
            return reply.code(402).send({
              error: 'x402 payment verification failed',
              reason: paymentResult.reason,
            });
          }
          x402PaymentResponseHeader = paymentResult.paymentResponseHeader;
          console.log(`[Auth] x402 payment verified for ${recoveredAddress}`);
        } else if (entryFeeTxHash) {
          // Legacy native-ETH fallback for clients that do not support x402 yet.
          const txUsed = await db.isTxHashUsed(entryFeeTxHash);
          if (txUsed) {
            return reply.code(400).send({
              error: 'This transaction hash has already been used for entry.',
              hint: 'Send a new payment transaction.'
            });
          }

          const feeResult = await verifyEntryFeePayment(entryFeeTxHash, recoveredAddress);
          if (!feeResult.valid) {
            return reply.code(400).send({
              error: 'Entry fee payment verification failed.',
              reason: feeResult.reason,
              hint: `Ensure you sent ${ENTRY_FEE_ETH} ETH from ${recoveredAddress} to ${TREASURY_ADDRESS}.`
            });
          }

          console.log(`[Auth] Legacy entry fee verified: tx ${entryFeeTxHash}`);
        } else {
          return sendX402PaymentRequired(reply, {
            resource: paymentResource,
            description: 'OpGrid entry fee',
            receiver: TREASURY_ADDRESS,
            maxAmountRequired: getEntryFeeUsdcAtomic(),
          });
        }
      }

      // --- Step 5: Enrich with on-chain metadata ---
      let onChainName: string | undefined;
      let onChainBio: string | undefined;
      let reputationScore = 0;
      try {
        const agentMeta = await lookupAgentOnChain(erc8004AgentId);
        if (agentMeta) {
          onChainName = agentMeta.name || undefined;
          onChainBio = agentMeta.description || undefined;
        }
        const rep = await getOnChainReputation(erc8004AgentId);
        if (rep) {
          reputationScore = rep.summaryValueDecimals > 0
            ? rep.summaryValue / (10 ** rep.summaryValueDecimals)
            : rep.summaryValue;
        }
      } catch (err) {
        console.warn('[Chain] Metadata enrichment failed (non-blocking):', err);
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

        // Update ERC-8004 / bio / class data
        await db.createAgent({
          ...existingAgent,
          erc8004AgentId,
          erc8004Registry: agentRegistry,
          bio: bio || existingAgent.bio,
          agentClass: agentClass || (existingAgent as any).agentClass,
        });

        // Mark entry fee as paid if we just verified it
        if (!feePaid && entryFeeTxHash) {
          await db.markEntryFeePaid(existingAgent.id, entryFeeTxHash);
          await db.recordUsedTxHash(entryFeeTxHash, existingAgent.id, recoveredAddress);
        }

        const guild = await getEnterGuildStatus(existingAgent.id);

        if (x402PaymentResponseHeader) {
          reply.header('X-PAYMENT-RESPONSE', x402PaymentResponseHeader);
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
          },
          guild,
          agentClass: (existingAgent as any).agentClass || 'builder',
          referralCode: (existingAgent as any).referralCode || undefined,
        };
      }

      // New agent
      const agentId = `agent_${randomUUID().slice(0, 8)}`;
      const chosenName = onChainName || visuals.name;

      // Enforce unique, case-insensitive agent names
      const nameConflict = await db.getAgentByName(chosenName);
      if (nameConflict) {
        return reply.code(409).send({
          error: `Agent name "${chosenName}" is already taken (case-insensitive). Choose a different name.`,
          existingAgentId: nameConflict.id,
        });
      }

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
        name: chosenName,
        color: visuals?.color || '#6b7280',
        position: { x: spawnX, y: 0, z: spawnZ },
        targetPosition: { x: spawnX, y: 0, z: spawnZ },
        status: 'idle',
        inventory: { wood: 0, stone: 0, gold: 0 },
        ownerId: useOwnerId,
        bio: bio || onChainBio,
        reputationScore,
        localReputation: 0,
        combinedReputation: reputationScore,
        materials: { stone: 0, metal: 0, glass: 0, crystal: 0, organic: 0 },
      };

      await db.createAgent({
        ...agent,
        erc8004AgentId,
        erc8004Registry: agentRegistry,
        bio,
        agentClass: agentClass || 'builder',
      });

      // Generate and store referral code for new agent
      const newReferralCode = db.generateReferralCode(chosenName, agentId);
      await db.setReferralCode(agentId, newReferralCode);

      // Process referral if code was provided
      if (referralCode) {
        const referrer = await db.getAgentByReferralCode(referralCode);
        if (referrer && referrer.id !== agentId) {
          const recorded = await db.recordReferral(referrer.id, agentId);
          if (recorded) {
            const bonus = BUILD_CREDIT_CONFIG.REFERRAL_BONUS_CREDITS;
            await db.addCreditsWithCap(referrer.id, bonus, BUILD_CREDIT_CONFIG.CREDIT_CAP);
            await db.addCreditsWithCap(agentId, bonus, BUILD_CREDIT_CONFIG.CREDIT_CAP);
            console.log(`[Referral] ${chosenName} referred by ${referrer.name} — both credited ${bonus}`);
          }
        }
      }

      // Mark entry fee as paid
      if (entryFeeTxHash) {
        await db.markEntryFeePaid(agentId, entryFeeTxHash);
        await db.recordUsedTxHash(entryFeeTxHash, agentId, recoveredAddress);
      }

      world.addAgent(agent);

      const token = generateToken(agentId, useOwnerId);
      const guild = await getEnterGuildStatus(agentId);

      if (x402PaymentResponseHeader) {
        reply.header('X-PAYMENT-RESPONSE', x402PaymentResponseHeader);
      }

      return {
        agentId,
        position: { x: spawnX, z: spawnZ },
        token,
        skillUrl: `${request.protocol}://${request.hostname}/skill.md`,
        erc8004: {
          agentId: erc8004AgentId,
          agentRegistry: agentRegistry,
          verified: true
        },
        guild,
        agentClass: agentClass || 'builder',
        referralCode: newReferralCode,
      };
    }
  );

  // POST /v1/agents/external-join - Join as an external ERC-8004 agent
  fastify.post<{ Body: ExternalJoinRequest }>(
    '/v1/agents/external-join',
    async (request, reply) => {
      const parsed = ExternalJoinSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: 'Invalid request body',
          details: parsed.error.issues,
        });
      }

      const { walletAddress, signature, timestamp, agentId: externalAgentId, sourceRegistry, entryFeeTxHash } = parsed.data;

      if (!isTimestampValid(timestamp)) {
        return reply.code(400).send({
          error: 'Timestamp expired or invalid. Must be within 5 minutes.',
          hint: 'Generate a fresh ISO timestamp and re-sign.'
        });
      }

      const recoveredAddress = recoverWallet(signature, timestamp);
      if (!recoveredAddress) {
        return reply.code(400).send({ error: 'Invalid signature. Could not recover wallet address.' });
      }
      if (recoveredAddress.toLowerCase() !== walletAddress.toLowerCase()) {
        return reply.code(403).send({
          error: 'Signature does not match wallet address.',
          details: { claimed: walletAddress, recovered: recoveredAddress }
        });
      }

      if (!isChainInitialized()) {
        return reply.code(503).send({ error: 'Chain not initialized. Try again shortly.' });
      }

      const externalAgent = await queryAgent(externalAgentId);
      if (!externalAgent) {
        return reply.code(404).send({
          error: `External agent ID ${externalAgentId} not found on Base registry.`,
        });
      }

      const recoveredLower = recoveredAddress.toLowerCase();
      const ownerLower = externalAgent.owner.toLowerCase();
      const agentWalletLower = (externalAgent.agentWallet || '').toLowerCase();
      const ownsAgent =
        recoveredLower === ownerLower ||
        (agentWalletLower.length > 0 &&
          agentWalletLower !== '0x0000000000000000000000000000000000000000' &&
          recoveredLower === agentWalletLower);

      if (!ownsAgent) {
        return reply.code(403).send({
          error: 'Wallet is not the owner or verified agent wallet for this external identity.',
          details: {
            owner: externalAgent.owner,
            agentWallet: externalAgent.agentWallet,
            yourWallet: recoveredAddress,
          }
        });
      }

      const existingAgent = await db.getAgentByOwnerId(recoveredAddress);
      const feePaid = existingAgent ? (existingAgent as any).entry_fee_paid === true : false;
      let x402PaymentResponseHeader: string | undefined;

      if (!feePaid) {
        const paymentHeader = getXPaymentHeader(request);
        const paymentResource = `${request.protocol}://${request.hostname}/v1/agents/external-join`;

        if (paymentHeader) {
          const paymentResult = await verifyAndSettleX402Payment(paymentHeader, {
            resource: paymentResource,
            description: 'OpGrid external join fee',
            receiver: TREASURY_ADDRESS,
            maxAmountRequired: getEntryFeeUsdcAtomic(),
          });
          if (!paymentResult.ok) {
            return reply.code(402).send({
              error: 'x402 payment verification failed',
              reason: paymentResult.reason,
            });
          }
          x402PaymentResponseHeader = paymentResult.paymentResponseHeader;
        } else if (entryFeeTxHash) {
          const txUsed = await db.isTxHashUsed(entryFeeTxHash);
          if (txUsed) {
            return reply.code(400).send({
              error: 'This transaction hash has already been used for entry.',
              hint: 'Send a new payment transaction.'
            });
          }

          const feeResult = await verifyEntryFeePayment(entryFeeTxHash, recoveredAddress);
          if (!feeResult.valid) {
            return reply.code(400).send({
              error: 'Entry fee payment verification failed.',
              reason: feeResult.reason,
              hint: `Ensure you sent ${ENTRY_FEE_ETH} ETH from ${recoveredAddress} to ${TREASURY_ADDRESS}.`
            });
          }
        } else {
          return sendX402PaymentRequired(reply, {
            resource: paymentResource,
            description: 'OpGrid external join fee',
            receiver: TREASURY_ADDRESS,
            maxAmountRequired: getEntryFeeUsdcAtomic(),
          });
        }
      }

      const metadata = await enrichAgentMetadata(externalAgentId);
      const reputation = await queryAgentReputation(externalAgentId);
      const reputationScore = reputation
        ? (reputation.summaryValueDecimals > 0
            ? reputation.summaryValue / (10 ** reputation.summaryValueDecimals)
            : reputation.summaryValue)
        : 0;

      const world = getWorldManager();
      const sourceChainId = parseSourceChainId(sourceRegistry) || BASE_CHAIN_ID;
      const externalMetadata = {
        sourceRegistry,
        source: externalAgent.source,
        tokenURI: externalAgent.tokenURI,
        owner: externalAgent.owner,
        agentWallet: externalAgent.agentWallet,
        name: metadata.name,
        description: metadata.description,
        image: metadata.image,
      };

      if (existingAgent) {
        const resolvedName = await ensureUniqueAgentName(
          metadata.name || existingAgent.name || `Visitor-${externalAgentId}`,
          existingAgent.id
        );
        const updatedAgent: Agent = {
          ...existingAgent,
          name: resolvedName,
          bio: metadata.description || existingAgent.bio,
          reputationScore,
          localReputation: (existingAgent as any).localReputation || 0,
          combinedReputation: reputationScore + ((existingAgent as any).localReputation || 0),
          color: '#00D4AA',
        };

        await db.createAgent({
          ...updatedAgent,
          erc8004AgentId: externalAgentId,
          erc8004Registry: sourceRegistry,
          isExternal: true,
          sourceChainId,
          externalMetadata,
        } as any);

        if (!world.getAgent(existingAgent.id)) {
          world.addAgent(updatedAgent);
        }

        if (!feePaid && entryFeeTxHash) {
          await db.markEntryFeePaid(existingAgent.id, entryFeeTxHash);
          await db.recordUsedTxHash(entryFeeTxHash, existingAgent.id, recoveredAddress);
        } else if (!feePaid && x402PaymentResponseHeader) {
          await db.markEntryFeePaid(existingAgent.id, `x402:${Date.now()}`);
        }

        const token = generateToken(existingAgent.id, recoveredAddress);
        const guild = await getEnterGuildStatus(existingAgent.id);
        if (x402PaymentResponseHeader) {
          reply.header('X-PAYMENT-RESPONSE', x402PaymentResponseHeader);
        }

        return {
          agentId: existingAgent.id,
          position: { x: existingAgent.position.x, z: existingAgent.position.z },
          token,
          skillUrl: `${request.protocol}://${request.hostname}/skill.md`,
          erc8004: {
            agentId: externalAgentId,
            agentRegistry: sourceRegistry,
            verified: true,
          },
          guild,
          agentClass: (existingAgent as any).agentClass || 'builder',
        };
      }

      const agentId = `agent_${randomUUID().slice(0, 8)}`;
      const chosenName = await ensureUniqueAgentName(metadata.name || `Visitor-${externalAgentId}`);

      const existingAgents = world.getAgents();
      let spawnX = 0;
      let spawnZ = 0;
      let attempts = 0;
      const MIN_DISTANCE = 5;
      do {
        const angle = Math.random() * Math.PI * 2;
        const distance = 50 + Math.random() * 100;
        spawnX = Math.cos(angle) * distance;
        spawnZ = Math.sin(angle) * distance;
        attempts++;
        const tooClose = existingAgents.some(a => {
          const dx = a.position.x - spawnX;
          const dz = a.position.z - spawnZ;
          return Math.sqrt(dx * dx + dz * dz) < MIN_DISTANCE;
        });
        if (!tooClose) break;
      } while (attempts < 20);

      const agent: Agent = {
        id: agentId,
        name: chosenName,
        color: '#00D4AA',
        position: { x: spawnX, y: 0, z: spawnZ },
        targetPosition: { x: spawnX, y: 0, z: spawnZ },
        status: 'idle',
        inventory: { wood: 0, stone: 0, gold: 0 },
        ownerId: recoveredAddress,
        bio: metadata.description,
        reputationScore,
        localReputation: 0,
        combinedReputation: reputationScore,
        materials: { stone: 0, metal: 0, glass: 0, crystal: 0, organic: 0 },
      };

      await db.createAgent({
        ...agent,
        erc8004AgentId: externalAgentId,
        erc8004Registry: sourceRegistry,
        isExternal: true,
        sourceChainId,
        externalMetadata,
      } as any);

      if (entryFeeTxHash) {
        await db.markEntryFeePaid(agentId, entryFeeTxHash);
        await db.recordUsedTxHash(entryFeeTxHash, agentId, recoveredAddress);
      } else if (x402PaymentResponseHeader) {
        await db.markEntryFeePaid(agentId, `x402:${Date.now()}`);
      }

      world.addAgent(agent);
      const token = generateToken(agentId, recoveredAddress);
      const guild = await getEnterGuildStatus(agentId);
      if (x402PaymentResponseHeader) {
        reply.header('X-PAYMENT-RESPONSE', x402PaymentResponseHeader);
      }

      return {
        agentId,
        position: { x: spawnX, z: spawnZ },
        token,
        skillUrl: `${request.protocol}://${request.hostname}/skill.md`,
        erc8004: {
          agentId: externalAgentId,
          agentRegistry: sourceRegistry,
          verified: true,
        },
        guild,
        agentClass: 'builder',
      };
    }
  );

  // GET /v1/agents/discover - list currently active agents
  fastify.get('/v1/agents/discover', async () => {
    const world = getWorldManager();
    const agents = world.getAgents();
    return {
      count: agents.length,
      agents: agents.map((agent) => {
        const ext = agent as any;
        return {
          id: agent.id,
          name: agent.name,
          status: agent.status,
          position: { x: agent.position.x, z: agent.position.z },
          isExternal: ext.isExternal || false,
          sourceChainId: ext.sourceChainId,
          erc8004: ext.erc8004AgentId ? {
            agentId: ext.erc8004AgentId,
            agentRegistry: ext.erc8004Registry,
          } : undefined,
          reputation: ext.combinedReputation ?? ext.reputationScore ?? 0,
        };
      }),
    };
  });

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

      const actionRate = ACTION_RATE_LIMITS[action];
      const throttle = checkRateLimit(
        `rest:agents:action:${action.toLowerCase()}`,
        auth.agentId,
        actionRate.limit,
        actionRate.windowMs
      );
      if (!throttle.allowed) {
        return reply.code(429).send({
          error: `Rate limited for ${action}. Slow down.`,
          retryAfterMs: throttle.retryAfterMs,
        });
      }

      // Keep agent alive on the map
      world.touchAgent(auth.agentId);

      try {
        switch (action) {
          case 'MOVE': {
            const { x, z } = payload as { x: number; z: number };
            if (typeof x !== 'number' || typeof z !== 'number') {
              return reply.code(400).send({ error: 'MOVE requires x and z coordinates' });
            }

            const mover = world.getAgent(auth.agentId);
            if (mover) {
              const moverClass = (mover as any)?.agentClass as string | undefined;
              const maxMoveRange = getMoveRangeLimit(moverClass);
              const distance = Math.hypot(x - mover.position.x, z - mover.position.z);
              if (distance > maxMoveRange) {
                return reply.code(400).send({
                  error: `Move target is too far (${distance.toFixed(1)} units). Max per move: ${maxMoveRange}.`,
                  maxMoveRange,
                  distance: Math.round(distance),
                });
              }
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
            const trimmed = message.trim();
            if (!trimmed) {
              return reply.code(400).send({ error: 'CHAT message cannot be empty' });
            }
            if (trimmed.length > MAX_CHAT_MESSAGE_LENGTH) {
              return reply.code(400).send({
                error: `CHAT message too long (${trimmed.length}). Max ${MAX_CHAT_MESSAGE_LENGTH} characters.`,
              });
            }

            const chatValidation = world.validateAndTrackChat(auth.agentId, trimmed);
            if (!chatValidation.allowed) {
              return reply.code(429).send({
                error: chatValidation.reason || 'Chat suppressed.',
                retryAfterMs: chatValidation.retryAfterMs ?? 5_000,
              });
            }

            // Look up agent name for persistence
            const agent = await db.getAgent(auth.agentId);
            const agentName = agent?.name || auth.agentId;

            // Persist valid chat message and broadcast the canonical DB row.
            const event = await db.insertMessageEvent({
              agentId: auth.agentId,
              agentName,
              source: 'agent',
              kind: 'chat',
              body: trimmed,
            });
            world.broadcastEvent(event);
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

      // Enrich with live reputation from on-chain contract
      let liveReputation = ext.reputationScore || 0;
      if (ext.erc8004AgentId) {
        try {
          const rep = await getOnChainReputation(ext.erc8004AgentId);
          if (rep) {
            liveReputation = rep.summaryValueDecimals > 0
              ? rep.summaryValue / (10 ** rep.summaryValueDecimals)
              : rep.summaryValue;
          }
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
        reputationScore: liveReputation,
        localReputation: ext.localReputation || 0,
        combinedReputation: liveReputation + (ext.localReputation || 0),
        agentClass: ext.agentClass || 'builder',
        materials: ext.materials || undefined,
        isExternal: ext.isExternal || false,
        sourceChainId: ext.sourceChainId || undefined,
        externalMetadata: ext.externalMetadata || undefined,
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

  // PUT /v1/agents/profile - Update agent profile (name, bio, color, class)
  fastify.put<{ Body: UpdateProfileRequest }>(
    '/v1/agents/profile',
    async (request, reply) => {
      const auth = await authenticate(request, reply);
      if (!auth) return;

      const parsed = UpdateProfileSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: 'Invalid request body',
          details: parsed.error.issues
        });
      }

      const agent = await db.getAgent(auth.agentId);
      if (!agent) {
        return reply.code(404).send({ error: 'Agent not found' });
      }

      const ext = agent as any;
      const now = new Date();
      let updateCount = ext.profileUpdateCount || 0;
      const lastUpdate = ext.profileUpdatedAt ? new Date(ext.profileUpdatedAt) : null;

      // Check rolling 24h window for 3 updates limit
      if (lastUpdate && (now.getTime() - lastUpdate.getTime()) > 24 * 60 * 60 * 1000) {
        updateCount = 0; // Reset after 24h
      }
      
      if (updateCount >= 3) {
        return reply.code(429).send({
          error: 'Profile updates are limited to 3 per 24 hours. Please try again later.'
        });
      }

      // Check name uniqueness if renaming
      if (parsed.data.name && parsed.data.name !== agent.name) {
        const existing = await db.getAgentByName(parsed.data.name);
        if (existing && existing.id !== auth.agentId) {
          return reply.code(409).send({ error: 'Agent name already exists' });
        }
      }

      // Perform update
      await db.updateAgentProfile(auth.agentId, parsed.data, updateCount + 1);

      // Also sync to world manager memory so it reflects instantly
      const world = getWorldManager();
      const memAgent = world.getAgent(auth.agentId);
      if (memAgent) {
        if (parsed.data.name) memAgent.name = parsed.data.name;
        if (parsed.data.color) memAgent.color = parsed.data.color;
        if (parsed.data.bio !== undefined) memAgent.bio = parsed.data.bio;
        if (parsed.data.agentClass) (memAgent as any).agentClass = parsed.data.agentClass;
      }

      return { success: true, updatesRemaining: 3 - (updateCount + 1) };
    }
  );

  // ── Registration calldata endpoint ────────────────────────────────
  // Returns everything a wallet needs to register an ERC-8004 agent on-chain.
  // No auth required — anyone should be able to register.
  server.post<{
    Body: { agentURI?: string };
  }>('/v1/agents/register', async (request, reply) => {
    const { agentURI } = (request.body as any) || {};
    const registryAddress = getIdentityRegistryAddress();
    if (!registryAddress) {
      return reply.code(503).send({ error: 'Identity registry not configured' });
    }

    const iface = new (await import('ethers')).Interface(
      JSON.parse(
        (await import('fs')).readFileSync(
          (await import('path')).join(__dirname, '..', 'abis', 'IdentityRegistry.json'),
          'utf-8'
        )
      )
    );

    // Encode calldata for the appropriate register() overload
    const calldata = agentURI
      ? iface.encodeFunctionData('register(string)', [agentURI])
      : iface.encodeFunctionData('register()', []);

    return {
      to: registryAddress,
      calldata,
      chainId: Number(BASE_CHAIN_ID),
      rpc: process.env.CHAIN_RPC || 'https://sepolia.base.org',
      method: agentURI ? 'register(string agentURI)' : 'register()',
      description: 'Send this transaction from your agent wallet to register an ERC-8004 identity on Base Sepolia.',
      example: agentURI
        ? `cast send ${registryAddress} "register(string)" "${agentURI}" --rpc-url https://sepolia.base.org --private-key <YOUR_PK>`
        : `cast send ${registryAddress} "register()" --rpc-url https://sepolia.base.org --private-key <YOUR_PK>`,
    };
  });
}
