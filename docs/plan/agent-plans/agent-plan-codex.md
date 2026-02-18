# Fix Blueprint Completion, Node Coherence, and Agent Conversation

## Summary (What’s Broken Right Now)
1. The “long black squares / tiny base boxes” are almost always the **first primitive of a blueprint** (examples: `LAMP_POST` base is `0.8 x 0.3 x 0.8`, `MEGA_SERVER_SPIRE` foundation is the dark `14 x 0.4 x 14` slab).
2. Blueprints are “completing” with `1/14`, `2/25`, `1/4` placed because server-side placement validation is picking the wrong snap target:
   - `validateBuildPosition()` snaps to **ground first** when the bottom edge is close to ground, even when the piece is intended to **stack on an existing piece**.
   - That causes the next piece to **overlap** the base slab, so it fails placement.
   - The blueprint engine keeps advancing, so it reaches the end and marks the plan “complete” with only the base placed.
3. This cascades into:
   - scattered “junk primitives” (partial builds),
   - agents looking sporadic,
   - “no conversations” (because progress never reaches meaningful milestones; chats devolve into repetitive status pings).

Concrete evidence from your current logs:
- `/Users/zacharymilo/Documents/world-model-agent/autonomous-agents/logs/clank.log`: `MEGA_SERVER_SPIRE` completes `2/25`, `LAMP_POST` completes `1/4`.
- `/Users/zacharymilo/Documents/world-model-agent/autonomous-agents/logs/smith.log`: `DATACENTER` completes `1/14`.
- `/Users/zacharymilo/Documents/world-model-agent/autonomous-agents/logs/oracle.log`: `DATACENTER` completes `1/14`, plus Gemini `429` rate limits.

---

## 0) Operator Commands (Stop + Snapshot + Cleanup)
Run these exactly (no edits), in this order.

### Stop all agent processes
```bash
cd /Users/zacharymilo/Documents/world-model-agent/autonomous-agents
bash stop-all.sh smith oracle clank mouse
pkill -f "node --import tsx index.ts smith" || true
pkill -f "node --import tsx index.ts oracle" || true
pkill -f "node --import tsx index.ts clank" || true
pkill -f "node --import tsx index.ts mouse" || true
ps aux | egrep "node --import tsx index.ts (smith|oracle|clank|mouse)|run-(smith|oracle|clank|mouse)\\.sh" | cat
```

### Delete junk primitives from the last 4h40m (owner-only safe)
```bash
cd /Users/zacharymilo/Documents/world-model-agent/autonomous-agents
npx tsx scripts/cleanup-recent-primitives.ts --api https://opgrid.up.railway.app --hours 4.67
npx tsx scripts/cleanup-recent-primitives.ts --api https://opgrid.up.railway.app --hours 4.67 --delete
```

### Clear directives (votes them to completion)
```bash
cd /Users/zacharymilo/Documents/world-model-agent/autonomous-agents
node scripts/clear-directives.mjs
```

### Reset WORKING.md for a fresh run (optional)
```bash
cd /Users/zacharymilo/Documents/world-model-agent
: > autonomous-agents/agent-smith/memory/WORKING.md
: > autonomous-agents/oracle/memory/WORKING.md
: > autonomous-agents/clank/memory/WORKING.md
: > autonomous-agents/mouse/memory/WORKING.md
```

---

## 1) Server Fix (High Priority): Make Stacking Work Reliably
### 1.1 Fix `validateBuildPosition()` snapping logic
File: `/Users/zacharymilo/Documents/world-model-agent/server/api/grid.ts`

Change validation to:
1. Compute candidate “support surfaces” that are within `SNAP_TOLERANCE` of the requested bottom edge:
   - Ground surface `0`
   - Any existing primitive top surface `existing.position.y + existing.scale.y/2` when XZ-overlapping
2. For each candidate surface:
   - Compute candidate center-y = `surfaceY + scale.y/2`
   - Reject candidates that cause `boxesOverlap()` with existing primitives
3. Pick the non-overlapping candidate with smallest `abs(candidateY - requestedY)`
4. If no candidate surfaces are within tolerance:
   - Keep current “floating” behavior: return `valid:false` with `correctedY` suggestion (nearest valid surface)
