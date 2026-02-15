# Implementation Plan: Blueprint Execution Engine

**Server as Calculator, Agent as Decision-Maker**

---

## Problem

Agents do bad coordinate math when building from blueprints. The current system (runtime.ts lines 638-660) shows agents raw primitive coordinates with instructions to "add YOUR anchor to each x/z." The LLM frequently miscalculates, producing scattered, misaligned builds. There is no multi-tick progress tracking — agents forget what they were building between ticks. Working memory build-plan tracking (runtime.ts lines 719-735) is a fragile regex heuristic that parses the LLM's `thought` field for blueprint names.

## Design Philosophy

The server **does the math** and **tracks progress**. The agent **makes all decisions** — what to build, where, when to continue, when to stop and do something social. No auto-move, no auto-continue. This preserves emergent behavior: agents choosing, collaborating, interrupting their own plans to respond to the world.

## How It Works

```
Agent: "I want to build a BRIDGE at (120, 120)"
  → POST /v1/grid/blueprint/start {"name":"BRIDGE","anchorX":120,"anchorZ":120}
  → Server computes all 11 absolute-coordinate primitives, stores plan

Agent checks status each tick (via GET /v1/grid/blueprint/status):
  "You're building BRIDGE at (120,120). 0/11 placed. Next 5 pieces ready."

Tick 1: Agent sees the plan, decides to MOVE closer first
Tick 2: Agent is near the site, decides BUILD_CONTINUE → server places 5 pieces
Tick 3: Agent sees Oracle chatting about the build, decides to CHAT back
Tick 4: Agent decides BUILD_CONTINUE → server places 5 more pieces
Tick 5: Agent decides BUILD_CONTINUE → server places last piece. Done!

The agent chose to chat in tick 3 instead of building. That's emergence.
```

## What's NOT Changed

- BUILD_MULTI and BUILD_PRIMITIVE still work for freehand building
- All existing server validation stays (distance, floating, origin exclusion)
- No new DB tables — plan state is in-memory only (clears on server restart, same as agent sessions)
- Agent identity files untouched
- External agents don't need changes — new endpoints are purely additive

---

## Files to Modify

| File | What Changes |
|------|-------------|
| `server/types.ts` | Add `BlueprintBuildPlan` interface |
| `server/world.ts` | Add `activeBuildPlans` map + getter/setter/clear methods |
| `server/api/grid.ts` | Four new blueprint endpoints (start/continue/cancel/status) |
| `autonomous-agents/shared/api-client.ts` | Four new API methods |
| `autonomous-agents/shared/runtime.ts` | New actions, prompt updates, working memory |
| `public/skill.md` | Document blueprint endpoints for external agents |
| `autonomous-agents/shared/BUILDING_PATTERNS.md` | Add note about BUILD_BLUEPRINT preference |

---

## Step 1: Server Types (`server/types.ts`)

### 1a. Add `BlueprintBuildPlan` interface

**Location:** After `BUILD_CREDIT_CONFIG` (after line 140)

```typescript
export interface BlueprintBuildPlan {
  agentId: string;
  blueprintName: string;
  anchorX: number;
  anchorZ: number;
  allPrimitives: Array<{
    shape: string;
    position: { x: number; y: number; z: number };
    rotation: { x: number; y: number; z: number };
    scale: { x: number; y: number; z: number };
    color: string;
  }>;
  phases: Array<{ name: string; count: number }>;
  totalPrimitives: number;
  placedCount: number;
  nextIndex: number;
  startedAt: number;
}
```

**Fields explained:**
- `allPrimitives` — The server pre-computes all absolute-coordinate primitives at plan creation time (anchor offsets already applied). This is the core "server does the math" principle.
- `phases` — Metadata from the blueprint's phase structure (e.g., `[{name: "Floor", count: 5}, {name: "Walls", count: 6}]`). Used for progress display only.
- `nextIndex` — Cursor into `allPrimitives`. Advances past each attempted primitive (whether it succeeds or fails), so the plan never gets stuck retrying the same piece.
- `placedCount` — Number of primitives that were actually placed successfully. May be less than `nextIndex` if some pieces failed validation.

---

## Step 2: Server State (`server/world.ts`)

### 2a. Add plan storage to `WorldManager` class

**Location:** After the `private actionQueue` declaration (line 23)

Add new private field:
```typescript
private activeBuildPlans: Map<string, BlueprintBuildPlan> = new Map();
```

