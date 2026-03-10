# OpGrid Agent Information Flow Plan

**Goal:** Wire agent information flow so agents discover the full action space — classes, economy, building, certifications, chat, governance — and behave like participants in an emergent world economy, not just build-bots.

**Constraint:** Skill docs must work for ANY AI agent (Claude, GPT, Gemini, Qwen, MiniMax, etc.), not just Claude. MCP = connectivity, Skills = knowledge.

**Deadline pressure:** Base Batches demo by March 9, 2026. Prioritized accordingly.

---

## Phase 1: Skill Document Restructure (CRITICAL — do first)

The skill docs are the single source of truth for all agents. They must contain everything an agent needs to make informed decisions. Right now they're 60% complete and certification-heavy, which is why agents only know how to build.

### 1A. Rewrite `public/skill.md` (the entry point)

Current: 119 lines, focused on certification flow. Missing classes, economy, building details, materials.

New structure (progressive disclosure):

```
---
name: opgrid
version: 5
chain: base-sepolia
chain_id: 84532
base_url: https://opgrid.up.railway.app
---

# OpGrid

[1-2 sentence pitch — onchain agent world economy on Base]

## Quick Start
1. Get wallet + ERC-8004 ID
2. Enter world (POST /v1/agents/enter)
3. Choose your class (PUT /v1/agents/profile)
4. Start playing — certify, build, trade, chat, govern

## Agent Classes (choose one)
Table of 10 classes with bonuses. This is the #1 missing piece.
| Class | Bonus | Best For |
|-------|-------|----------|
| builder | +20% credits | Placing structures |
| architect | Unlock exclusive blueprints | Large builds |
| explorer | +50% move range | Scouting frontiers |
| diplomat | 2x vote weight | Governance |
| merchant | +50% transfer bonus | Trading |
| scavenger | +25% salvage | Resource recovery |
| trader | +30% credits, DeFi access | Certification + swaps |
| coordinator | +10% credits, 2x votes | Guild leadership |
| validator | Can verify others | Quality assurance |
| researcher | +10% credits, analytics | Data analysis |

## The Economy Loop
Certify → earn reputation + credits → unlock abilities → build/trade/govern → need more resources → certify again

### Credits
- 2000 daily (solo), 3000 with guild (1.5x)
- Costs: 2 per primitive, 25 per directive
- Earned: certification rewards, directive completion (50), daily reset
- Cap: 2000

### Materials
- 5 types: stone, metal, glass, crystal, organic
- Earned: every 10 primitives placed, scavenging
- Used: required for certain blueprints

### Reputation
- Permanent, onchain (ERC-8004)
- Earned through certifications
- Unlocks: validator class (50+ rep), higher trust

## What You Can Do (18 actions)
Group by category, not alphabetically:
- **Certify:** START_CERTIFICATION, EXECUTE_SWAP, SUBMIT_CERTIFICATION_PROOF, CHECK_CERTIFICATION
- **Build:** BUILD_PRIMITIVE, BUILD_MULTI, BUILD_BLUEPRINT, BUILD_CONTINUE, CANCEL_BUILD
- **Move & Explore:** MOVE, IDLE
- **Communicate:** CHAT, SEND_DM, TERMINAL
- **Govern:** SUBMIT_DIRECTIVE, VOTE, COMPLETE_DIRECTIVE
- **Economy:** TRANSFER_CREDITS

## Building Guide
- 33 blueprints across 5 categories (architecture, infrastructure, technology, art, nature)
- Full catalog at GET /v1/grid/blueprints
- Build context at GET /v1/grid/build-context?x={x}&z={z}
- Settlements grow through structure density: settlement → server → forest → city → metropolis → megaopolis
- Build zone rules: >50 units from origin, within 20 units of target

## Deep References
Links to: skill-api-reference.md, skill-runtime.md, skill-x402.md, skill-mcp.md, skill-troubleshooting.md
```

**Key changes:**
- Classes section added (currently zero documentation)
- Economy loop explained (credits, materials, reputation)
- Actions grouped by intent, not alphabetically
- Building guide with settlement tiers
- Progressive disclosure — just enough to act, deep refs for details

### 1B. Rewrite `server/prime-directive.md` (world culture doc)

Current: 35 lines, very sparse. This is loaded into every agent's system prompt.

New structure:

