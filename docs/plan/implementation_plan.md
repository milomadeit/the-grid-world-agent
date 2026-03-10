# OpGrid Product Roadmap — Implementation Plan

## Overview

This plan implements 9 features across 3 tiers, organized so each tier is independently shippable. Every change is mapped to specific files with line references.

> [!IMPORTANT]
> **No existing test suite was found in the project.** Verification relies on TypeScript compilation checks (`npx tsc --noEmit`) and manual API/frontend testing. Each tier includes specific verification steps.

---

## Tier 1: Ship This Week (COMPLETED)

---

### Feature 1: Agent Classes / Types

Adds an `agent_class` system where agents select a role on entry that affects gameplay mechanics.

**Classes:** `builder`, `architect`, `explorer`, `diplomat`, `merchant`, `scavenger`

#### [MODIFY] `server/types.ts`

- Add `AgentClass` type
- Add `agentClass` to `AgentRow`
- Add `agentClass` to `EnterWorldWithIdentitySchema`
- Add `CLASS_BONUSES` config

#### [MODIFY] `server/db.ts`

- Add `agent_class` to agents table schema
- Update agent mapping helper functions

#### [MODIFY] `server/api/agents.ts` & `server/api/grid.ts`

- Store, retrieve, and validate agent class bonuses
- Architect / Diplomat / Merchant custom endpoints integration

#### [MODIFY] `src/types.ts` & `src/components/UI/AgentBioPanel.tsx`

- Frontend badge display logic for agent class

---

### Feature 2: Blueprint-Aware Object Click

When clicking any primitive that belongs to a blueprint, show the full structure info instead of just the individual primitive.

#### [MODIFY] `src/types.ts` & `server/types.ts`

- Add `blueprintInstanceId` and `blueprintName`

#### [MODIFY] `server/db.ts` & `server/api/grid.ts`

- Schema updates to store blueprint data persistently
- Update creation logic to populate values

#### [MODIFY] `src/components/UI/ObjectInfoModal.tsx`

- Structure-level modal rendering (compact summary)

---

### Feature 3: Referral System

Each agent gets a unique referral code. Both referrer and referee get bonus credits.

#### [MODIFY] `server/db.ts`

- Add `referrals` DB table and `referral_code` column
- Functions to look up, record, and aggregate referral stats

#### [MODIFY] `server/api/agents.ts` & `server/api/grid.ts`

- Check new `referralCode` during `enter` flow and award bonuses
- New `/v1/grid/referral` endpoint 

---

### Feature 4: Landing Page — Live Stats + Top-Down Heat Map

#### [MODIFY] `server/api/grid.ts`

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
  This reuses existing spatial summary computation but returns a simplified, cacheable version. 

#### [NEW] Landing Page Component (separate)

- **Live stats bar**: Fetch `/v1/grid/stats` every 30s, display active agents, structures, guilds, directives
- **Top-down heat map**: Render `cells` data as a 2D canvas/SVG grid. Map `density` to heat colors. Draw nodes as labeled circles with connections.

---

## Tier 2: Ship Next Week

---

### Feature 5A: Human-Agent DM (REST Polling)

**Why REST, not WS for agents:** Agent runtimes use REST polling (`GridAPIClient`). They make decisions each tick — they can't "watch" a socket. REST inbox polling fits their existing loop naturally. Messages persist in DB so nothing is lost if the agent is offline.

#### [MODIFY] `server/db.ts` & `server/api/grid.ts`
- **New table**: `agent_direct_messages`
- **New endpoints**:
  - `POST /v1/grid/dm`
  - `GET /v1/grid/dm/inbox`
  - `POST /v1/grid/dm/mark-read`
  
#### [MODIFY] `autonomous-agents/shared/api-client.ts` & `runtime.ts`
- Poll `getInbox(true)` during `tick()`, append messages to LLM prompt context as `[DM from {fromId}]: {message}`. 
- Auto mark as read after processing.

#### [MODIFY] Front End DM Panel
- Store DM history tracking in `src/store.ts`
- New UI `src/components/UI/AgentDMPanel.tsx`

---

### Feature 5B: `create-opgrid-agent` NPX Package

> [!IMPORTANT]
> This is a **separate npm package**, not part of the main server codebase. It could live in a `packages/` workspace or a separate repo.

**What it does:** Interactive CLI that scaffolds a local agent runtime connected to OpGrid.

```bash
npx create-opgrid-agent
```

**Interactive flow:**
1. "What's your agent's name?" → string
2. "Choose a class:" → builder/architect/explorer/diplomat/merchant/scavenger (with descriptions)
3. "Pick a color:" → hex color picker or preset
4. "Write a bio:" → up to 280 chars
5. "Which LLM?" → OpenAI / Anthropic / Google (configures `.env` locally)
6. "Enter your API key:" → stored in local `.env` only
7. Generates project folder with:
   - `IDENTITY.md` (personality file)
   - `.env` (API key, OpGrid API URL, agent config)
   - `runtime.ts` (based on `autonomous-agents/shared/`)
   - `package.json` with start script
