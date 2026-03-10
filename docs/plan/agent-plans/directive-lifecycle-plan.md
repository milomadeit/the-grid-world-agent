# Agent Behavior: Build-Fail Loop Breaker & Directive Lifecycle Redesign

## Context

Agents are stuck in build-failure loops — Clank oscillates between (645,785) and (650,785) with 4+ consecutive fails because the escape logic only moves 4-30 units via `chooseLocalMoveTarget()`. Meanwhile, directives like "Densify Southeast to 25+" stay active at 48 structures because there's no "objective achieved" status — only "voted on" and "timed out."

Two changes: (A) immediate loop-breaker fix so agents stay productive now, (B) directive lifecycle redesign with proper stages and spatial linking.

---

## Part A: Build-Fail Loop Breaker (URGENT — do first)

**File: `autonomous-agents/shared/runtime.ts`**

### A1. Add `chooseEscapeNodeTarget()` function (after `chooseLocalMoveTarget` ~line 601)

New function that uses `serverSpatial.nodes` to find a different node to escape to:
- Find which node the agent is currently at (nearest by distance)
- Filter that node out
- Score remaining nodes: prefer lower structure count (more open space) + moderate distance
- Return the best candidate's center, or `null`

### A2. Two-tier escalation at build-fail decision block (lines 3607-3623)

Currently: `>= 4` fails → `chooseLocalMoveTarget` (4-30u move, causes oscillation)

Change to:
- **`>= 6` fails (new tier 2):** Call `chooseEscapeNodeTarget()` → move to a different node entirely. Fallback to `chooseLoopBreakMoveTarget()` if no other nodes exist.
- **`>= 4` fails (existing tier 1):** Keep current `chooseLocalMoveTarget` behavior as-is.

Set a `let escapeMoveTriggered = false` flag before the decision block; set `true` in tier-2 branch.

### A3. Reset fail counter on escape (lines 4429-4436)

Add `escapeMoveTriggered` check to the consecutive-fails tracking:
```
escapeMoveTriggered ? 0 : (existing logic)
```

### A4. Enhanced warning at >= 6 fails (lines 3411-3423)

Add a stronger prompt warning before the existing `>= 3` warning:
```
>= 6: "CRITICAL: N CONSECUTIVE BUILD FAILURES. This area is saturated. You WILL be moved to a different node."
>= 3: (existing warning with safe spot coordinates)
```

---

## Part B: Directive Lifecycle Redesign

### New Status Flow

```
active (voting) → passed (enough yes votes) → in_progress (auto) → completed (goal met)
       ↓                    ↓                        ↓
    expired             declined               expired (timeout)
```

- **active**: Awaiting votes
- **passed**: `yesVotes >= agentsNeeded` — replaces old "completed" meaning
- **in_progress**: Auto-transitions from passed (agents are working on it)
- **completed**: Objective achieved — agent marks via `COMPLETE_DIRECTIVE`, or server auto-completes for measurable goals
- **declined**: `noVotes >= agentsNeeded` — agents voted it down
- **expired**: Timed out at any pre-completed stage

### Key Rules

- **No completion credits** — building itself earns credits, completing a directive is just a status change.
- **Submitter lock** — an agent cannot submit a new directive while they have an unresolved one (active/passed/in_progress). Forces follow-through.
- **Declined via voting** — when `noVotes >= agentsNeeded`, directive is declined. Explicit rejection power for agents.

### New Directive Fields

```
targetX: float (optional) — target location X coordinate
targetZ: float (optional) — target location Z coordinate
targetStructureGoal: int (optional) — structure count goal at target
completedBy: varchar (optional) — agent who marked it complete
completedAt: timestamp (optional) — when it was completed
```

Using coordinates (not node IDs) because node IDs are ephemeral and shift with recomputation.

### File Changes

#### B1. `server/types.ts` (lines 243-293)

- **DirectiveSchema**: Add statuses `'passed' | 'in_progress' | 'declined'` to status enum. Add optional fields: `targetX`, `targetZ`, `targetStructureGoal`, `completedBy`, `completedAt`.
- **SubmitGridDirectiveSchema**: Add optional `targetX`, `targetZ`, `targetStructureGoal`.
- **SubmitGuildDirectiveSchema**: Same optional fields.
- **Add `CompleteDirectiveSchema`**: `{ directiveId: z.string() }`

#### B2. `server/db.ts`

- **Migration** (after line 176 in the DO block): Add columns to directives table:
  ```sql
  ALTER TABLE directives ADD COLUMN IF NOT EXISTS target_x FLOAT DEFAULT NULL;
  ALTER TABLE directives ADD COLUMN IF NOT EXISTS target_z FLOAT DEFAULT NULL;
  ALTER TABLE directives ADD COLUMN IF NOT EXISTS target_structure_goal INTEGER DEFAULT NULL;
  ALTER TABLE directives ADD COLUMN IF NOT EXISTS completed_by VARCHAR(255) DEFAULT NULL;
  ALTER TABLE directives ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP DEFAULT NULL;
  ```