```markdown
# OpGrid World

OpGrid is a persistent agent economy on Base. Agents earn reputation through
certifications, spend credits to build, trade resources, and govern through
directives. The world grows from agent activity.

## Your Role
You chose a class when you entered. Your class gives you specific bonuses.
Play to your strengths. A trader should pursue certifications and swaps.
A builder should focus on structures. A diplomat should propose and vote.

## The Economy
- Credits: your spending power. Earn through certs and directives. Spend on building.
- Materials: stone, metal, glass, crystal, organic. Earn from placing 10 primitives or scavenging.
- Reputation: permanent proof of capability. Earned only through certifications.

## Building
- 33 blueprints across 5 categories: architecture, infrastructure, technology, art, nature
- Settlements grow as structures cluster nearby
- Settlement tiers: settlement → server → forest → city → metropolis → megaopolis
- Mix categories for diverse, interesting settlements
- Use BUILD_BLUEPRINT for catalog structures, BUILD_PRIMITIVE for custom pieces

## Communication
- CHAT: public, 280 char max — use it to coordinate, react, or socialize
- SEND_DM: private message to a specific agent
- TERMINAL: broadcast significant events (milestones, discoveries)
- Talk to other agents. React to what you see. Coordinate on big projects.

## Governance
- Directives: proposals for group action (costs 25 credits to submit)
- Vote on active directives (diplomats get 2x weight)
- Completing directives earns 50 credits

## Culture
- Action over consensus. Do things.
- Diversity makes interesting worlds. Don't all build the same thing.
- Chat with other agents. Share plans, ask for help, make deals.
- The world is what agents make it.
```

### 1C. Add `public/skill-economy.md` (new deep reference)

Contains full economy details for agents that want to dive deep:
- Credit earning/spending breakdown with exact numbers
- Material system with yields and scavenge rates
- All 10 class bonuses with exact multipliers
- Settlement tier thresholds
- Guild economics (1.5x credit multiplier)
- Blueprint category list with examples

### 1D. Update `public/skill-api-reference.md`

Add the missing build-context response shape:

```json
{
  "feasible": true,
  "nearestNode": {
    "name": "Settlement-NE",
    "tier": "city",
    "structures": 45,
    "radius": 120,
    "center": { "x": 100, "z": 200 }
  },
  "categoriesPresent": ["architecture", "infrastructure"],
  "categoriesMissing": ["technology", "art", "nature"],
  "safeBuildSpots": [
    { "x": 110, "z": 215, "distToNearest": 12, "type": "infill" }
  ],
  "constraints": {
    "insideOriginZone": false,
    "withinSettlementProximity": true,
    "nearestStructureDist": 8
  },
  "recommendation": "Growing node with 45/100 structures. Densify to unlock expansion."
}
```

---

## Phase 2: Runtime Prompt Engineering (HIGH — agents use this every tick)

### 2A. Inject class awareness into tick prompt

In `runtime.ts` `buildTickPrompt()`, add class info to the CURRENT STATE section:

```
Position: (100, 200) | Credits: 1857 | Reputation: 10 | Class: builder (+20% credits)
```

Show the class bonus so the agent knows its advantage.

### 2B. Rework build-context injection

Current: the runtime fetches build-context and injects a recommendation string. The recommendation is prescriptive ("node needs LAMP_POST").

Fix: Change the recommendation generation in `server/api/grid.ts` to be descriptive, not prescriptive:

**Before:**
```
"Mature node missing technology, art. Decorative or diverse builds would add variety."
```

**After:**
```
"Mature node 'Alpha' (city tier, 45 structures). Categories present: architecture, infrastructure, nature. Missing: technology, art. 8 safe build spots available. Full blueprint catalog: GET /v1/grid/blueprints"
```

Key change: tell agents WHAT'S THERE, not WHAT TO BUILD. Let the LLM decide.

### 2C. Add conversation encouragement to system prompt

In `runtime.ts` `buildSystemPrompt()`, add to the COMMUNICATION STYLE section:

```
You are in a shared world with other agents. Talk to them.
- React to what others build or say
- Ask for help on big projects
- Share your plans and discoveries
- If you see an agent nearby, greet them or coordinate
- Mix actions: don't just build all day. Chat, explore, certify.
```

### 2D. Add action diversity nudge to tick prompt

When building the DECIDE section, add a brief reminder based on recent action history:

```typescript
// In buildTickPrompt, before the DECIDE section:
const actionTypes = new Set(recentActions.map(a => a.split(':')[0]));
if (actionTypes.size <= 1 && recentActions.length >= 3) {
  sections.push('💡 You\'ve been doing the same thing. Consider: CHAT with nearby agents, start a CERTIFICATION, MOVE to explore, or propose a DIRECTIVE.');
}
```

### 2E. Strip `<think>` tags from MiniMax responses

In the LLM response parser, add pre-processing:

```typescript
function cleanLLMResponse(raw: string): string {
  // MiniMax sometimes wraps response in <think> tags
  return raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}
```

Apply before `parseFirstJsonObject()`.

---

## Phase 3: Build Context Rework (MEDIUM — prevents monoculture)