5. Keep overlap rejection strict (don’t relax geometry rules).

This single change fixes the exact lamppost issue:
- Current: cylinder bottom edge `0.25` triggers ground snap → overlaps base → cylinder rejected.
- New: both ground `0` and base-top `0.3` are candidates; ground overlaps → discard; base-top wins → lamppost completes.

### 1.2 Blueprint engine: auto-apply suggested Y
File: `/Users/zacharymilo/Documents/world-model-agent/server/api/grid.ts`, endpoint `POST /v1/grid/blueprint/continue`

When `validateBuildPosition()` returns `valid:false` with `correctedY`:
1. Set `position.y = correctedY`
2. Re-run `validateBuildPosition()` to ensure overlap rejection is applied at correctedY
3. If valid, place the primitive
4. If still invalid, record the failure.

Keep the “advance cursor on failure” behavior initially (to avoid deadlocks), but also add a clear signal in the response.

### 1.3 Improve blueprint completion signaling
Also in `blueprint/continue`:
- If `plan.nextIndex >= totalPrimitives` and `placedCount < totalPrimitives`, return:
  - `status: "complete_with_failures"`
  - `failedCount`
  - `results` (already exists)
- Broadcast a system chat/terminal line that includes failures:
  - `placed X/Y (failures Z)`

This prevents agents from believing a 1-piece slab == “finished structure”.

---

## 2) Blueprint Consistency Pass (So “buildings” look like buildings)
Even with better snapping, some templates (e.g. `SHOP` shelves) are genuinely unsupported. Do a quick deterministic lint + fix pass.

### 2.1 Add a blueprint lint script (server-side)
Add: `/Users/zacharymilo/Documents/world-model-agent/server/scripts/lint-blueprints.ts`

Behavior:
1. Load `/Users/zacharymilo/Documents/world-model-agent/server/blueprints.json`
2. For each blueprint:
   - Simulate placements in order, maintaining an in-memory placed list
   - Use the same `validateBuildPosition()` function
   - When floating returns `correctedY`, apply it and retry validation once
3. Fail the script if any blueprint cannot place `100%` of primitives in an empty world.

To make this easy:
- Extract `validateBuildPosition()` + helpers into `/Users/zacharymilo/Documents/world-model-agent/server/build-validation.ts` and import it from both `api/grid.ts` and the lint script.

### 2.2 Fix any failing blueprints
Primary targets based on current behavior:
- `SHOP` (shelves need a support or should be repositioned onto a counter/platform)
- `DATACENTER` (verify decorative pieces stack on racks/platforms)
- `BRIDGE` (torus arch should stack on deck, not float)
- Re-check: `LAMP_POST`, `MEGA_SERVER_SPIRE` (should be fine after snap fix)

Acceptance criterion:
- Lint shows `placed == total` for all 19 blueprints.

---

## 3) Agent Runtime: Make a Real Guild Loop (Plan -> Directive -> Vote -> Execute)
### 3.1 Stop forced “cadence spam”; replace with kickoff + milestone chat
File: `/Users/zacharymilo/Documents/world-model-agent/autonomous-agents/shared/runtime.ts`

Changes:
1. Remove the periodic “cadenceEligible window” override that forces chat when nothing happened.
2. Add a single kickoff chat per session:
   - Smith sends one “Guild plan” message as soon as at least 2 other agents are online.
3. Add milestone chats:
   - When a blueprint completes successfully (`placed == total`), send one short progress update.
4. Make coordination chat default be **broadcast**, not targeted at `otherAgents[0]` (stops the endless “Mouse, I see you” spam).

### 3.2 Deterministic directive behavior (so it actually happens)
File: `/Users/zacharymilo/Documents/world-model-agent/autonomous-agents/shared/runtime.ts`

Implement policy (no LLM required):
1. If agent is Smith, there are other agents online, and no active directives:
   - Submit a directive like:
     - `Densify "server-node Northwest" at (-35, 75) to 25+ structures (goal 50). Roles: Smith civic/architecture, Clank infra/tech, Oracle art/nature.`
