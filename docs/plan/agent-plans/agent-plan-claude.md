
# Documentation For Plan from Claude

# Plan: Fix Agent Building Behavior + Add Node/Edge Foundation System

## Context

Agents are not producing the expected emergent infrastructure. Specific symptoms:
- **Mouse**: Building flat foundation pieces but builds stall before going vertical (looks like "long black squares" instead of skyscrapers)
- **Clank/Oracle**: Sporadic, fragmented builds. Start blueprints but lose them to 404 errors, fall into recovery loops
- **Smith**: Stuck trying same coordinates despite overlap errors. Not adapting.

**Root causes identified:**
1. **Server 404 bug**: Build plans stored in-memory (`server/world.ts:48 buildPlans Map`). Server restart/redeploy wipes them → all agents get "No active build plan" 404s on BUILD_CONTINUE → cascading failures
2. **No node founding concept**: Agents build individual structures but have no workflow for "found a node → lay foundation → populate → connect"
3. **No road/edge blueprints**: BRIDGE exists but no standardized road segments. Agents can't easily connect nodes
4. **Agents don't understand spatial planning**: They know "build near cluster" but not "plan a neighborhood layout, invite others, then populate"

**Goal**: Agents should be able to found nodes, lay foundations, populate with creative structures, and connect everything with roads/bridges — producing emergent city-like infrastructure from simple rules.

---

## Changes

### 1. Fix the Server 404 Build Plan Bug
**File**: `server/world.ts`

Persist `buildPlans` and `blueprintReservations` to the database (or at minimum a JSON file) so they survive server restarts:
- On `setBuildPlan()`: write to DB/file alongside the Map
- On server startup: reload active build plans from DB/file into the Map
- On `clearBuildPlan()`: remove from DB/file
- Keep the in-memory Map as the hot cache for performance

This is the #1 blocker — nothing else works if builds keep vanishing.

### 2. Improve Client-Side Build Recovery
**File**: `autonomous-agents/shared/runtime.ts`

Even with server fix, make agents more resilient:
- On 404 "No active build plan": clear local working memory's blueprint tracking, pick a NEW location (shift 15-20u), and restart. Don't retry the same spot.
- On overlap error: shift 10-20u within same node, don't re-attempt exact same coordinates
- Add a `buildPlanStale` check: before BUILD_CONTINUE, call `GET /blueprint/status` first. If `active: false`, skip straight to starting a new blueprint instead of wasting a tick on a doomed BUILD_CONTINUE.
- Limit consecutive MOVE actions to 3 before forcing a BUILD_BLUEPRINT at current position

### 3. Add Foundation & Road Blueprints
**File**: `server/blueprints.json`

Add 3 new blueprints:

**NODE_FOUNDATION** (6 primitives, easy, category: "infrastructure"):
- Large flat ground platform (10x10 box at y=0.05)
- 4 corner marker posts (thin cylinders at corners, 2u tall)
- Central pedestal/marker (cylinder at center, 1u tall)
- Purpose: "Step 1 of founding a new node. Place this, then build structures around it."
- Tags: `["foundation", "node", "starter", "collaborative"]`

**ROAD_SEGMENT** (5 primitives, easy, category: "infrastructure"):
- 3 flat road tiles (boxes, scaleX=2, scaleY=0.1, scaleZ=2, spaced 4u apart along X)
- 2 edge markers/curbs (thin boxes along sides)
- Purpose: "Chain multiple segments to connect two nodes. Align along the line between node centers."
- Tags: `["road", "connector", "edge", "modular", "collaborative"]`
- Customization note: "Chain by offsetting anchorX by 12 units per segment. Use neutral #94a3b8 for main roads or your agent color for paths."

**INTERSECTION** (7 primitives, easy, category: "infrastructure"):
- Cross-shaped ground platform
- 4 corner posts
- Central marker
- Purpose: "Place where two roads meet. Connect roads from multiple directions."
- Tags: `["road", "connector", "intersection", "collaborative"]`

### 4. Update skill.md — Add Node Founding Workflow
**File**: `dist/skill.md`

Add a new section "How to Found a Node" in the Build section (after "How nodes grow"):

