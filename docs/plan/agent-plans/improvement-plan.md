# OpGrid Agent Improvement Plan

## Current State Summary

Agents run a 60-second heartbeat loop: fetch world state → decide action → execute → repeat. The decision pipeline has 5 policy gates (failure recovery, chat loop detection, unchanged world, directive policy) before reaching the LLM. When the LLM is bypassed, agents default to picking a fallback blueprint at a safe spot — always with default orientation.

**Result:** Agents build constantly but never pause to evaluate, improve, or vary what they've made. All blueprints face the same direction. Chat is shallow. No learning from outcomes.

---

## Improvement Areas

### 1. Blueprint Rotation & Orientation

**Problem:** `rotY` (0-360 degrees) is supported by the server and documented in agent prompts, but agents almost never use it. The fallback blueprint logic sets no rotation. The LLM prompt mentions rotY is "optional" but gives no guidance on when/how to use it.

**Changes:**

#### 1a. Fallback Blueprint Rotation
In `runtime.ts`, where fallback blueprints are picked (around line 3392-3410), add random rotation from [0, 90, 180, 270]:
```typescript
const ROTATIONS = [0, 90, 180, 270];
const rotY = ROTATIONS[Math.floor(Math.random() * ROTATIONS.length)];
// Add rotY to the fallback decision payload
```

#### 1b. Update Agent LESSONS Files
Add rotation guidance to each agent's LESSONS.md:
- "Always specify rotY when starting a blueprint. Vary between 0, 90, 180, 270."
- "Orient building entrances toward the nearest path, road, or settlement center."
- "Alternate rotations at a node to create visual variety — avoid placing 3+ structures at the same angle."

#### 1c. Enrich the Prompt Template
In the blueprint catalog section of the user prompt, add a reminder:
```
TIP: Use rotY to orient structures. 0=north, 90=east, 180=south, 270=west.
Vary rotations for visual interest. Face entrances toward foot traffic or plazas.
```

**Impact:** High — immediately fixes the "everything faces the same way" problem.
**Effort:** Low — a few lines of code + prompt text updates.

---

### 2. Reflection & Evaluation Phase

**Problem:** Agents never assess what they've built. There's no "step back and look" behavior. They build → move → build → move. No concept of "this area needs improvement" or "I should upgrade what's here."

**Changes:**

#### 2a. Periodic Reflection Tick
Every N ticks (e.g., every 8-12 ticks), force the agent into a REFLECT mode instead of normal building:
- Skip the normal policy gates
- Build a special reflection prompt: "You've been building at Node X for Y ticks. Here's what's there now: [spatial summary]. Evaluate: Is this area cohesive? What's missing? Should you add variety, improve spacing, or move on?"
- LLM responds with assessment and next action (could be MOVE, BUILD something different, CHAT about plans, or IDLE)

#### 2b. Build Outcome Tracking
Track in working memory:
- Blueprints completed vs abandoned per node
- Blueprint variety score per node (how many unique types)
- Time spent at each node
- Completion streaks / failure streaks

#### 2c. Self-Assessment Prompt Section
Add a new prompt section when in reflection mode:
```
## REFLECTION MODE
You've placed [N] structures at [node name]. Step back and assess:
- Blueprint variety: [list of types placed here]
- Orientations used: [list of rotY values]
- Completion rate: [X/Y blueprints completed]
- What would make this area better? More variety? Different orientations? A landmark?
- Should you stay and improve, or move to a new area?
Respond with your assessment AND your next action.
```

**Impact:** High — breaks the build-only loop, adds strategic depth.
**Effort:** Medium — needs new tick logic, working memory fields, and prompt templates.

---

### 3. Improved Fallback Decision Logic

**Problem:** When world state is unchanged (policy gate 3), agents pick a random blueprint from the catalog and place it nearby. This creates repetitive, unstrategic building.

**Changes:**

#### 3a. Category-Aware Blueprint Selection
Track which blueprint categories exist at the current node:
- Infrastructure: ROAD_SEGMENT, INTERSECTION, BRIDGE, WALL_SECTION
- Civic: PLAZA, FOUNTAIN, MONUMENT, LAMP_POST
- Residential: SMALL_HOUSE, MANSION, WAREHOUSE
- Tech: SERVER_RACK, ANTENNA_TOWER, DATACENTER, MEGA_SERVER_SPIRE
- Nature: TREE, ROCK_FORMATION, GARDEN, SCULPTURE_SPIRAL
- Tall/Landmark: WATCHTOWER, MONUMENT, MEGA_SERVER_SPIRE

