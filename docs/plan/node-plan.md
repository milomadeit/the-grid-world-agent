# node plan

## Summary
1. **Stop forcing `MEGA_SERVER_SPIRE`** based on `NODE_MEGA_TARGET` (this is the direct cause of spires clustering).
2. Add a **Mouse “signature landmark” policy**: at most one spire per new frontier node, enforce minimum spacing, and never build spires inside unestablished nodes.
3. Add an **Oracle road/edge micro-policy** so roads actually get built (deterministically when missing), producing the “epicenters + edges” look.
4. Add a small, prompt-safe **shared `LESSONS.md`** (optional) to encode “don’t do this again” rules without touching server `skill.md`/Prime Directive.


---

## 1) Mouse: Remove Spire Forcing + Add Spire Spacing Guard

### 1.1 Remove the faulty forcing rule
**File:** `/Users/zacharymilo/Documents/world-model-agent/autonomous-agents/shared/runtime.ts`  
**Change:**
- Delete (or fully disable) the block that unconditionally sets `payload.name = 'MEGA_SERVER_SPIRE'` when `nearestNodeStructuresAtSelf < NODE_MEGA_TARGET`.

Why: `NODE_MEGA_TARGET=100` is a *node maturity target*, not “build 100 spires”. The override currently defeats variety and causes clustering.

Acceptance:
- `mouse.log` no longer prints `Build guard: prioritizing MEGA_SERVER_SPIRE…`.
- Mouse’s chosen blueprint name is not replaced unless it’s invalid/gated.

### 1.2 Add a “signature landmark policy” (guard, not forcing)
**File:** `/Users/zacharymilo/Documents/world-model-agent/autonomous-agents/shared/runtime.ts`  
Add a new helper used inside the `decision.action === 'BUILD_BLUEPRINT'` guard block:

**Policy (defaults):**
- `MOUSE_SPIRE_MIN_DISTANCE = 90` units between spire anchors.
- `MOUSE_SPIRE_COOLDOWN_BLUEPRINTS = 8` (if `Recent blueprints` contains `MEGA_SERVER_SPIRE`, do not allow another).
- Spires are allowed only when the chosen safe spot is `type === 'frontier'` *and* the nearest node to that spot is established (`>= 25` structures). If not, Mouse must build something else (DATACENTER / PLAZA / MONUMENT / etc).

**Implementation detail (decision-complete):**
- When `payload.name === 'MEGA_SERVER_SPIRE'`:
  1. Resolve the candidate anchor to the nearest safe spot record (`safeSpotCandidates`) so we know its `type` and `nearestNodeName`.
  2. Reject if not `frontier`.
  3. Reject if `Recent blueprints` already contains `MEGA_SERVER_SPIRE`.
  4. Reject if distance to `Last spire anchor` in working memory is `< MOUSE_SPIRE_MIN_DISTANCE`.
- On reject: replace with `pickFallbackBlueprintName(…, { preferMega: false, recentNames })` (so Mouse still builds big landmarks, just not a spire again).

### 1.3 Track spire anchors in WORKING.md (so spacing works reliably)
**File:** `/Users/zacharymilo/Documents/world-model-agent/autonomous-agents/shared/runtime.ts`  
**Change:**
- When `decision.action === 'BUILD_BLUEPRINT'` and `payload.name === 'MEGA_SERVER_SPIRE'`, persist:
  - `Last spire anchor: (X, Z)`
  - `Spire anchors: (x1,z1); (x2,z2); …` capped to last 5 entries

Acceptance:
- Mouse can build a spire, but cannot start another within 90u of the last anchor.
- Over a 30-minute run: Mouse builds at most 1 spire per new frontier lane, not “a cluster”.

---

## 2) Roads/Edges: Make Oracle Actually Connect Nodes (Deterministic, Not Just Prompting)

### 2.1 Add an “edge-needed” detector from server spatial summary
**Inputs available today:**
- `serverSpatial.nodes[].connections[]` includes `hasConnector` + `distance`.

**File:** `/Users/zacharymilo/Documents/world-model-agent/autonomous-agents/shared/runtime.ts`  
Add helper:
- `pickUnconnectedEstablishedPair(nodes)`:
  - Find the closest pair where:
    - both nodes have `structureCount >= 25`
    - connection exists and `hasConnector === false`
    - `distance` is within a sane buildable range (default: `80..350`)

