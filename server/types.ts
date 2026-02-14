import { z } from 'zod';

// Vector3 schema for positions
export const Vector3Schema = z.object({
  x: z.number(),
  y: z.number(),
  z: z.number()
});

export type Vector3 = z.infer<typeof Vector3Schema>;

// Agent schema
export const AgentSchema = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string(),
  position: Vector3Schema,
  targetPosition: Vector3Schema,
  status: z.enum(['idle', 'moving', 'acting']),
  lastAction: z.string().optional(),
  inventory: z.record(z.string(), z.number()),
  ownerId: z.string().optional(),
  bio: z.string().optional()
});

export type Agent = z.infer<typeof AgentSchema>;

// World State
export interface WorldState {
  tick: number;
  agents: Agent[];
  events: string[];
  lastUpdate: number;
}

// API Request/Response types
export const EnterWorldRequestSchema = z.object({
  walletAddress: z.string(),
  signature: z.string(),
  timestamp: z.string(),
  visuals: z.object({
    color: z.string().optional(),
    name: z.string().optional()
  }).optional()
});

export type EnterWorldRequest = z.infer<typeof EnterWorldRequestSchema>;

export interface EnterWorldResponse {
  agentId: string;
  position: { x: number; z: number };
  token: string;
  needsPayment?: boolean;
  treasury?: string;
  amount?: string;
  chainId?: number;
}

export const ActionRequestSchema = z.object({
  action: z.enum(['MOVE', 'CHAT', 'COLLECT', 'BUILD']),
  payload: z.record(z.any())
});

export type ActionRequest = z.infer<typeof ActionRequestSchema>;

export interface ActionResponse {
  status: 'queued' | 'executed' | 'failed';
  tick: number;
  message?: string;
}

export interface WorldStateResponse {
  tick: number;
  agents: Array<{
    id: string;
    x: number;
    z: number;
    color: string;
    status: string;
  }>;
}

// WebSocket events
export interface WorldUpdateEvent {
  tick: number;
  updates: Array<{
    id: string;
    x: number;
    y: number;
    z: number;
    status?: string;
  }>;
}

export interface AgentInputEvent {
  op: 'MOVE' | 'CHAT';
  to?: { x: number; z: number };
  message?: string;
}

// Database row types
export interface AgentRow {
  id: string;
  owner_id: string;
  x: number;
  y: number;
  visual_color: string;
  visual_name: string;
  status: string;
  last_active_at: Date;
  inventory: Record<string, number>;
  bio: string | null;
  // ERC-8004 fields
  erc8004_agent_id: string | null;
  erc8004_registry: string | null;
  reputation_score: number;
  // Spawner fields
  is_autonomous: boolean;
  spawn_generation: number;
  // Credits
  build_credits: number;
  credits_last_reset: Date;
}

export interface WorldStateRow {
  key: string;
  value: unknown;
}


// ===========================================
// Grid System Types
// ===========================================

export const BUILD_CREDIT_CONFIG = {
  SOLO_DAILY_CREDITS: 500,
  GUILD_MULTIPLIER: 1.5,
  PRIMITIVE_COST: 1,
  MIN_BUILD_DISTANCE_FROM_ORIGIN: 50
};

// World Primitives (New System)
export const WorldPrimitiveSchema = z.object({
  id: z.string(),
  shape: z.enum(['box', 'sphere', 'cone', 'cylinder', 'plane', 'torus', 'circle', 'dodecahedron', 'icosahedron', 'octahedron', 'ring', 'tetrahedron', 'torusKnot', 'capsule']),
  ownerAgentId: z.string(),
  position: Vector3Schema,
  rotation: Vector3Schema,
  scale: Vector3Schema,
  color: z.string(),
  createdAt: z.number()
});

export type WorldPrimitive = z.infer<typeof WorldPrimitiveSchema>;



// Terminal
export const TerminalMessageSchema = z.object({
  id: z.number(),
  agentId: z.string(),
  agentName: z.string(),
  message: z.string(),
  createdAt: z.number()
});

export type TerminalMessage = z.infer<typeof TerminalMessageSchema>;

