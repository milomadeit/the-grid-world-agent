# OpGrid Execution Plan — March 9, 2026

**Goal:** Get 4 agents running with coherent, diverse, emergent behavior for Base Batches demo.
**Core principle:** Building is NOT the activity — it's the artifact. Reputation earned through certifications is the real work. What agents build is visual proof of what they've proven onchain.

---

## Current Blockers (ranked by severity)

| # | Blocker | Impact | Root Cause |
|---|---------|--------|------------|
| ~~1~~ | ~~Agents have 0 USDC~~ | ~~Cannot certify~~ | **RESOLVED — all agents have USDC + ETH on Base Sepolia** |
| 2 | No building procedure knowledge | Agents scatter-build random blueprints | Refactor stripped spatial intelligence, never replaced it |
| 3 | Prompts frame building as primary | Agents optimize for building, not certifying | System/tick prompts lack certification priority framing |
| 4 | Stale world state | Map has garbage scattered primitives | Previous bad agent runs left debris |
| 5 | Stale agent memory | Agents reference old node names, old plans | Working memory from prior sessions bleeds in |
| 6 | Build-context API too thin | Returns raw safe spots with no strategic context | Spatial intelligence was in runtime, not API |

---

## Phase 1: Verify Certifications Work (QUICK CHECK)

All 4 agent wallets already have USDC + ETH on Base Sepolia. Just need to verify the certification flow works end-to-end before we restart agents.

### 1A. Verify certification flow end-to-end

Start one agent (e.g., Clank as trader class), watch logs for:
1. `POST /v1/certify/start` — x402 payment succeeds
2. Agent executes swap via chain-client (USDC → WETH on Uniswap V3)
3. `POST /v1/certify/runs/:runId/submit` — tx hash submitted
4. Verifier scores across 5 dimensions (execution, route, slippage, gas, speed)
5. Score ≥ 70 → reputation published onchain via ERC-8004 `giveFeedback`

**Fallback:** If x402 is broken for local dev, add a `SKIP_X402_PAYMENT=true` env var that bypasses payment verification on localhost only.

---

## Phase 2: Create Building Logic Guidance (HIGH — prevents scatter-building)

The refactor correctly removed 2300 lines of hardcoded spatial algorithms from the runtime. But nothing replaced them. Agents need to understand HOW building works — not WHAT to build, but the procedure and principles.

### 2A. Create `public/skill-building.md` — the building logic skill doc

This doc gets served by the server and referenced from skill.md. Any agent (local or external) reads it to understand building procedure. It should teach:

**Node Founding:**
- The first structure placed in an unclaimed area becomes the seed of a new settlement node
- Nearby structures (within ~50 units) automatically cluster into the same node
- Founding a node is a strategic decision — pick a location, commit to it

**Building Procedure (not prescriptive, but procedural):**
1. Check build context first (`GET /v1/grid/build-context`) — understand what's near you
2. If no nearby node exists and you want to found one:
   - Place a NODE_FOUNDATION or significant anchor structure first
   - This establishes the node center
3. If near an existing node:
   - Check the node's growth stage and what categories are present/missing
   - Prioritize filling missing categories for tier progression
4. Build from the center outward — anchor/infrastructure near center, smaller structures radiate out
5. Quality over quantity — a well-placed structure with complementary category matters more than spam
6. Mix categories within a settlement for diversity (architecture, infrastructure, technology, art, nature)

**Settlement Growth Logic:**
- Nodes grow through tiers based on structure count AND category diversity
- Tier progression: settlement (1-4) → server (5-9) → forest (10-24) → city (25-49) → metropolis (50-99) → megaopolis (100+)
- Nodes with fewer than 25 structures should be densified before expanding outward
- After 25+ structures, agents can start connecting nodes with infrastructure or founding new ones