2. If agent is Clank/Oracle and there is an active directive you haven’t voted on:
   - Vote `yes` once.

### 3.3 Blueprint selection based on node missing categories
Use `serverSpatial.nodes[].missingCategories` (already in the API) to drive variety:
- If missing `infrastructure`: `LAMP_POST`, `ANTENNA_TOWER`, `BRIDGE`
- If missing `technology`: `DATACENTER`, `SERVER_RACK`
- If missing `nature`: `GARDEN`, `TREE`
- If missing `art`: `FOUNTAIN`, `ROCK_FORMATION` (and `SCULPTURE_SPIRAL`/`MONUMENT` when reputation allows)

This turns “black box spam” into coherent districts.

### 3.4 Mouse behavior: skyscraper at the right time/place
Keep hard gate at 25.
1. Before the guild node hits 25:
   - Mouse helps densify (but does not force `MEGA_SERVER_SPIRE` in cramped anchors).
2. After 25:
   - Mouse moves to a `frontier` openArea 50–69u out from that node and starts `MEGA_SERVER_SPIRE`.
3. After spire completes:
   - Mouse stays and densifies that new district toward 50–100.

---

## 4) Fix Oracle’s LLM 429 (Reduce stalls)
File: `/Users/zacharymilo/Documents/world-model-agent/autonomous-agents/index.ts`

Make Oracle provider configurable and default to MiniMax if Gemini is rate-limiting:
- Support env overrides:
  - `ORACLE_LLM_PROVIDER=minimax|gemini|openai|anthropic`
  - `ORACLE_LLM_MODEL=...`
- Default recommendation: use MiniMax for Oracle to match Smith/Clank/Mouse.

Acceptance:
- No `Gemini API error (429)` in `/Users/zacharymilo/Documents/world-model-agent/autonomous-agents/logs/oracle.log` during a 30-minute run.

---

## 5) Process Control Reliability (No more “8 loops running”)
File: `/Users/zacharymilo/Documents/world-model-agent/autonomous-agents/stop-all.sh`

Update fallback matching to kill agents started from the directory (relative command line):
- Also match `run-smith.sh` (not just the absolute path)
- Keep node-pattern kill as final fallback

Acceptance:
- `bash stop-all.sh` stops everything regardless of how it was started.

---

## 6) Verification Plan (30-minute diagnostic you asked for)
### 6.1 Local sanity checks (pre-deploy)
1. Run blueprint lint script; it must pass.
2. Start server locally and verify:
   - Start `LAMP_POST`, `BUILD_CONTINUE` until done -> returns `placed=4 total=4`
   - Start `MEGA_SERVER_SPIRE` -> progresses beyond `2/25`

### 6.2 Post-deploy checks (production)
1. Confirm `/v1/grid/spatial-summary` `world.highestPoint` jumps above `50` after Mouse spire completes.
2. Run agents for 30 minutes.
3. Analyze logs:
```bash
cd /Users/zacharymilo/Documents/world-model-agent/autonomous-agents
npx tsx scripts/analyze-logs.ts --dir /Users/zacharymilo/Documents/world-model-agent/autonomous-agents/logs --label post-blueprint-fix
```

Acceptance criteria:
- Blueprints complete at high rates (`placed ~= total`) in logs.
- Chat includes:
  - Smith kickoff plan
  - at least a few milestone/progress messages
  - minimal suppression spam
- Directives show up and receive votes.
- Nodes climb coherently (NW node -> 25 -> 50 target); Mouse establishes a frontier mega-node.

---

## Assumptions / Defaults
1. Keep server expansion gate at `25`, density targets `50` and `100`, spacing `50–69`, settlement proximity `≤70` (already implemented in `/Users/zacharymilo/Documents/world-model-agent/server/types.ts` and `/Users/zacharymilo/Documents/world-model-agent/autonomous-agents/shared/runtime.ts`).
2. We do not relax overlap rules; blueprints must be non-overlapping and physically valid under server constraints.
3. We will not commit/push memory files under `/Users/zacharymilo/Documents/world-model-agent/autonomous-agents/*/memory/` (optional follow-up: gitignore or relocate memory output).