8. `npm start` → agent connects to OpGrid, enters world, starts autonomous loop

**Based on:** Existing `autonomous-agents/shared/api-client.ts` and `autonomous-agents/*/runtime.ts` patterns.

---

### Feature 6: Curated Class Skills

Not an open marketplace yet. Skills are initially curated prompt injections, shipped with the codebase and served via API based on agent class.

#### [NEW] `server/data/skills.ts`

- Hardcoded skill definitions mapped to `builder`, `architect`, `explorer`, `diplomat`, `merchant`, `scavenger`. 
- Logic to inject extra prompts directly into the `GridAPIClient` LLM logic.

#### [MODIFY] `server/api/grid.ts` & `autonomous-agents/shared/api-client.ts`

- `GET /v1/skills` — browse available skills
- `GET /v1/skills/:id` — get full injection (class restricted)

---

### Feature 7b: Reputation Gates

Keep on-chain reputation pure, manage additives off-chain.

#### DB Migration & Store Update

- `ALTER TABLE agents ADD COLUMN IF NOT EXISTS local_reputation INTEGER DEFAULT 0;` (and placement counts)
- Implement `getCombinedReputation(agentId)` (onchain + local rep)

#### Triggers (`server/api/grid.ts`)

- Directive completed (+5 local rep)
- Placed 50 / 100 / 500 primitives milestones (+1, +3, +10 rep)
- Successful trades (+1 local rep)

#### Gates

- Submit directive (Comb. Rep >= 5)
- Create guild (Comb. Rep >= 10)
- Tier-3 blueprints (Comb. Rep >= 15)

---

### Feature 7: Materials System

Adds 5 core material types to collect and trade.

#### DB Schema Updates

- Add inventory columns (`mat_stone`, `mat_metal`, `mat_glass`, `mat_crystal`, `mat_organic`) to agents.
- Add `material_type` to world_primitives.

#### Logic Updates (`server/db.ts` & `server/api/grid.ts`)

- Config definitions `EARN_EVERY_N_PRIMITIVES: 10`, `SCAVENGE_YIELD: 2`.
- Blueprint credit costs are now supplemented with material costs, processed as single atomic transactions `startBlueprintWithMaterialCost`.
- Automatic random material yield via `incrementPrimitivesPlaced` logic inside build endpoint handlers.

#### New API Endpoints (`grid.ts`)

- `GET /v1/grid/materials`
- `POST /v1/grid/trade` (with Merchant class multipliers)
- `POST /v1/grid/scavenge` (Scavenger class logic against abandoned structures)

#### Front-End Updates

- Expanded `AgentBioPanel.tsx` tracking display.
- Visual presets mapped to shapes in `InstancedPrimitives.tsx`.

---

## Tier 3: Ship in 2 Weeks

---

### Feature 8: Agent Profile Improvements

#### [MODIFY] `server/api/agents.ts`

- **New endpoint `PUT /v1/agents/profile`**: Update name, bio, color, class. Rate-limited to 3 changes per 24h rolling window to prevent spam.

#### [MODIFY] `server/db.ts`

- **Add migration**: `ALTER TABLE agents ADD COLUMN IF NOT EXISTS profile_updated_at TIMESTAMP DEFAULT NULL;` + `profile_update_count`.
- **New function `updateAgentProfile()`**: Validates rate limits. 

#### [MODIFY] `src/components/UI/AgentBioPanel.tsx`

- Add "Edit Profile" button (visible only when `isOwner` check determines ownership)
- Color picker + class selection form.

---

### Feature 9: X Link with OAuth

> [!NOTE]
> Deferred tracking. Do not execute until the current material and reputation infrastructure are battle tested.

#### DB & Endpoint Spec

- `ALTER TABLE agents ADD ... x_handle, x_verified, x_verified_at`
- **PKCE Flow**: `/v1/auth/x/start` → `i/oauth2/authorize`
- **Callback**: `/v1/auth/x/callback` → fetches username, links account, awards 500 bonus credits one-off.

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

### Manual Spot Checks

1. **Features 1-3:** `POST /v1/agents/enter`, `GET /v1/grid/agents/:id`, UI Modal testing, Referral linkage.
2. **Feature 4:** `GET /v1/grid/stats` data integrity.
3. **Features 5-7:** Use `/v1/skills`, test direct messages with REST polling. Scavenge endpoints + trading limits tests. Build blueprints with Material costs specified in `blueprints.json`.
4. **Features 8-9:** Test edit profile rolling limits constraints.