```
### How to Found a Node
A node starts with a foundation. One agent founds it, then invites others to populate.

**Step 1: Choose Location**
- Check spatial-summary for open areas (type: "frontier" or "growth")
- New nodes should be 50-69 units from existing nodes
- Avoid overlap with existing structures

**Step 2: Lay Foundation**
- BUILD_BLUEPRINT: NODE_FOUNDATION at your chosen (x, z)
- This creates a visible ground platform that marks the node's center

**Step 3: Build Anchor Structure**
- Place a civic anchor at the center: PLAZA, FOUNTAIN, or MONUMENT
- This gives the node identity and a central gathering point

**Step 4: Invite & Populate**
- CHAT: "Founded new node at (x, z) — building [theme]. Come build here!"
- Other agents populate with varied structures: houses, shops, tech, art, nature
- Each agent builds what they want — creativity is the point

**Step 5: Connect**
- Chain ROAD_SEGMENT blueprints between your node and the nearest existing node
- Space anchors 12u apart along the line between centers
- Add LAMP_POST every 15-20u along the road
- For gaps/terrain: use BRIDGE blueprint

**Step 6: Densify**
- Keep building until 25+ structures (established node)
- Push toward 50-100 for city/metropolis scale
- Fill category gaps: architecture, infrastructure, technology, art, nature
```

Also update the "What is a node?" section to emphasize:
- A node starts with a FOUNDATION, not random scattered builds
- Neighborhoods are smaller clusters WITHIN a node
- Edges (roads) physically connect node centers

### 5. Update Agent Operating Manuals
**Files**: `autonomous-agents/*/AGENTS.md`

#### Smith (`agent-smith/AGENTS.md`):
- Add to Decision Priority #2: "If no node has a foundation yet, BUILD_BLUEPRINT NODE_FOUNDATION first, then PLAZA/FOUNTAIN at center"
- Add: "When founding a new node: lay NODE_FOUNDATION, build anchor, then CHAT to invite guild members"
- Add: "After a node reaches 10+ structures, build ROAD_SEGMENT chain to connect it to nearest node"

#### Mouse (`mouse/AGENTS.md`):
- Add: "When claiming frontier space: lay NODE_FOUNDATION first, then build MEGA_SERVER_SPIRE at center"
- Emphasize: "Your foundation should be the launching pad for your skyscraper. Build UP from the foundation, not sideways."
- Add: "Connect your solo node to the nearest existing node with a road"

#### Clank (`clank/AGENTS.md`):
- Add: "When an agent founds a new node and invites you, go there and build complementary structures"
- Add: "Specialize in connecting nodes: chain ROAD_SEGMENT blueprints between unconnected nodes"

#### Oracle (`oracle/AGENTS.md`):
- Add: "When an agent founds a new node, populate it with structures that fill category gaps"
- Add: "Before building, check what the node is missing (architecture, art, nature, tech) and fill the gap"

### 6. Update Runtime Strategic Thinking
**File**: `autonomous-agents/shared/runtime.ts` (systemPrompt section ~line 2028)

Update the "Strategic Thinking" and "The City is a Graph" sections:

- Add a "Node Founding Workflow" block:
  ```
  ## How to Found a New Node
  1. BUILD_BLUEPRINT NODE_FOUNDATION at chosen location
  2. BUILD_BLUEPRINT a civic anchor (PLAZA, FOUNTAIN, MONUMENT) at center
  3. CHAT to invite other agents to populate
  4. Chain ROAD_SEGMENT blueprints to connect to nearest existing node
  5. Keep densifying with varied structures until 25+ structures
  ```

- Update "How to Build Roads" to reference ROAD_SEGMENT blueprint as the preferred method (instead of raw BUILD_MULTI flat boxes)

- Add to the World Graph formatter (`formatSettlementMap`): when suggesting "GROW node", also suggest specific missing blueprints and mention NODE_FOUNDATION if the node has no foundation-tagged structure

---

## Files Modified

| File | Change |
|------|--------|
| `server/world.ts` | Persist buildPlans to DB/file, reload on startup |
| `server/blueprints.json` | Add NODE_FOUNDATION, ROAD_SEGMENT, INTERSECTION |
| `dist/skill.md` | Add "How to Found a Node" section, update node/edge explanations |
| `autonomous-agents/shared/runtime.ts` | Build recovery improvements, strategic thinking updates, World Graph suggestions |
| `autonomous-agents/agent-smith/AGENTS.md` | Add node founding workflow |
| `autonomous-agents/mouse/AGENTS.md` | Add foundation-first building guidance |
| `autonomous-agents/clank/AGENTS.md` | Add populate/connect role guidance |
| `autonomous-agents/oracle/AGENTS.md` | Add gap-filling role guidance |

## Verification

1. **Build the runtime**: `cd autonomous-agents && npm run build` — should typecheck clean
2. **Start server locally**: verify NODE_FOUNDATION, ROAD_SEGMENT, INTERSECTION appear in `GET /v1/grid/blueprints`
3. **Run agents**: start all 4 agents and observe for 10-15 minutes:
   - Agents should found nodes with foundations before populating
   - Mouse should build tall structures on top of foundations
   - Roads should appear connecting nodes
   - No more 404 BUILD_CONTINUE cascade failures
4. **Check logs**: `tail -f autonomous-agents/*/[agent].log` — verify no repeated 404 errors or infinite MOVE loops