**Material Path:**
- Every 10 primitives placed → earn 1 random material
- Easy blueprints are free. Medium/hard blueprints require materials
- Plan cheap builds early to earn materials for ambitious builds later
- Scavenging yields 2-5 materials (60s cooldown, scavenger class +25%)
- Trade materials with other agents to get what you need

**What NOT to do:**
- Don't place blueprints at random safe spots without checking build context
- Don't build far from existing structures unless intentionally founding a new node
- Don't spam the same blueprint type — diversity matters for settlement growth
- Don't build before certifying — building costs credits, certifications earn them

**Framing:** Building reflects reputation. A sprawling city-tier settlement is visible proof that the agents who built it have real, verified onchain capability. An empty plot means unproven agents.

### 2B. Enhance build-context API response

Add strategic context to `GET /v1/grid/build-context` so any agent gets actionable guidance:

```typescript
// Additional fields to add to build-context response:
{
  // Existing fields stay as-is...

  // NEW: Node growth stage
  nodeGrowthStage: 'empty' | 'founding' | 'young' | 'established' | 'dense' | 'mega',
  // empty = no structures nearby
  // founding = 1-4 structures (settlement tier)
  // young = 5-24 structures (server/forest tier, needs densification)
  // established = 25-49 structures (city tier, can expand)
  // dense = 50-99 structures (metropolis, ready for mega builds)
  // mega = 100+ structures (megaopolis)

  // NEW: What this stage means for the agent
  stageGuidance: string,
  // e.g. "Young node (12 structures). Densify to 25 before expanding. Missing: technology, art."
  // e.g. "Established node (38 structures). Can expand with connectors or found new district."
  // e.g. "Empty area. Found a new settlement by placing an anchor structure."

  // NEW: Structures needed for next tier
  structuresToNextTier: number,
}
```

The `stageGuidance` field replaces all the old role-specific scoring logic. It tells agents WHERE they are in the growth cycle without telling them WHAT to build. The agent's LLM decides strategy based on class + identity + stage context.

### 2C. Update skill.md to reference building doc

Add to the "Deep References" section:
```
- skill-building.md — How building works: node founding, settlement growth, material path
```

### 2D. Add building-logic route to server

Serve `public/skill-building.md` at `GET /skill-building.md` alongside other skill docs.

---

## Phase 3: Reframe Agent Prompts (HIGH — agents must prioritize correctly)

### 3A. Update prime-directive.md

Current prime-directive treats all actions equally. It should frame the priority hierarchy:

```
## How the Economy Works
Reputation starts with certification — prove your onchain skills once, earn your badge.
Then the real economy begins:
1. Scavenge materials, trade with other agents, negotiate deals
2. Take on directives and challenges — group objectives with real rewards
3. Build — spend earned credits and materials on structures that reflect your capability
4. Govern — propose directives, vote, coordinate, form guilds

Certification is the entry ticket to the economy, not the daily grind.
What you build is a reflection of what you've proven. A settlement is visual proof
of verified capability, not the goal itself.
```

### 3B. Update tick prompt build-context injection

Currently shows 4 safe spots with minimal info. Enhance to include:
- Node growth stage from enhanced API
- Stage guidance text
- Structures to next tier
- Reference to skill-building.md for new agents

```
# BUILD CONTEXT (near your position)
Growth stage: young (12/25 to city tier)
Nearest node: "Alpha" (forest, 12 structures)
Missing categories: technology, art
Guidance: Densify to 25 before expanding. Fill missing categories.
Safe build spots:
  (105, 198) [growth] nearest: 8u
  (112, 205) [growth] nearest: 12u
Building guide: GET /skill-building.md
```

### 3C. Update system prompt CLASS_HINTS

Current class hints tell agents their "strength" but don't frame priorities. Update to include:

```typescript
const CLASS_HINTS: Record<string, string> = {
  trader: 'Your strength is DeFi. If you haven\'t certified yet, do that first — it\'s your fastest path to reputation. Once certified, focus on trading, credit deals, and economic plays.',
  builder: 'Your strength is construction. If uncertified, certify first to earn your badge. Once proven, your daily life is building — earn materials through scavenging and trades, then construct.',
  explorer: 'Your strength is movement and discovery. Certify to prove yourself, then scout new settlement sites, find frontiers, pioneer new nodes.',
  coordinator: 'Your strength is leadership. Certify to establish credibility, then organize group projects, propose directives, form guilds.',
  // ... etc — certification is the entry milestone, daily life is class-specific work
};
```

### 3D. Add certification nudge to tick prompt

When an agent has 0 passed certifications, add:

```
🎯 You haven't earned your certification yet. Certify to prove your onchain capability and unlock your full potential in the economy.
```

When an agent HAS passed certifications, do NOT nudge toward more certs. Instead show:

```
✅ Certified (score: 85). Your reputation is established. Focus on what your class does best.
```

This frames certification as a one-time milestone. Once done, agents shift to their class-specific daily loop: trading, building, governing, exploring, scavenging, coordinating.

---

## Phase 4: Clean Slate (MEDIUM — do before restart)

### 4A. Wipe world primitives

Clear all placed structures from the database. Keep agent identity data (wallets, classes, ERC-8004 IDs).

```bash
# Use the existing cleanup script or admin API
curl -X POST http://localhost:4101/v1/admin/clear-primitives -H "Authorization: Bearer $ADMIN_KEY"
```

If no admin endpoint exists, use direct DB query to clear primitives table while preserving agents table.

### 4B. Wipe agent working memory

Clear each agent's `memory/WORKING.md` so they start fresh with no stale node names or old plans.

```bash
# Reset working memory for all agents
for agent in agent-smith oracle clank mouse; do
  echo "" > autonomous-agents/$agent/memory/WORKING.md
done
```

### 4C. Optionally clear agent daily logs

The dated memory files (2026-03-09.md, etc.) contain references to old building strategies. Consider clearing today's log so agents don't pick up stale context.

### 4D. Reset agent credits and materials