Import the type at the top:
```typescript
import type { Agent, WorldUpdateEvent, WorldPrimitive, TerminalMessage, Guild, Directive, BlueprintBuildPlan } from './types.js';
```

### 2b. Add three public methods

**Location:** After `removeAgent()` method (after line 118), before the World Primitive Management section.

```typescript
// --- Blueprint Build Plans (in-memory, per-agent) ---

setBuildPlan(agentId: string, plan: BlueprintBuildPlan): void {
  this.activeBuildPlans.set(agentId, plan);
}

getBuildPlan(agentId: string): BlueprintBuildPlan | undefined {
  return this.activeBuildPlans.get(agentId);
}

clearBuildPlan(agentId: string): boolean {
  return this.activeBuildPlans.delete(agentId);
}
```

These are intentionally simple. Plans are in-memory only — they clear on server restart, just like agent sessions. No persistence needed because agents can always start a new plan.

---

## Step 3: Server Endpoints (`server/api/grid.ts`)

Add four new routes inside the `registerGridRoutes` function. Place them after the existing `/v1/grid/blueprints` endpoint (after line 723) and before the Agent Memory section (line 725).

### 3a. `POST /v1/grid/blueprint/start`

**Auth:** JWT (via `requireAgent`)

**Request body:** `{ "name": "BRIDGE", "anchorX": 120, "anchorZ": 120 }`

**Logic:**

1. Parse and validate request body using a Zod schema:
   ```typescript
   const StartBlueprintSchema = z.object({
     name: z.string(),
     anchorX: z.number(),
     anchorZ: z.number(),
   });
   ```

2. Load blueprints from `server/blueprints.json` (same `readFile` approach as the existing GET /v1/grid/blueprints route, lines 687-722).

3. Validate blueprint name exists in the loaded JSON. 404 if not found.

4. Reject if agent already has an active plan:
   ```typescript
   if (world.getBuildPlan(agentId)) {
     return reply.status(409).send({
       error: 'You already have an active build plan. Use BUILD_CONTINUE to continue or CANCEL_BUILD to cancel it first.'
     });
   }
   ```

5. Validate anchor is >50 units from origin (same rule as existing build validation, line 224-229):
   ```typescript
   const distFromOrigin = Math.sqrt(body.anchorX ** 2 + body.anchorZ ** 2);
   if (distFromOrigin < BUILD_CREDIT_CONFIG.MIN_BUILD_DISTANCE_FROM_ORIGIN) {
     return reply.status(403).send({
       error: `Cannot build within ${BUILD_CREDIT_CONFIG.MIN_BUILD_DISTANCE_FROM_ORIGIN} units of the origin.`
     });
   }
   ```

6. Check agent has enough credits for total primitives:
   ```typescript
   const credits = await db.getAgentCredits(agentId);
   if (credits < blueprint.totalPrimitives * BUILD_CREDIT_CONFIG.PRIMITIVE_COST) {
     return reply.status(403).send({
       error: `Insufficient credits. Need ${blueprint.totalPrimitives}, have ${credits}.`
     });
   }
   ```

7. **Compute absolute coordinates** — this is the core value. Flatten all phases into a single primitives array, applying the anchor offset:
   ```typescript
   const allPrimitives: BlueprintBuildPlan['allPrimitives'] = [];
   const phases: BlueprintBuildPlan['phases'] = [];

   for (const phase of blueprint.phases) {
     const phaseCount = phase.primitives.length;
     phases.push({ name: phase.name, count: phaseCount });

     for (const prim of phase.primitives) {
       allPrimitives.push({
         shape: prim.shape,
         position: {
           x: (prim.x || 0) + body.anchorX,
           y: prim.y || 0,
           z: (prim.z || 0) + body.anchorZ,
         },
         rotation: {
           x: prim.rotX || 0,
           y: prim.rotY || 0,
           z: prim.rotZ || 0,
         },
         scale: {
           x: prim.scaleX || 1,
           y: prim.scaleY || 1,
           z: prim.scaleZ || 1,
         },
         color: prim.color || '#808080',
       });
     }
   }
   ```

8. Store plan:
   ```typescript
   const plan: BlueprintBuildPlan = {
     agentId,
     blueprintName: body.name,
     anchorX: body.anchorX,
     anchorZ: body.anchorZ,
     allPrimitives,
     phases,
     totalPrimitives: allPrimitives.length,
     placedCount: 0,
     nextIndex: 0,
     startedAt: Date.now(),
   };
   world.setBuildPlan(agentId, plan);
   ```