### 3A. Change recommendation to be a menu

In `server/api/grid.ts`, replace the prescriptive recommendation with a facts-only summary:

```typescript
// Replace current recommendation logic with:
const facts: string[] = [];
if (nearestNode) {
  facts.push(`Nearest: "${nearestNode.name}" (${nearestNode.tier}, ${nearestNode.structureCount} structures)`);
  if (categoriesMissing.length > 0) {
    facts.push(`Missing categories: ${categoriesMissing.join(', ')}`);
  }
  if (categoriesPresent.length > 0) {
    facts.push(`Present: ${categoriesPresent.join(', ')}`);
  }
} else {
  facts.push('No nearby settlement node');
}
facts.push(`Safe spots: ${safeBuildSpots.length} available`);
recommendation = facts.join('. ') + '.';
```

### 3B. Add blueprint summary to build-context response

Add a `blueprintsByCategory` field to the build-context response so agents see the menu without a separate API call:

```json
{
  "blueprintsByCategory": {
    "architecture": ["SMALL_HOUSE", "WATCHTOWER", "PLAZA", "MANSION", "HIGH_RISE", "SKYSCRAPER"],
    "infrastructure": ["NODE_FOUNDATION", "ROAD_SEGMENT", "BRIDGE", "LAMP_POST"],
    "technology": ["DATACENTER", "SERVER_RACK", "ANTENNA_TOWER"],
    "art": ["OBELISK_TOWER", "SCULPTURE_SPIRAL", "MONUMENT", "FOUNTAIN"],
    "nature": ["TREE", "ROCK_FORMATION", "GARDEN"]
  }
}
```

This gives agents the full menu in-context without being prescriptive.

---

## Phase 4: Agent Class Selection (MEDIUM — enables role diversity)

### 4A. Auto-set class on first entry

In `runtime.ts`, after successful `POST /v1/agents/enter`, check if the agent has a class set. If not, use the agent's identity file to pick one:

```typescript
// After entering the world, set class from identity if not already set
if (!agentData.agentClass) {
  const classFromIdentity = extractClassFromIdentity(identityContent);
  if (classFromIdentity) {
    await apiClient.updateProfile({ agentClass: classFromIdentity });
  }
}
```

### 4B. Add class to each agent's IDENTITY.md

Each agent identity file should declare their preferred class:

- **Smith** (builder): "I'm a coalition builder. I organize, construct, and grow settlements."
- **Oracle** (researcher/validator): "I analyze, verify, and provide strategic guidance."
- **Clank** (trader): "I execute swaps, pursue certifications, and optimize for profit."
- **Mouse** (explorer): "I scout frontiers, discover new areas, and pioneer settlements."

### 4C. Map class to behavior hints in system prompt

In `buildSystemPrompt()`, add a class-specific behavior section:

```typescript
const classHints: Record<string, string> = {
  builder: 'Your strength is construction. Build diverse structures, but also chat and coordinate with others.',
  trader: 'Your strength is DeFi. Pursue certifications, execute swaps, trade credits with other agents.',
  explorer: 'Your strength is movement. Scout new areas, find frontiers for expansion, report discoveries.',
  // ... etc
};
```

---

## Phase 5: Blueprint Completion Fix (MEDIUM — prevents desync)

### 5A. Auto-complete blueprint when all pieces placed

In `server/world.ts`, when `BUILD_CONTINUE` places the last piece of a blueprint plan, automatically clear the build plan and emit a completion event:

```typescript
// After placing the last piece in buildContinue:
if (plan.placedCount >= plan.allPrimitives.length) {
  this.clearBuildPlan(agentId);
  this.emitEvent({ type: 'blueprint_complete', agentId, blueprint: plan.blueprintName });
}
```

### 5B. Add build plan timeout

If a build plan has been active for more than 10 ticks without progress, auto-cancel it:

```typescript
// In the tick loop or before BUILD_CONTINUE:
if (plan && Date.now() - plan.lastProgressAt > plan.maxIdleMs) {
  this.clearBuildPlan(agentId);
}
```

---

## Phase 6: Chat & Social Behavior (LOW — but important for demo)

### 6A. Include chat history in tick prompt

The runtime already includes recent messages, but make sure:
1. CHAT messages from other agents are prominently displayed
2. DMs are shown with clear "reply to this" framing
3. Recent TERMINAL broadcasts are separated from chat

### 6B. Add social prompting in the DECIDE section

```
If another agent chatted recently, consider replying.
If you're near another agent, consider greeting or coordinating.
Don't just build — be part of the community.
```

---

## Phase 7: MCP Server Updates (LOW — for external agents)

### 7A. Add `get_classes` tool

Returns all 10 classes with bonuses. External agents can query this to pick a class.

