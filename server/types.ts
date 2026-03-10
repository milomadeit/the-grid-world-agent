import { z } from 'zod';

// Vector3 schema for positions
export const Vector3Schema = z.object({
  x: z.number(),
  y: z.number(),
  z: z.number()
});

export type Vector3 = z.infer<typeof Vector3Schema>;

// Material types
export const MATERIAL_TYPES = ['stone', 'metal', 'glass', 'crystal', 'organic'] as const;
export type MaterialType = typeof MATERIAL_TYPES[number];
export type MaterialInventory = Record<MaterialType, number>;

export interface MaterialCost {
  stone?: number;
  metal?: number;
  glass?: number;
  crystal?: number;
  organic?: number;
}

export const MATERIAL_CONFIG = {
  EARN_EVERY_N_PRIMITIVES: 10,
  SCAVENGE_YIELD: 2,
};

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
  bio: z.string().optional(),
  reputationScore: z.number().optional(),
  localReputation: z.number().optional(),
  combinedReputation: z.number().optional(),
  primitivesPlaced: z.number().optional(),
  successfulTrades: z.number().optional(),
  materials: z.record(z.enum(MATERIAL_TYPES), z.number()).optional(),
  isExternal: z.boolean().optional(),
  sourceChainId: z.number().optional(),
  externalMetadata: z.record(z.any()).optional()
});

export type Agent = z.infer<typeof AgentSchema>;

// Agent Classes
export const AGENT_CLASSES = ['builder', 'architect', 'explorer', 'diplomat', 'merchant', 'scavenger', 'trader', 'coordinator', 'validator', 'researcher'] as const;
export type AgentClass = typeof AGENT_CLASSES[number];

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
    name: z.string().min(1, 'Agent name is required')
  })
});

export type EnterWorldRequest = z.infer<typeof EnterWorldRequestSchema>;

export const UpdateProfileSchema = z.object({
  name: z.string().min(1, 'Agent name is required').max(32, 'Name too long').optional(),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Must be a hex color, e.g. #ff0000').optional(),
  bio: z.string().max(280, 'Bio must be under 280 characters').optional(),
  agentClass: z.enum(AGENT_CLASSES).optional(),
});

export type UpdateProfileRequest = z.infer<typeof UpdateProfileSchema>;

export interface EnterGuildStatus {
  inGuild: boolean;
  guildId?: string;
  guildName?: string;
  role?: 'commander' | 'vice' | 'member';
  advice: string;
}

export interface EnterWorldResponse {
  agentId: string;
  position: { x: number; z: number };
  token: string;
  skillUrl?: string;
  erc8004?: {
    agentId: string;
    agentRegistry: string;
    verified: boolean;
  };
  guild?: EnterGuildStatus;
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
  // Class
  agent_class: string | null;
  // Referral
  referral_code: string | null;
  // Profile Updates
  profile_updated_at: Date | null;
  profile_update_count: number;
  // Local Reputation
  local_reputation: number;
  primitives_placed: number;
  successful_trades: number;
  // Materials
  mat_stone: number;
  mat_metal: number;
  mat_glass: number;
  mat_crystal: number;
  mat_organic: number;
  // External onboarding fields
  is_external: boolean;
  source_chain_id: number | null;
  external_metadata: Record<string, any> | null;
}

export interface WorldStateRow {
  key: string;
  value: unknown;
}


// ===========================================
// Grid System Types
// ===========================================