### 2.2 Oracle road micro-policy (minimal deterministic override)
For `agentName === 'Oracle'` only:

If:
- there is an unconnected established pair, and
- Oracle has no active blueprint, and
- Oracle is not currently in a directive build that explicitly says “densify X”

Then:
- Override the LLM’s build choice into a **road-building loop**:
  1. MOVE along the line from node A to node B (one waypoint per tick).
  2. When within 20u of the next waypoint, BUILD_MULTI with 5 contiguous flat boxes aligned to the direction:
     - `shape: "box"`, `scaleX: 10`, `scaleY: 0.1`, `scaleZ: 2`, `y: 0.05`, `color: "#94A3B8"`, `rotY: atan2(dz, dx)`
     - Segment offsets from agent position along the direction: `4, 8, 12, 16, 19` (keeps within the runtime’s 2–20u constraint)

Stop condition:
- After N ticks (default 8) or once the connection flips to `hasConnector=true` on the next spatial summary refresh.

Acceptance:
- `connectorEdges` increases over time in logs (`METRIC_SPATIAL … connectorEdges=…`).
- Visually: you see actual paths connecting hubs, not just isolated buildings.

---

## 3) “Epicenter” Look: Bigger Foundation Blueprint (Optional Content Upgrade)
You already have `NODE_FOUNDATION`, but it’s visually small. Add a new blueprint that reads as an epicenter from top view.

**File:** `/Users/zacharymilo/Documents/world-model-agent/server/blueprints.json`  
Add `NODE_EPICENTER`:
- A large circular/hex pad + a central marker (counts as a real structure, not a connector-only slab).
- Keep at least one primitive **non-connector** (e.g., `box scaleY >= 0.4` or any non-(plane/flat box/flat cylinder)) so it counts as a structure in the node model.

Update agent manuals (light-touch, local):
- Smith/Clank/Oracle: “When founding a frontier node, place `NODE_EPICENTER` first.”

Validation:
- Run `/Users/zacharymilo/Documents/world-model-agent/server/scripts/lint-blueprints.ts` (must pass).

Acceptance:
- New nodes have a visible “pad/epicenter” so the map doesn’t look patchy even before roads are complete.

---

## 4) Add `LESSONS.md` (Small, Non-Conflicting, Prompt-Safe)
### 4.1 Shared file, manual-curated first (no agent auto-write yet)
**File:** `/Users/zacharymilo/Documents/world-model-agent/autonomous-agents/shared/LESSONS.md`  
Constraints:
- <= 1500 chars
- numbered lessons, one per line
- no duplicates, no stories, no debates
- explicitly subordinate to Prime Directive + `skill.md`

Seed content (examples):
- “Do not spam signature landmarks: at most one MEGA_SERVER_SPIRE per district; enforce spacing.”
- “Frontier node founding: epicenter pad first, then 3–5 varied structures, then connect by road.”
- “Oracle: if established nodes are unconnected, roads are top priority.”

### 4.2 Inject it into the system prompt
**File:** `/Users/zacharymilo/Documents/world-model-agent/autonomous-agents/shared/runtime.ts`  
- Read `shared/LESSONS.md` and append as `# LOCAL LESSONS (subordinate)` in system prompt.

Acceptance:
- Agents consistently reference the same small set of “don’t do this” rules without bloating prompts or diverging from server docs.

---

## Tests / Verification
1. Typecheck runtime:
   - `cd /Users/zacharymilo/Documents/world-model-agent/autonomous-agents && npx tsc -p tsconfig.json --noEmit`
2. Blueprint lint (if adding `NODE_EPICENTER`):
   - `cd /Users/zacharymilo/Documents/world-model-agent/server && npx tsx scripts/lint-blueprints.ts`
3. Production observation (30–60 min):
   - Mouse starts **0–1** spires per frontier lane; never within 90u of the last spire.
   - Oracle increases `connectorEdges` over time and roads appear.

---

## Assumptions / Defaults (Call These Out in Code)
- Spire spacing: 90u minimum
- Spire cooldown: “no second spire if it appears in recent 8 blueprints”
- Spire placement: frontier-only (not inside unestablished nodes)
- Oracle roads: deterministic override only when nodes are established and unconnected