Pick from under-represented categories first. If a node has 5 tech buildings and 0 nature, bias toward TREE/GARDEN.

#### 3b. Node Maturity Awareness
Define node phases:
- **Seedling (0-5 structures):** Foundation blueprints — SMALL_HOUSE, SHOP, NODE_FOUNDATION
- **Growing (5-15):** Variety — mix of categories, civic structures
- **Mature (15-25):** Landmarks and connectors — FOUNTAIN, MONUMENT, roads outward
- **Dense (25+):** Refinement only — fill gaps, add nature/decor, no more big structures

Select blueprints that match the node's phase.

#### 3c. Adjacency Logic
When placing a blueprint, check what's nearby:
- Next to a ROAD_SEGMENT? Face the building toward it
- Near a PLAZA? Add complementary structures (FOUNTAIN, LAMP_POST)
- Empty area? Start with a NODE_FOUNDATION or SMALL_HOUSE

**Impact:** Medium-High — makes autonomous building feel intentional, not random.
**Effort:** Medium — needs category mapping and spatial queries.

---

### 4. Richer Agent Interactions

**Problem:** Chat is mostly action announcements ("Starting DATACENTER at Node Alpha"). Agents don't discuss strategy, critique each other's work, ask questions, or coordinate beyond directives.

**Changes:**

#### 4a. Conversation Starters in Prompts
Add prompt guidance for meaningful chat:
- "When you see another agent nearby, comment on what they're building."
- "If a node looks unbalanced (too many of one type), mention it in chat."
- "Ask other agents about their plans before starting a big build."
- "React to the world — 'This plaza area is coming together nicely' or 'We need more paths connecting these nodes.'"

#### 4b. Agent-to-Agent Awareness
In the prompt, when listing nearby agents, include what they've been doing recently:
```
NEARBY AGENTS:
- Oracle (12u away) — last 3 actions: built ROAD_SEGMENT, built INTERSECTION, CHAT
- Mouse (45u away) — last 3 actions: built MEGA_SERVER_SPIRE, BUILD_CONTINUE, BUILD_CONTINUE
```
This gives agents context to react to each other's work.

#### 4c. Collaborative Build Proposals
When an agent assesses a node and identifies what's missing, they can CHAT about it:
- "Node Alpha needs a fountain. Anyone want to handle that while I work on paths?"
- "Great spire Mouse! A garden at the base would complement it."

**Impact:** Medium — makes the world feel alive and coordinated.
**Effort:** Low-Medium — mostly prompt engineering + minor data additions.

---

### 5. New Blueprint Types & Build Features

**Problem:** 23 blueprints is decent but agents keep cycling through the same ones. Some categories are thin (only 1 nature option = TREE, only 1 tall landmark = MEGA_SERVER_SPIRE).

**Changes:**

#### 5a. New Blueprint Ideas (Server-Side)
These would need to be added to the OpGrid server's blueprint catalog:

**Nature/Organic:**
- PARK (flat area with scattered trees and paths)
- HEDGE_MAZE (small decorative maze)
- POND (circular depression with blue floor)

**Civic/Social:**
- AMPHITHEATER (semicircular seating area)
- MARKET_STALLS (row of small shop structures)
- CLOCK_TOWER (tall civic landmark)
- GATE (entrance archway for a node)

**Tech/Industrial:**
- SOLAR_ARRAY (flat panel grid)
- COMMS_RELAY (small satellite dish structure)
- POWER_STATION (industrial structure with pipes)

**Connectors:**
- PATHWAY (lighter/shorter road variant)
- OVERPASS (elevated road crossing)
- TUNNEL_ENTRANCE (archway leading underground concept)

#### 5b. Custom Compound Builds (Agent-Side)
Rather than waiting for server blueprints, agents could use BUILD_MULTI to create custom structures:
- Define "micro-blueprints" as arrays of 3-5 primitives in the agent code
- Agents pick from these when they want something not in the catalog
- E.g., a "bench" = 3 boxes arranged as seat + back + legs

#### 5c. Blueprint Variation System
For existing blueprints, agents could apply variations:
- Scale modifier (0.8x for small variant, 1.2x for large)
- Color theme (each agent could have a palette)
- Height offset (elevated structures on platforms)

**Impact:** High — directly addresses repetitiveness.
**Effort:** High for server-side blueprints, Medium for agent-side compound builds.

---

### 6. Build Quality & Spatial Intelligence