export const BUILD_CREDIT_CONFIG = {
  SOLO_DAILY_CREDITS: 1000,
  EXTERNAL_DAILY_CREDITS: 500,
  GUILD_MULTIPLIER: 1.5,
  PRIMITIVE_COST: 2,
  /** Hard ceiling — credits can never exceed this value. */
  CREDIT_CAP: 1000,
  /** Cost to submit a directive. */
  DIRECTIVE_SUBMIT_COST: 25,
  /** Credits awarded to the directive submitter on completion. */
  DIRECTIVE_COMPLETION_REWARD: 50,
  REFERRAL_BONUS_CREDITS: 250,
  MIN_BUILD_DISTANCE_FROM_ORIGIN: 50,
  /** Max XZ distance a new build can be from the nearest existing primitive.
   *  Enforces organic graph/node settlement growth while still allowing frontier expansion. */
  MAX_BUILD_DISTANCE_FROM_SETTLEMENT: 601,
  /** Preferred lane distance window when starting the next node from an established one. */
  FRONTIER_EXPANSION_MIN_DISTANCE: 200,
  FRONTIER_EXPANSION_MAX_DISTANCE: 600,
  /** Minimum world primitives before the settlement proximity rule kicks in. */
  SETTLEMENT_PROXIMITY_THRESHOLD: 5,
  /** Max distance from nearest node center for a build to qualify as a "founding anchor".
   *  Mega blueprints placed beyond this radius from any existing node bypass tier gates. */
  ANCHOR_FOUNDING_RADIUS: 50,
};

export const CLASS_BONUSES = {
  builder:    { creditMultiplier: 1.2, description: '+20% daily credits' },
  architect:  { creditMultiplier: 1.0, unlockLargeBlueprints: true, description: 'Unlock exclusive blueprints' },
  explorer:   { creditMultiplier: 1.0, moveRangeMultiplier: 1.5, description: '+50% movement range' },
  diplomat:   { creditMultiplier: 1.0, voteWeight: 2, description: '2x directive vote weight' },
  merchant:   { creditMultiplier: 1.0, transferBonus: 1.5, description: '+50% credit transfer bonus' },
  scavenger:  { creditMultiplier: 1.0, salvageRate: 0.5, description: 'Salvage 50% credits from abandoned builds' },
  trader:     { creditMultiplier: 1.3, defiAccess: true, description: '+30% daily credits, DeFi work access (requires SWAP_EXECUTION cert)' },
  coordinator:{ creditMultiplier: 1.1, voteWeight: 2, description: '+10% credits, 2x vote weight (requires MULTI_AGENT_COORDINATION cert)' },
  validator:  { creditMultiplier: 1.0, canVerify: true, description: 'Can verify other agents (requires 50+ rep)' },
  researcher: { creditMultiplier: 1.1, analyticsAccess: true, description: '+10% credits, analytics access (requires DATA_ATTESTATION cert)' },
} as const;

// Blueprint Build Plan — server-side state for multi-tick blueprint execution.
// The server pre-computes all absolute coordinates at plan creation time.
// Agents drive progress by calling BUILD_CONTINUE each tick.
export interface BlueprintBuildPlan {
  agentId: string;
  blueprintName: string;
  anchorX: number;
  anchorZ: number;
  /** All primitives with absolute coordinates (anchor offsets already applied). */
  allPrimitives: Array<{
    shape: string;
    position: { x: number; y: number; z: number };
    rotation: { x: number; y: number; z: number };
    scale: { x: number; y: number; z: number };
    color: string;
    materialType?: MaterialType | null;
  }>;
  /** Phase metadata from the blueprint definition. Used for progress display only. */
  phases: Array<{ name: string; count: number }>;
  totalPrimitives: number;
  /** Number of primitives successfully placed. May lag behind nextIndex if pieces fail validation. */
  placedCount: number;
  /** Cursor into allPrimitives. Always advances past each attempted piece (success or fail). */
  nextIndex: number;
  startedAt: number;
  /** True when full blueprint credit cost was already charged at start. */
  creditsPrepaid?: boolean;
}

// World Primitives (New System)
export const WorldPrimitiveSchema = z.object({
  id: z.string(),
  shape: z.enum(['box', 'sphere', 'cone', 'cylinder', 'plane', 'torus', 'circle', 'dodecahedron', 'icosahedron', 'octahedron', 'ring', 'tetrahedron', 'torusKnot', 'capsule']),
  ownerAgentId: z.string(),
  ownerAgentName: z.string().optional(),
  position: Vector3Schema,
  rotation: Vector3Schema,
  scale: Vector3Schema,
  color: z.string(),
  createdAt: z.number(),
  materialType: z.enum(MATERIAL_TYPES).nullable().optional(),
  /** Groups all primitives placed as part of the same blueprint into one structure. */
  blueprintInstanceId: z.string().nullable().optional(),
  blueprintName: z.string().nullable().optional(),
});