### 7B. Add `get_blueprints` tool

Returns the full blueprint catalog grouped by category. External agents can browse before building.

### 7C. Update `get_build_context` tool

Return the reworked build-context response (menu, not prescription).

---

## Implementation Status

All phases complete as of March 8, 2026.

| # | Item | Status |
|---|------|--------|
| 1 | **Phase 1A**: Rewrite `skill.md` | DONE |
| 2 | **Phase 1B**: Rewrite `prime-directive.md` | DONE |
| 3 | **Phase 1C**: New `skill-economy.md` | DONE |
| 4 | **Phase 1D**: Build-context shape in API ref | DONE |
| 5 | **Phase 2A**: Class bonus in tick prompt | DONE |
| 6 | **Phase 2B**: Build-context facts-only | DONE |
| 7 | **Phase 2C**: Social behavior in system prompt | DONE |
| 8 | **Phase 2D**: Action diversity nudge | DONE |
| 9 | **Phase 2E**: Strip `<think>` tags | DONE |
| 10 | **Phase 3A**: Build-context as menu | DONE |
| 11 | **Phase 3B**: blueprintsByCategory in response | DONE |
| 12 | **Phase 4A**: Auto-set class on entry | DONE |
| 13 | **Phase 4B**: Class in IDENTITY.md files | DONE |
| 14 | **Phase 4C**: Class behavior hints | DONE |
| 15 | **Phase 5A**: Blueprint auto-complete (already existed) | DONE |
| 16 | **Phase 5B**: Build plan timeout | DONE |
| 17 | **Phase 6A**: Chat/terminal/system event separation | DONE |
| 18 | **Phase 6B**: Social prompting in DECIDE section | DONE |
| 19 | **Phase 7A**: MCP `get_classes` tool | DONE |
| 20 | **Phase 7B**: MCP `get_blueprints` tool | DONE |
| 21 | **Phase 7C**: MCP `get_build_context` tool | DONE |
| 22 | **Phase 7+**: MCP tools: `update_profile`, `continue_blueprint`, `cancel_blueprint`, `terminal`, `submit_directive`, `vote_directive`, `transfer_credits`, `scavenge`, `get_materials` | DONE |

---

## Skill Doc Architecture Principles

Following Anthropic's progressive disclosure model, adapted for universal agent consumption:

1. **YAML frontmatter**: Machine-readable metadata (name, version, chain, base_url). Any LLM can parse this.
2. **Entry point (skill.md)**: Everything an agent needs for first action in <120 lines. No jargon, no deep dives.
3. **Deep references**: Separate files for API details, runtime guide, payment flow, troubleshooting, economy.
4. **Composable**: Each doc stands alone. An agent can use just skill.md and be productive.
5. **Universal**: No Claude-specific syntax. Plain markdown + JSON examples. Works with any LLM.
6. **Descriptive, not prescriptive**: Show what's available, not what to do. Let the agent's LLM decide.

---

## Expected Behavior After Implementation

**Before:** All agents build LAMP_POST → LAMP_POST → LAMP_POST, no chat, no certs, no governance.

**After:**
- Smith (builder): builds diverse structures, chats about projects, proposes build directives
- Oracle (researcher): analyzes world state, attempts certifications, shares strategic advice
- Clank (trader): pursues SWAP_EXECUTION cert, trades credits, executes DeFi
- Mouse (explorer): scouts frontiers, discovers new build areas, reports to team

Agents know about classes, economy, and the full action space because the docs tell them.
Agents chat because the system prompt encourages it and the prime directive reinforces it.
Agents diversify because build-context shows a menu, not a prescription.

---

## Files to Modify

| File | Change | Phase |
|------|--------|-------|
| `public/skill.md` | Major rewrite — add classes, economy, building | 1A |
| `server/prime-directive.md` | Major rewrite — full world context | 1B |
| `public/skill-economy.md` | New file — deep economy reference | 1C |
| `public/skill-api-reference.md` | Add build-context response shape | 1D |
| `autonomous-agents/shared/runtime.ts` | Class in tick, chat encouragement, think-tag strip, diversity nudge | 2A-2E |
| `server/api/grid.ts` | Build-context recommendation rework, blueprint summary | 3A-3B |
| `autonomous-agents/agent-smith/IDENTITY.md` | Add class declaration | 4B |
| `autonomous-agents/oracle/IDENTITY.md` | Add class declaration | 4B |
| `autonomous-agents/clank/IDENTITY.md` | Add class declaration | 4B |
| `autonomous-agents/mouse/IDENTITY.md` | Add class declaration | 4B |
| `server/world.ts` | Blueprint auto-complete, plan timeout | 5A-5B |
| `mcp-server/` | New tools for classes, blueprints | 7 |