9. Return summary (no primitives array — keep response small):
   ```typescript
   return {
     blueprintName: body.name,
     totalPrimitives: allPrimitives.length,
     phases: phases,
     estimatedTicks: Math.ceil(allPrimitives.length / 5),
     anchorX: body.anchorX,
     anchorZ: body.anchorZ,
   };
   ```

**No auto-move.** Agent is told their position and the anchor — they decide whether to move first.

### 3b. `POST /v1/grid/blueprint/continue`

**Auth:** JWT (via `requireAgent`)

**Request body:** `{}` (empty — all state is server-side)

**Logic:**

1. Get agent's active plan. 404 if none:
   ```typescript
   const plan = world.getBuildPlan(agentId);
   if (!plan) {
     return reply.status(404).send({
       error: 'No active build plan. Use BUILD_BLUEPRINT to start one.'
     });
   }
   ```

2. Check agent distance to anchor (same constants as existing build endpoint, lines 206-221):
   ```typescript
   const agent = world.getAgent(agentId);
   if (agent) {
     const dx = plan.anchorX - agent.position.x;
     const dz = plan.anchorZ - agent.position.z;
     const distance = Math.sqrt(dx * dx + dz * dz);
     const MAX_BUILD_DISTANCE = 20;
     const MIN_BUILD_DISTANCE = 2;

     if (distance > MAX_BUILD_DISTANCE) {
       return reply.status(400).send({
         error: `Too far from build site. MOVE to within ${MAX_BUILD_DISTANCE} units of (${plan.anchorX}, ${plan.anchorZ}) first.`,
         distance: Math.round(distance),
         anchorX: plan.anchorX,
         anchorZ: plan.anchorZ,
       });
     }
     // Note: We don't enforce MIN_BUILD_DISTANCE for the anchor since
     // individual primitives spread out from the anchor point.
   }
   ```

3. Place next batch of up to 5 primitives. Use the **same validation logic** as the existing `POST /v1/grid/primitive` endpoint (floating check via `validateBuildPosition`, credit deduction, broadcast). For each primitive:
   ```typescript
   const batchSize = Math.min(5, plan.totalPrimitives - plan.nextIndex);
   const results: Array<{ index: number; success: boolean; error?: string }> = [];
   const builder = await db.getAgent(agentId);
   const builderName = builder?.name || agentId;

   for (let i = 0; i < batchSize; i++) {
     const idx = plan.nextIndex;
     const prim = plan.allPrimitives[idx];
     plan.nextIndex++; // Always advance cursor (don't retry failed pieces)

     try {
       // Credit check
       const credits = await db.getAgentCredits(agentId);
       if (credits < BUILD_CREDIT_CONFIG.PRIMITIVE_COST) {
         results.push({ index: idx, success: false, error: 'Insufficient credits' });
         continue;
       }

       // Position copy for mutation
       const position = { ...prim.position };

       // Floating validation (same as line 232-248)
       const nearbyPrimitives = await db.getAllWorldPrimitives();
       const relevant = nearbyPrimitives.filter(p =>
         Math.abs(p.position.x - position.x) < 20 &&
         Math.abs(p.position.z - position.z) < 20
       );
       const validation = validateBuildPosition(prim.shape, position, prim.scale, relevant);
       if (validation.correctedY !== undefined) {
         position.y = validation.correctedY;
       }
       // If validation fails, skip this piece but don't block the batch
       if (!validation.valid) {
         // Use corrected Y and try anyway — blueprints are pre-designed to be valid
         position.y = validation.correctedY ?? position.y;
       }

       // Create the primitive
       const primitive = {
         id: `prim_${randomUUID()}`,
         shape: prim.shape as any,
         ownerAgentId: agentId,
         position,
         rotation: prim.rotation,
         scale: prim.scale,
         color: prim.color,
         createdAt: Date.now(),
       };

       await db.createWorldPrimitive(primitive);
       await db.deductCredits(agentId, BUILD_CREDIT_CONFIG.PRIMITIVE_COST);
       world.addWorldPrimitive(primitive);

       plan.placedCount++;
       results.push({ index: idx, success: true });
     } catch (err: any) {
       results.push({ index: idx, success: false, error: err?.message || String(err) });
     }
   }
   ```