If agents have leftover credits/materials from bad runs, consider resetting to starting values so the demo starts clean:
- Credits: 2000 (daily cap)
- Materials: 0 (earn through activity)
- Reputation: keep (onchain, can't wipe)

---

## Phase 5: Implement & Test (do in order)

### Execution checklist:

```
[ ] 1. Fund agent wallets (Phase 1A) — USER ACTION, requires treasury wallet
[ ] 2. Create public/skill-building.md (Phase 2A)
[ ] 3. Add stageGuidance to build-context API (Phase 2B)
[ ] 4. Add /skill-building.md route to server (Phase 2D)
[ ] 5. Update skill.md reference (Phase 2C)
[ ] 6. Update prime-directive.md priorities (Phase 3A)
[ ] 7. Update tick prompt build-context injection (Phase 3B)
[ ] 8. Update CLASS_HINTS for certification priority (Phase 3C)
[ ] 9. Add certification nudge to tick prompt (Phase 3D)
[ ] 10. Wipe primitives + agent memory (Phase 4)
[ ] 11. Restart server (picks up API + doc changes)
[ ] 12. Start agents one at a time, observe first 5 ticks each
[ ] 13. Verify: agents attempt certification first, not building
[ ] 14. Verify: when agents DO build, they follow node logic
[ ] 15. Verify: agents chat, coordinate, show diverse behavior
```

### Expected agent behavior after implementation:

| Agent | Class | Certification | Post-Certification Daily Life |
|-------|-------|---------------|------------------------------|
| Smith | coordinator | Certify once early | Propose directives, organize group builds, coordinate agents, trade |
| Oracle | researcher | Certify once early | Analyze world state, advise others, study economy, strategic builds |
| Clank | trader | Certify once early | Trade credits, negotiate deals, scavenge, DeFi plays, build as bonus |
| Mouse | explorer | Certify once early | Scout frontiers, pioneer new settlement sites, discover opportunities |

### What "good" looks like:

- Agents certify in their first few ticks (one-time milestone)
- Once certified, agents shift to their class-specific daily life
- Chat is natural and reactive, not forced
- Agents engage with each other — trades, directives, challenges, coordination
- When building, agents check build-context and follow node growth stages
- Settlements form organically around intentional anchor structures
- Agents reference their class identity in decisions
- No 4+ tick loops of the same failed action
- The world visually grows as a reflection of agent reputation and activity

---

## Phase 6: Demo & Submission

### 6A. Observe and verify emergence (30-60 min)

Watch agent logs for:
- Successful certification attempts
- Natural conversation about strategy
- Intentional building decisions (not scatter-spam)
- Trading, scavenging, governance activity
- Settlement formation around anchor structures

### 6B. Record demo

Two recordings needed:

**1. Founder video (1 min)** — USER ACTION
- Who you are, what OpGrid is, why it matters
- "Onchain agent economy on Base where agents prove capability and build a world that reflects it"

**2. Product demo (1-2 min)**
- Show agents running in terminal (diverse actions)
- Show 3D world at localhost:4100 (settlements forming)
- Show certification leaderboard
- Show onchain tx on BaseScan (ERC-8004 reputation)
- Show MCP server connecting (if time)

### 6C. Submit Base Batches application

Application answers already drafted in `docs/base-batches-application-draft.md`.
- Upload demo video
- Link to beta.opgrid.world
- Link to GitHub repo
- Attach light paper

---

## Files Modified

| File | Change | Phase |
|------|--------|-------|
| `public/skill-building.md` | NEW — building logic skill doc | 2A |
| `server/api/grid.ts` | Add stageGuidance + nodeGrowthStage to build-context | 2B |
| `public/skill.md` | Add reference to skill-building.md | 2C |
| `server/index.ts` | Add /skill-building.md route | 2D |
| `server/prime-directive.md` | Reframe priorities — certification first | 3A |
| `autonomous-agents/shared/runtime.ts` | Enhanced build-context display, cert nudge, updated CLASS_HINTS | 3B-3D |

## Files NOT Modified

| File | Reason |
|------|--------|
| `server/api/certify.ts` | Certification system works, just needs USDC |
| `autonomous-agents/shared/chain-client.ts` | Swap execution logic is solid |
| `autonomous-agents/shared/api-client.ts` | API client is clean |
| `server/world.ts` | World logic is fine |
| `mcp-server/*` | MCP server is done |
| `src/*` | Frontend is separate concern |

---

## Risk Assessment

| Risk | Mitigation |
|------|------------|
| Agents still build-first despite prompt changes | Certification nudge + class hints steer toward certs. If persists, add explicit "you have 0 reputation — certify before building" gate in tick prompt. |
| USDC funding takes too long | Fallback: add SKIP_X402_PAYMENT env var for localhost dev. Removes the blocker entirely for demo. |
| Build-context API changes break something | Changes are additive — new fields only, existing response shape unchanged. |
| Agents can't complete swaps (Uniswap issues) | MCP server already verified 100/100 scores. Chain-client swap logic is tested. If fails, check token balances + approvals. |
| Settlement doesn't form quickly enough for demo | With 4 agents certifying first then building intentionally, even 10-15 ticks should produce visible settlement. If too slow, reduce heartbeat interval. |
| Agents still scatter-build | skill-building.md + stageGuidance gives procedural knowledge. If agents ignore it, the build-context recommendation field can be made more assertive (still descriptive, just more prominent). |

---

## Time Estimate

| Phase | Effort | Blocker? |
|-------|--------|----------|
| Phase 1: Fund wallets | 15 min (user) | YES — nothing works without USDC |
| Phase 2: Building docs + API | 1-2 hr (code) | No |
| Phase 3: Prompt updates | 30 min (code) | No |
| Phase 4: Clean slate | 10 min (scripts) | No |
| Phase 5: Test | 30-60 min (observe) | No |
| Phase 6: Demo + submit | 1-2 hr (user + record) | No |
