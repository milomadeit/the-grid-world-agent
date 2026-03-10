# OpGrid Product Roadmap — Implementation Plan

## Overview

This plan implements 9 features across 3 tiers, organized so each tier is independently shippable. Every change is mapped to specific files with line references.

> [!IMPORTANT]
> **No existing test suite was found in the project.** Verification relies on TypeScript compilation checks (`npx tsc --noEmit`) and manual API/frontend testing. Each tier includes specific verification steps.

---

## Tier 1: Ship This Week

---

### Feature 1: Agent Classes / Types

Adds an `agent_class` system where agents select a role on entry that affects gameplay mechanics.

**Classes:** `builder`, `architect`, `explorer`, `diplomat`, `merchant`, `scavenger`

#### [MODIFY] [types.ts](file:///Users/zacharymilo/Documents/world-model-agent/server/types.ts)

- **Add `AgentClass` type** (after line 26):
  ```ts
  export const AGENT_CLASSES = ['builder', 'architect', 'explorer', 'diplomat', 'merchant', 'scavenger'] as const;
  export type AgentClass = typeof AGENT_CLASSES[number];
  ```
- **Add `agentClass` to [AgentRow](file:///Users/zacharymilo/Documents/world-model-agent/server/types.ts#117-139)** (line 137, before `build_credits`):
  ```ts
  agent_class: string | null;
  ```
- **Add `agentClass` to `EnterWorldWithIdentitySchema`** (line 373-378): Add optional field:
  ```ts
  agentClass: z.enum(AGENT_CLASSES).optional(),
  ```
- **Add class bonus config to `BUILD_CREDIT_CONFIG`** (after line 172):
  ```ts
  export const CLASS_BONUSES = {
    builder:    { creditMultiplier: 1.2, description: '+20% daily credits' },
    architect:  { creditMultiplier: 1.0, unlockLargeBlueprints: true, description: 'Unlock exclusive blueprints' },
    explorer:   { creditMultiplier: 1.0, moveRangeMultiplier: 1.5, description: '+50% movement range' },
    diplomat:   { creditMultiplier: 1.0, voteWeight: 2, description: '2x directive vote weight' },
    merchant:   { creditMultiplier: 1.0, transferBonus: 1.5, description: '+50% credit transfer bonus' },
    scavenger:  { creditMultiplier: 1.0, salvageRate: 0.5, description: 'Salvage 50% credits from abandoned builds' },
  } as const;
  ```

#### [MODIFY] [db.ts](file:///Users/zacharymilo/Documents/world-model-agent/server/db.ts)

- **Add migration** (line 182, after `completed_at` migration):
  ```sql
  ALTER TABLE agents ADD COLUMN IF NOT EXISTS agent_class VARCHAR(50) DEFAULT NULL;
  ```
- **Update [createAgent](file:///Users/zacharymilo/Documents/world-model-agent/server/db.ts#240-281)** (line 252): Add `agent_class` to INSERT columns and ON CONFLICT SET
- **Update [rowToAgent](file:///Users/zacharymilo/Documents/world-model-agent/server/db.ts#439-465)** (line 440-464): Add `agentClass: row.agent_class || null` to returned object
- **Update [ExtendedAgent](file:///Users/zacharymilo/Documents/world-model-agent/server/db.ts#232-239) interface** (line 232-238): Add `agentClass?: string`
- **Modify [resetDailyCredits](file:///Users/zacharymilo/Documents/world-model-agent/server/db.ts#1241-1259)** (line 1241-1258): Apply class-based credit multiplier:
  - Builder class gets `SOLO_DAILY_CREDITS * 1.2`, others get base amount
  - Still apply guild multiplier on top

#### [MODIFY] [agents.ts](file:///Users/zacharymilo/Documents/world-model-agent/server/api/agents.ts)

- **Update enter endpoint** (line 79): Destructure `agentClass` from parsed data
- **Pass `agentClass` to new agent creation** (line 305-315): Add to agent object
- **Pass `agentClass` to `db.createAgent`** (line 317-322)
- **Include `agentClass` in enter response** (lines 253-264, 335-346):
  ```ts
  agentClass: existingAgent.agentClass || 'builder'
  ```
- **Include class in agent details endpoint** (line 514-527): Add `agentClass` to response

#### [MODIFY] [grid.ts](file:///Users/zacharymilo/Documents/world-model-agent/server/api/grid.ts)

- **Blueprint tier gate check**: When checking `architect` class, unlock exclusive blueprints without node tier requirements (in the blueprint start endpoint, around line 1500+)
- **Vote weight**: In the vote endpoint (~line 2034), if voter's class is `diplomat`, count vote weight as 2 instead of 1
- **Credit transfer**: In the transfer endpoint, if sender's class is `merchant`, apply 1.5x bonus to transfer amount

#### [MODIFY] [src/types.ts](file:///Users/zacharymilo/Documents/world-model-agent/src/types.ts)

- **Add `agentClass` to [Agent](file:///Users/zacharymilo/Documents/world-model-agent/src/types.ts#10-24) interface** (line 10-23):
  ```ts
  agentClass?: string;
  ```

#### [MODIFY] [AgentBioPanel.tsx](file:///Users/zacharymilo/Documents/world-model-agent/src/components/UI/AgentBioPanel.tsx)

- Display agent class as a badge next to the agent name (e.g., "🔨 Builder", "🧭 Explorer")

---

### Feature 2: Blueprint-Aware Object Click

When clicking any primitive that belongs to a blueprint, show the full structure info instead of just the individual primitive.

#### [MODIFY] [src/types.ts](file:///Users/zacharymilo/Documents/world-model-agent/src/types.ts)

- **Add `blueprintInstanceId` and `blueprintName` to [WorldPrimitive](file:///Users/zacharymilo/Documents/world-model-agent/src/types.ts#93-104)** (line 93-103):
  ```ts
  blueprintInstanceId?: string | null;
  blueprintName?: string | null;
  ```

#### [MODIFY] [server/types.ts](file:///Users/zacharymilo/Documents/world-model-agent/server/types.ts)

- **Add `blueprintName` to `WorldPrimitiveSchema`** (after line 212):
  ```ts
  blueprintName: z.string().nullable().optional(),
  ```

#### [MODIFY] [db.ts](file:///Users/zacharymilo/Documents/world-model-agent/server/db.ts)

- **Add migration** (in DO block, ~line 176):
  ```sql
  ALTER TABLE world_primitives ADD COLUMN IF NOT EXISTS blueprint_name VARCHAR(100) DEFAULT NULL;
  ```
- **Update [createWorldPrimitive](file:///Users/zacharymilo/Documents/world-model-agent/server/db.ts#634-653)** (line 634-652): Include `blueprint_name` in INSERT
- **Update [createWorldPrimitiveWithCreditDebit](file:///Users/zacharymilo/Documents/world-model-agent/server/db.ts#658-726)** (line 662-725): Include `blueprint_name` in INSERT
- **Update [getWorldPrimitive](file:///Users/zacharymilo/Documents/world-model-agent/server/db.ts#733-757)** (line 733-756): Include `blueprint_name` in SELECT and mapping
- **Update [getAllWorldPrimitives](file:///Users/zacharymilo/Documents/world-model-agent/server/db.ts#758-779)** (line 758-778): Include `blueprint_name` in mapping

#### [MODIFY] [grid.ts](file:///Users/zacharymilo/Documents/world-model-agent/server/api/grid.ts)

- **Blueprint continue endpoint** (~line 1579): When creating primitives during blueprint execution, set `blueprintName` from the plan's `blueprintName` field

#### [MODIFY] [ObjectInfoModal.tsx](file:///Users/zacharymilo/Documents/world-model-agent/src/components/UI/ObjectInfoModal.tsx)

- **Complete rewrite of the modal** (lines 4-70):
  - When `selectedPrimitive.blueprintInstanceId` exists:
    - Look up all primitives sharing the same `blueprintInstanceId` from the store
    - Show structure-level info: blueprint name, total pieces, builder agent, completion status
    - Show a compact summary instead of individual primitive details
  - When no `blueprintInstanceId`, keep current primitive-level display

#### [MODIFY] [store.ts](file:///Users/zacharymilo/Documents/world-model-agent/src/store.ts)

- No store changes needed — `worldPrimitives` array already contains all primitives, and `selectedPrimitive` already has the type. The modal can filter in-component.

---

### Feature 3: Referral System

Each agent gets a unique referral code. Both referrer and referee get bonus credits.

#### [MODIFY] [db.ts](file:///Users/zacharymilo/Documents/world-model-agent/server/db.ts)

- **Add `referrals` table** in [initDatabase](file:///Users/zacharymilo/Documents/world-model-agent/server/db.ts#23-230) (after `agent_memory` table, ~line 205):
  ```sql
  CREATE TABLE IF NOT EXISTS referrals (
    id SERIAL PRIMARY KEY,
    referrer_agent_id VARCHAR(255) NOT NULL,
    referee_agent_id VARCHAR(255) NOT NULL,
    credited_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(referee_agent_id)
  );
  ```
- **Add migration** (in DO block ~line 176):
  ```sql
  ALTER TABLE agents ADD COLUMN IF NOT EXISTS referral_code VARCHAR(50) DEFAULT NULL;
  ```
- **Add index** (after line 217):
  ```sql
  CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_referral_code ON agents(referral_code) WHERE referral_code IS NOT NULL;
  ```
- **New function `generateReferralCode(agentName, agentId)`**: Returns `ref_${agentName}_${agentId.slice(-6)}`
- **New function `getAgentByReferralCode(code)`**: Lookup agent by referral code
- **New function `recordReferral(referrerAgentId, refereeAgentId)`**: Insert into `referrals` table
- **New function `getReferralStats(agentId)`**: Count referrals + total credits earned from them

#### [MODIFY] [types.ts](file:///Users/zacharymilo/Documents/world-model-agent/server/types.ts)

- **Update [AgentRow](file:///Users/zacharymilo/Documents/world-model-agent/server/types.ts#117-139)** (line 117-138): Add `referral_code: string | null`
- **Update `EnterWorldWithIdentitySchema`** (line 373-378): Add:
  ```ts
  referralCode: z.string().max(50).optional(),
  ```
- **Add referral config to `BUILD_CREDIT_CONFIG`**:
  ```ts
  REFERRAL_BONUS_CREDITS: 250,
  ```

#### [MODIFY] [agents.ts](file:///Users/zacharymilo/Documents/world-model-agent/server/api/agents.ts)

- **In enter endpoint** (line 66-347):
  - Destructure `referralCode` from parsed data
  - For new agents: generate a referral code, store it in DB
  - If `referralCode` provided: look up referrer, record referral, credit both with 250 credits
  - Include `referralCode` in enter response

#### [MODIFY] [grid.ts](file:///Users/zacharymilo/Documents/world-model-agent/server/api/grid.ts)

- **New endpoint `GET /v1/grid/referral`**: Returns agent's referral code and stats (requires auth)

---

### Feature 4: Landing Page — Live Stats + Top-Down Heat Map

#### [MODIFY] [grid.ts](file:///Users/zacharymilo/Documents/world-model-agent/server/api/grid.ts)

- **New endpoint `GET /v1/grid/stats`** (public, no auth): Returns lightweight world stats for the landing page:
  ```json
  {
    "agentsOnline": 4,
    "totalStructures": 847,
    "totalGuilds": 3,
    "activeDirectives": 2,
    "heatMap": {
      "cellSize": 20,
      "cells": [{ "x": 180, "z": 200, "density": 42 }, ...]
    },
    "nodes": [
      { "name": "city-node Central", "tier": "city-node", "center": {"x":160,"z":180}, "structureCount": 14 }
    ]
  }
  ```
  This reuses existing spatial summary computation but returns a simplified, cacheable version. Cache response with 30-second TTL to avoid repeated computation.

#### [NEW] Landing Page Component (separate from the Three.js app)

This depends on how the landing page at `opgrid.world` is built. If it's a separate static site, the integration is a `fetch` call to the `/v1/grid/stats` endpoint. If it's the same Vite app, add a new route/component.

- **Live stats bar**: Fetch `/v1/grid/stats` every 30s, display active agents, structures, guilds, directives
- **Top-down heat map**: Render `cells` data as a 2D canvas/SVG grid. Each cell is a colored square where `density` maps to heat color (blue→yellow→red). Draw `nodes` as labeled circles with connections.

> [!NOTE]
> The landing page implementation depends on the current `opgrid.world` setup. If it's a separate repo/hosting, this becomes a small standalone JS widget. If it's part of the same Vite app, it's a new page component.

---

## Tier 2: Ship Next Week

---

### Feature 5: BYOA — "Prompt Your Agent"

Allow wallet-connected humans to interact with their agent in the world through the frontend.

#### Phase A: Text commands from frontend

#### [MODIFY] [App.tsx](file:///Users/zacharymilo/Documents/world-model-agent/src/App.tsx)

- Add state for the connected agent's JWT token (returned from enter flow)
- When wallet is connected and agent is authenticated, show a chat/command input bar at the bottom of the viewport

#### [MODIFY] [store.ts](file:///Users/zacharymilo/Documents/world-model-agent/src/store.ts)

- Add `authToken: string | null` and `setAuthToken` action
- Add `isAgentOwner: boolean` and `setIsAgentOwner` action

#### [NEW] [src/components/UI/AgentCommandBar.tsx](file:///Users/zacharymilo/Documents/world-model-agent/src/components/UI/AgentCommandBar.tsx)

- Floating command bar at the bottom of the viewport (only visible when authenticated as an agent owner)
- Three input modes:
  - **Chat**: Text input → sends `POST /v1/agents/action` with `action: "CHAT"`
  - **Move**: Click on the 3D viewport → sends `POST /v1/agents/action` with `action: "MOVE"` to clicked coordinates
  - **Build**: Dropdown of blueprints → sends `POST /v1/grid/blueprint/start`
- Uses the stored JWT token for auth headers

#### Phase B: API Key + Full runtime (Tier 3 — future)

Phase B requires significant server-side work (hosted runtime management, API key encryption, resource management) and should be deferred to Tier 3 or beyond. Phase A provides the core interaction loop.

---

### Feature 6: Skill Market v1

A public registry of agent behavioral modules (skills) that any agent can discover and load.

#### [MODIFY] [db.ts](file:///Users/zacharymilo/Documents/world-model-agent/server/db.ts)

- **Add `skills` table** in [initDatabase](file:///Users/zacharymilo/Documents/world-model-agent/server/db.ts#23-230):
  ```sql
  CREATE TABLE IF NOT EXISTS skills (
    id VARCHAR(255) PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    description TEXT NOT NULL,
    prompt_injection TEXT NOT NULL,
    tags TEXT[] DEFAULT '{}',
    category VARCHAR(50) DEFAULT 'general',
    author_agent_id VARCHAR(255),
    is_opgrid_specific BOOLEAN DEFAULT FALSE,
    required_class VARCHAR(50) DEFAULT NULL,
    rating_sum FLOAT DEFAULT 0,
    rating_count INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS skill_ratings (
    skill_id VARCHAR(255) NOT NULL,
    agent_id VARCHAR(255) NOT NULL,
    rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
    rated_at TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (skill_id, agent_id)
  );
  ```
- **New functions:**
  - `createSkill(skill)` — insert into skills table
  - `getAllSkills(filters?)` — list skills with optional category/tag/class filters
  - `getSkill(id)` — get single skill
  - `rateSkill(skillId, agentId, rating)` — upsert rating, update aggregate
  - `getSkillsByClass(agentClass)` — filter skills by required class

#### [MODIFY] [types.ts](file:///Users/zacharymilo/Documents/world-model-agent/server/types.ts)

- **Add skill schemas:**
  ```ts
  export const CreateSkillSchema = z.object({
    name: z.string().min(3).max(100),
    description: z.string().min(10).max(2000),
    promptInjection: z.string().min(10).max(5000),
    tags: z.array(z.string()).max(10).default([]),
    category: z.enum(['building', 'governance', 'exploration', 'economy', 'social', 'general']).default('general'),
    isOpgridSpecific: z.boolean().default(false),
    requiredClass: z.enum(AGENT_CLASSES).optional(),
  });
  export const RateSkillSchema = z.object({
    rating: z.number().int().min(1).max(5),
  });
  ```

#### [NEW] [server/api/skills.ts](file:///Users/zacharymilo/Documents/world-model-agent/server/api/skills.ts)

- **`GET /v1/skills`** — Browse all skills (public, supports `?category=`, `?tag=`, `?class=` filters)
- **`GET /v1/skills/:id`** — Get single skill with full prompt injection
- **`POST /v1/skills`** — Register a new skill (requires auth, sets `author_agent_id`)
- **`POST /v1/skills/:id/rate`** — Rate a skill (requires auth)

#### [MODIFY] [server/index.ts](file:///Users/zacharymilo/Documents/world-model-agent/server/index.ts)

- Register the new skills routes

#### [MODIFY] [public/skill.md](file:///Users/zacharymilo/Documents/world-model-agent/public/skill.md)

- Add skill market endpoints to the API reference section

---

## Tier 3: Ship in 2 Weeks

---

### Feature 7: Resource System

Adds Energy, Materials, and Influence as resources beyond credits.

#### [MODIFY] [db.ts](file:///Users/zacharymilo/Documents/world-model-agent/server/db.ts)

- **Add migration** (in DO block):
  ```sql
  ALTER TABLE agents ADD COLUMN IF NOT EXISTS energy INTEGER DEFAULT 100;
  ALTER TABLE agents ADD COLUMN IF NOT EXISTS materials INTEGER DEFAULT 0;
  ALTER TABLE agents ADD COLUMN IF NOT EXISTS influence INTEGER DEFAULT 0;
  ALTER TABLE agents ADD COLUMN IF NOT EXISTS energy_last_regen TIMESTAMP DEFAULT NOW();
  ```
- **Update [AgentRow](file:///Users/zacharymilo/Documents/world-model-agent/server/types.ts#117-139)** to include `energy`, `materials`, `influence`, `energy_last_regen`
- **Update [rowToAgent](file:///Users/zacharymilo/Documents/world-model-agent/server/db.ts#439-465)** to map the new fields
- **New functions:**
  - `regenerateEnergy(agentId)` — replenish energy based on time elapsed
  - `deductEnergy(agentId, amount)` — atomic deduction
  - `addMaterials(agentId, amount)` — e.g., from scavenging
  - `addInfluence(agentId, amount)` — from completed directives, reputation

#### [MODIFY] [types.ts](file:///Users/zacharymilo/Documents/world-model-agent/server/types.ts)

- **Update [AgentRow](file:///Users/zacharymilo/Documents/world-model-agent/server/types.ts#117-139)** with new resource fields
- **Add resource config:**
  ```ts
  export const RESOURCE_CONFIG = {
    MAX_ENERGY: 100,
    ENERGY_REGEN_RATE: 10, // per hour
    BLUEPRINT_ENERGY_COST: 5,
    DIRECTIVE_ENERGY_COST: 10,
    SCAVENGE_BASE_MATERIALS: 3,
    INFLUENCE_PER_DIRECTIVE: 5,
  };
  ```

#### [MODIFY] [grid.ts](file:///Users/zacharymilo/Documents/world-model-agent/server/api/grid.ts)

- **Blueprint start**: Deduct energy alongside credits
- **Directive submit**: Deduct energy
- **Directive complete**: Award influence to completers
- **New endpoint `GET /v1/grid/resources`**: Returns agent's energy, materials, influence
- **New endpoint `POST /v1/grid/scavenge`**: Scavenger class can salvage materials from abandoned structures

---

### Feature 8: Agent Profile Improvements

#### [MODIFY] [agents.ts](file:///Users/zacharymilo/Documents/world-model-agent/server/api/agents.ts)

- **New endpoint `PUT /v1/agents/profile`**: Update name, bio, color, class. Rate-limited to 1 change per 24h.
  ```ts
  const ProfileUpdateSchema = z.object({
    name: z.string().min(1).max(50).optional(),
    bio: z.string().max(280).optional(),
    color: z.string().optional(),
    agentClass: z.enum(AGENT_CLASSES).optional(),
  });
  ```

#### [MODIFY] [db.ts](file:///Users/zacharymilo/Documents/world-model-agent/server/db.ts)

- **Add migration**: `ALTER TABLE agents ADD COLUMN IF NOT EXISTS profile_updated_at TIMESTAMP DEFAULT NULL;`
- **New function `updateAgentProfile(agentId, updates)`**: Updates bio, name, color, class with 24h rate limit check

#### [MODIFY] [AgentBioPanel.tsx](file:///Users/zacharymilo/Documents/world-model-agent/src/components/UI/AgentBioPanel.tsx)

- Add "Edit Profile" button (visible only when viewing own agent while authenticated)
- Add color picker for agent color
- Add class badge display
- Show build count, reputation details, guild info

---

### Feature 9: Cross-Platform Marketing — Twitter Integration

#### [MODIFY] [db.ts](file:///Users/zacharymilo/Documents/world-model-agent/server/db.ts)

- **Add migration**: `ALTER TABLE agents ADD COLUMN IF NOT EXISTS twitter_handle VARCHAR(100) DEFAULT NULL;`

#### [MODIFY] [types.ts](file:///Users/zacharymilo/Documents/world-model-agent/server/types.ts)

- **Update [AgentRow](file:///Users/zacharymilo/Documents/world-model-agent/server/types.ts#117-139)**: Add `twitter_handle: string | null`
- **Add link schema:**
  ```ts
  export const LinkTwitterSchema = z.object({
    twitterHandle: z.string().min(1).max(100),
  });
  ```

#### [MODIFY] [agents.ts](file:///Users/zacharymilo/Documents/world-model-agent/server/api/agents.ts)

- **New endpoint `POST /v1/agents/link-twitter`**: Save Twitter handle to agent profile (requires auth)
- **Include `twitterHandle` in agent details response**

#### [NEW] [server/scripts/twitter-herald.ts](file:///Users/zacharymilo/Documents/world-model-agent/server/scripts/twitter-herald.ts)

- Standalone daemon that polls for notable events and tweets them:
  - New agent entered (tag their linked Twitter)
  - Blueprint completed
  - Directive passed/completed
  - Guild formed
  - Milestone hit (100th structure, new node tier reached)
- Uses the X/Twitter API v2 with OAuth 2.0
- Runs as a separate process (`node twitter-herald.js`)

> [!WARNING]
> Twitter API integration requires API keys and an approved developer account. This feature is a standalone daemon, not part of the main server process. It can be deferred if API access isn't available yet.

---

## Verification Plan

### Automated Checks (Every Tier)

Run after every set of changes:

```bash
# Server TypeScript compilation
cd /Users/zacharymilo/Documents/world-model-agent && npx tsc --noEmit --project tsconfig.json

# Agent runtime TypeScript compilation  
cd /Users/zacharymilo/Documents/world-model-agent/autonomous-agents && npx tsc --noEmit
```

### Tier 1 Manual Verification

1. **Agent Classes**: Deploy server, call `POST /v1/agents/enter` with `agentClass: "explorer"`. Verify response includes `agentClass`. Call `GET /v1/grid/agents/:id` and verify class is returned.

2. **Blueprint Click**: Open `beta.opgrid.world` in browser. Click on a primitive that is part of a blueprint. Verify modal shows structure name, builder name, and piece count instead of just primitive info.

3. **Referrals**: Enter with agent A (get referral code from response). Enter with agent B using `referralCode` from agent A. Verify both agents get +250 credits. Call `GET /v1/grid/referral` as agent A and verify stats.

4. **Landing Page Stats**: Call `GET /v1/grid/stats` (no auth). Verify it returns `agentsOnline`, `totalStructures`, `heatMap.cells`, and `nodes` array.

### Tier 2 Manual Verification

5. **BYOA**: Open `beta.opgrid.world`, connect wallet, enter the world. Verify the command bar appears at the bottom. Type a chat message and verify it appears in the world chat. Click "Move" and click on the ground — verify agent moves.

6. **Skill Market**: Call `POST /v1/skills` with a skill definition. Call `GET /v1/skills` and verify it appears. Call `POST /v1/skills/:id/rate` with a rating. Call `GET /v1/skills/:id` and verify the rating is reflected.

### Tier 3 Manual Verification

7. **Resources**: After entering, call `GET /v1/grid/resources`. Verify `energy: 100`, `materials: 0`, `influence: 0`. Start a blueprint and verify energy is deducted. Complete a directive and verify influence is awarded.

8. **Profile Update**: Call `PUT /v1/agents/profile` with new bio and color. Verify changes persist. Call again within 24h — verify it's rejected with rate limit error.

9. **Twitter Link**: Call `POST /v1/agents/link-twitter` with a handle. Call `GET /v1/grid/agents/:id` and verify `twitterHandle` is returned.

---

## Implementation Order

```
Tier 1 (parallel streams):
├─ Stream A: Agent Classes (types → db → agents.ts → grid.ts → frontend)
├─ Stream B: Blueprint Click (types → db → grid.ts → frontend modal)
├─ Stream C: Referrals (types → db → agents.ts → grid.ts)
└─ Stream D: Stats endpoint (grid.ts only)

Tier 2 (after Tier 1 deployed):
├─ Stream E: BYOA Command Bar (store → App → new component)
└─ Stream F: Skill Market (types → db → new API file → skill.md)

Tier 3 (after Tier 2 deployed):
├─ Stream G: Resources (types → db → grid.ts → agents.ts)
├─ Stream H: Profile improvements (db → agents.ts → frontend)
└─ Stream I: Twitter integration (db → agents.ts → new script)
```

> [!TIP]
> Tier 1 streams A-D can be implemented in parallel since they touch different sections of the same files. Recommend doing them in order A→B→C→D to avoid merge conflicts in [types.ts](file:///Users/zacharymilo/Documents/world-model-agent/src/types.ts) and [db.ts](file:///Users/zacharymilo/Documents/world-model-agent/server/db.ts).
