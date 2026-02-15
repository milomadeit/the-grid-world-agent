import pg from 'pg';
import type { Agent, AgentRow, WorldPrimitive, TerminalMessage, Guild, Directive, GuildMemberRow, DirectiveVoteRow } from './types.js';

const { Pool } = pg;

let pool: pg.Pool | null = null;

// In-memory fallback when no database is configured
const inMemoryStore = {
  agents: new Map<string, Agent>(),
  worldState: new Map<string, unknown>(),
  chatMessages: [] as TerminalMessage[],
  terminalMessages: [] as TerminalMessage[],
  directives: new Map<string, Directive>(),
  directiveVotes: new Map<string, Map<string, string>>(), // directiveId -> agentId -> vote
  nextMsgId: 1,
};

export async function initDatabase(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    console.log('[DB] No DATABASE_URL found, using in-memory storage');
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
        inventory JSONB DEFAULT '{}'::jsonb
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
        created_at TIMESTAMP DEFAULT NOW()
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

    // One-time migration: reset all existing agents to 500 credits
    await pool.query(`UPDATE agents SET build_credits = 500, credits_last_reset = NOW()`);

    // Create indexes (safe now that all columns exist)
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_agents_owner ON agents(owner_id);
      CREATE INDEX IF NOT EXISTS idx_agents_position ON agents(x, y);
      CREATE INDEX IF NOT EXISTS idx_agents_erc8004 ON agents(erc8004_agent_id);
      CREATE INDEX IF NOT EXISTS idx_agents_autonomous ON agents(is_autonomous);
      CREATE INDEX IF NOT EXISTS idx_reputation_to_agent ON reputation_feedback(to_agent_id);
      CREATE INDEX IF NOT EXISTS idx_reputation_from_agent ON reputation_feedback(from_agent_id);
      CREATE INDEX IF NOT EXISTS idx_chat_messages_created ON chat_messages(created_at DESC);
    `);

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
}

// Agent operations
export async function createAgent(agent: ExtendedAgent): Promise<ExtendedAgent> {
  if (!pool) {
    inMemoryStore.agents.set(agent.id, agent);
    return agent;
  }

  await pool.query(`
    INSERT INTO agents (id, owner_id, x, y, visual_color, visual_name, status, inventory, erc8004_agent_id, erc8004_registry, reputation_score, is_autonomous, spawn_generation, bio)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
    ON CONFLICT (id) DO UPDATE SET
      x = EXCLUDED.x,
      y = EXCLUDED.y,
      status = EXCLUDED.status,
      last_active_at = NOW(),
      erc8004_agent_id = COALESCE(EXCLUDED.erc8004_agent_id, agents.erc8004_agent_id),
      erc8004_registry = COALESCE(EXCLUDED.erc8004_registry, agents.erc8004_registry),
      bio = COALESCE(EXCLUDED.bio, agents.bio)
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
    agent.bio || null
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
function rowToAgent(row: AgentRow): Agent & { erc8004AgentId?: string; erc8004Registry?: string; reputationScore?: number; isAutonomous?: boolean; spawnGeneration?: number; buildCredits?: number; entry_fee_paid?: boolean; entry_fee_tx?: string } {
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
    reputationScore: row.reputation_score || 0,
    // Spawner fields
    isAutonomous: row.is_autonomous || false,
    spawnGeneration: row.spawn_generation || 0,
    // Credits
    buildCredits: row.build_credits ?? 500,
    // Entry fee
    entry_fee_paid: (row as any).entry_fee_paid ?? false,
    entry_fee_tx: (row as any).entry_fee_tx || undefined,
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


// ===========================================
// World Primitives (New System)
// ===========================================

export async function createWorldPrimitive(primitive: WorldPrimitive): Promise<WorldPrimitive> {
  if (!pool) return primitive;
  await pool.query(
    `INSERT INTO world_primitives (id, shape, owner_agent_id, x, y, z, rot_x, rot_y, rot_z, scale_x, scale_y, scale_z, color, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, TO_TIMESTAMP($14 / 1000.0))`,
    [
      primitive.id,
      primitive.shape,
      primitive.ownerAgentId,
      primitive.position.x, primitive.position.y, primitive.position.z,
      primitive.rotation.x, primitive.rotation.y, primitive.rotation.z,
      primitive.scale.x, primitive.scale.y, primitive.scale.z,
      primitive.color,
      primitive.createdAt
    ]
  );
  return primitive;
}

export async function deleteWorldPrimitive(id: string): Promise<boolean> {
  if (!pool) return true;
  const result = await pool.query('DELETE FROM world_primitives WHERE id = $1', [id]);
  return (result.rowCount ?? 0) > 0;
}

export async function getWorldPrimitive(id: string): Promise<WorldPrimitive | null> {
  if (!pool) return null;
  const result = await pool.query('SELECT * FROM world_primitives WHERE id = $1', [id]);
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    id: row.id,
    shape: row.shape,
    ownerAgentId: row.owner_agent_id,
    position: { x: row.x, y: row.y, z: row.z },
    rotation: { x: row.rot_x, y: row.rot_y, z: row.rot_z },
    scale: { x: row.scale_x, y: row.scale_y, z: row.scale_z },
    color: row.color,
    createdAt: new Date(row.created_at).getTime()
  };
}

export async function getAllWorldPrimitives(): Promise<WorldPrimitive[]> {
  if (!pool) return [];
  const result = await pool.query('SELECT * FROM world_primitives ORDER BY created_at ASC');
  return result.rows.map(row => ({
    id: row.id,
    shape: row.shape,
    ownerAgentId: row.owner_agent_id,
    position: { x: row.x, y: row.y, z: row.z },
    rotation: { x: row.rot_x, y: row.rot_y, z: row.rot_z },
    scale: { x: row.scale_x, y: row.scale_y, z: row.scale_z },
    color: row.color,
    createdAt: new Date(row.created_at).getTime()
  }));
}

// ===========================================
// World Objects (Legacy)
// ===========================================

// Terminal
export async function writeTerminalMessage(msg: TerminalMessage): Promise<TerminalMessage> {
  if (!pool) {
    const saved = { ...msg, id: inMemoryStore.nextMsgId++, createdAt: msg.createdAt || Date.now() };
    inMemoryStore.terminalMessages.push(saved);
    if (inMemoryStore.terminalMessages.length > 100) inMemoryStore.terminalMessages.shift();
    return saved;
  }
  const result = await pool.query(
    `INSERT INTO terminal_messages (agent_id, agent_name, message)
     VALUES ($1, $2, $3)
     RETURNING id, created_at`,
    [msg.agentId, msg.agentName, msg.message]
  );
  return { ...msg, id: result.rows[0].id, createdAt: result.rows[0].created_at.getTime() };
}

export async function getTerminalMessages(limit = 20): Promise<TerminalMessage[]> {
  if (!pool) {
    return inMemoryStore.terminalMessages.slice(-limit);
  }
  const result = await pool.query(
    'SELECT * FROM terminal_messages ORDER BY created_at DESC LIMIT $1',
    [limit]
  );
  return result.rows.reverse().map(row => ({
    id: row.id,
    agentId: row.agent_id,
    agentName: row.agent_name,
    message: row.message,
    createdAt: new Date(row.created_at).getTime()
  }));
}

// Chat
export async function writeChatMessage(msg: TerminalMessage): Promise<TerminalMessage> {
  if (!pool) {
    const saved = { ...msg, id: inMemoryStore.nextMsgId++, createdAt: msg.createdAt || Date.now() };
    inMemoryStore.chatMessages.push(saved);
    if (inMemoryStore.chatMessages.length > 100) inMemoryStore.chatMessages.shift();
    return saved;
  }
  const result = await pool.query(
    `INSERT INTO chat_messages (agent_id, agent_name, message)
     VALUES ($1, $2, $3)
     RETURNING id, created_at`,
    [msg.agentId, msg.agentName, msg.message]
  );
  return { ...msg, id: result.rows[0].id, createdAt: result.rows[0].created_at.getTime() };
}

export async function getChatMessages(limit = 20): Promise<TerminalMessage[]> {
  if (!pool) {
    return inMemoryStore.chatMessages.slice(-limit);
  }
  const result = await pool.query(
    'SELECT * FROM chat_messages ORDER BY created_at DESC LIMIT $1',
    [limit]
  );
  return result.rows.reverse().map(row => ({
    id: row.id,
    agentId: row.agent_id,
    agentName: row.agent_name,
    message: row.message,
    createdAt: new Date(row.created_at).getTime()
  }));
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

// Directives
export async function createDirective(directive: Directive): Promise<Directive> {
  if (!pool) {
    inMemoryStore.directives.set(directive.id, directive);
    return directive;
  }
  await pool.query(
    `INSERT INTO directives (id, type, submitted_by, guild_id, description, agents_needed, expires_at, status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7/1000.0), $8, to_timestamp($9/1000.0))`,
    [directive.id, directive.type, directive.submittedBy, directive.guildId || null, directive.description, directive.agentsNeeded, directive.expiresAt, directive.status, directive.createdAt]
  );
  return directive;
}

export async function getActiveDirectives(): Promise<Directive[]> {
  if (!pool) {
    const now = Date.now();
    return Array.from(inMemoryStore.directives.values())
      .filter(d => d.status === 'active' && d.expiresAt > now)
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
    WHERE d.status = 'active'
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
    status: row.status as 'active' | 'completed' | 'expired',
    createdAt: new Date(row.created_at).getTime(),
    yesVotes: parseInt(row.yes_votes),
    noVotes: parseInt(row.no_votes)
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
    status: row.status as 'active' | 'completed' | 'expired',
    createdAt: new Date(row.created_at).getTime(),
    yesVotes: parseInt(row.yes_votes),
    noVotes: parseInt(row.no_votes)
  };
}

export async function expireAllDirectives(): Promise<number> {
  if (!pool) {
    let count = 0;
    for (const d of inMemoryStore.directives.values()) {
      if (d.status === 'active') { d.status = 'expired'; count++; }
    }
    return count;
  }
  const result = await pool.query("UPDATE directives SET status = 'expired' WHERE status = 'active'");
  const count = result.rowCount ?? 0;
  console.log(`[DB] Force-expired ${count} directive(s)`);
  return count;
}

export async function expireDirectives(): Promise<number> {
  if (!pool) {
    const now = Date.now();
    let count = 0;
    for (const [id, d] of inMemoryStore.directives) {
      if (d.expiresAt < now && d.status === 'active') {
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
    WHERE expires_at < NOW() AND status IN ('pending_vote', 'active')
  `);
  const count = result.rowCount ?? 0;
  if (count > 0) {
    console.log(`[DB] Expired ${count} directive(s)`);
  }
  return count;
}

// Credits
export async function getAgentCredits(agentId: string): Promise<number> {
  if (!pool) return 10;
  const result = await pool.query('SELECT build_credits FROM agents WHERE id = $1', [agentId]);
  return result.rows[0]?.build_credits ?? 500;
}

export async function deductCredits(agentId: string, amount: number): Promise<boolean> {
  if (!pool) return true;
  const result = await pool.query(
    'UPDATE agents SET build_credits = build_credits - $1 WHERE id = $2 AND build_credits >= $1',
    [amount, agentId]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function resetDailyCredits(soloAmount: number): Promise<void> {
  if (!pool) return;
  const guildAmount = Math.round(soloAmount * 1.5);
  // Solo agents: base credits
  await pool.query(
    `UPDATE agents SET build_credits = $1, credits_last_reset = NOW()
     WHERE credits_last_reset < NOW() - INTERVAL '24 hours'
     AND id NOT IN (SELECT agent_id FROM guild_members)`,
    [soloAmount]
  );
  // Guild agents: 1.5x multiplier
  await pool.query(
    `UPDATE agents SET build_credits = $1, credits_last_reset = NOW()
     WHERE credits_last_reset < NOW() - INTERVAL '24 hours'
     AND id IN (SELECT agent_id FROM guild_members)`,
    [guildAmount]
  );
}

// --- Directive Completion + Rewards ---

export async function completeDirective(directiveId: string): Promise<void> {
  if (!pool) {
    const d = inMemoryStore.directives.get(directiveId);
    if (d) d.status = 'completed';
    return;
  }
  await pool.query(
    "UPDATE directives SET status = 'completed' WHERE id = $1",
    [directiveId]
  );
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

// --- Credit Transfer ---

export async function transferCredits(fromAgentId: string, toAgentId: string, amount: number): Promise<void> {
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
      'UPDATE agents SET build_credits = build_credits + $1 WHERE id = $2',
      [amount, toAgentId]
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
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

export async function clearAllAgentMemory(): Promise<number> {
  if (!pool) return 0;
  const result = await pool.query('DELETE FROM agent_memory');
  const count = result.rowCount ?? 0;
  console.log(`[DB] Cleared ${count} agent memory entries`);
  return count;
}

export async function closeDatabase(): Promise<void> {
  if (pool) {
    await pool.end();
    console.log('[DB] Connection closed');
  }
}