- **`createDirective`** (line 1021): Expand INSERT to include new columns.

- **`getActiveDirectives`** (line 1034): Filter now includes `status IN ('active', 'passed', 'in_progress')`. Map new columns in result rows.

- **`getDirective`** (line 1094): Map new columns in result rows.

- **Rename `completeDirective` → `passDirective`** (line 1222): Sets `status = 'passed'`.

- **New `activateDirective`**: Sets `status = 'in_progress'` (only from `'passed'`).

- **New `declineDirective`**: Sets `status = 'declined'`.

- **New `completeDirective`**: Sets `status = 'completed'`, `completed_by`, `completed_at`.

- **New `getAgentActiveDirective(agentId)`**: Returns first directive where `submitted_by = agentId AND status IN ('active', 'passed', 'in_progress')`. Used by submission endpoint for the submitter lock.

- **`expireDirectives`** (line 1149): Expand WHERE to `status IN ('active', 'passed', 'in_progress')`.

- **`expireAllDirectives`** (line 1135): Same expansion.

#### B3. `server/api/grid.ts`

- **Vote endpoint** (~line 2034):
  - On yes vote threshold: Change `db.completeDirective(id)` → `db.passDirective(id)` then `db.activateDirective(id)`. Update terminal message to say "passed" not "completed". Credit reward stays (submitter earns credits when directive passes vote).
  - On no vote threshold: If `noVotes >= agentsNeeded`, call `db.declineDirective(id)`. Broadcast "Directive declined" terminal message.

- **New `POST /v1/grid/directives/:id/complete` endpoint** (after vote endpoint ~line 2057):
  - Requires agent auth
  - Validates directive exists and is `'passed'` or `'in_progress'`
  - Calls `db.completeDirective(id, agentId)`
  - No credit reward (building itself earns credits)
  - Broadcasts terminal message

- **Directive submission endpoints** (lines 1905-1970, 1972-2010):
  - Include `targetX`, `targetZ`, `targetStructureGoal` in the directive creation object from request body.
  - **Submitter lock**: Before creating, check if the submitting agent already has an active/passed/in_progress directive they submitted. If so, reject with "You have an unresolved directive. Complete or let it expire before submitting another."

#### B4. `autonomous-agents/shared/api-client.ts`

- **Directive interface** (line 159): Add `targetX?`, `targetZ?`, `targetStructureGoal?`, `completedBy?`, `completedAt?`, `submittedBy?`.

- **New `completeDirective(directiveId)` method**: `POST /v1/grid/directives/${directiveId}/complete`.

- **Update `submitDirective` signature**: Accept optional `targetX`, `targetZ`, `targetStructureGoal`.

#### B5. `autonomous-agents/shared/runtime.ts`

- **AgentDecision interface** (line 82): Add `'COMPLETE_DIRECTIVE'` to action union.

- **ACTION_FORMAT_BLOCK** (line 2526): Add `COMPLETE_DIRECTIVE: {"directiveId":"dir_xxx"}` format.

- **Directive prompt display** (lines 3006-3018): Show status label (VOTING/PASSED/IN PROGRESS), target location, structure goal. Show "Use COMPLETE_DIRECTIVE when objective is met" for in_progress directives.

- **Voting logic** (lines 3537-3555): Filter to only vote on `status === 'active'` directives (not passed/in_progress ones).

- **Directive submission** (lines 3557-3596): When Smith submits, include `targetX`, `targetZ` from nearest cachedNode center, and `targetStructureGoal` based on the description logic (uses `NODE_EXPANSION_GATE` as the goal).

- **New: COMPLETE_DIRECTIVE auto-policy** (after voting logic, before `return null` ~line 3598): For each `in_progress` directive with `targetX/targetZ/targetStructureGoal`, check if the nearest cachedNode to those coords has `count >= targetStructureGoal`. If so, any agent can auto-send `COMPLETE_DIRECTIVE`.

- **executeAction** (lines 5416-5435): Add `COMPLETE_DIRECTIVE` case — validate directiveId, call `api.completeDirective()`.

- **executeAction SUBMIT_DIRECTIVE** (line 5424): Pass new optional fields through.

---

## Implementation Order

1. **Part A** (all in runtime.ts) — unblocks agents immediately
2. **Part B1-B2** — server types + DB schema
3. **Part B3** — server API endpoints
4. **Part B4** — client API
5. **Part B5** — agent runtime behavior

## Verification

1. `cd server && npx tsc --noEmit` — no compilation errors
2. `cd autonomous-agents && npx tsc --noEmit` — no compilation errors
3. Deploy and monitor agent logs:
   - At 6+ fails: agent moves to a different node (look for "saturated" in log)
   - Fail counter resets to 0 after escape
   - Smith submits directives with target coordinates
   - Directives transition: active → passed → in_progress → completed
   - Agents auto-complete directives when structure goal is met at target node
   - Expired directives still expire across all pre-completed statuses
   - Smith cannot submit a new directive while a previous one is unresolved
   - Directives decline when noVotes >= agentsNeeded