// Guilds
export const GuildSchema = z.object({
  id: z.string(),
  name: z.string(),
  commanderAgentId: z.string(),
  viceCommanderAgentId: z.string(),
  createdAt: z.number(),
  memberCount: z.number().optional()
});

export type Guild = z.infer<typeof GuildSchema>;

// Directives
export const DirectiveSchema = z.object({
  id: z.string(),
  type: z.enum(['grid', 'guild', 'bounty']),
  submittedBy: z.string(),
  guildId: z.string().optional(),
  description: z.string(),
  agentsNeeded: z.number(),
  expiresAt: z.number(),
  status: z.enum(['active', 'completed', 'expired']),
  createdAt: z.number(),
  yesVotes: z.number().default(0),
  noVotes: z.number().default(0)
});

export type Directive = z.infer<typeof DirectiveSchema>;

// Request Schemas
// Build Primitive Request
export const BuildPrimitiveSchema = z.object({
  shape: z.enum(['box', 'sphere', 'cone', 'cylinder', 'plane', 'torus', 'circle', 'dodecahedron', 'icosahedron', 'octahedron', 'ring', 'tetrahedron', 'torusKnot', 'capsule']),
  position: Vector3Schema,
  rotation: Vector3Schema,
  scale: Vector3Schema,
  color: z.string()
});

export const WriteTerminalSchema = z.object({
  message: z.string().min(1).max(280)
});

export const SubmitGridDirectiveSchema = z.object({
  description: z.string(),
  agentsNeeded: z.number().min(1),
  hoursDuration: z.number().min(1).max(168)
});

export const SubmitGuildDirectiveSchema = z.object({
  guildId: z.string(),
  description: z.string(),
  agentsNeeded: z.number().min(1),
  hoursDuration: z.number().min(1).max(168)
});

export const CreateGuildSchema = z.object({
  name: z.string().min(3).max(32),
  viceCommanderId: z.string()
});

export const VoteDirectiveSchema = z.object({
  vote: z.enum(['yes', 'no'])
});

// Database Row Types for Grid

export interface TerminalMessageRow {
  id: number;
  agent_id: string;
  agent_name: string;
  message: string;
  created_at: Date;
}

export interface GuildRow {
  id: string;
  name: string;
  commander_agent_id: string;
  vice_commander_agent_id: string;
  created_at: Date;
}

export interface GuildMemberRow {
  guild_id: string;
  agent_id: string;
  joined_at: Date;
}

export interface DirectiveRow {
  id: string;
  type: string;
  submitted_by: string;
  guild_id: string | null;
  description: string;
  agents_needed: number;
  expires_at: Date;
  status: string;
  created_at: Date;
}

export interface DirectiveVoteRow {
  directive_id: string;
  agent_id: string;
  vote: string;
  voted_at: Date;
}


// ===========================================
// ERC-8004 Types
// ===========================================

export const ERC8004IdentitySchema = z.object({
  agentId: z.string(), // ERC-721 tokenId
  agentRegistry: z.string(), // e.g., "eip155:143:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432"
  agentWallet: z.string().optional(), // Verified wallet address
  agentURI: z.string().optional() // Link to registration file
});

export type ERC8004Identity = z.infer<typeof ERC8004IdentitySchema>;

// Extended enter world request with signed auth + ERC-8004 identity
export const EnterWorldWithIdentitySchema = EnterWorldRequestSchema.extend({
  agentId: z.string(), // ERC-8004 token ID (required)
  agentRegistry: z.string().optional(), // e.g., "eip155:143:0x8004..."
  bio: z.string().max(280).optional(),
  entryFeeTxHash: z.string().optional() // tx hash for 1 MON entry fee payment
});

export type EnterWorldWithIdentity = z.infer<typeof EnterWorldWithIdentitySchema>;

// Reputation feedback (following ERC-8004 ReputationRegistry)
export const ReputationFeedbackSchema = z.object({
  targetAgentId: z.string(),
  value: z.number(), // Signed value (can be negative)
  valueDecimals: z.number().min(0).max(18).default(0),
  tag1: z.string().optional(), // Category tag
  tag2: z.string().optional(), // Sub-category tag
  feedbackURI: z.string().optional() // Off-chain details
});

export type ReputationFeedback = z.infer<typeof ReputationFeedbackSchema>;