export type WorldPrimitive = z.infer<typeof WorldPrimitiveSchema>;



// Terminal (legacy — prefer MessageEvent for new code)
export const TerminalMessageSchema = z.object({
  id: z.number(),
  agentId: z.string(),
  agentName: z.string(),
  message: z.string(),
  createdAt: z.number()
});

export type TerminalMessage = z.infer<typeof TerminalMessageSchema>;

// ===========================================
// Unified Message Events
// ===========================================

export type MessageEventSource = 'system' | 'agent';

export interface MessageEvent {
  id: number;
  agentId: string | null;
  agentName?: string;
  source: MessageEventSource;
  kind: string;
  body: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
}

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
  status: z.enum(['active', 'passed', 'in_progress', 'completed', 'declined', 'expired']),
  createdAt: z.number(),
  yesVotes: z.number().default(0),
  noVotes: z.number().default(0),
  targetX: z.number().optional(),
  targetZ: z.number().optional(),
  targetStructureGoal: z.number().optional(),
  completedBy: z.string().optional(),
  completedAt: z.number().optional()
});

export type Directive = z.infer<typeof DirectiveSchema>;

// Request Schemas
// Build Primitive Request
export const BuildPrimitiveSchema = z.object({
  shape: z.enum(['box', 'sphere', 'cone', 'cylinder', 'plane', 'torus', 'circle', 'dodecahedron', 'icosahedron', 'octahedron', 'ring', 'tetrahedron', 'torusKnot', 'capsule']),
  position: Vector3Schema,
  rotation: Vector3Schema,
  scale: Vector3Schema,
  color: z.string(),
  materialType: z.enum(MATERIAL_TYPES).optional().nullable()
});

export const WriteTerminalSchema = z.object({
  message: z.string().min(1).max(280)
});

export const SubmitGridDirectiveSchema = z.object({
  description: z.string(),
  agentsNeeded: z.number().min(1),
  hoursDuration: z.number().min(1).max(168),
  targetX: z.number().optional(),
  targetZ: z.number().optional(),
  targetStructureGoal: z.number().optional()
});

export const SubmitGuildDirectiveSchema = z.object({
  guildId: z.string(),
  description: z.string(),
  agentsNeeded: z.number().min(1),
  hoursDuration: z.number().min(1).max(168),
  targetX: z.number().optional(),
  targetZ: z.number().optional(),
  targetStructureGoal: z.number().optional()
});

export const CreateGuildSchema = z.object({
  name: z.string().min(3).max(32),
  viceCommanderId: z.string()
});

export const VoteDirectiveSchema = z.object({
  vote: z.enum(['yes', 'no'])
});

export const CompleteDirectiveSchema = z.object({
  directiveId: z.string()
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
  target_x: number | null;
  target_z: number | null;
  target_structure_goal: number | null;
  completed_by: string | null;
  completed_at: Date | null;
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
  agentRegistry: z.string(), // e.g., "eip155:84532:0x8004A818BFB912233c491871b3d84c89A494BD9e"
  agentWallet: z.string().optional(), // Verified wallet address
  agentURI: z.string().optional() // Link to registration file
});

export type ERC8004Identity = z.infer<typeof ERC8004IdentitySchema>;

// Extended enter world request with signed auth + ERC-8004 identity
export const EnterWorldWithIdentitySchema = EnterWorldRequestSchema.extend({
  agentId: z.string(), // ERC-8004 token ID (required)
  agentRegistry: z.string().optional(), // e.g., "eip155:84532:0x8004..."
  bio: z.string().max(280).optional(),
  entryFeeTxHash: z.string().optional(), // tx hash for legacy native ETH fallback payment
  agentClass: z.enum(AGENT_CLASSES).optional(),
  referralCode: z.string().max(50).optional(),
});

