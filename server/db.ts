import pg from 'pg';
import type {
  Agent,
  AgentRow,
  WorldPrimitive,
  MessageEvent,
  MessageEventSource,
  Guild,
  Directive,
  GuildMemberRow,
  DirectiveVoteRow,
  BlueprintBuildPlan,
  AgentClass,
  MaterialType,
  MaterialCost,
  MaterialInventory,
} from './types.js';
import { CLASS_BONUSES, AGENT_CLASSES, MATERIAL_CONFIG, MATERIAL_TYPES } from './types.js';

const { Pool } = pg;

let pool: pg.Pool | null = null;
const DEFAULT_IN_MEMORY_BUILD_CREDITS = 500;
const MATERIAL_SET = new Set<string>(MATERIAL_TYPES);
const SWAP_EXECUTION_TEMPLATE_ID = 'SWAP_EXECUTION_V1';
const SWAP_EXECUTION_TEMPLATE_SEED = {
  id: SWAP_EXECUTION_TEMPLATE_ID,
  version: 4,
  displayName: 'Swap Execution V1',
  type: 'swap',
  description: 'Execute a token swap on Base Sepolia. You choose the DEX, routing, and execution strategy. Graded on multiple dimensions.',
  feeUsdcAtomic: '1000000',
  rewardCredits: 100,
  rewardReputation: 10,
  deadlineSeconds: 3600,
  config: {
    allowedTokenPairs: [
      [
        '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        '0x4200000000000000000000000000000000000006',
      ],
    ],
    maxGasLimit: 500000,
    expectedGas: 150000,
    passingScore: 70,
  } as Record<string, unknown>,
  challenge: {
    network: 'testnet',
    chain: { name: 'Base Sepolia', chainId: 84532 },
    objective: 'Swap at least 1 USDC for WETH on Base Sepolia. You choose the DEX, routing, and execution strategy.',
    constraints: {
      inputToken: { symbol: 'USDC', decimals: 6 },
      outputToken: { symbol: 'WETH', decimals: 18 },
      minInputAmount: '1000000',   // 1 USDC
      senderMustMatch: true,
    },
    rubric: [
      { dimension: 'execution', weight: 30, description: 'Transaction confirmed onchain (status=1).' },
      { dimension: 'route_validity', weight: 20, description: 'Correct token pair (USDC → WETH) transferred.' },
      { dimension: 'slippage_management', weight: 20, description: 'Non-zero slippage protection set. Tighter is better.' },
      { dimension: 'gas_efficiency', weight: 15, description: 'Gas usage. Lower is better.' },
      { dimension: 'speed', weight: 15, description: 'Time from cert start to tx confirmation. Faster is better.' },
    ],
    passingScore: 70,
    tools: [
      'EXECUTE_ONCHAIN — sign and send any transaction from your wallet',
      'APPROVE_TOKEN — approve a spender for ERC-20 tokens',
      'SUBMIT_CERTIFICATION_PROOF — submit your tx hash for grading',
    ],
    hints: {
      testnet: 'Base Sepolia testnet. Uniswap V3 is deployed here.',
      contracts: {
        USDC: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        WETH: '0x4200000000000000000000000000000000000006',
        SwapRouter02: '0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4',
        QuoterV2: '0xC5290058841028F1614F3A6F0F5816cAd0df5E27',
      },
      poolFee: 3000,
      flow: '1. APPROVE_TOKEN: token=0x036CbD53842c5426634e7929541eC2318f3dCF7e, spender=0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4, amount=1000000. 2. Use ENCODE_SWAP to get pre-built calldata. 3. EXECUTE_ONCHAIN: to=<router from encode-swap>, data=<calldata from encode-swap>, value=0. 4. SUBMIT_CERTIFICATION_PROOF: submit the swap tx hash.',
      encodeSwapEndpoint: 'POST /v1/certify/encode-swap — returns ready-to-use calldata. Send { recipient: YOUR_WALLET } and it returns { router, calldata, usage } with exact APPROVE_TOKEN and EXECUTE_ONCHAIN instructions. Use action ENCODE_SWAP to call this.',
      note: 'Use ENCODE_SWAP action to get pre-built calldata instead of manually encoding. Set amountOutMinimum > 0 for slippage protection — higher values score better.',
    },
    hintsEnabled: true,  // false on mainnet
    submission: {
      endpoint: 'POST /v1/certify/runs/{runId}/submit',
      body: '{ "runId": "<your run ID>", "proof": { "txHash": "<your tx hash>" } }',
    },
  } as Record<string, unknown>,
  isActive: true,
} as const;

type InMemoryAgent = Agent & { buildCredits?: number };
type CertificationStatus = 'created' | 'active' | 'submitted' | 'verifying' | 'passed' | 'failed' | 'expired';

export type DirectMessageFromType = 'human' | 'agent';

export interface DirectMessage {
  id: number;
  fromId: string;
  fromType: DirectMessageFromType;
  toAgentId: string;
  message: string;
  readAt?: number | null;
  createdAt: number;
}

export interface CertificationTemplateRecord {
  id: string;
  version: number;
  displayName: string;
  type: string;
  description: string;
  feeUsdcAtomic: string;
  rewardCredits: number;
  rewardReputation: number;
  deadlineSeconds: number;
  config: Record<string, unknown>;
  challenge: Record<string, unknown>;
  isActive: boolean;
}

export interface CertificationRunRecord {
  id: string;
  agentId: string;
  ownerWallet: string;
  templateId: string;
  status: CertificationStatus;
  feePaidUsdc: string;
  x402PaymentRef?: string;
  deadlineAt: number;
  startedAt: number;
  submittedAt?: number;
  completedAt?: number;
  verificationResult?: Record<string, unknown>;
  attestationJson?: Record<string, unknown>;
  onchainTxHash?: string;
}

export interface CertificationSubmissionRecord {
  id: number;
  runId: string;
  submittedAt: number;
  proof: Record<string, unknown>;
}

export interface CertificationVerificationRecord {
  id: number;
  runId: string;
  submissionId: number;
  templateId: string;
  passed: boolean;
  checks: unknown;
  verifiedAt: number;
}

export interface CertificationPayoutRecord {
  id: number;
  runId: string;
  payoutType: 'fee_collected' | 'credit_reward' | 'reputation_reward';
  amount: string;
  currency: 'USDC' | 'credits' | 'reputation';
  recipientAgentId?: string;
  recipientWallet?: string;
  onchainTxHash?: string;
}

function normalizeCertificationTemplateRecord(row: {
  id: string;
  version: number;
  display_name: string;
  type?: string | null;
  description: string | null;
  fee_usdc_atomic: string;
  reward_credits: number;
  reward_reputation: number;
  deadline_seconds: number;
  config: Record<string, unknown> | null;
  challenge?: Record<string, unknown> | null;
  is_active: boolean;
}): CertificationTemplateRecord {
  return {
    id: row.id,
    version: Number(row.version ?? 1),
    displayName: row.display_name,
    type: row.type ?? 'swap',
    description: row.description ?? '',
    feeUsdcAtomic: row.fee_usdc_atomic,
    rewardCredits: Number(row.reward_credits ?? 0),
    rewardReputation: Number(row.reward_reputation ?? 0),
    deadlineSeconds: Number(row.deadline_seconds ?? 0),
    config: (row.config ?? {}) as Record<string, unknown>,
    challenge: (row.challenge ?? {}) as Record<string, unknown>,
    isActive: Boolean(row.is_active),
  };
}

function normalizeCertificationRunRecord(row: {
  id: string;
  agent_id: string;
  owner_wallet: string;
  template_id: string;
  status: CertificationStatus;
  fee_paid_usdc: string;
  x402_payment_ref: string | null;
  deadline_at: Date;
  started_at: Date;
  submitted_at: Date | null;
  completed_at: Date | null;
  verification_result: Record<string, unknown> | null;
  attestation_json: Record<string, unknown> | null;
  onchain_tx_hash: string | null;
}): CertificationRunRecord {
  return {
    id: row.id,
    agentId: row.agent_id,
    ownerWallet: row.owner_wallet,
    templateId: row.template_id,
    status: row.status,
    feePaidUsdc: row.fee_paid_usdc,
    x402PaymentRef: row.x402_payment_ref || undefined,
    deadlineAt: new Date(row.deadline_at).getTime(),
    startedAt: new Date(row.started_at).getTime(),
    submittedAt: row.submitted_at ? new Date(row.submitted_at).getTime() : undefined,
    completedAt: row.completed_at ? new Date(row.completed_at).getTime() : undefined,
    verificationResult: row.verification_result || undefined,
    attestationJson: row.attestation_json || undefined,
    onchainTxHash: row.onchain_tx_hash || undefined,
  };
}

function seedInMemoryCertificationTemplate(): void {
  if (!inMemoryStore.certificationTemplates.has(SWAP_EXECUTION_TEMPLATE_ID)) {
    inMemoryStore.certificationTemplates.set(SWAP_EXECUTION_TEMPLATE_ID, {
      ...SWAP_EXECUTION_TEMPLATE_SEED,
      config: JSON.parse(JSON.stringify(SWAP_EXECUTION_TEMPLATE_SEED.config)) as Record<string, unknown>,
      challenge: JSON.parse(JSON.stringify(SWAP_EXECUTION_TEMPLATE_SEED.challenge)) as Record<string, unknown>,
    });
  }
}

function isMaterialType(value: string): value is MaterialType {
  return MATERIAL_SET.has(value);
}

function materialColumn(materialType: string): string | null {
  return isMaterialType(materialType) ? `mat_${materialType}` : null;
}

// In-memory fallback when no database is configured
const inMemoryStore = {
  agents: new Map<string, InMemoryAgent>(),
  worldState: new Map<string, unknown>(),
  messageEvents: [] as MessageEvent[],
  directMessages: [] as DirectMessage[],
  directives: new Map<string, Directive>(),
  directiveVotes: new Map<string, Map<string, string>>(), // directiveId -> agentId -> vote
  blueprintBuildPlans: new Map<string, { plan: BlueprintBuildPlan; updatedAt: number }>(),
  certificationTemplates: new Map<string, CertificationTemplateRecord>(),
  certificationRuns: new Map<string, CertificationRunRecord>(),
  certificationSubmissions: [] as CertificationSubmissionRecord[],
  certificationVerifications: [] as CertificationVerificationRecord[],
  certificationPayouts: [] as CertificationPayoutRecord[],
  nextMsgId: 1,
  nextDirectMessageId: 1,
  nextCertificationSubmissionId: 1,
  nextCertificationVerificationId: 1,
  nextCertificationPayoutId: 1,
};