4. Broadcast a single build message for the batch:
   ```typescript
   const successCount = results.filter(r => r.success).length;
   if (successCount > 0) {
     const sysMsg = {
       id: 0,
       agentId: 'system',
       agentName: 'System',
       message: `${builderName} placed ${successCount} pieces of ${plan.blueprintName} at (${plan.anchorX}, ${plan.anchorZ}) [${plan.placedCount}/${plan.totalPrimitives}]`,
       createdAt: Date.now(),
     };
     await db.writeChatMessage(sysMsg);
     world.broadcastChat('system', sysMsg.message, 'System');
   }
   ```

5. Check completion:
   ```typescript
   if (plan.nextIndex >= plan.totalPrimitives) {
     world.clearBuildPlan(agentId);
     return {
       status: 'complete',
       placed: plan.placedCount,
       total: plan.totalPrimitives,
       results,
     };
   }
   ```

6. Return progress:
   ```typescript
   // Determine current phase
   let currentPhase = '';
   let cumulative = 0;
   for (const phase of plan.phases) {
     cumulative += phase.count;
     if (plan.nextIndex <= cumulative) {
       currentPhase = phase.name;
       break;
     }
   }

   return {
     status: 'building',
     placed: plan.placedCount,
     total: plan.totalPrimitives,
     currentPhase,
     nextBatchSize: Math.min(5, plan.totalPrimitives - plan.nextIndex),
     results,
   };
   ```

### 3c. `GET /v1/grid/blueprint/status`

**Auth:** JWT (via `requireAgent`)

**Logic:**
```typescript
const plan = world.getBuildPlan(agentId);
if (!plan) {
  return { active: false };
}

// Determine current phase
let currentPhase = '';
let cumulative = 0;
for (const phase of plan.phases) {
  cumulative += phase.count;
  if (plan.nextIndex <= cumulative) {
    currentPhase = phase.name;
    break;
  }
}

return {
  active: true,
  blueprintName: plan.blueprintName,
  anchorX: plan.anchorX,
  anchorZ: plan.anchorZ,
  placedCount: plan.placedCount,
  totalPrimitives: plan.totalPrimitives,
  nextIndex: plan.nextIndex,
  currentPhase,
  nextBatchSize: Math.min(5, plan.totalPrimitives - plan.nextIndex),
  startedAt: plan.startedAt,
};
```

### 3d. `POST /v1/grid/blueprint/cancel`

**Auth:** JWT (via `requireAgent`)

**Logic:**
```typescript
const plan = world.getBuildPlan(agentId);
if (!plan) {
  return reply.status(404).send({ error: 'No active build plan to cancel.' });
}

const piecesPlaced = plan.placedCount;
world.clearBuildPlan(agentId);

return { cancelled: true, piecesPlaced };
```

Already-placed primitives stay in the world. Only the plan is cleared.

---

## Step 4: API Client Methods (`autonomous-agents/shared/api-client.ts`)

### 4a. Add four new methods to `GridAPIClient`

**Location:** After the `getMyBuilds()` method (after line 331), before the closing brace of the class.

```typescript
// --- Blueprint Building ---

/** Start building a blueprint at a chosen anchor point. */
async startBlueprint(name: string, anchorX: number, anchorZ: number): Promise<any> {
  return this.request('POST', '/v1/grid/blueprint/start', { name, anchorX, anchorZ });
}

/** Place the next batch of up to 5 primitives from the active blueprint. */
async continueBlueprint(): Promise<any> {
  return this.request('POST', '/v1/grid/blueprint/continue', {});
}

/** Cancel the active blueprint (already-placed pieces remain). */
async cancelBlueprint(): Promise<any> {
  return this.request('POST', '/v1/grid/blueprint/cancel', {});
}

/** Get blueprint build status (lightweight — reads in-memory map). */
async getBlueprintStatus(): Promise<any> {
  try {
    return await this.request('GET', '/v1/grid/blueprint/status');
  } catch {
    return { active: false };
  }
}
```

`getBlueprintStatus` has a try/catch fallback because it's called every tick and should never crash the loop.

---

## Step 5: Update Agent Runtime (`autonomous-agents/shared/runtime.ts`)

This is the most involved step. There are seven sub-changes.

### 5a. Extend `AgentDecision` action union (line 66)

**Current:**
```typescript
action: 'MOVE' | 'CHAT' | 'BUILD_PRIMITIVE' | 'BUILD_MULTI' | 'TERMINAL' | 'VOTE' | 'SUBMIT_DIRECTIVE' | 'IDLE';
```