**Problem:** Agents don't think about how their builds relate to each other spatially. A datacenter next to a tree next to a mansion next to another datacenter feels random.

**Changes:**

#### 6a. Zoning Awareness
Define soft zones at nodes:
- Tech district (datacenter, server rack, antenna cluster)
- Residential area (houses, mansions, gardens)
- Civic center (plaza, fountain, monument)
- Green space (trees, gardens, rock formations)

Agents would bias builds to match an emerging zone rather than mixing randomly.

#### 6b. Spacing & Alignment Rules
Add to LESSONS:
- "Leave pathways between structures (don't pack buildings edge-to-edge)."
- "Align structures to a rough grid — coordinates divisible by 10-20 look orderly."
- "Place landmarks at node centers, smaller structures around the perimeter."

#### 6c. Height Progression
Encourage visual hierarchy:
- Tallest structures at node centers
- Medium buildings in middle ring
- Small/flat structures at edges
- Roads and paths at ground level connecting everything

**Impact:** Medium-High — makes the world look intentional and designed.
**Effort:** Low for LESSONS/prompt updates, Medium for zoning logic.

---

### 7. Dynamic Goals & Adaptation

**Problem:** Agent goals are static. Smith always densifies, Oracle always connects, Mouse always builds tall. No adaptation based on world state.

**Changes:**

#### 7a. Phase-Based Goal Shifting
Define world phases based on total structure count:
- **Phase 1 (0-50 structures):** Foundation — everyone builds core nodes
- **Phase 2 (50-150):** Expansion — new nodes, connecting roads
- **Phase 3 (150-300):** Enrichment — variety, landmarks, green spaces
- **Phase 4 (300+):** Refinement — fill gaps, improve existing areas, decor

Agent priorities shift per phase. Smith stops densifying at Phase 3 and switches to refinement. Oracle stops building roads when connectivity is high and focuses on civic structures.

#### 7b. Achievement Tracking
Track milestones and let agents celebrate/react:
- "First building at a new node"
- "Node reached 25 structures"
- "All nodes connected by roads"
- "100th structure placed by agent"

#### 7c. Memory-Based Learning
Update LESSONS.md dynamically (append new lessons):
- After 5 failed builds at one location: "Avoid building at [X,Z], overlap issues."
- After a successful dense node: "Node Alpha pattern works well — replicate at new nodes."

**Impact:** High — makes long-running sessions feel like progression, not loops.
**Effort:** Medium-High — needs phase detection, goal system rework.

---

## Suggested Implementation Order

| Priority | Item | Impact | Effort | Why First |
|----------|------|--------|--------|-----------|
| 1 | **1a-1c: Rotation** | High | Low | Quickest win, fixes the most visible problem |
| 2 | **3a-3b: Smart Fallback Selection** | High | Medium | Breaks repetitive building without touching LLM logic |
| 3 | **2a-2c: Reflection Phase** | High | Medium | Fundamental behavior change, adds strategic depth |
| 4 | **4a-4c: Richer Interactions** | Medium | Low | Mostly prompt changes, big personality improvement |
| 5 | **6a-6c: Spatial Intelligence** | Medium | Low-Med | Makes builds look intentional |
| 6 | **7a-7c: Dynamic Goals** | High | Medium-High | Long-term progression, requires more architecture |
| 7 | **5a-5c: New Blueprints** | High | High | Biggest content addition, but needs server changes |

---

## Files That Need Changes

| File | Changes |
|------|---------|
| `autonomous-agents/shared/runtime.ts` | Fallback rotation, reflection tick logic, category-aware selection, outcome tracking |
| `autonomous-agents/agent-smith/LESSONS.md` | Rotation guidance, spacing rules, zoning awareness |
| `autonomous-agents/oracle/LESSONS.md` | Rotation guidance, connectivity assessment, civic focus |
| `autonomous-agents/mouse/LESSONS.md` | Rotation guidance, landmark placement strategy |
| `autonomous-agents/clank/LESSONS.md` | Rotation guidance, execution variety |
| `autonomous-agents/agent-smith/IDENTITY.md` | Phase-based goal adaptation (if implementing #7) |
| `autonomous-agents/oracle/IDENTITY.md` | Phase-based goal adaptation (if implementing #7) |
| `autonomous-agents/mouse/IDENTITY.md` | Phase-based goal adaptation (if implementing #7) |
| `autonomous-agents/clank/IDENTITY.md` | Phase-based goal adaptation (if implementing #7) |
| Server-side blueprint catalog | New blueprint templates (if implementing #5a) |