export async function initDatabase(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    console.log('[DB] No DATABASE_URL found, using in-memory storage');
    seedInMemoryCertificationTemplate();
    return;
  }

  try {
    pool = new Pool({ connectionString });

    // Test connection
    await pool.query('SELECT NOW()');
    console.log('[DB] Connected to PostgreSQL');

    // Create tables if they don't exist
    await pool.query(`
      CREATE TABLE IF NOT EXISTS agents (
        id VARCHAR(255) PRIMARY KEY,
        owner_id VARCHAR(255) NOT NULL,
        x FLOAT DEFAULT 0,
        y FLOAT DEFAULT 0,
        visual_color VARCHAR(50) DEFAULT '#6b7280',
        visual_name VARCHAR(255) DEFAULT 'Agent',
        status VARCHAR(50) DEFAULT 'idle',
        last_active_at TIMESTAMP DEFAULT NOW(),
        inventory JSONB DEFAULT '{}'::jsonb,
        is_external BOOLEAN DEFAULT FALSE,
        source_chain_id INTEGER DEFAULT NULL,
        external_metadata JSONB DEFAULT '{}'::jsonb
      );

      CREATE TABLE IF NOT EXISTS world_state (
        key VARCHAR(255) PRIMARY KEY,
        value JSONB NOT NULL
      );

      CREATE TABLE IF NOT EXISTS reputation_feedback (
        id SERIAL PRIMARY KEY,
        from_agent_id VARCHAR(255) NOT NULL,
        to_agent_id VARCHAR(255) NOT NULL,
        value INTEGER NOT NULL,
        value_decimals SMALLINT DEFAULT 0,
        tag1 VARCHAR(100),
        tag2 VARCHAR(100),
        feedback_uri VARCHAR(500),
        created_at TIMESTAMP DEFAULT NOW(),
        revoked BOOLEAN DEFAULT FALSE
      );

      CREATE TABLE IF NOT EXISTS world_objects (
        id VARCHAR(255) PRIMARY KEY,
        type VARCHAR(50) NOT NULL,
        owner_agent_id VARCHAR(255) NOT NULL,
        x FLOAT NOT NULL,
        y FLOAT NOT NULL,
        z FLOAT NOT NULL,
        width FLOAT,
        length FLOAT,
        height FLOAT,
        radius FLOAT,
        color VARCHAR(50) NOT NULL,
        rotation FLOAT,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS world_primitives (
        id VARCHAR(255) PRIMARY KEY,
        shape VARCHAR(50) NOT NULL,
        owner_agent_id VARCHAR(255) NOT NULL,
        x FLOAT NOT NULL,
        y FLOAT NOT NULL,
        z FLOAT NOT NULL,
        rot_x FLOAT NOT NULL,
        rot_y FLOAT NOT NULL,
        rot_z FLOAT NOT NULL,
        scale_x FLOAT NOT NULL,
        scale_y FLOAT NOT NULL,
        scale_z FLOAT NOT NULL,
        color VARCHAR(50) NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        blueprint_instance_id VARCHAR(255) DEFAULT NULL,
        material_type VARCHAR(20) DEFAULT NULL
      );

      CREATE TABLE IF NOT EXISTS terminal_messages (
        id SERIAL PRIMARY KEY,
        agent_id VARCHAR(255) NOT NULL,
        agent_name VARCHAR(255) NOT NULL,
        message TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS chat_messages (
        id SERIAL PRIMARY KEY,
        agent_id VARCHAR(255) NOT NULL,
        agent_name VARCHAR(255) NOT NULL,
        message TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS message_events (
        id SERIAL PRIMARY KEY,
        agent_id VARCHAR(255),
        agent_name VARCHAR(255),
        source VARCHAR(20) NOT NULL DEFAULT 'system',
        kind VARCHAR(50) NOT NULL DEFAULT 'status',
        body TEXT NOT NULL,
        metadata JSONB DEFAULT '{}'::jsonb,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS agent_direct_messages (
        id SERIAL PRIMARY KEY,
        from_id VARCHAR(255) NOT NULL,
        from_type VARCHAR(20) NOT NULL DEFAULT 'human',
        to_agent_id VARCHAR(255) NOT NULL,
        message TEXT NOT NULL,
        read_at TIMESTAMP DEFAULT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS guilds (
        id VARCHAR(255) PRIMARY KEY,
        name VARCHAR(255) NOT NULL UNIQUE,
        commander_agent_id VARCHAR(255) NOT NULL,
        vice_commander_agent_id VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS guild_members (
        guild_id VARCHAR(255) NOT NULL,
        agent_id VARCHAR(255) NOT NULL,
        joined_at TIMESTAMP DEFAULT NOW(),
        PRIMARY KEY (guild_id, agent_id)
      );

      CREATE TABLE IF NOT EXISTS directives (
        id VARCHAR(255) PRIMARY KEY,
        type VARCHAR(50) NOT NULL,
        submitted_by VARCHAR(255) NOT NULL,
        guild_id VARCHAR(255),
        description TEXT NOT NULL,
        agents_needed INTEGER NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        status VARCHAR(50) DEFAULT 'active',
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS directive_votes (
        directive_id VARCHAR(255) NOT NULL,
        agent_id VARCHAR(255) NOT NULL,
        vote VARCHAR(10) NOT NULL,
        voted_at TIMESTAMP DEFAULT NOW(),
        PRIMARY KEY (directive_id, agent_id)
      );

      CREATE TABLE IF NOT EXISTS blueprint_build_plans (
        agent_id VARCHAR(255) PRIMARY KEY,
        plan_json JSONB NOT NULL,
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS certification_templates (
        id VARCHAR(100) PRIMARY KEY,
        version INTEGER NOT NULL DEFAULT 1,
        display_name VARCHAR(255) NOT NULL,
        type VARCHAR(50) NOT NULL DEFAULT 'swap',
        description TEXT NOT NULL DEFAULT '',
        fee_usdc_atomic VARCHAR(100) NOT NULL,
        reward_credits INTEGER NOT NULL DEFAULT 0,
        reward_reputation INTEGER NOT NULL DEFAULT 0,
        deadline_seconds INTEGER NOT NULL DEFAULT 3600,
        config JSONB NOT NULL DEFAULT '{}'::jsonb,
        challenge JSONB NOT NULL DEFAULT '{}'::jsonb,
        is_active BOOLEAN NOT NULL DEFAULT TRUE
      );

      CREATE TABLE IF NOT EXISTS certification_runs (
        id VARCHAR(255) PRIMARY KEY,
        agent_id VARCHAR(255) NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        owner_wallet VARCHAR(255) NOT NULL,
        template_id VARCHAR(100) NOT NULL REFERENCES certification_templates(id),
        status VARCHAR(50) NOT NULL,
        fee_paid_usdc VARCHAR(100) NOT NULL,
        x402_payment_ref TEXT,
        deadline_at TIMESTAMP NOT NULL,
        started_at TIMESTAMP DEFAULT NOW(),
        submitted_at TIMESTAMP,
        completed_at TIMESTAMP,
        verification_result JSONB,
        attestation_json JSONB,
        onchain_tx_hash VARCHAR(255)
      );

      CREATE TABLE IF NOT EXISTS certification_submissions (
        id SERIAL PRIMARY KEY,
        run_id VARCHAR(255) NOT NULL REFERENCES certification_runs(id) ON DELETE CASCADE,
        submitted_at TIMESTAMP DEFAULT NOW(),
        proof JSONB NOT NULL
      );

      CREATE TABLE IF NOT EXISTS certification_verifications (
        id SERIAL PRIMARY KEY,
        run_id VARCHAR(255) NOT NULL REFERENCES certification_runs(id) ON DELETE CASCADE,
        submission_id INTEGER NOT NULL REFERENCES certification_submissions(id) ON DELETE CASCADE,
        template_id VARCHAR(100) NOT NULL,
        passed BOOLEAN NOT NULL,
        checks JSONB NOT NULL,
        verified_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS certification_payouts (
        id SERIAL PRIMARY KEY,
        run_id VARCHAR(255) NOT NULL REFERENCES certification_runs(id) ON DELETE CASCADE,
        payout_type VARCHAR(50) NOT NULL CHECK (payout_type IN ('fee_collected', 'credit_reward', 'reputation_reward')),
        amount VARCHAR(100) NOT NULL,
        currency VARCHAR(20) NOT NULL CHECK (currency IN ('USDC', 'credits', 'reputation')),
        recipient_agent_id VARCHAR(255),
        recipient_wallet VARCHAR(255),
        onchain_tx_hash VARCHAR(255),
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Migrate columns for existing DBs (must run before index creation)
    await pool.query(`
      DO $$
      BEGIN
        ALTER TABLE agents ADD COLUMN IF NOT EXISTS erc8004_agent_id VARCHAR(255) DEFAULT NULL;
        ALTER TABLE agents ADD COLUMN IF NOT EXISTS erc8004_registry VARCHAR(255) DEFAULT NULL;
        ALTER TABLE agents ADD COLUMN IF NOT EXISTS reputation_score FLOAT DEFAULT 0;
        ALTER TABLE agents ADD COLUMN IF NOT EXISTS is_autonomous BOOLEAN DEFAULT FALSE;
        ALTER TABLE agents ADD COLUMN IF NOT EXISTS spawn_generation INTEGER DEFAULT 0;
        ALTER TABLE agents ADD COLUMN IF NOT EXISTS bio TEXT DEFAULT NULL;
        ALTER TABLE agents ADD COLUMN IF NOT EXISTS build_credits INTEGER DEFAULT 500;
        ALTER TABLE agents ADD COLUMN IF NOT EXISTS credits_last_reset TIMESTAMP DEFAULT NOW();
        ALTER TABLE agents ADD COLUMN IF NOT EXISTS entry_fee_paid BOOLEAN DEFAULT FALSE;
        ALTER TABLE agents ADD COLUMN IF NOT EXISTS entry_fee_tx VARCHAR(255) DEFAULT NULL;
        ALTER TABLE world_primitives ADD COLUMN IF NOT EXISTS blueprint_instance_id VARCHAR(255) DEFAULT NULL;
        ALTER TABLE directives ADD COLUMN IF NOT EXISTS target_x FLOAT DEFAULT NULL;
        ALTER TABLE directives ADD COLUMN IF NOT EXISTS target_z FLOAT DEFAULT NULL;
        ALTER TABLE directives ADD COLUMN IF NOT EXISTS target_structure_goal INTEGER DEFAULT NULL;
        ALTER TABLE directives ADD COLUMN IF NOT EXISTS completed_by VARCHAR(255) DEFAULT NULL;
        ALTER TABLE directives ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP DEFAULT NULL;
        ALTER TABLE agents ADD COLUMN IF NOT EXISTS agent_class VARCHAR(50) DEFAULT NULL;
        ALTER TABLE world_primitives ADD COLUMN IF NOT EXISTS blueprint_name VARCHAR(100) DEFAULT NULL;
        ALTER TABLE agents ADD COLUMN IF NOT EXISTS referral_code VARCHAR(50) DEFAULT NULL;
        ALTER TABLE agents ADD COLUMN IF NOT EXISTS profile_updated_at TIMESTAMP DEFAULT NULL;
        ALTER TABLE agents ADD COLUMN IF NOT EXISTS profile_update_count INTEGER DEFAULT 0;
        ALTER TABLE agents ADD COLUMN IF NOT EXISTS local_reputation INTEGER DEFAULT 0;
        ALTER TABLE agents ADD COLUMN IF NOT EXISTS primitives_placed INTEGER DEFAULT 0;
        ALTER TABLE agents ADD COLUMN IF NOT EXISTS successful_trades INTEGER DEFAULT 0;
        ALTER TABLE agents ADD COLUMN IF NOT EXISTS mat_stone INTEGER DEFAULT 0;
        ALTER TABLE agents ADD COLUMN IF NOT EXISTS mat_metal INTEGER DEFAULT 0;
        ALTER TABLE agents ADD COLUMN IF NOT EXISTS mat_glass INTEGER DEFAULT 0;
        ALTER TABLE agents ADD COLUMN IF NOT EXISTS mat_crystal INTEGER DEFAULT 0;
        ALTER TABLE agents ADD COLUMN IF NOT EXISTS mat_organic INTEGER DEFAULT 0;
        ALTER TABLE agents ADD COLUMN IF NOT EXISTS is_external BOOLEAN DEFAULT FALSE;
        ALTER TABLE agents ADD COLUMN IF NOT EXISTS source_chain_id INTEGER DEFAULT NULL;
        ALTER TABLE agents ADD COLUMN IF NOT EXISTS external_metadata JSONB DEFAULT '{}'::jsonb;
        ALTER TABLE world_primitives ADD COLUMN IF NOT EXISTS material_type VARCHAR(20) DEFAULT NULL;
        ALTER TABLE certification_templates ADD COLUMN IF NOT EXISTS type VARCHAR(50) NOT NULL DEFAULT 'swap';
        ALTER TABLE certification_templates ADD COLUMN IF NOT EXISTS challenge JSONB NOT NULL DEFAULT '{}'::jsonb;
      EXCEPTION WHEN others THEN NULL;
      END $$;
    `);

    // Entry fee tx hash tracking (prevents duplicate tx reuse)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS used_entry_tx_hashes (
        tx_hash VARCHAR(255) PRIMARY KEY,
        agent_id VARCHAR(255) NOT NULL,
        wallet_address VARCHAR(255) NOT NULL,
        verified_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Agent memory (bounded key-value store for visiting agents)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS agent_memory (
        agent_id VARCHAR(255) NOT NULL,
        key VARCHAR(100) NOT NULL,
        value JSONB NOT NULL,
        updated_at TIMESTAMP DEFAULT NOW(),
        PRIMARY KEY (agent_id, key)
      );
    `);

    // Referrals tracking
    await pool.query(`
      CREATE TABLE IF NOT EXISTS referrals (
        id SERIAL PRIMARY KEY,
        referrer_agent_id VARCHAR(255) NOT NULL,
        referee_agent_id VARCHAR(255) NOT NULL,
        credited_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(referee_agent_id)
      );
    `);

    // Create indexes (safe now that all columns exist)
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_agents_owner ON agents(owner_id);
      CREATE INDEX IF NOT EXISTS idx_agents_position ON agents(x, y);
      CREATE INDEX IF NOT EXISTS idx_agents_erc8004 ON agents(erc8004_agent_id);
      CREATE INDEX IF NOT EXISTS idx_agents_autonomous ON agents(is_autonomous);
      CREATE INDEX IF NOT EXISTS idx_reputation_to_agent ON reputation_feedback(to_agent_id);
      CREATE INDEX IF NOT EXISTS idx_reputation_from_agent ON reputation_feedback(from_agent_id);
      CREATE INDEX IF NOT EXISTS idx_chat_messages_created ON chat_messages(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_message_events_created ON message_events(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_message_events_source_kind ON message_events(source, kind, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_message_events_agent ON message_events(agent_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_dm_to_agent ON agent_direct_messages(to_agent_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_blueprint_build_plans_updated_at ON blueprint_build_plans(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_cert_runs_agent ON certification_runs(agent_id);
      CREATE INDEX IF NOT EXISTS idx_cert_runs_status ON certification_runs(status);
      CREATE INDEX IF NOT EXISTS idx_cert_runs_template ON certification_runs(template_id);
    `);

    // Unique case-insensitive agent name constraint
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_name_unique ON agents (LOWER(visual_name));
    `);

    // Unique referral code index
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_referral_code ON agents(referral_code) WHERE referral_code IS NOT NULL;
    `);

    await pool.query(
      `
      INSERT INTO certification_templates (
        id,
        version,
        display_name,
        type,
        description,
        fee_usdc_atomic,
        reward_credits,
        reward_reputation,
        deadline_seconds,
        config,
        challenge,
        is_active
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12)
      ON CONFLICT (id) DO UPDATE SET
        version = EXCLUDED.version,
        display_name = EXCLUDED.display_name,
        type = EXCLUDED.type,
        description = EXCLUDED.description,
        config = EXCLUDED.config,
        challenge = EXCLUDED.challenge
      `,
      [
        SWAP_EXECUTION_TEMPLATE_SEED.id,
        SWAP_EXECUTION_TEMPLATE_SEED.version,
        SWAP_EXECUTION_TEMPLATE_SEED.displayName,
        SWAP_EXECUTION_TEMPLATE_SEED.type,
        SWAP_EXECUTION_TEMPLATE_SEED.description,
        SWAP_EXECUTION_TEMPLATE_SEED.feeUsdcAtomic,
        SWAP_EXECUTION_TEMPLATE_SEED.rewardCredits,
        SWAP_EXECUTION_TEMPLATE_SEED.rewardReputation,
        SWAP_EXECUTION_TEMPLATE_SEED.deadlineSeconds,
        JSON.stringify(SWAP_EXECUTION_TEMPLATE_SEED.config),
        JSON.stringify(SWAP_EXECUTION_TEMPLATE_SEED.challenge),
        SWAP_EXECUTION_TEMPLATE_SEED.isActive,
      ],
    );

    console.log('[DB] Tables initialized');
  } catch (error) {
    console.error('[DB] Failed to connect to PostgreSQL, using in-memory storage:', error);
    pool = null;
  }
}

// Extended agent type with optional ERC-8004 and spawner fields
interface ExtendedAgent extends Agent {
  erc8004AgentId?: string;
  erc8004Registry?: string;
  reputationScore?: number;
  isAutonomous?: boolean;
  spawnGeneration?: number;
  agentClass?: string;
  isExternal?: boolean;
  sourceChainId?: number;
  externalMetadata?: Record<string, any>;
}

// Agent operations
export async function createAgent(agent: ExtendedAgent): Promise<ExtendedAgent> {
  if (!pool) {
    const inMemoryAgent: InMemoryAgent = {
      ...agent,
      buildCredits: (agent as any).buildCredits ?? DEFAULT_IN_MEMORY_BUILD_CREDITS,
    };
    inMemoryStore.agents.set(agent.id, inMemoryAgent);
    return inMemoryAgent as ExtendedAgent;
  }

  await pool.query(`
    INSERT INTO agents (
      id, owner_id, x, y, visual_color, visual_name, status, inventory,
      erc8004_agent_id, erc8004_registry, reputation_score, is_autonomous, spawn_generation,
      bio, agent_class, is_external, source_chain_id, external_metadata
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
    ON CONFLICT (id) DO UPDATE SET
      x = EXCLUDED.x,
      y = EXCLUDED.y,
      status = EXCLUDED.status,
      last_active_at = NOW(),
      erc8004_agent_id = COALESCE(EXCLUDED.erc8004_agent_id, agents.erc8004_agent_id),
      erc8004_registry = COALESCE(EXCLUDED.erc8004_registry, agents.erc8004_registry),
      bio = COALESCE(EXCLUDED.bio, agents.bio),
      agent_class = COALESCE(EXCLUDED.agent_class, agents.agent_class),
      is_external = COALESCE(EXCLUDED.is_external, agents.is_external),
      source_chain_id = COALESCE(EXCLUDED.source_chain_id, agents.source_chain_id),
      external_metadata = COALESCE(EXCLUDED.external_metadata, agents.external_metadata)
  `, [
    agent.id,
    (agent.ownerId || 'anonymous').toLowerCase(),
    agent.position.x,
    agent.position.z,
    agent.color,
    agent.name,
    agent.status,
    JSON.stringify(agent.inventory),
    agent.erc8004AgentId || null,
    agent.erc8004Registry || null,
    agent.reputationScore || 0,
    agent.isAutonomous || false,
    agent.spawnGeneration || 0,
    agent.bio || null,
    agent.agentClass || null,
    agent.isExternal || false,
    agent.sourceChainId || null,
    JSON.stringify(agent.externalMetadata || {})
  ]);

  return agent;
}

export async function getAgent(id: string): Promise<Agent | null> {
  if (!pool) {
    return inMemoryStore.agents.get(id) || null;
  }

  const result = await pool.query<AgentRow>(
    'SELECT * FROM agents WHERE id = $1',
    [id]
  );

  if (result.rows.length === 0) return null;
  return rowToAgent(result.rows[0]);
}

export async function getAgentByOwnerId(ownerId: string): Promise<Agent | null> {
  // Normalize to lowercase for case-insensitive Ethereum address matching
  const normalizedId = ownerId.toLowerCase();

  if (!pool) {
    for (const agent of inMemoryStore.agents.values()) {
      if (agent.ownerId?.toLowerCase() === normalizedId) return agent;
    }
    return null;
  }

  const result = await pool.query<AgentRow>(
    'SELECT * FROM agents WHERE LOWER(owner_id) = $1',
    [normalizedId]
  );

  if (result.rows.length === 0) return null;
  return rowToAgent(result.rows[0]);
}

/** Case-insensitive agent name lookup. */
export async function getAgentByName(name: string): Promise<Agent | null> {
  const normalizedName = name.toLowerCase();

  if (!pool) {
    for (const agent of inMemoryStore.agents.values()) {
      if (agent.name?.toLowerCase() === normalizedName) return agent;
    }
    return null;
  }

  const result = await pool.query<AgentRow>(
    'SELECT * FROM agents WHERE LOWER(visual_name) = $1',
    [normalizedName]
  );

  if (result.rows.length === 0) return null;
  return rowToAgent(result.rows[0]);
}

export async function getAllAgents(): Promise<Agent[]> {
  if (!pool) {
    return Array.from(inMemoryStore.agents.values());
  }

  const result = await pool.query<AgentRow>('SELECT * FROM agents');
  return result.rows.map(rowToAgent);
}

export async function getAgentsInRadius(centerX: number, centerZ: number, radius: number): Promise<Agent[]> {
  if (!pool) {
    return Array.from(inMemoryStore.agents.values()).filter(agent => {
      const dx = agent.position.x - centerX;
      const dz = agent.position.z - centerZ;
      return Math.sqrt(dx * dx + dz * dz) <= radius;
    });
  }

  const result = await pool.query<AgentRow>(`
    SELECT * FROM agents
    WHERE SQRT(POWER(x - $1, 2) + POWER(y - $2, 2)) <= $3
  `, [centerX, centerZ, radius]);

  return result.rows.map(rowToAgent);
}

export async function updateAgent(id: string, updates: Partial<Agent>): Promise<Agent | null> {
  if (!pool) {
    const existing = inMemoryStore.agents.get(id);
    if (!existing) return null;
    const updated = { ...existing, ...updates };
    inMemoryStore.agents.set(id, updated);
    return updated;
  }

  const setClauses: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  if (updates.position) {
    setClauses.push(`x = $${paramIndex++}`);
    values.push(updates.position.x);
    setClauses.push(`y = $${paramIndex++}`);
    values.push(updates.position.z);
  }
  if (updates.status) {
    setClauses.push(`status = $${paramIndex++}`);
    values.push(updates.status);
  }
  if (updates.inventory) {
    setClauses.push(`inventory = $${paramIndex++}`);
    values.push(JSON.stringify(updates.inventory));
  }

  setClauses.push(`last_active_at = NOW()`);
  values.push(id);

  const result = await pool.query<AgentRow>(`
    UPDATE agents SET ${setClauses.join(', ')}
    WHERE id = $${paramIndex}
    RETURNING *
  `, values);

  if (result.rows.length === 0) return null;
  return rowToAgent(result.rows[0]);
}

export async function updateAgentProfile(
  agentId: string,
  updates: { name?: string; color?: string; bio?: string; agentClass?: string },
  newUpdateCount: number
): Promise<void> {
  if (!pool) return;
  const setClauses: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  if (updates.name !== undefined) {
    setClauses.push(`visual_name = $${paramIndex++}`);
    values.push(updates.name);
  }
  if (updates.color !== undefined) {
    setClauses.push(`visual_color = $${paramIndex++}`);
    values.push(updates.color);
  }
  if (updates.bio !== undefined) {
    setClauses.push(`bio = $${paramIndex++}`);
    values.push(updates.bio);
  }
  if (updates.agentClass !== undefined) {
    setClauses.push(`agent_class = $${paramIndex++}`);
    values.push(updates.agentClass);
  }

  setClauses.push(`profile_update_count = $${paramIndex++}`);
  values.push(newUpdateCount);

  setClauses.push(`profile_updated_at = NOW()`);

  if (setClauses.length === 0) return; // Nothing to update

  values.push(agentId);
  await pool.query(`
    UPDATE agents SET ${setClauses.join(', ')}
    WHERE id = $${paramIndex}
  `, values);
}

export async function deleteAgent(id: string): Promise<boolean> {
  if (!pool) {
    return inMemoryStore.agents.delete(id);
  }

  const result = await pool.query('DELETE FROM agents WHERE id = $1', [id]);
  return (result.rowCount ?? 0) > 0;
}

// World state operations
export async function getWorldValue<T>(key: string): Promise<T | null> {
  if (!pool) {
    return (inMemoryStore.worldState.get(key) as T) || null;
  }

  const result = await pool.query<{ value: T }>(
    'SELECT value FROM world_state WHERE key = $1',
    [key]
  );

  return result.rows[0]?.value || null;
}

export async function setWorldValue<T>(key: string, value: T): Promise<void> {
  if (!pool) {
    inMemoryStore.worldState.set(key, value);
    return;
  }

  await pool.query(`
    INSERT INTO world_state (key, value)
    VALUES ($1, $2)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
  `, [key, JSON.stringify(value)]);
}

// Helper function to convert database row to Agent
function rowToAgent(row: AgentRow): Agent & {
  erc8004AgentId?: string;
  erc8004Registry?: string;
  reputationScore?: number;
  localReputation?: number;
  combinedReputation?: number;
  isAutonomous?: boolean;
  spawnGeneration?: number;
  buildCredits?: number;
  entry_fee_paid?: boolean;
  entry_fee_tx?: string;
  agentClass?: string;
  referralCode?: string;
  profileUpdatedAt?: Date;
  profileUpdateCount?: number;
  primitivesPlaced?: number;
  successfulTrades?: number;
  lastActiveAt?: Date;
  materials?: MaterialInventory;
  isExternal?: boolean;
  sourceChainId?: number;
  externalMetadata?: Record<string, any>;
} {
  const onChainReputation = typeof row.reputation_score === 'number' ? row.reputation_score : 0;
  const localReputation = typeof row.local_reputation === 'number' ? row.local_reputation : 0;
  return {
    id: row.id,
    name: row.visual_name,
    color: row.visual_color,
    position: { x: row.x, y: 0, z: row.y },
    targetPosition: { x: row.x, y: 0, z: row.y },
    status: row.status as 'idle' | 'moving' | 'acting',
    inventory: row.inventory || {},
    ownerId: row.owner_id,
    bio: row.bio || undefined,
    // ERC-8004 fields
    erc8004AgentId: row.erc8004_agent_id || undefined,
    erc8004Registry: row.erc8004_registry || undefined,
    reputationScore: onChainReputation,
    localReputation,
    combinedReputation: onChainReputation + localReputation,
    // Spawner fields
    isAutonomous: row.is_autonomous || false,
    spawnGeneration: row.spawn_generation || 0,
    // Credits
    buildCredits: row.build_credits ?? 500,
    // Entry fee
    entry_fee_paid: (row as any).entry_fee_paid ?? false,
    entry_fee_tx: (row as any).entry_fee_tx || undefined,
    // Class
    agentClass: row.agent_class || undefined,
    // Referral
    referralCode: row.referral_code || undefined,
    profileUpdatedAt: row.profile_updated_at || undefined,
    profileUpdateCount: typeof row.profile_update_count === 'number' ? row.profile_update_count : 0,
    primitivesPlaced: typeof row.primitives_placed === 'number' ? row.primitives_placed : 0,
    successfulTrades: typeof row.successful_trades === 'number' ? row.successful_trades : 0,
    lastActiveAt: row.last_active_at || undefined,
    isExternal: row.is_external || false,
    sourceChainId: row.source_chain_id || undefined,
    externalMetadata: row.external_metadata || undefined,
    materials: {
      stone: row.mat_stone ?? 0,
      metal: row.mat_metal ?? 0,
      glass: row.mat_glass ?? 0,
      crystal: row.mat_crystal ?? 0,
      organic: row.mat_organic ?? 0,
    }
  };
}

// ===========================================
// Reputation Operations (ERC-8004)
// ===========================================

export interface FeedbackRecord {
  id: number;
  fromAgentId: string;
  toAgentId: string;
  value: number;
  valueDecimals: number;
  tag1?: string;
  tag2?: string;
  feedbackUri?: string;
  createdAt: Date;
  revoked: boolean;
}

export async function giveFeedback(
  fromAgentId: string,
  toAgentId: string,
  value: number,
  valueDecimals: number = 0,
  tag1?: string,
  tag2?: string,
  feedbackUri?: string
): Promise<FeedbackRecord | null> {
  if (!pool) {
    console.log('[DB] Reputation feedback skipped (in-memory mode)');
    return null;
  }

  // Prevent self-feedback (ERC-8004 requirement)
  if (fromAgentId === toAgentId) {
    throw new Error('Self-feedback is not allowed');
  }

  const result = await pool.query<{ id: number; created_at: Date }>(`
    INSERT INTO reputation_feedback (from_agent_id, to_agent_id, value, value_decimals, tag1, tag2, feedback_uri)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING id, created_at
  `, [fromAgentId, toAgentId, value, valueDecimals, tag1, tag2, feedbackUri]);

  // Update agent's aggregate reputation score
  await updateReputationScore(toAgentId);

  return {
    id: result.rows[0].id,
    fromAgentId,
    toAgentId,
    value,
    valueDecimals,
    tag1,
    tag2,
    feedbackUri,
    createdAt: result.rows[0].created_at,
    revoked: false
  };
}

export async function getReputationSummary(
  agentId: string,
  tag1?: string,
  tag2?: string
): Promise<{ count: number; summaryValue: number; summaryValueDecimals: number }> {
  if (!pool) {
    return { count: 0, summaryValue: 0, summaryValueDecimals: 0 };
  }

  let query = `
    SELECT COUNT(*) as count, COALESCE(SUM(value), 0) as sum_value
    FROM reputation_feedback
    WHERE to_agent_id = $1 AND revoked = FALSE
  `;
  const params: (string | undefined)[] = [agentId];

  if (tag1) {
    query += ` AND tag1 = $${params.length + 1}`;
    params.push(tag1);
  }
  if (tag2) {
    query += ` AND tag2 = $${params.length + 1}`;
    params.push(tag2);
  }

  const result = await pool.query<{ count: string; sum_value: string }>(query, params);

  return {
    count: parseInt(result.rows[0].count, 10),
    summaryValue: parseInt(result.rows[0].sum_value, 10),
    summaryValueDecimals: 0
  };
}

export async function getFeedbackForAgent(
  agentId: string,
  includeRevoked: boolean = false
): Promise<FeedbackRecord[]> {
  if (!pool) {
    return [];
  }

  let query = `
    SELECT * FROM reputation_feedback
    WHERE to_agent_id = $1
  `;
  if (!includeRevoked) {
    query += ' AND revoked = FALSE';
  }
  query += ' ORDER BY created_at DESC';

  const result = await pool.query(query, [agentId]);

  return result.rows.map(row => ({
    id: row.id,
    fromAgentId: row.from_agent_id,
    toAgentId: row.to_agent_id,
    value: row.value,
    valueDecimals: row.value_decimals,
    tag1: row.tag1,
    tag2: row.tag2,
    feedbackUri: row.feedback_uri,
    createdAt: row.created_at,
    revoked: row.revoked
  }));
}

export async function revokeFeedback(
  fromAgentId: string,
  feedbackId: number
): Promise<boolean> {
  if (!pool) {
    return false;
  }

  const result = await pool.query(`
    UPDATE reputation_feedback
    SET revoked = TRUE
    WHERE id = $1 AND from_agent_id = $2
    RETURNING to_agent_id
  `, [feedbackId, fromAgentId]);

  if (result.rows.length > 0) {
    // Recalculate target agent's reputation
    await updateReputationScore(result.rows[0].to_agent_id);
    return true;
  }
  return false;
}

async function updateReputationScore(agentId: string): Promise<void> {
  if (!pool) return;

  await pool.query(`
    UPDATE agents
    SET reputation_score = COALESCE((
      SELECT SUM(value)::float / GREATEST(COUNT(*), 1)
      FROM reputation_feedback
      WHERE to_agent_id = $1 AND revoked = FALSE
    ), 0)
    WHERE id = $1
  `, [agentId]);
}

export async function addLocalReputation(agentId: string, amount: number): Promise<void> {
  if (!pool) return;
  await pool.query(`
    UPDATE agents
    SET local_reputation = COALESCE(local_reputation, 0) + $1
    WHERE id = $2
  `, [amount, agentId]);
}

export async function getCombinedReputation(agentId: string): Promise<number> {
  if (!pool) {
    const agent = inMemoryStore.agents.get(agentId) as any;
    const chain = typeof agent?.reputationScore === 'number' ? agent.reputationScore : 0;
    const local = typeof agent?.localReputation === 'number' ? agent.localReputation : 0;
    return chain + local;
  }
  const result = await pool.query<{ reputation_score: number; local_reputation: number }>(
    'SELECT COALESCE(reputation_score, 0) AS reputation_score, COALESCE(local_reputation, 0) AS local_reputation FROM agents WHERE id = $1',
    [agentId]
  );
  if (result.rows.length === 0) return 0;
  return (result.rows[0].reputation_score || 0) + (result.rows[0].local_reputation || 0);
}

export async function incrementPrimitivesPlaced(agentId: string, count: number): Promise<number> {
  if (count <= 0) return 0;
  if (!pool) {
    const agent = inMemoryStore.agents.get(agentId) as any;
    if (!agent) return 0;
    const nextValue = (typeof agent.primitivesPlaced === 'number' ? agent.primitivesPlaced : 0) + count;
    agent.primitivesPlaced = nextValue;
    inMemoryStore.agents.set(agentId, agent);
    return nextValue;
  }
  const result = await pool.query<{ primitives_placed: number }>(
    `UPDATE agents
     SET primitives_placed = COALESCE(primitives_placed, 0) + $1
     WHERE id = $2
     RETURNING primitives_placed`,
    [count, agentId]
  );
  if (result.rows.length === 0) return 0;
  return result.rows[0].primitives_placed ?? 0;
}

export async function incrementSuccessfulTrades(agentId: string): Promise<number> {
  if (!pool) {
    const agent = inMemoryStore.agents.get(agentId) as any;
    if (!agent) return 0;
    const nextValue = (typeof agent.successfulTrades === 'number' ? agent.successfulTrades : 0) + 1;
    agent.successfulTrades = nextValue;
    inMemoryStore.agents.set(agentId, agent);
    return nextValue;
  }
  const result = await pool.query<{ successful_trades: number }>(
    `UPDATE agents
     SET successful_trades = COALESCE(successful_trades, 0) + 1
     WHERE id = $1
     RETURNING successful_trades`,
    [agentId]
  );
  if (result.rows.length === 0) return 0;
  return result.rows[0].successful_trades ?? 0;
}


// ===========================================
// World Primitives (New System)
// ===========================================

export async function createWorldPrimitive(primitive: WorldPrimitive): Promise<WorldPrimitive> {
  if (!pool) return primitive;
  await pool.query(
    `INSERT INTO world_primitives (id, shape, owner_agent_id, x, y, z, rot_x, rot_y, rot_z, scale_x, scale_y, scale_z, color, created_at, blueprint_instance_id, blueprint_name, material_type)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, TO_TIMESTAMP($14 / 1000.0), $15, $16, $17)`,
    [
      primitive.id,
      primitive.shape,
      primitive.ownerAgentId,
      primitive.position.x, primitive.position.y, primitive.position.z,
      primitive.rotation.x, primitive.rotation.y, primitive.rotation.z,
      primitive.scale.x, primitive.scale.y, primitive.scale.z,
      primitive.color,
      primitive.createdAt,
      primitive.blueprintInstanceId || null,
      primitive.blueprintName || null,
      primitive.materialType || null,
    ]
  );
  return primitive;
}

export type CreatePrimitiveWithCreditResult =
  | { ok: true; repReward?: number; totalBuilt?: number; materialEarned?: MaterialType | null }
  | { ok: false; reason: 'insufficient_credits' | 'db_error' };

/**
 * Atomically debit credits and insert a primitive in a single DB transaction.
 * This prevents "free primitive" races under concurrent requests.
 */
export async function createWorldPrimitiveWithCreditDebit(
  primitive: WorldPrimitive,
  creditCost: number,
): Promise<CreatePrimitiveWithCreditResult> {
  if (!pool) {
    const agent = inMemoryStore.agents.get(primitive.ownerAgentId);
    if (!agent) {
      return { ok: false, reason: 'db_error' };
    }

    const currentCredits = agent.buildCredits ?? DEFAULT_IN_MEMORY_BUILD_CREDITS;
    if (currentCredits < creditCost) {
      return { ok: false, reason: 'insufficient_credits' };
    }

    agent.buildCredits = currentCredits - creditCost;
    const totalBuilt = ((agent as any).primitivesPlaced || 0) + 1;
    (agent as any).primitivesPlaced = totalBuilt;
    // Certification-first economy: primitive placement no longer grants reputation.
    const repReward = 0;
    let materialEarned: MaterialType | null = null;
    if (totalBuilt % MATERIAL_CONFIG.EARN_EVERY_N_PRIMITIVES === 0) {
      materialEarned = MATERIAL_TYPES[Math.floor(Math.random() * MATERIAL_TYPES.length)];
      const matKey = `mat_${materialEarned}`;
      (agent as any)[matKey] = ((agent as any)[matKey] || 0) + 1;
    }
    inMemoryStore.agents.set(agent.id, agent);
    return { ok: true, repReward, totalBuilt, materialEarned };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const debit = await client.query(
      'UPDATE agents SET build_credits = build_credits - $1 WHERE id = $2 AND build_credits >= $1',
      [creditCost, primitive.ownerAgentId]
    );

    if ((debit.rowCount ?? 0) === 0) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'insufficient_credits' };
    }

    await client.query(
      `INSERT INTO world_primitives (id, shape, owner_agent_id, x, y, z, rot_x, rot_y, rot_z, scale_x, scale_y, scale_z, color, created_at, blueprint_instance_id, blueprint_name, material_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, TO_TIMESTAMP($14 / 1000.0), $15, $16, $17)`,
      [
        primitive.id,
        primitive.shape,
        primitive.ownerAgentId,
        primitive.position.x, primitive.position.y, primitive.position.z,
        primitive.rotation.x, primitive.rotation.y, primitive.rotation.z,
        primitive.scale.x, primitive.scale.y, primitive.scale.z,
        primitive.color,
        primitive.createdAt,
        primitive.blueprintInstanceId || null,
        primitive.blueprintName || null,
        primitive.materialType || null,
      ]
    );

    const countRes = await client.query<{ primitives_placed: number }>(
      `UPDATE agents
       SET primitives_placed = COALESCE(primitives_placed, 0) + 1
       WHERE id = $1
       RETURNING primitives_placed`,
      [primitive.ownerAgentId]
    );
    const totalBuilt = countRes.rows[0]?.primitives_placed ?? 0;

    // Certification-first economy: primitive placement no longer grants reputation.
    const repReward = 0;

    let materialEarned: MaterialType | null = null;
    if (totalBuilt > 0 && totalBuilt % MATERIAL_CONFIG.EARN_EVERY_N_PRIMITIVES === 0) {
      materialEarned = MATERIAL_TYPES[Math.floor(Math.random() * MATERIAL_TYPES.length)];
      const earnedCol = materialColumn(materialEarned);
      if (earnedCol) {
        await client.query(
          `UPDATE agents SET ${earnedCol} = COALESCE(${earnedCol}, 0) + 1 WHERE id = $1`,
          [primitive.ownerAgentId]
        );
      }
    }

    await client.query('COMMIT');
    return { ok: true, repReward, totalBuilt, materialEarned };
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Ignore rollback errors; original failure is returned below.
    }
    console.error('[DB] createWorldPrimitiveWithCreditDebit failed:', error);
    return { ok: false, reason: 'db_error' };
  } finally {
    client.release();
  }
}

export async function deleteWorldPrimitive(id: string): Promise<boolean> {
  if (!pool) return true;
  const result = await pool.query('DELETE FROM world_primitives WHERE id = $1', [id]);
  return (result.rowCount ?? 0) > 0;
}

export async function getWorldPrimitive(id: string): Promise<WorldPrimitive | null> {
  if (!pool) return null;
  const result = await pool.query(
    `SELECT wp.*, a.visual_name AS owner_agent_name
     FROM world_primitives wp
     LEFT JOIN agents a ON a.id = wp.owner_agent_id
     WHERE wp.id = $1`,
    [id]
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    id: row.id,
    shape: row.shape,
    ownerAgentId: row.owner_agent_id,
    ownerAgentName: row.owner_agent_name || row.owner_agent_id,
    position: { x: row.x, y: row.y, z: row.z },
    rotation: { x: row.rot_x, y: row.rot_y, z: row.rot_z },
    scale: { x: row.scale_x, y: row.scale_y, z: row.scale_z },
    color: row.color,
    createdAt: new Date(row.created_at).getTime(),
    materialType: row.material_type || null,
    blueprintInstanceId: row.blueprint_instance_id || null,
    blueprintName: row.blueprint_name || null,
  };
}

export async function getAllWorldPrimitives(): Promise<WorldPrimitive[]> {
  if (!pool) return [];
  const result = await pool.query(
    `SELECT wp.*, a.visual_name AS owner_agent_name
     FROM world_primitives wp
     LEFT JOIN agents a ON a.id = wp.owner_agent_id
     ORDER BY wp.created_at ASC`
  );
  return result.rows.map(row => ({
    id: row.id,
    shape: row.shape,
    ownerAgentId: row.owner_agent_id,
    ownerAgentName: row.owner_agent_name || row.owner_agent_id,
    position: { x: row.x, y: row.y, z: row.z },
    rotation: { x: row.rot_x, y: row.rot_y, z: row.rot_z },
    scale: { x: row.scale_x, y: row.scale_y, z: row.scale_z },
    color: row.color,
    createdAt: new Date(row.created_at).getTime(),
    materialType: row.material_type || null,
    blueprintInstanceId: row.blueprint_instance_id || null,
    blueprintName: row.blueprint_name || null,
  }));
}

// ===========================================
// Blueprint Build Plans (Persistence Layer)
// ===========================================

export type PersistedBlueprintBuildPlan = {
  agentId: string;
  plan: BlueprintBuildPlan;
  updatedAt: number;
};

function parseBlueprintBuildPlanJson(value: unknown): BlueprintBuildPlan | null {
  if (!value) return null;
  if (typeof value === 'object') return value as BlueprintBuildPlan;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as BlueprintBuildPlan;
    } catch {
      return null;
    }
  }
  return null;
}

export async function upsertBlueprintBuildPlan(agentId: string, plan: BlueprintBuildPlan): Promise<void> {
  if (!pool) {
    inMemoryStore.blueprintBuildPlans.set(agentId, { plan, updatedAt: Date.now() });
    return;
  }

  await pool.query(
    `
      INSERT INTO blueprint_build_plans (agent_id, plan_json, updated_at)
      VALUES ($1, $2::jsonb, NOW())
      ON CONFLICT (agent_id) DO UPDATE SET
        plan_json = EXCLUDED.plan_json,
        updated_at = NOW()
    `,
    [agentId, JSON.stringify(plan)],
  );
}

export async function deleteBlueprintBuildPlan(agentId: string): Promise<void> {
  if (!pool) {
    inMemoryStore.blueprintBuildPlans.delete(agentId);
    return;
  }

  await pool.query('DELETE FROM blueprint_build_plans WHERE agent_id = $1', [agentId]);
}

export async function listBlueprintBuildPlansUpdatedSince(cutoffMs: number): Promise<PersistedBlueprintBuildPlan[]> {
  if (!pool) {
    const out: PersistedBlueprintBuildPlan[] = [];
    for (const [agentId, entry] of inMemoryStore.blueprintBuildPlans.entries()) {
      if (entry.updatedAt >= cutoffMs) {
        out.push({ agentId, plan: entry.plan, updatedAt: entry.updatedAt });
      }
    }
    // Most recent first.
    out.sort((a, b) => b.updatedAt - a.updatedAt);
    return out;
  }

  const cutoff = new Date(cutoffMs);
  const result = await pool.query<{ agent_id: string; plan_json: unknown; updated_at: Date }>(
    'SELECT agent_id, plan_json, updated_at FROM blueprint_build_plans WHERE updated_at >= $1 ORDER BY updated_at DESC',
    [cutoff],
  );

  const out: PersistedBlueprintBuildPlan[] = [];
  for (const row of result.rows) {
    const plan = parseBlueprintBuildPlanJson(row.plan_json);
    if (!plan) continue;
    out.push({
      agentId: row.agent_id,
      plan,
      updatedAt: new Date(row.updated_at).getTime(),
    });
  }
  return out;
}

export async function deleteBlueprintBuildPlansOlderThan(cutoffMs: number): Promise<number> {
  if (!pool) {
    let removed = 0;
    for (const [agentId, entry] of inMemoryStore.blueprintBuildPlans.entries()) {
      if (entry.updatedAt < cutoffMs) {
        inMemoryStore.blueprintBuildPlans.delete(agentId);
        removed += 1;
      }
    }
    return removed;
  }

  const cutoff = new Date(cutoffMs);
  const result = await pool.query('DELETE FROM blueprint_build_plans WHERE updated_at < $1', [cutoff]);
  return result.rowCount ?? 0;
}

// ===========================================
// World Objects (Legacy)
// ===========================================

// Legacy terminal/chat helpers removed — use insertMessageEvent / getRecentMessageEvents

// ===========================================
// Unified Message Events
// ===========================================

export async function insertMessageEvent(event: {
  agentId?: string | null;
  agentName?: string;
  source: MessageEventSource;
  kind: string;
  body: string;
  metadata?: Record<string, unknown>;
}): Promise<MessageEvent> {
  if (!pool) {
    const saved: MessageEvent = {
      id: inMemoryStore.nextMsgId++,
      agentId: event.agentId || null,
      agentName: event.agentName,
      source: event.source,
      kind: event.kind,
      body: event.body,
      metadata: event.metadata || {},
      createdAt: Date.now(),
    };
    inMemoryStore.messageEvents.push(saved);
    if (inMemoryStore.messageEvents.length > 200) inMemoryStore.messageEvents.shift();
    return saved;
  }
  const nowMs = Date.now();
  const result = await pool.query(
    `INSERT INTO message_events (agent_id, agent_name, source, kind, body, metadata, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7::double precision / 1000))
     RETURNING id`,
    [event.agentId || null, event.agentName || null, event.source, event.kind, event.body, JSON.stringify(event.metadata || {}), nowMs]
  );
  return {
    id: result.rows[0].id,
    agentId: event.agentId || null,
    agentName: event.agentName,
    source: event.source,
    kind: event.kind,
    body: event.body,
    metadata: event.metadata || {},
    createdAt: nowMs,
  };
}

export async function getRecentMessageEvents(limit = 50): Promise<MessageEvent[]> {
  if (!pool) {
    return inMemoryStore.messageEvents.slice(-limit);
  }
  const result = await pool.query(
    'SELECT *, EXTRACT(EPOCH FROM created_at) * 1000 AS created_at_ms FROM message_events ORDER BY created_at DESC LIMIT $1',
    [limit]
  );
  return result.rows.reverse().map(row => ({
    id: row.id,
    agentId: row.agent_id,
    agentName: row.agent_name,
    source: row.source as MessageEventSource,
    kind: row.kind,
    body: row.body,
    metadata: row.metadata || {},
    createdAt: Math.round(Number(row.created_at_ms)),
  }));
}

// Human-Agent direct messages (REST inbox polling)
export async function sendDirectMessage(
  fromId: string,
  fromType: DirectMessageFromType,
  toAgentId: string,
  message: string
): Promise<DirectMessage> {
  const normalizedType: DirectMessageFromType = fromType === 'agent' ? 'agent' : 'human';
  const normalizedMessage = String(message || '').trim();
  const TTL_MS = 24 * 60 * 60 * 1000;
  const MAX_PER_AGENT = 50;

  if (!pool) {
    const now = Date.now();
    const cutoff = now - TTL_MS;
    inMemoryStore.directMessages = inMemoryStore.directMessages.filter((dm) => dm.createdAt >= cutoff);

    const saved: DirectMessage = {
      id: inMemoryStore.nextDirectMessageId++,
      fromId,
      fromType: normalizedType,
      toAgentId,
      message: normalizedMessage,
      readAt: null,
      createdAt: now,
    };
    inMemoryStore.directMessages.push(saved);

    const recipient = inMemoryStore.directMessages
      .filter((dm) => dm.toAgentId === toAgentId)
      .sort((a, b) => b.createdAt - a.createdAt);

    if (recipient.length > MAX_PER_AGENT) {
      const keepIds = new Set(recipient.slice(0, MAX_PER_AGENT).map((dm) => dm.id));
      inMemoryStore.directMessages = inMemoryStore.directMessages.filter(
        (dm) => dm.toAgentId !== toAgentId || keepIds.has(dm.id)
      );
    }

    return saved;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `DELETE FROM agent_direct_messages
       WHERE created_at < NOW() - INTERVAL '24 hours'`
    );

    const inserted = await client.query<{ id: number; created_at: Date }>(
      `INSERT INTO agent_direct_messages (from_id, from_type, to_agent_id, message)
       VALUES ($1, $2, $3, $4)
       RETURNING id, created_at`,
      [fromId, normalizedType, toAgentId, normalizedMessage]
    );

    await client.query(
      `DELETE FROM agent_direct_messages
       WHERE to_agent_id = $1
         AND id NOT IN (
           SELECT id
           FROM agent_direct_messages
           WHERE to_agent_id = $1
           ORDER BY created_at DESC
           LIMIT ${MAX_PER_AGENT}
         )`,
      [toAgentId]
    );

    await client.query('COMMIT');

    return {
      id: inserted.rows[0].id,
      fromId,
      fromType: normalizedType,
      toAgentId,
      message: normalizedMessage,
      readAt: null,
      createdAt: inserted.rows[0].created_at.getTime(),
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function getAgentInbox(agentId: string, unreadOnly = false): Promise<DirectMessage[]> {
  const limit = 50;

  if (!pool) {
    return inMemoryStore.directMessages
      .filter((dm) => dm.toAgentId === agentId && (!unreadOnly || !dm.readAt))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
  }

  const params: unknown[] = [agentId, limit];
  const unreadClause = unreadOnly ? 'AND read_at IS NULL' : '';
  const result = await pool.query<{
    id: number;
    from_id: string;
    from_type: string;
    to_agent_id: string;
    message: string;
    read_at: Date | null;
    created_at: Date;
  }>(
    `SELECT id, from_id, from_type, to_agent_id, message, read_at, created_at
     FROM agent_direct_messages
     WHERE to_agent_id = $1
       ${unreadClause}
     ORDER BY created_at DESC
     LIMIT $2`,
    params
  );

  return result.rows.map((row) => ({
    id: row.id,
    fromId: row.from_id,
    fromType: row.from_type === 'agent' ? 'agent' : 'human',
    toAgentId: row.to_agent_id,
    message: row.message,
    readAt: row.read_at ? row.read_at.getTime() : null,
    createdAt: row.created_at.getTime(),
  }));
}

export async function markDMsRead(agentId: string, messageIds: number[]): Promise<number> {
  const dedupedIds = Array.from(
    new Set(
      messageIds
        .map((id) => Number(id))
        .filter((id) => Number.isInteger(id) && id > 0)
    )
  );
  if (dedupedIds.length === 0) return 0;

  if (!pool) {
    let updated = 0;
    const now = Date.now();
    inMemoryStore.directMessages = inMemoryStore.directMessages.map((dm) => {
      if (dm.toAgentId === agentId && dedupedIds.includes(dm.id) && !dm.readAt) {
        updated += 1;
        return { ...dm, readAt: now };
      }
      return dm;
    });
    return updated;
  }

  const result = await pool.query(
    `UPDATE agent_direct_messages
     SET read_at = NOW()
     WHERE to_agent_id = $1
       AND id = ANY($2::int[])
       AND read_at IS NULL`,
    [agentId, dedupedIds]
  );

  return result.rowCount ?? 0;
}

// Guilds
export async function createGuild(guild: Guild, members: string[]): Promise<Guild> {
  if (!pool) return guild;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    await client.query(
      `INSERT INTO guilds (id, name, commander_agent_id, vice_commander_agent_id, created_at)
       VALUES ($1, $2, $3, $4, to_timestamp($5/1000.0))`,
      [guild.id, guild.name, guild.commanderAgentId, guild.viceCommanderAgentId, guild.createdAt]
    );

    for (const memberId of members) {
      await client.query(
        'INSERT INTO guild_members (guild_id, agent_id) VALUES ($1, $2)',
        [guild.id, memberId]
      );
    }

    await client.query('COMMIT');
    return guild;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function getAllGuilds(): Promise<Guild[]> {
  if (!pool) return [];
  const result = await pool.query(`
    SELECT g.*, COUNT(gm.agent_id) as member_count 
    FROM guilds g
    LEFT JOIN guild_members gm ON g.id = gm.guild_id
    GROUP BY g.id
  `);
  return result.rows.map(row => ({
    id: row.id,
    name: row.name,
    commanderAgentId: row.commander_agent_id,
    viceCommanderAgentId: row.vice_commander_agent_id,
    createdAt: new Date(row.created_at).getTime(),
    memberCount: parseInt(row.member_count)
  }));
}

export async function getGuild(id: string): Promise<Guild | null> {
  if (!pool) return null;
  const result = await pool.query(`
    SELECT g.*, COUNT(gm.agent_id) as member_count 
    FROM guilds g
    LEFT JOIN guild_members gm ON g.id = gm.guild_id
    WHERE g.id = $1
    GROUP BY g.id
  `, [id]);
  
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    id: row.id,
    name: row.name,
    commanderAgentId: row.commander_agent_id,
    viceCommanderAgentId: row.vice_commander_agent_id,
    createdAt: new Date(row.created_at).getTime(),
    memberCount: parseInt(row.member_count)
  };
}

export async function getAgentGuild(agentId: string): Promise<string | null> {
  if (!pool) return null;
  const result = await pool.query(
    'SELECT guild_id FROM guild_members WHERE agent_id = $1',
    [agentId]
  );
  return result.rows.length > 0 ? result.rows[0].guild_id : null;
}

export async function addGuildMember(guildId: string, agentId: string): Promise<boolean> {
  if (!pool) return false;
  const result = await pool.query(
    `INSERT INTO guild_members (guild_id, agent_id)
     VALUES ($1, $2)
     ON CONFLICT (guild_id, agent_id) DO NOTHING
     RETURNING agent_id`,
    [guildId, agentId]
  );
  return result.rows.length > 0;
}

// Directives
export async function createDirective(directive: Directive): Promise<Directive> {
  if (!pool) {
    inMemoryStore.directives.set(directive.id, directive);
    return directive;
  }
  await pool.query(
    `INSERT INTO directives (id, type, submitted_by, guild_id, description, agents_needed, expires_at, status, created_at, target_x, target_z, target_structure_goal)
     VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7/1000.0), $8, to_timestamp($9/1000.0), $10, $11, $12)`,
    [directive.id, directive.type, directive.submittedBy, directive.guildId || null, directive.description, directive.agentsNeeded, directive.expiresAt, directive.status, directive.createdAt, directive.targetX ?? null, directive.targetZ ?? null, directive.targetStructureGoal ?? null]
  );
  return directive;
}

export async function getActiveDirectives(): Promise<Directive[]> {
  if (!pool) {
    const now = Date.now();
    return Array.from(inMemoryStore.directives.values())
      .filter(d => ['active', 'passed', 'in_progress'].includes(d.status) && d.expiresAt > now)
      .map(d => {
        // Compute vote counts from in-memory votes
        const votes = inMemoryStore.directiveVotes.get(d.id);
        let yesVotes = 0, noVotes = 0;
        if (votes) {
          for (const v of votes.values()) {
            if (v === 'yes') yesVotes++;
            else if (v === 'no') noVotes++;
          }
        }
        return { ...d, yesVotes, noVotes };
      });
  }
  const result = await pool.query(`
    SELECT d.*,
      COUNT(DISTINCT CASE WHEN v.vote = 'yes' THEN v.agent_id END) as yes_votes,
      COUNT(DISTINCT CASE WHEN v.vote = 'no' THEN v.agent_id END) as no_votes
    FROM directives d
    LEFT JOIN directive_votes v ON d.id = v.directive_id
    WHERE d.status IN ('active', 'passed', 'in_progress')
    GROUP BY d.id
  `);

  return result.rows.map(row => ({
    id: row.id,
    type: row.type as 'grid' | 'guild' | 'bounty',
    submittedBy: row.submitted_by,
    guildId: row.guild_id || undefined,
    description: row.description,
    agentsNeeded: row.agents_needed,
    expiresAt: new Date(row.expires_at).getTime(),
    status: row.status as Directive['status'],
    createdAt: new Date(row.created_at).getTime(),
    yesVotes: parseInt(row.yes_votes),
    noVotes: parseInt(row.no_votes),
    targetX: row.target_x ?? undefined,
    targetZ: row.target_z ?? undefined,
    targetStructureGoal: row.target_structure_goal ?? undefined,
    completedBy: row.completed_by ?? undefined,
    completedAt: row.completed_at ? new Date(row.completed_at).getTime() : undefined
  }));
}

export async function castVote(directiveId: string, agentId: string, vote: 'yes' | 'no'): Promise<void> {
  if (!pool) {
    if (!inMemoryStore.directiveVotes.has(directiveId)) {
      inMemoryStore.directiveVotes.set(directiveId, new Map());
    }
    inMemoryStore.directiveVotes.get(directiveId)!.set(agentId, vote);
    return;
  }
  await pool.query(
    `INSERT INTO directive_votes (directive_id, agent_id, vote)
     VALUES ($1, $2, $3)
     ON CONFLICT (directive_id, agent_id) DO UPDATE SET vote = EXCLUDED.vote, voted_at = NOW()`,
    [directiveId, agentId, vote]
  );
}

// Directive helpers
export async function getDirective(id: string): Promise<Directive | null> {
  if (!pool) {
    const d = inMemoryStore.directives.get(id);
    if (!d) return null;
    const votes = inMemoryStore.directiveVotes.get(id);
    let yesVotes = 0, noVotes = 0;
    if (votes) {
      for (const v of votes.values()) {
        if (v === 'yes') yesVotes++;
        else if (v === 'no') noVotes++;
      }
    }
    return { ...d, yesVotes, noVotes };
  }
  const result = await pool.query(`
    SELECT d.*,
      COUNT(DISTINCT CASE WHEN v.vote = 'yes' THEN v.agent_id END) as yes_votes,
      COUNT(DISTINCT CASE WHEN v.vote = 'no' THEN v.agent_id END) as no_votes
    FROM directives d
    LEFT JOIN directive_votes v ON d.id = v.directive_id
    WHERE d.id = $1
    GROUP BY d.id
  `, [id]);

  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    id: row.id,
    type: row.type as 'grid' | 'guild' | 'bounty',
    submittedBy: row.submitted_by,
    guildId: row.guild_id || undefined,
    description: row.description,
    agentsNeeded: row.agents_needed,
    expiresAt: new Date(row.expires_at).getTime(),
    status: row.status as Directive['status'],
    createdAt: new Date(row.created_at).getTime(),
    yesVotes: parseInt(row.yes_votes),
    noVotes: parseInt(row.no_votes),
    targetX: row.target_x ?? undefined,
    targetZ: row.target_z ?? undefined,
    targetStructureGoal: row.target_structure_goal ?? undefined,
    completedBy: row.completed_by ?? undefined,
    completedAt: row.completed_at ? new Date(row.completed_at).getTime() : undefined
  };
}

export async function expireAllDirectives(): Promise<number> {
  if (!pool) {
    let count = 0;
    for (const d of inMemoryStore.directives.values()) {
      if (['active', 'passed', 'in_progress'].includes(d.status)) { d.status = 'expired'; count++; }
    }
    return count;
  }
  const result = await pool.query("UPDATE directives SET status = 'expired' WHERE status IN ('active', 'passed', 'in_progress')");
  const count = result.rowCount ?? 0;
  console.log(`[DB] Force-expired ${count} directive(s)`);
  return count;
}

export async function expireDirectives(): Promise<number> {
  if (!pool) {
    const now = Date.now();
    let count = 0;
    for (const [id, d] of inMemoryStore.directives) {
      if (d.expiresAt < now && ['active', 'passed', 'in_progress'].includes(d.status)) {
        d.status = 'expired';
        count++;
      }
    }
    if (count > 0) console.log(`[DB] Expired ${count} directive(s)`);
    return count;
  }
  const result = await pool.query(`
    UPDATE directives
    SET status = 'expired'
    WHERE expires_at < NOW() AND status IN ('active', 'passed', 'in_progress')
  `);
  const count = result.rowCount ?? 0;
  if (count > 0) {
    console.log(`[DB] Expired ${count} directive(s)`);
  }
  return count;
}

// Credits
export async function getAgentCredits(agentId: string): Promise<number> {
  if (!pool) {
    const agent = inMemoryStore.agents.get(agentId);
    return agent?.buildCredits ?? DEFAULT_IN_MEMORY_BUILD_CREDITS;
  }
  const result = await pool.query('SELECT build_credits FROM agents WHERE id = $1', [agentId]);
  return result.rows[0]?.build_credits ?? 500;
}

export async function deductCredits(agentId: string, amount: number): Promise<boolean> {
  if (!pool) {
    const agent = inMemoryStore.agents.get(agentId);
    if (!agent) return false;
    const currentCredits = agent.buildCredits ?? DEFAULT_IN_MEMORY_BUILD_CREDITS;
    if (currentCredits < amount) return false;
    agent.buildCredits = currentCredits - amount;
    inMemoryStore.agents.set(agentId, agent);
    return true;
  }
  const result = await pool.query(
    'UPDATE agents SET build_credits = build_credits - $1 WHERE id = $2 AND build_credits >= $1',
    [amount, agentId]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function resetDailyCredits(soloAmount: number, creditCap: number, externalAmount: number = 500): Promise<void> {
  if (!pool) return;
  const guildMultiplier = 1.5;
  const builderMultiplier = CLASS_BONUSES.builder.creditMultiplier; // 1.2

  // External visitors always reset to their lower daily credit pool.
  await pool.query(
    `UPDATE agents SET build_credits = LEAST($1::integer, $2::integer), credits_last_reset = NOW()
     WHERE credits_last_reset < NOW() - INTERVAL '24 hours'
     AND COALESCE(is_external, FALSE) = TRUE`,
    [Math.round(externalAmount), Math.round(externalAmount)]
  );

  // Solo non-builder agents: base amount, capped
  await pool.query(
    `UPDATE agents SET build_credits = LEAST($1::integer, $2::integer), credits_last_reset = NOW()
     WHERE credits_last_reset < NOW() - INTERVAL '24 hours'
     AND COALESCE(is_external, FALSE) = FALSE
     AND id NOT IN (SELECT agent_id FROM guild_members)
     AND (agent_class IS NULL OR agent_class != 'builder')`,
    [Math.round(soloAmount), Math.round(creditCap)]
  );
  // Solo builder agents: 1.2x amount, capped
  await pool.query(
    `UPDATE agents SET build_credits = LEAST($1::integer, $2::integer), credits_last_reset = NOW()
     WHERE credits_last_reset < NOW() - INTERVAL '24 hours'
     AND COALESCE(is_external, FALSE) = FALSE
     AND id NOT IN (SELECT agent_id FROM guild_members)
     AND agent_class = 'builder'`,
    [Math.round(soloAmount * builderMultiplier), Math.round(creditCap)]
  );
  // Guild non-builder agents: 1.5x multiplier, capped
  await pool.query(
    `UPDATE agents SET build_credits = LEAST($1::integer, $2::integer), credits_last_reset = NOW()
     WHERE credits_last_reset < NOW() - INTERVAL '24 hours'
     AND COALESCE(is_external, FALSE) = FALSE
     AND id IN (SELECT agent_id FROM guild_members)
     AND (agent_class IS NULL OR agent_class != 'builder')`,
    [Math.round(soloAmount * guildMultiplier), Math.round(creditCap)]
  );
  // Guild builder agents: 1.5x * 1.2x multiplier, capped
  await pool.query(
    `UPDATE agents SET build_credits = LEAST($1::integer, $2::integer), credits_last_reset = NOW()
     WHERE credits_last_reset < NOW() - INTERVAL '24 hours'
     AND COALESCE(is_external, FALSE) = FALSE
     AND id IN (SELECT agent_id FROM guild_members)
     AND agent_class = 'builder'`,
    [Math.round(soloAmount * guildMultiplier * builderMultiplier), Math.round(creditCap)]
  );
}

// --- Directive Lifecycle Functions ---

/** Transition directive to 'passed' (enough yes votes). */
export async function passDirective(directiveId: string): Promise<void> {
  if (!pool) {
    const d = inMemoryStore.directives.get(directiveId);
    if (d) d.status = 'passed';
    return;
  }
  await pool.query(
    "UPDATE directives SET status = 'passed' WHERE id = $1",
    [directiveId]
  );
}

/** Auto-transition directive to 'in_progress' (agents are working on it). */
export async function activateDirective(directiveId: string): Promise<void> {
  if (!pool) {
    const d = inMemoryStore.directives.get(directiveId);
    if (d && d.status === 'passed') d.status = 'in_progress';
    return;
  }
  await pool.query(
    "UPDATE directives SET status = 'in_progress' WHERE id = $1 AND status = 'passed'",
    [directiveId]
  );
}

/** Decline directive (enough no votes). */
export async function declineDirective(directiveId: string): Promise<void> {
  if (!pool) {
    const d = inMemoryStore.directives.get(directiveId);
    if (d) d.status = 'declined';
    return;
  }
  await pool.query(
    "UPDATE directives SET status = 'declined' WHERE id = $1",
    [directiveId]
  );
}

/** Complete directive — objective achieved. */
export async function completeDirective(directiveId: string, completedByAgentId?: string): Promise<void> {
  if (!pool) {
    const d = inMemoryStore.directives.get(directiveId);
    if (d) {
      d.status = 'completed';
      if (completedByAgentId) {
        d.completedBy = completedByAgentId;
        d.completedAt = Date.now();
      }
    }
    return;
  }
  await pool.query(
    "UPDATE directives SET status = 'completed', completed_by = $2, completed_at = NOW() WHERE id = $1",
    [directiveId, completedByAgentId || null]
  );
}

/** Get the first unresolved directive submitted by an agent (submitter lock). */
export async function getAgentActiveDirective(agentId: string): Promise<Directive | null> {
  if (!pool) {
    for (const d of inMemoryStore.directives.values()) {
      if (d.submittedBy === agentId && ['active', 'passed', 'in_progress'].includes(d.status)) {
        return d;
      }
    }
    return null;
  }
  const result = await pool.query(`
    SELECT d.*,
      COUNT(DISTINCT CASE WHEN v.vote = 'yes' THEN v.agent_id END) as yes_votes,
      COUNT(DISTINCT CASE WHEN v.vote = 'no' THEN v.agent_id END) as no_votes
    FROM directives d
    LEFT JOIN directive_votes v ON d.id = v.directive_id
    WHERE d.submitted_by = $1 AND d.status IN ('active', 'passed', 'in_progress')
    GROUP BY d.id
    LIMIT 1
  `, [agentId]);

  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    id: row.id,
    type: row.type as 'grid' | 'guild' | 'bounty',
    submittedBy: row.submitted_by,
    guildId: row.guild_id || undefined,
    description: row.description,
    agentsNeeded: row.agents_needed,
    expiresAt: new Date(row.expires_at).getTime(),
    status: row.status as Directive['status'],
    createdAt: new Date(row.created_at).getTime(),
    yesVotes: parseInt(row.yes_votes),
    noVotes: parseInt(row.no_votes),
    targetX: row.target_x ?? undefined,
    targetZ: row.target_z ?? undefined,
    targetStructureGoal: row.target_structure_goal ?? undefined,
    completedBy: row.completed_by ?? undefined,
    completedAt: row.completed_at ? new Date(row.completed_at).getTime() : undefined
  };
}

export async function rewardDirectiveVoters(directiveId: string, creditAmount: number): Promise<void> {
  if (!pool) return;
  // Add credits to all yes-voters on this directive
  await pool.query(
    `UPDATE agents SET build_credits = build_credits + $1
     WHERE id IN (SELECT agent_id FROM directive_votes WHERE directive_id = $2 AND vote = 'yes')`,
    [creditAmount, directiveId]
  );
}

/** Add credits to an agent, clamped at the hard cap. */
export async function addCreditsWithCap(agentId: string, amount: number, cap: number): Promise<void> {
  if (!pool) {
    const agent = inMemoryStore.agents.get(agentId);
    if (agent) {
      agent.buildCredits = Math.min((agent.buildCredits ?? 0) + amount, cap);
      inMemoryStore.agents.set(agentId, agent);
    }
    return;
  }
  await pool.query(
    'UPDATE agents SET build_credits = LEAST(build_credits + $1, $3) WHERE id = $2',
    [amount, agentId, cap]
  );
}

// --- Credit Transfer ---

export async function transferCredits(fromAgentId: string, toAgentId: string, amount: number, cap: number): Promise<void> {
  if (!pool) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const deduct = await client.query(
      'UPDATE agents SET build_credits = build_credits - $1 WHERE id = $2 AND build_credits >= $1',
      [amount, fromAgentId]
    );
    if ((deduct.rowCount ?? 0) === 0) {
      throw new Error('Insufficient credits for transfer');
    }
    await client.query(
      'UPDATE agents SET build_credits = LEAST(build_credits + $1, $3) WHERE id = $2',
      [amount, toAgentId, cap]
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// --- Referrals ---

export function generateReferralCode(agentName: string, agentId: string): string {
  // Sanitize name: lowercase, replace non-alphanumeric with dash, trim
  const safeName = agentName.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 20);
  return `ref_${safeName}_${agentId.slice(-6)}`;
}

export async function setReferralCode(agentId: string, code: string): Promise<void> {
  if (!pool) return;
  await pool.query(
    'UPDATE agents SET referral_code = $1 WHERE id = $2',
    [code, agentId]
  );
}

export async function getAgentByReferralCode(code: string): Promise<Agent | null> {
  if (!pool) return null;
  const result = await pool.query<AgentRow>(
    'SELECT * FROM agents WHERE referral_code = $1',
    [code]
  );
  if (result.rows.length === 0) return null;
  return rowToAgent(result.rows[0]);
}

export async function recordReferral(referrerAgentId: string, refereeAgentId: string): Promise<boolean> {
  if (!pool) return false;
  try {
    await pool.query(
      'INSERT INTO referrals (referrer_agent_id, referee_agent_id) VALUES ($1, $2) ON CONFLICT (referee_agent_id) DO NOTHING',
      [referrerAgentId, refereeAgentId]
    );
    return true;
  } catch {
    return false;
  }
}

export async function getReferralStats(agentId: string): Promise<{ referralCount: number; creditsEarned: number }> {
  if (!pool) return { referralCount: 0, creditsEarned: 0 };
  const result = await pool.query(
    'SELECT COUNT(*) as count FROM referrals WHERE referrer_agent_id = $1',
    [agentId]
  );
  const count = parseInt(result.rows[0]?.count ?? '0', 10);
  return {
    referralCount: count,
    creditsEarned: count * 250, // REFERRAL_BONUS_CREDITS
  };
}

// --- Entry Fee ---

export async function isEntryFeePaid(agentId: string): Promise<boolean> {
  if (!pool) return false;
  const result = await pool.query('SELECT entry_fee_paid FROM agents WHERE id = $1', [agentId]);
  return result.rows[0]?.entry_fee_paid ?? false;
}

export async function markEntryFeePaid(agentId: string, txHash: string): Promise<void> {
  if (!pool) return;
  await pool.query(
    'UPDATE agents SET entry_fee_paid = TRUE, entry_fee_tx = $1 WHERE id = $2',
    [txHash, agentId]
  );
}

export async function isTxHashUsed(txHash: string): Promise<boolean> {
  if (!pool) return false;
  const result = await pool.query('SELECT tx_hash FROM used_entry_tx_hashes WHERE LOWER(tx_hash) = $1', [txHash.toLowerCase()]);
  return (result.rows.length ?? 0) > 0;
}

export async function recordUsedTxHash(txHash: string, agentId: string, walletAddress: string): Promise<void> {
  if (!pool) return;
  await pool.query(
    'INSERT INTO used_entry_tx_hashes (tx_hash, agent_id, wallet_address) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
    [txHash.toLowerCase(), agentId, walletAddress.toLowerCase()]
  );
}

// --- Agent Memory (bounded key-value store) ---

const MAX_MEMORY_KEYS = 10;
const MAX_MEMORY_VALUE_BYTES = 10 * 1024; // 10KB

export async function getAgentMemory(agentId: string): Promise<Record<string, unknown>> {
  if (!pool) return {};
  const result = await pool.query(
    'SELECT key, value FROM agent_memory WHERE agent_id = $1 ORDER BY updated_at DESC',
    [agentId]
  );
  const memory: Record<string, unknown> = {};
  for (const row of result.rows) {
    memory[row.key] = row.value;
  }
  return memory;
}

export async function setAgentMemory(agentId: string, key: string, value: unknown): Promise<{ ok: boolean; error?: string }> {
  if (!pool) return { ok: false, error: 'No database' };

  // Check value size
  const serialized = JSON.stringify(value);
  if (serialized.length > MAX_MEMORY_VALUE_BYTES) {
    return { ok: false, error: `Value too large (${serialized.length} bytes, max ${MAX_MEMORY_VALUE_BYTES})` };
  }

  // Check key count (allow update of existing keys)
  const existing = await pool.query(
    'SELECT key FROM agent_memory WHERE agent_id = $1',
    [agentId]
  );
  const existingKeys = existing.rows.map((r: { key: string }) => r.key);
  if (!existingKeys.includes(key) && existingKeys.length >= MAX_MEMORY_KEYS) {
    return { ok: false, error: `Too many keys (max ${MAX_MEMORY_KEYS}). Delete one first.` };
  }

  await pool.query(
    `INSERT INTO agent_memory (agent_id, key, value, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (agent_id, key) DO UPDATE SET value = $3, updated_at = NOW()`,
    [agentId, key, JSON.stringify(value)]
  );
  return { ok: true };
}

export async function deleteAgentMemory(agentId: string, key: string): Promise<boolean> {
  if (!pool) return false;
  const result = await pool.query(
    'DELETE FROM agent_memory WHERE agent_id = $1 AND key = $2',
    [agentId, key]
  );
  return (result.rowCount ?? 0) > 0;
}

// --- Build History ---

export async function getAgentBuilds(agentId: string): Promise<unknown[]> {
  if (!pool) return [];
  const result = await pool.query(
    'SELECT * FROM world_primitives WHERE owner_agent_id = $1 ORDER BY created_at DESC LIMIT 200',
    [agentId]
  );
  return result.rows;
}

// --- Admin Wipe Functions ---

export async function clearAllWorldPrimitives(): Promise<number> {
  if (!pool) return 0;
  const result = await pool.query('DELETE FROM world_primitives');
  const count = result.rowCount ?? 0;
  console.log(`[DB] Cleared ${count} world primitives`);
  return count;
}

export async function resetAllAgentCredits(amount: number): Promise<number> {
  if (!pool) return 0;
  const result = await pool.query('UPDATE agents SET build_credits = $1, credits_last_reset = NOW()', [amount]);
  const count = result.rowCount ?? 0;
  console.log(`[DB] Reset ${count} agents to ${amount} credits`);
  return count;
}

export async function clearAllAgentMemory(): Promise<number> {
  if (!pool) return 0;
  const result = await pool.query('DELETE FROM agent_memory');
  const count = result.rowCount ?? 0;
  console.log(`[DB] Cleared ${count} agent memory entries`);
  return count;
}

// --- Materials Functions ---

export async function getAgentMaterials(agentId: string): Promise<MaterialInventory> {
  if (!pool) {
    const inMemoryAgent = inMemoryStore.agents.get(agentId) as any;
    return {
      stone: inMemoryAgent?.mat_stone ?? 0,
      metal: inMemoryAgent?.mat_metal ?? 0,
      glass: inMemoryAgent?.mat_glass ?? 0,
      crystal: inMemoryAgent?.mat_crystal ?? 0,
      organic: inMemoryAgent?.mat_organic ?? 0,
    };
  }
  const result = await pool.query(
    'SELECT mat_stone, mat_metal, mat_glass, mat_crystal, mat_organic FROM agents WHERE id = $1',
    [agentId]
  );
  if (result.rows.length === 0) {
    return { stone: 0, metal: 0, glass: 0, crystal: 0, organic: 0 };
  }
  const row = result.rows[0];
  return {
    stone: row.mat_stone ?? 0,
    metal: row.mat_metal ?? 0,
    glass: row.mat_glass ?? 0,
    crystal: row.mat_crystal ?? 0,
    organic: row.mat_organic ?? 0
  };
}

export async function addMaterial(agentId: string, materialType: string, amount: number): Promise<void> {
  if (amount <= 0) return;
  const col = materialColumn(materialType);
  if (!col) throw new Error(`Invalid material type: ${materialType}`);

  if (!pool) {
    const inMemoryAgent = inMemoryStore.agents.get(agentId) as any;
    if (!inMemoryAgent) return;
    inMemoryAgent[col] = (inMemoryAgent[col] || 0) + amount;
    inMemoryStore.agents.set(agentId, inMemoryAgent);
    return;
  }

  await pool.query(`UPDATE agents SET ${col} = COALESCE(${col}, 0) + $1 WHERE id = $2`, [amount, agentId]);
}

export async function addRandomMaterial(agentId: string): Promise<MaterialType | null> {
  const materialType = MATERIAL_TYPES[Math.floor(Math.random() * MATERIAL_TYPES.length)];
  await addMaterial(agentId, materialType, 1);
  return materialType;
}

export async function deductMaterials(agentId: string, costs: MaterialCost): Promise<boolean> {
  if (!pool) {
    const inMemoryAgent = inMemoryStore.agents.get(agentId) as any;
    if (!inMemoryAgent) return false;
    for (const [mat, amount] of Object.entries(costs)) {
      if (!amount || amount <= 0) continue;
      const col = materialColumn(mat);
      if (!col) return false;
      if ((inMemoryAgent[col] || 0) < amount) return false;
    }
    for (const [mat, amount] of Object.entries(costs)) {
      if (!amount || amount <= 0) continue;
      const col = materialColumn(mat);
      if (!col) return false;
      inMemoryAgent[col] = (inMemoryAgent[col] || 0) - amount;
    }
    inMemoryStore.agents.set(agentId, inMemoryAgent);
    return true;
  }
  
  const updates: string[] = [];
  const checks: string[] = [];
  const values: unknown[] = [agentId];
  let paramIdx = 2; // $1 is agentId

  for (const [mat, amount] of Object.entries(costs)) {
    if (!amount || amount <= 0) continue;
    const col = materialColumn(mat);
    if (!col) return false;
    updates.push(`${col} = ${col} - $${paramIdx}`);
    checks.push(`${col} >= $${paramIdx}`);
    values.push(amount);
    paramIdx++;
  }

  if (updates.length === 0) return true; // nothing to deduct

  const query = `
    UPDATE agents 
    SET ${updates.join(', ')}
    WHERE id = $1 AND ${checks.join(' AND ')}
  `;

  const result = await pool.query(query, values);
  return (result.rowCount ?? 0) > 0;
}

export async function startBlueprintWithMaterialCost(
  agentId: string,
  creditCost: number,
  materialCost: MaterialCost
): Promise<boolean> {
  if (!pool) {
    const inMemoryAgent = inMemoryStore.agents.get(agentId) as any;
    if (!inMemoryAgent) return false;
    const currentCredits = inMemoryAgent.buildCredits ?? DEFAULT_IN_MEMORY_BUILD_CREDITS;
    if (currentCredits < creditCost) return false;
    for (const [mat, amount] of Object.entries(materialCost)) {
      if (!amount || amount <= 0) continue;
      const col = materialColumn(mat);
      if (!col) return false;
      if ((inMemoryAgent[col] || 0) < amount) return false;
    }
    inMemoryAgent.buildCredits = currentCredits - creditCost;
    for (const [mat, amount] of Object.entries(materialCost)) {
      if (!amount || amount <= 0) continue;
      const col = materialColumn(mat);
      if (!col) return false;
      inMemoryAgent[col] = (inMemoryAgent[col] || 0) - amount;
    }
    inMemoryStore.agents.set(agentId, inMemoryAgent);
    return true;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const creditDebit = await client.query(
      'UPDATE agents SET build_credits = build_credits - $1 WHERE id = $2 AND build_credits >= $1',
      [creditCost, agentId]
    );
    if ((creditDebit.rowCount ?? 0) === 0) {
      await client.query('ROLLBACK');
      return false;
    }

    const updates: string[] = [];
    const checks: string[] = [];
    const values: unknown[] = [agentId];
    let paramIdx = 2;
    for (const [mat, amount] of Object.entries(materialCost)) {
      if (!amount || amount <= 0) continue;
      const col = materialColumn(mat);
      if (!col) {
        await client.query('ROLLBACK');
        return false;
      }
      updates.push(`${col} = ${col} - $${paramIdx}`);
      checks.push(`${col} >= $${paramIdx}`);
      values.push(amount);
      paramIdx++;
    }

    if (updates.length > 0) {
      const deduction = await client.query(
        `UPDATE agents
         SET ${updates.join(', ')}
         WHERE id = $1 AND ${checks.join(' AND ')}`,
        values
      );
      if ((deduction.rowCount ?? 0) === 0) {
        await client.query('ROLLBACK');
        return false;
      }
    }

    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function transferMaterial(fromAgentId: string, toAgentId: string, materialType: string, amount: number): Promise<boolean> {
  if (amount <= 0) return false;
  const col = materialColumn(materialType);
  if (!col) return false;

  if (!pool) {
    const fromAgent = inMemoryStore.agents.get(fromAgentId) as any;
    const toAgent = inMemoryStore.agents.get(toAgentId) as any;
    if (!fromAgent || !toAgent) return false;
    if ((fromAgent[col] || 0) < amount) return false;
    fromAgent[col] = (fromAgent[col] || 0) - amount;
    toAgent[col] = (toAgent[col] || 0) + amount;
    inMemoryStore.agents.set(fromAgentId, fromAgent);
    inMemoryStore.agents.set(toAgentId, toAgent);
    return true;
  }
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Deduct
    const debit = await client.query(
      `UPDATE agents SET ${col} = ${col} - $1 WHERE id = $2 AND ${col} >= $1`,
      [amount, fromAgentId]
    );
    
    if ((debit.rowCount ?? 0) === 0) {
      await client.query('ROLLBACK');
      return false; // Insufficient funds
    }
    
    // Add
    await client.query(
      `UPDATE agents SET ${col} = COALESCE(${col}, 0) + $1 WHERE id = $2`,
      [amount, toAgentId]
    );
    
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ===========================================
// Certification System
// ===========================================

export interface CertificationRunUpdateInput {
  feePaidUsdc?: string;
  x402PaymentRef?: string | null;
  deadlineAt?: number;
  startedAt?: number;
  submittedAt?: number | null;
  completedAt?: number | null;
  verificationResult?: Record<string, unknown> | null;
  attestationJson?: Record<string, unknown> | null;
  onchainTxHash?: string | null;
}

export interface CertificationVerificationInput {
  runId: string;
  submissionId: number;
  templateId: string;
  passed: boolean;
  checks: unknown;
  verifiedAt?: number;
}

export interface CertificationPayoutInput {
  runId: string;
  payoutType: 'fee_collected' | 'credit_reward' | 'reputation_reward';
  amount: string;
  currency: 'USDC' | 'credits' | 'reputation';
  recipientAgentId?: string;
  recipientWallet?: string;
  onchainTxHash?: string;
}

export interface CertificationAgentStats {
  total: number;
  passed: number;
  failed: number;
}

export interface CertificationLeaderboardEntry {
  agentId: string;
  agentName: string;
  templateId: string;
  totalRuns: number;
  passCount: number;
  failCount: number;
  passRate: number;
  bestScore: number;
  avgScore: number;
}

export async function getCertificationTemplate(id: string): Promise<CertificationTemplateRecord | null> {
  if (!pool) {
    seedInMemoryCertificationTemplate();
    return inMemoryStore.certificationTemplates.get(id) || null;
  }

  const result = await pool.query<{
    id: string;
    version: number;
    display_name: string;
    type: string | null;
    description: string | null;
    fee_usdc_atomic: string;
    reward_credits: number;
    reward_reputation: number;
    deadline_seconds: number;
    config: Record<string, unknown> | null;
    challenge: Record<string, unknown> | null;
    is_active: boolean;
  }>(
    `
    SELECT id, version, display_name, type, description, fee_usdc_atomic, reward_credits, reward_reputation, deadline_seconds, config, challenge, is_active
    FROM certification_templates
    WHERE id = $1
    `,
    [id],
  );

  if (result.rows.length === 0) return null;
  return normalizeCertificationTemplateRecord(result.rows[0]);
}

export async function getActiveCertificationTemplates(): Promise<CertificationTemplateRecord[]> {
  if (!pool) {
    seedInMemoryCertificationTemplate();
    return Array.from(inMemoryStore.certificationTemplates.values())
      .filter((template) => template.isActive)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  const result = await pool.query<{
    id: string;
    version: number;
    display_name: string;
    type: string | null;
    description: string | null;
    fee_usdc_atomic: string;
    reward_credits: number;
    reward_reputation: number;
    deadline_seconds: number;
    config: Record<string, unknown> | null;
    challenge: Record<string, unknown> | null;
    is_active: boolean;
  }>(
    `
    SELECT id, version, display_name, type, description, fee_usdc_atomic, reward_credits, reward_reputation, deadline_seconds, config, challenge, is_active
    FROM certification_templates
    WHERE is_active = TRUE
    ORDER BY id ASC
    `,
  );

  return result.rows.map(normalizeCertificationTemplateRecord);
}

export async function createCertificationRun(run: CertificationRunRecord): Promise<CertificationRunRecord> {
  if (!pool) {
    seedInMemoryCertificationTemplate();
    const created: CertificationRunRecord = {
      ...run,
      x402PaymentRef: run.x402PaymentRef || undefined,
      verificationResult: run.verificationResult || undefined,
      attestationJson: run.attestationJson || undefined,
      onchainTxHash: run.onchainTxHash || undefined,
    };
    inMemoryStore.certificationRuns.set(run.id, created);
    return created;
  }

  const result = await pool.query<{
    id: string;
    agent_id: string;
    owner_wallet: string;
    template_id: string;
    status: CertificationStatus;
    fee_paid_usdc: string;
    x402_payment_ref: string | null;
    deadline_at: Date;
    started_at: Date;
    submitted_at: Date | null;
    completed_at: Date | null;
    verification_result: Record<string, unknown> | null;
    attestation_json: Record<string, unknown> | null;
    onchain_tx_hash: string | null;
  }>(
    `
    INSERT INTO certification_runs (
      id,
      agent_id,
      owner_wallet,
      template_id,
      status,
      fee_paid_usdc,
      x402_payment_ref,
      deadline_at,
      started_at,
      submitted_at,
      completed_at,
      verification_result,
      attestation_json,
      onchain_tx_hash
    )
    VALUES (
      $1,
      $2,
      $3,
      $4,
      $5,
      $6,
      $7,
      TO_TIMESTAMP($8 / 1000.0),
      TO_TIMESTAMP($9 / 1000.0),
      $10,
      $11,
      $12::jsonb,
      $13::jsonb,
      $14
    )
    RETURNING *
    `,
    [
      run.id,
      run.agentId,
      run.ownerWallet.toLowerCase(),
      run.templateId,
      run.status,
      run.feePaidUsdc,
      run.x402PaymentRef || null,
      run.deadlineAt,
      run.startedAt,
      run.submittedAt ? new Date(run.submittedAt) : null,
      run.completedAt ? new Date(run.completedAt) : null,
      run.verificationResult ? JSON.stringify(run.verificationResult) : null,
      run.attestationJson ? JSON.stringify(run.attestationJson) : null,
      run.onchainTxHash || null,
    ],
  );

  return normalizeCertificationRunRecord(result.rows[0]);
}

export async function getCertificationRun(id: string): Promise<CertificationRunRecord | null> {
  if (!pool) {
    seedInMemoryCertificationTemplate();
    return inMemoryStore.certificationRuns.get(id) || null;
  }

  const result = await pool.query<{
    id: string;
    agent_id: string;
    owner_wallet: string;
    template_id: string;
    status: CertificationStatus;
    fee_paid_usdc: string;
    x402_payment_ref: string | null;
    deadline_at: Date;
    started_at: Date;
    submitted_at: Date | null;
    completed_at: Date | null;
    verification_result: Record<string, unknown> | null;
    attestation_json: Record<string, unknown> | null;
    onchain_tx_hash: string | null;
  }>(
    `
    SELECT *
    FROM certification_runs
    WHERE id = $1
    `,
    [id],
  );

  if (result.rows.length === 0) return null;
  return normalizeCertificationRunRecord(result.rows[0]);
}

export async function getCertificationRunsForAgent(agentId: string): Promise<CertificationRunRecord[]> {
  if (!pool) {
    seedInMemoryCertificationTemplate();
    return Array.from(inMemoryStore.certificationRuns.values())
      .filter((run) => run.agentId === agentId)
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  const result = await pool.query<{
    id: string;
    agent_id: string;
    owner_wallet: string;
    template_id: string;
    status: CertificationStatus;
    fee_paid_usdc: string;
    x402_payment_ref: string | null;
    deadline_at: Date;
    started_at: Date;
    submitted_at: Date | null;
    completed_at: Date | null;
    verification_result: Record<string, unknown> | null;
    attestation_json: Record<string, unknown> | null;
    onchain_tx_hash: string | null;
  }>(
    `
    SELECT *
    FROM certification_runs
    WHERE agent_id = $1
    ORDER BY started_at DESC
    `,
    [agentId],
  );

  return result.rows.map(normalizeCertificationRunRecord);
}

export async function updateCertificationRunStatus(
  id: string,
  status: CertificationStatus,
  updates?: CertificationRunUpdateInput,
): Promise<CertificationRunRecord | null> {
  if (!pool) {
    seedInMemoryCertificationTemplate();
    const existing = inMemoryStore.certificationRuns.get(id);
    if (!existing) return null;
    const merged: CertificationRunRecord = {
      ...existing,
      status,
      ...(updates?.feePaidUsdc !== undefined ? { feePaidUsdc: updates.feePaidUsdc } : {}),
      ...(updates?.x402PaymentRef !== undefined ? { x402PaymentRef: updates.x402PaymentRef || undefined } : {}),
      ...(updates?.deadlineAt !== undefined ? { deadlineAt: updates.deadlineAt } : {}),
      ...(updates?.startedAt !== undefined ? { startedAt: updates.startedAt } : {}),
      ...(updates?.submittedAt !== undefined ? { submittedAt: updates.submittedAt || undefined } : {}),
      ...(updates?.completedAt !== undefined ? { completedAt: updates.completedAt || undefined } : {}),
      ...(updates?.verificationResult !== undefined ? { verificationResult: updates.verificationResult || undefined } : {}),
      ...(updates?.attestationJson !== undefined ? { attestationJson: updates.attestationJson || undefined } : {}),
      ...(updates?.onchainTxHash !== undefined ? { onchainTxHash: updates.onchainTxHash || undefined } : {}),
    };
    inMemoryStore.certificationRuns.set(id, merged);
    return merged;
  }

  const setClauses: string[] = ['status = $1'];
  const values: unknown[] = [status];
  let paramIndex = 2;

  if (updates?.feePaidUsdc !== undefined) {
    setClauses.push(`fee_paid_usdc = $${paramIndex++}`);
    values.push(updates.feePaidUsdc);
  }
  if (updates?.x402PaymentRef !== undefined) {
    setClauses.push(`x402_payment_ref = $${paramIndex++}`);
    values.push(updates.x402PaymentRef || null);
  }
  if (updates?.deadlineAt !== undefined) {
    setClauses.push(`deadline_at = TO_TIMESTAMP($${paramIndex++} / 1000.0)`);
    values.push(updates.deadlineAt);
  }
  if (updates?.startedAt !== undefined) {
    setClauses.push(`started_at = TO_TIMESTAMP($${paramIndex++} / 1000.0)`);
    values.push(updates.startedAt);
  }
  if (updates?.submittedAt !== undefined) {
    setClauses.push(`submitted_at = $${paramIndex++}`);
    values.push(updates.submittedAt ? new Date(updates.submittedAt) : null);
  }
  if (updates?.completedAt !== undefined) {
    setClauses.push(`completed_at = $${paramIndex++}`);
    values.push(updates.completedAt ? new Date(updates.completedAt) : null);
  }
  if (updates?.verificationResult !== undefined) {
    setClauses.push(`verification_result = $${paramIndex++}::jsonb`);
    values.push(updates.verificationResult ? JSON.stringify(updates.verificationResult) : null);
  }
  if (updates?.attestationJson !== undefined) {
    setClauses.push(`attestation_json = $${paramIndex++}::jsonb`);
    values.push(updates.attestationJson ? JSON.stringify(updates.attestationJson) : null);
  }
  if (updates?.onchainTxHash !== undefined) {
    setClauses.push(`onchain_tx_hash = $${paramIndex++}`);
    values.push(updates.onchainTxHash || null);
  }

  values.push(id);
  const result = await pool.query<{
    id: string;
    agent_id: string;
    owner_wallet: string;
    template_id: string;
    status: CertificationStatus;
    fee_paid_usdc: string;
    x402_payment_ref: string | null;
    deadline_at: Date;
    started_at: Date;
    submitted_at: Date | null;
    completed_at: Date | null;
    verification_result: Record<string, unknown> | null;
    attestation_json: Record<string, unknown> | null;
    onchain_tx_hash: string | null;
  }>(
    `
    UPDATE certification_runs
    SET ${setClauses.join(', ')}
    WHERE id = $${paramIndex}
    RETURNING *
    `,
    values,
  );

  if (result.rows.length === 0) return null;
  return normalizeCertificationRunRecord(result.rows[0]);
}

export async function createCertificationSubmission(
  runId: string,
  proof: Record<string, unknown>,
): Promise<CertificationSubmissionRecord> {
  if (!pool) {
    seedInMemoryCertificationTemplate();
    const created: CertificationSubmissionRecord = {
      id: inMemoryStore.nextCertificationSubmissionId++,
      runId,
      submittedAt: Date.now(),
      proof,
    };
    inMemoryStore.certificationSubmissions.push(created);
    return created;
  }

  const result = await pool.query<{
    id: number;
    run_id: string;
    submitted_at: Date;
    proof: Record<string, unknown>;
  }>(
    `
    INSERT INTO certification_submissions (run_id, proof)
    VALUES ($1, $2::jsonb)
    RETURNING id, run_id, submitted_at, proof
    `,
    [runId, JSON.stringify(proof)],
  );

  return {
    id: result.rows[0].id,
    runId: result.rows[0].run_id,
    submittedAt: new Date(result.rows[0].submitted_at).getTime(),
    proof: result.rows[0].proof || {},
  };
}

export async function createCertificationVerification(
  verification: CertificationVerificationInput,
): Promise<CertificationVerificationRecord> {
  if (!pool) {
    seedInMemoryCertificationTemplate();
    const created: CertificationVerificationRecord = {
      id: inMemoryStore.nextCertificationVerificationId++,
      runId: verification.runId,
      submissionId: verification.submissionId,
      templateId: verification.templateId,
      passed: verification.passed,
      checks: verification.checks,
      verifiedAt: verification.verifiedAt || Date.now(),
    };
    inMemoryStore.certificationVerifications.push(created);
    return created;
  }

  const result = await pool.query<{
    id: number;
    run_id: string;
    submission_id: number;
    template_id: string;
    passed: boolean;
    checks: unknown;
    verified_at: Date;
  }>(
    `
    INSERT INTO certification_verifications (run_id, submission_id, template_id, passed, checks, verified_at)
    VALUES ($1, $2, $3, $4, $5::jsonb, TO_TIMESTAMP($6 / 1000.0))
    RETURNING id, run_id, submission_id, template_id, passed, checks, verified_at
    `,
    [
      verification.runId,
      verification.submissionId,
      verification.templateId,
      verification.passed,
      JSON.stringify(verification.checks),
      verification.verifiedAt || Date.now(),
    ],
  );

  return {
    id: result.rows[0].id,
    runId: result.rows[0].run_id,
    submissionId: result.rows[0].submission_id,
    templateId: result.rows[0].template_id,
    passed: result.rows[0].passed,
    checks: result.rows[0].checks || [],
    verifiedAt: new Date(result.rows[0].verified_at).getTime(),
  };
}

export async function recordCertificationPayout(
  payout: CertificationPayoutInput,
): Promise<CertificationPayoutRecord> {
  if (!pool) {
    seedInMemoryCertificationTemplate();
    const created: CertificationPayoutRecord = {
      id: inMemoryStore.nextCertificationPayoutId++,
      runId: payout.runId,
      payoutType: payout.payoutType,
      amount: payout.amount,
      currency: payout.currency,
      recipientAgentId: payout.recipientAgentId,
      recipientWallet: payout.recipientWallet,
      onchainTxHash: payout.onchainTxHash,
    };
    inMemoryStore.certificationPayouts.push(created);
    return created;
  }

  const result = await pool.query<{
    id: number;
    run_id: string;
    payout_type: 'fee_collected' | 'credit_reward' | 'reputation_reward';
    amount: string;
    currency: 'USDC' | 'credits' | 'reputation';
    recipient_agent_id: string | null;
    recipient_wallet: string | null;
    onchain_tx_hash: string | null;
  }>(
    `
    INSERT INTO certification_payouts (
      run_id,
      payout_type,
      amount,
      currency,
      recipient_agent_id,
      recipient_wallet,
      onchain_tx_hash
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING id, run_id, payout_type, amount, currency, recipient_agent_id, recipient_wallet, onchain_tx_hash
    `,
    [
      payout.runId,
      payout.payoutType,
      payout.amount,
      payout.currency,
      payout.recipientAgentId || null,
      payout.recipientWallet ? payout.recipientWallet.toLowerCase() : null,
      payout.onchainTxHash || null,
    ],
  );

  return {
    id: result.rows[0].id,
    runId: result.rows[0].run_id,
    payoutType: result.rows[0].payout_type,
    amount: result.rows[0].amount,
    currency: result.rows[0].currency,
    recipientAgentId: result.rows[0].recipient_agent_id || undefined,
    recipientWallet: result.rows[0].recipient_wallet || undefined,
    onchainTxHash: result.rows[0].onchain_tx_hash || undefined,
  };
}

export async function getAgentCertificationStats(agentId: string): Promise<CertificationAgentStats> {
  if (!pool) {
    seedInMemoryCertificationTemplate();
    const runs = Array.from(inMemoryStore.certificationRuns.values()).filter((run) => run.agentId === agentId);
    const passed = runs.filter((run) => run.status === 'passed').length;
    const failed = runs.filter((run) => run.status === 'failed').length;
    return {
      total: runs.length,
      passed,
      failed,
    };
  }

  const result = await pool.query<{
    total: string;
    passed: string;
    failed: string;
  }>(
    `
    SELECT
      COUNT(*)::text AS total,
      COUNT(*) FILTER (WHERE status = 'passed')::text AS passed,
      COUNT(*) FILTER (WHERE status = 'failed')::text AS failed
    FROM certification_runs
    WHERE agent_id = $1
    `,
    [agentId],
  );

  return {
    total: parseInt(result.rows[0]?.total ?? '0', 10),
    passed: parseInt(result.rows[0]?.passed ?? '0', 10),
    failed: parseInt(result.rows[0]?.failed ?? '0', 10),
  };
}

export async function getCertificationLeaderboard(
  templateId?: string,
  limit = 50,
): Promise<CertificationLeaderboardEntry[]> {
  const safeLimit = Math.min(Math.max(Math.trunc(limit) || 50, 1), 200);

  if (!pool) {
    seedInMemoryCertificationTemplate();
    const grouped = new Map<string, CertificationLeaderboardEntry>();

    for (const run of inMemoryStore.certificationRuns.values()) {
      if (templateId && run.templateId !== templateId) continue;
      const key = `${run.agentId}:${run.templateId}`;
      const existing = grouped.get(key) || {
        agentId: run.agentId,
        agentName: inMemoryStore.agents.get(run.agentId)?.name || run.agentId,
        templateId: run.templateId,
        totalRuns: 0,
        passCount: 0,
        failCount: 0,
        passRate: 0,
        bestScore: 0,
        avgScore: 0,
      };
      existing.totalRuns += 1;
      if (run.status === 'passed') existing.passCount += 1;
      if (run.status === 'failed') existing.failCount += 1;
      existing.passRate = existing.totalRuns > 0 ? (existing.passCount / existing.totalRuns) * 100 : 0;
      const score = (typeof run.verificationResult?.score === 'number' ? run.verificationResult.score : 0) as number;
      if (score > existing.bestScore) existing.bestScore = score;
      const completedRuns = existing.passCount + existing.failCount;
      if (completedRuns > 0) {
        existing.avgScore = Math.round(((existing.avgScore * (completedRuns - 1)) + score) / completedRuns);
      }
      grouped.set(key, existing);
    }

    return Array.from(grouped.values())
      .sort((a, b) => {
        if (b.passCount !== a.passCount) return b.passCount - a.passCount;
        if (b.bestScore !== a.bestScore) return b.bestScore - a.bestScore;
        if (b.totalRuns !== a.totalRuns) return b.totalRuns - a.totalRuns;
        return a.agentId.localeCompare(b.agentId);
      })
      .slice(0, safeLimit);
  }

  const result = await pool.query<{
    agent_id: string;
    agent_name: string | null;
    template_id: string;
    total_runs: string;
    pass_count: string;
    fail_count: string;
    pass_rate: string;
    best_score: string;
    avg_score: string;
  }>(
    `
    SELECT
      cr.agent_id,
      COALESCE(a.visual_name, cr.agent_id) AS agent_name,
      cr.template_id,
      COUNT(*)::text AS total_runs,
      COUNT(*) FILTER (WHERE cr.status = 'passed')::text AS pass_count,
      COUNT(*) FILTER (WHERE cr.status = 'failed')::text AS fail_count,
      COALESCE(
        ROUND(
          (
            COUNT(*) FILTER (WHERE cr.status = 'passed')::numeric
            / NULLIF(COUNT(*)::numeric, 0)
          ) * 100,
          2
        ),
        0
      )::text AS pass_rate,
      COALESCE(MAX((cr.verification_result->>'score')::int) FILTER (WHERE cr.status IN ('passed','failed')), 0)::text AS best_score,
      COALESCE(ROUND(AVG((cr.verification_result->>'score')::int) FILTER (WHERE cr.status IN ('passed','failed'))), 0)::text AS avg_score
    FROM certification_runs cr
    LEFT JOIN agents a ON a.id = cr.agent_id
    WHERE ($1::varchar IS NULL OR cr.template_id = $1)
    GROUP BY cr.agent_id, a.visual_name, cr.template_id
    ORDER BY
      COUNT(*) FILTER (WHERE cr.status = 'passed') DESC,
      MAX((cr.verification_result->>'score')::int) FILTER (WHERE cr.status IN ('passed','failed')) DESC NULLS LAST,
      COUNT(*) DESC,
      cr.agent_id ASC
    LIMIT $2
    `,
    [templateId || null, safeLimit],
  );

  return result.rows.map((row) => ({
    agentId: row.agent_id,
    agentName: row.agent_name || row.agent_id,
    templateId: row.template_id,
    totalRuns: parseInt(row.total_runs, 10),
    passCount: parseInt(row.pass_count, 10),
    failCount: parseInt(row.fail_count, 10),
    passRate: parseFloat(row.pass_rate),
    bestScore: parseInt(row.best_score, 10),
    avgScore: parseInt(row.avg_score, 10),
  }));
}

export async function expireActiveCertificationRuns(nowMs: number = Date.now()): Promise<number> {
  if (!pool) {
    seedInMemoryCertificationTemplate();
    let expired = 0;
    for (const [runId, run] of inMemoryStore.certificationRuns.entries()) {
      if (run.status === 'active' && run.deadlineAt < nowMs) {
        inMemoryStore.certificationRuns.set(runId, {
          ...run,
          status: 'expired',
          completedAt: nowMs,
        });
        expired += 1;
      }
    }
    return expired;
  }

  const result = await pool.query(
    `
    UPDATE certification_runs
    SET
      status = 'expired',
      completed_at = COALESCE(completed_at, NOW())
    WHERE status = 'active' AND deadline_at < TO_TIMESTAMP($1 / 1000.0)
    `,
    [nowMs],
  );

  return result.rowCount ?? 0;
}

export async function getAbandonedStructureCount(daysInactive = 7): Promise<number> {
  if (!pool) return 0;
  const result = await pool.query<{ structure_count: string }>(
    `
      SELECT COUNT(DISTINCT COALESCE(wp.blueprint_instance_id, wp.id)) AS structure_count
      FROM world_primitives wp
      JOIN agents a ON a.id = wp.owner_agent_id
      WHERE a.last_active_at < NOW() - ($1 * INTERVAL '1 day')
    `,
    [daysInactive]
  );
  return parseInt(result.rows[0]?.structure_count ?? '0', 10);
}

export async function closeDatabase(): Promise<void> {
  if (pool) {
    await pool.end();
    console.log('[DB] Connection closed');
  }
}