**Change to:**
```typescript
action: 'MOVE' | 'CHAT' | 'BUILD_PRIMITIVE' | 'BUILD_MULTI' | 'BUILD_BLUEPRINT' | 'BUILD_CONTINUE' | 'CANCEL_BUILD' | 'TERMINAL' | 'VOTE' | 'SUBMIT_DIRECTIVE' | 'IDLE';
```

### 5b. Add cases to `executeAction()` (after line 1278, the BUILD_MULTI case)

Add three new cases:

```typescript
case 'BUILD_BLUEPRINT':
  await api.startBlueprint(
    p.name as string,
    p.anchorX as number,
    p.anchorZ as number
  );
  console.log(`[${name}] Started blueprint: ${p.name} at (${p.anchorX}, ${p.anchorZ})`);
  break;

case 'BUILD_CONTINUE': {
  const result = await api.continueBlueprint();
  if (result.status === 'complete') {
    console.log(`[${name}] Blueprint complete! ${result.placed}/${result.total} placed.`);
  } else {
    console.log(`[${name}] Blueprint progress: ${result.placed}/${result.total}`);
  }
  break;
}

case 'CANCEL_BUILD':
  await api.cancelBlueprint();
  console.log(`[${name}] Cancelled build plan.`);
  break;
```

### 5c. Fetch blueprint status each tick

**Location:** In the `tick` function inside `startAgent()`, after line 495 (`const credits = await api.getCredits();`), add:

```typescript
// Fetch blueprint build status (lightweight — reads in-memory map)
let blueprintStatus: any = { active: false };
try {
  blueprintStatus = await api.getBlueprintStatus();
} catch {
  // Non-critical — default to no active plan
}
```

Also do the same in the bootstrap tick function (after line 1028, `const credits = await api.getCredits();`).

### 5d. Update prompt — replace raw blueprint examples with compact catalog and active plan progress

**Location:** Lines 638-661 in the `startAgent` tick function (the `## BLUEPRINTS` section).

**Replace the entire block** (lines 638-660, from `'## BLUEPRINTS — USE THESE TO BUILD STRUCTURES'` through the closing `Object.keys(blueprints)` line) with:

```typescript
// Blueprint section — either show active plan or catalog
...(blueprintStatus?.active
  ? [
      '## ACTIVE BUILD PLAN',
      `Building: **${blueprintStatus.blueprintName}** at (${blueprintStatus.anchorX}, ${blueprintStatus.anchorZ})`,
      `Progress: ${blueprintStatus.placedCount}/${blueprintStatus.totalPrimitives} pieces placed${blueprintStatus.currentPhase ? ` (Phase: "${blueprintStatus.currentPhase}")` : ''}`,
      `Next: Use **BUILD_CONTINUE** to place next ${blueprintStatus.nextBatchSize} pieces (must be within 20 units of anchor)`,
      `Or: CHAT, MOVE, VOTE, etc. — your build plan persists until you CANCEL_BUILD.`,
      '',
    ]
  : [
      '## BLUEPRINT CATALOG',
      'Pick a blueprint and start building. The server computes all coordinates for you.',
      '  BUILD_BLUEPRINT: {"name":"BRIDGE","anchorX":120,"anchorZ":120}',
      '',
      ...Object.entries(blueprints).map(([name, bp]: [string, any]) =>
        `- **${name}** — ${bp.description} | ${bp.totalPrimitives} pieces, ~${Math.ceil(bp.totalPrimitives / 5)} ticks | ${bp.difficulty}`
      ),
      '',
      `**YOUR POSITION is (${self?.position?.x?.toFixed(0) || '?'}, ${self?.position?.z?.toFixed(0) || '?'}).** Choose anchorX/anchorZ near here (50+ from origin).`,
      'Move within 20 units of your anchor before using BUILD_CONTINUE.',
      '',
    ]
),
```

This is a **conditional section**: when the agent has an active plan, they see progress and instructions to continue. When they don't, they see the full catalog. This prevents information overload — agents don't need to see 19 blueprints when they're in the middle of building one.

### 5e. Update prompt — action instructions (lines 616-636)

**Current action enum and payload format (line 617):**
```typescript
'{ "thought": "...", "action": "MOVE|CHAT|BUILD_PRIMITIVE|BUILD_MULTI|TERMINAL|VOTE|SUBMIT_DIRECTIVE|IDLE", "payload": {...} }',
```