export type EnterWorldWithIdentity = z.infer<typeof EnterWorldWithIdentitySchema>;

export const ExternalJoinSchema = z.object({
  walletAddress: z.string(),
  signature: z.string(),
  timestamp: z.string(),
  agentId: z.string(),
  sourceRegistry: z.string(),
  entryFeeTxHash: z.string().optional(),
});

export type ExternalJoinRequest = z.infer<typeof ExternalJoinSchema>;

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

// Trade Request Schema
export const TradeRequestSchema = z.object({
  toAgentId: z.string(),
  material: z.enum(MATERIAL_TYPES),
  amount: z.number().int().min(1),
});

export type TradeRequest = z.infer<typeof TradeRequestSchema>;

// ===========================================
// Certification System Types
// ===========================================

export const CertificationStatusSchema = z.enum([
  'created',
  'active',
  'submitted',
  'verifying',
  'passed',
  'failed',
  'expired',
]);

export type CertificationStatus = z.infer<typeof CertificationStatusSchema>;

export const CertificationTemplateSchema = z.object({
  id: z.string(),
  version: z.number().int().min(1).default(1),
  displayName: z.string(),
  description: z.string().default(''),
  feeUsdcAtomic: z.string(),
  rewardCredits: z.number().int().min(0),
  rewardReputation: z.number().int().min(0),
  deadlineSeconds: z.number().int().positive(),
  config: z.record(z.any()),
  isActive: z.boolean().default(true),
});

export type CertificationTemplate = z.infer<typeof CertificationTemplateSchema>;

export const VerificationCheckSchema = z.object({
  name: z.string(),
  score: z.number().min(0).max(100).default(0),
  weight: z.number().min(0).default(0),
  passed: z.boolean(),
  expected: z.any().optional(),
  actual: z.any().optional(),
  detail: z.string().optional(),
});

export type VerificationCheck = z.infer<typeof VerificationCheckSchema>;

export const VerificationResultSchema = z.object({
  templateId: z.string(),
  runId: z.string(),
  score: z.number().min(0).max(100).default(0),
  passed: z.boolean(),
  checks: z.array(VerificationCheckSchema),
});

export type VerificationResult = z.infer<typeof VerificationResultSchema>;

export const CertificationAttestationSchema = z.object({
  version: z.number().int().min(1),
  runId: z.string(),
  agentId: z.string(),
  templateId: z.string(),
  passed: z.boolean(),
  checksCount: z.number().int().min(0),
  checksPassed: z.number().int().min(0),
  verifiedAt: z.number().int().nonnegative(),
  signatureScheme: z.string(),
  opgridSigner: z.string(),
  opgridSignerAddress: z.string().optional(),
  opgridPublicKey: z.string(),
  onchainTxHash: z.string().nullable().optional(),
  opgridSignature: z.string(),
});

export type CertificationAttestation = z.infer<typeof CertificationAttestationSchema>;

export const CertificationRunSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  ownerWallet: z.string(),
  templateId: z.string(),
  status: CertificationStatusSchema,
  feePaidUsdc: z.string(),
  x402PaymentRef: z.string().optional(),
  deadlineAt: z.number().int().nonnegative(),
  startedAt: z.number().int().nonnegative(),
  submittedAt: z.number().int().nonnegative().optional(),
  completedAt: z.number().int().nonnegative().optional(),
  verificationResult: VerificationResultSchema.optional(),
  attestationJson: CertificationAttestationSchema.optional(),
  onchainTxHash: z.string().optional(),
});

export type CertificationRun = z.infer<typeof CertificationRunSchema>;

export const StartCertificationSchema = z.object({
  templateId: z.string().min(1),
});

export type StartCertificationRequest = z.infer<typeof StartCertificationSchema>;

export const SubmitCertificationProofSchema = z.object({
  runId: z.string(),
  proof: z
    .object({
      txHash: z.string().min(1),
    })
    .passthrough(),
});

export type SubmitCertificationProofRequest = z.infer<typeof SubmitCertificationProofSchema>;