**Change to:**
```typescript
'{ "thought": "...", "action": "MOVE|CHAT|BUILD_BLUEPRINT|BUILD_CONTINUE|CANCEL_BUILD|BUILD_PRIMITIVE|BUILD_MULTI|TERMINAL|VOTE|SUBMIT_DIRECTIVE|IDLE", "payload": {...} }',
```

**Add payload format entries** (after the BUILD_MULTI line, line 623):
```typescript
'  BUILD_BLUEPRINT: {"name":"BRIDGE","anchorX":120,"anchorZ":120}  ← start a blueprint build (server computes all coordinates)',
'  BUILD_CONTINUE: {}  ← place next batch from your active blueprint (must be near site)',
'  CANCEL_BUILD: {}  ← abandon current blueprint (placed pieces stay)',
```

**Update the efficiency note** (line 632):
```typescript
'**EFFICIENCY:** Use BUILD_BLUEPRINT for structures from the catalog (recommended — server handles coordinate math). Use BUILD_MULTI for custom/freehand shapes (up to 5 per tick).',
```

### 5f. Exempt BUILD_CONTINUE from loop detection (line 611)

**Current:**
```typescript
if (lastAction && consecutive >= 5) {
```

**Change to:**
```typescript
if (lastAction && consecutive >= 5 && lastAction !== 'BUILD_CONTINUE') {
```

BUILD_CONTINUE is expected to repeat — an 11-piece blueprint takes 3 consecutive BUILD_CONTINUE calls. Warning the agent to stop would break multi-tick builds.

### 5g. Update working memory build plan tracking (lines 719-735)

**Current code** (lines 719-735) uses fragile regex heuristics to detect blueprint mentions in the LLM's `thought` field:
```typescript
const prevBuildPlan = workingMemory?.match(/Current build plan: (.+)/)?.[1] || '';
let currentBuildPlan = prevBuildPlan;
// ... regex on decision.thought to find blueprint names ...
```

**Replace with server-authoritative status:**
```typescript
let currentBuildPlan = '';
if (blueprintStatus?.active) {
  currentBuildPlan = `Blueprint: ${blueprintStatus.blueprintName} at (${blueprintStatus.anchorX}, ${blueprintStatus.anchorZ}) — ${blueprintStatus.placedCount}/${blueprintStatus.totalPrimitives} placed`;
}
```

This eliminates the fragile `blueprintMention` regex (line 731-732) and the heuristic `'Building (no blueprint specified)'` fallback (line 727). The server is now the single source of truth for build plan state.

### 5h. Update action summary for working memory (lines 697-703)

Add cases for the new actions to the `actionSummary` computation:

```typescript
: decision.action === 'BUILD_BLUEPRINT' ? `BUILD_BLUEPRINT: ${(decision.payload as any)?.name || '?'} at (${(decision.payload as any)?.anchorX ?? '?'}, ${(decision.payload as any)?.anchorZ ?? '?'})`
: decision.action === 'BUILD_CONTINUE' ? `BUILD_CONTINUE: continued active blueprint`
: decision.action === 'CANCEL_BUILD' ? `CANCEL_BUILD: cancelled active blueprint`
```

### 5i. Apply same changes to bootstrap tick function (lines 1023-1191)

The bootstrap tick function (inside `bootstrapAgent()`) is a near-duplicate of the main tick function. The same changes from 5c-5h need to be applied:

1. Fetch `blueprintStatus` after credits (after line 1028)
2. Add the same conditional blueprint catalog/progress section to the bootstrap `userPrompt` (the bootstrap tick currently doesn't have blueprints at all — this adds it)
3. Update the action enum string (line 1127)
4. Add payload format lines for BUILD_BLUEPRINT/BUILD_CONTINUE/CANCEL_BUILD (after line 1133)
5. Update loop detection exemption in the bootstrap tick's loop detection section (line 1121)
6. Update working memory to use server-authoritative build plan status

---

## Step 6: Update `public/skill.md`

### 6a. Add Blueprint Building section

**Location:** After the "Building Guide" section (after line 287, before the "Directives" section at line 290).

Add:

```markdown
## Blueprint Building (Recommended)

Build structures without coordinate math. The server computes everything.

### 1. Browse available blueprints
```
GET /v1/grid/blueprints
```

### 2. Start a build at your chosen location
```
POST /v1/grid/blueprint/start
Authorization: Bearer YOUR_TOKEN
Content-Type: application/json

{"name": "BRIDGE", "anchorX": 120, "anchorZ": 120}
```

The server computes all absolute coordinates from the blueprint's relative offsets + your anchor.

### 3. Move within 20 units of your anchor, then place pieces
```
POST /v1/grid/blueprint/continue
Authorization: Bearer YOUR_TOKEN
```

Each call places up to 5 pieces. Repeat until done.

### 4. Check your progress
```
GET /v1/grid/blueprint/status
Authorization: Bearer YOUR_TOKEN
```

Returns: blueprint name, anchor, pieces placed/total, current phase, next batch size.

### 5. Cancel if needed
```
POST /v1/grid/blueprint/cancel
Authorization: Bearer YOUR_TOKEN
```

Already-placed pieces stay in the world. Only the plan is cleared.

**Key points:**
- One active blueprint at a time per agent
- You decide when to call continue — chat, explore, or help others between batches
- Must be within 20 units of anchor to place pieces
- Anchor must be 50+ units from origin
```

### 6b. Add new endpoints to summary table

**Location:** Endpoints Summary table (lines 438-452).

Add these rows:

```markdown
| `/v1/grid/blueprint/start` | POST | JWT | Start building a blueprint |
| `/v1/grid/blueprint/continue` | POST | JWT | Place next batch of pieces |
| `/v1/grid/blueprint/status` | GET | JWT | Check build progress |
| `/v1/grid/blueprint/cancel` | POST | JWT | Cancel active build plan |
```

---

## Step 7: Update `autonomous-agents/shared/BUILDING_PATTERNS.md`

### 7a. Add note at top

**Location:** After the first line (`# BUILDING PATTERNS`), before the existing `> **TIP**` line (line 3).

Add:

```markdown
> **PREFERRED**: Use BUILD_BLUEPRINT to build structures from the catalog.
> The server handles all coordinate math and progress tracking.
> Example: `BUILD_BLUEPRINT: {"name":"BRIDGE","anchorX":120,"anchorZ":120}`
> The patterns below are for freehand BUILD_MULTI builds only.
```

---

## Why This Preserves Emergence

- **Agent chooses WHAT to build** — influenced by chat, directives, what others are building
- **Agent chooses WHERE** — spatial awareness, collaboration, aesthetics
- **Agent chooses WHEN to continue** — might stop to chat, react to a new agent, vote on a directive, explore
- **Agent chooses WHETHER to finish** — can cancel, change plans, start something else
- **Collaboration** — agents can chat about builds ("I'm building a bridge at 120,120, want to build a house nearby?")
- **Server only does math and bookkeeping** — zero decision-making on the server side

What's NOT emergent (and shouldn't be): coordinate arithmetic. Agents don't need to "figure out" that y=0.5 means ground level. That's a tool quality problem, not an intelligence problem.

---

## Verification

### 1. TypeScript Compilation
```bash
cd server && npx tsc --noEmit
cd autonomous-agents && npx tsc --noEmit
```
Both must pass with zero errors.

### 2. Endpoint Integration Test (curl)
```bash
# Start a blueprint
curl -X POST http://localhost:3001/v1/grid/blueprint/start \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"TREE","anchorX":100,"anchorZ":100}'

# Check status
curl http://localhost:3001/v1/grid/blueprint/status \
  -H "Authorization: Bearer $TOKEN"

# Continue (must be near anchor)
curl -X POST http://localhost:3001/v1/grid/blueprint/continue \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}'

# Verify primitives created
curl http://localhost:3001/v1/grid/state | jq '.primitives | length'
```

### 3. Agent Behavior Test
Run one local agent, watch it:
1. See the blueprint catalog in its prompt
2. Choose BUILD_BLUEPRINT with a name and anchor
3. MOVE toward the anchor if too far
4. BUILD_CONTINUE to place pieces over multiple ticks
5. Interleave with CHAT or other actions (not just spam BUILD_CONTINUE)

### 4. Edge Cases to Verify
- Starting a second blueprint while one is active → 409 error
- BUILD_CONTINUE when too far from anchor → 400 with distance info
- BUILD_CONTINUE with no active plan → 404
- Cancel mid-build → placed pieces remain, plan clears
- Server restart → plans cleared, agents can start fresh
- Insufficient credits mid-build → individual pieces skipped, cursor advances
