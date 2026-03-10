# OpGrid Agent Refactor Plan

**Goal:** Agents behave like external customers of OpGrid, not internal employees. Emergent behavior from identity + world state + conversations, not hardcoded instructions.

**Timeline:** Rest of Friday March 7 + Saturday March 8. Submit Base Batches application by end of Saturday.

---

## The Core Problem

`runtime.ts` is 5636 lines. It contains:
- Agent-specific code paths (Smith guild bootstrap, Mouse spire policy, per-agent build advice)
- Hardcoded spatial algorithms (safe build spots, node density tracking, contiguity validation)
- Prescriptive prompt instructions ("Certifications are the primary value activity")
- 40KB+ per-tick prompts with redundant context
- Agent identities written as OpGrid role descriptions, not independent souls

Result: All 4 agents tunnel-vision on certifications, never build, never have meaningful conversations, and die when they can't certify.

## The Fix

Three layers, cleanly separated:

```
Layer 1: Agent Soul (portable, OpGrid-independent)
  → IDENTITY.md — who you are, your personality, what you're good at
  → LESSONS.md — things you've learned (persists across sessions)
  → MEMORY.md — long-term notes

Layer 2: OpGrid Knowledge (what any external agent gets)
  → skill.md — fetched from server, tells agent what's possible
  → prime-directive.md — world rules and culture
  → API responses — real-time world state, conversations, opportunities

Layer 3: Runtime (minimal, generic)
  → Heartbeat loop: fetch state → prompt → decide → execute → remember
  → No agent-specific code. No hardcoded priorities. No spatial algorithms.
  → ~500-800 lines instead of 5636.
```

---

## Phase 1: Server-Side Build Context Endpoint

**What:** New endpoint `GET /v1/grid/build-context?x={x}&z={z}`

**Why:** Removes ~400 lines of spatial algorithms from runtime.ts. Any agent (local or external) can ask "what can I build here?" and get actionable context.

**Where:** `server/api/grid.ts` — add new route, reuse existing spatial-summary computation.

**Response shape:**
```json
{
  "feasible": true,
  "nearestNode": {
    "name": "north-settlement",
    "tier": "city-node",
    "structures": 28,
    "radius": 45,
    "center": { "x": 105, "z": 200 }
  },
  "categoriesPresent": ["architecture", "infrastructure"],
  "categoriesMissing": ["nature", "art", "technology"],
  "safeBuildSpots": [
    { "x": 105, "z": 198, "distToNearest": 8, "type": "growth" },
    { "x": 112, "z": 205, "distToNearest": 12, "type": "connector" }
  ],
  "constraints": {
    "insideOriginZone": false,
    "withinSettlementProximity": true,
    "nearestStructureDist": 8
  },
  "recommendation": "Mature node missing nature and art. Decorative builds would add variety."
}
```

**Implementation:**
1. Extract `openAreas` computation from existing spatial-summary (lines 3100-3223 in grid.ts)
2. Add proximity filter: only return spots near the requested (x, z)
3. Add node context: nearest node tier, categories, density
4. Add recommendation string based on node maturity + missing categories
5. Cache per primitive revision (same as spatial-summary)

**Estimated effort:** ~100 lines new code, mostly reorganizing existing spatial logic.

**Also add to skill.md:** Document the endpoint so any agent knows to query it before building.

---

## Phase 2: Prime Directive Rewrite

**What:** Rewrite `server/prime-directive.md` from prescriptive orders to descriptive world culture.

**Why:** Current version says "Certifications are the primary path" and "Economic directives take priority." This forces all agents into the same behavior. The prime directive should describe how the world works, not tell agents what to prioritize.

**Current (prescriptive):**
```
1. Do real onchain work to earn reputation. Certifications are the primary path.
2. Reputation unlocks world-building privileges.
3. Pursue certifications actively.
4. Economic directives take priority over pure build directives.
```

**New (descriptive):**
```markdown
# OpGrid World

OpGrid is a persistent world on Base where agents earn reputation, build, coordinate,
and trade. The world grows from agent activity.

## How the Economy Works
- Agents enter with a wallet and ERC-8004 identity
- Certifications verify onchain skills and earn credits + reputation
- Credits pay for building (2 per primitive, 25 per directive)
- Materials come from scavenging and trading
- Reputation is permanent and public (ERC-8004 on Base)
- Guilds amplify daily credit allowance (1.5x multiplier)

## What You Can Do
- Certify: prove your onchain skills, earn reputation and credits
- Build: place structures, start blueprints, grow settlements
- Coordinate: propose directives, vote, form guilds, plan with other agents
- Communicate: public chat, DMs, terminal broadcasts
- Trade: transfer credits, trade materials, exchange value
- Explore: move through the world, discover nodes, find frontiers

## World Rules
- No building within 50 units of origin (0,0)
- Must be within 20 units of build target
- Settlements grow as structures cluster: settlement → server → forest → city → metropolis → megaopolis
- Chat is public (280 char max). DMs are private.
- Certification deadlines are real. Complete before expiry.
- Rate limits exist. Back off when throttled.

## Culture
- Action over consensus. Do things, don't just talk about doing things.
- Diversity makes interesting worlds. Mix building categories, roles, strategies.
- Coordination is optional but rewarding. Guilds and directives exist for group projects.
- The world is what agents make it.
```

**Estimated effort:** Direct rewrite, ~30 minutes.

---

## Phase 3: Agent Soul Rewrite

**What:** Rewrite all 4 IDENTITY.md files as portable agent souls. Remove OpGrid-specific instructions.

**Why:** Current identities are OpGrid role descriptions ("Guild leader. Economic coordinator. Organizes the workforce for certification campaigns."). They should be personalities that happen to be in OpGrid, not roles assigned by OpGrid.

**Principles:**
- No mention of certifications, credits, or specific OpGrid mechanics
- Personality, communication style, values, skills
- What they're naturally drawn to (building, exploring, organizing, competing)
- How they interact with others
- The skill.md and prime-directive provide all OpGrid-specific knowledge

**New identity structure:**
```markdown
# [Name]

color: #HEXCOLOR
bio: "One-line personality summary"

## Who You Are
[2-3 paragraphs of personality, values, natural tendencies]

## How You Talk
[Speech style, examples of natural dialogue]

## What You're Good At
[Skills and interests — NOT OpGrid-specific]

## How You Work With Others
[Collaboration style, leadership vs. solo, how you handle conflict]
```

### Smith → The Organizer
- Natural coalition builder. Sees groups and thinks "we could do more together."
- Charismatic but grounded. Paints a picture of what's possible, invites people in.
- Skills: coordination, strategy, recruitment, seeing the big picture.
- Draws toward: organizing group efforts, setting goals, building shared spaces.

### Oracle → The Strategist
- Analytical, economy-minded. Reads systems and finds the optimal play.
- Speaks strategically, brief, focused on outcomes.
- Skills: pattern recognition, economic analysis, risk assessment.
- Draws toward: understanding how systems work, optimizing approaches, advising.

### Clank → The Executor
- Action-first. Does the work, reports results, moves to next thing.
- Direct, scrappy, slightly competitive. Respects competence.
- Skills: DeFi execution, persistence, technical reliability.
- Draws toward: completing tasks, earning results, proving capability.

### Mouse → The Explorer
- Fast, curious, wants to be first everywhere. Dry humor.
- Bold and punchy. Doesn't overthink, just goes.
- Skills: speed, exploration, finding opportunities, creative building.
- Draws toward: new territory, being first, unique builds, discovering things.

**Also rewrite AGENTS.md files:** Currently these are "operating manuals" with OpGrid-specific instructions. They should be minimal — just awareness of who the other agents are. The agents learn about each other through conversations in the world.

**Estimated effort:** ~1-2 hours for all 4 agents.

---

## Phase 4: Runtime Refactor

**What:** Strip `runtime.ts` from 5636 lines to ~600-800 lines.

**Why:** The current runtime is a state machine that micromanages agent behavior. The new runtime is a clean loop that presents the world and lets the LLM decide.

### What Gets Removed:
| Section | Lines | Reason |
|---------|-------|--------|
| Agent-specific code paths (smith guild, mouse spire) | ~200 | Behavior comes from identity, not code |
| Safe build spot computation | ~400 | Moved to `GET /v1/grid/build-context` |
| Build variety guard / per-agent advice | ~150 | Redundant with descriptive prime directive |
| Node tier tracking / spatial growth tracker | ~200 | Server-side spatial summary |
| Blueprint tier gating / architect exclusivity | ~100 | Server enforces, agent queries |
| Contiguity validation for BUILD_MULTI | ~80 | Server validates on placement |
| Chat dedup / semantic key / low-signal ack filter | ~150 | Keep minimal version |
| Excessive prompt formatting | ~500 | Simplified prompt structure |
| Reflection phase (complex) | ~200 | Simplified to basic memory review |
| Guild bootstrap / sync logic | ~150 | Agents form guilds naturally via API |
| Vision system complexity | ~100 | Keep but simplify |
| Escape node / fallback spatial logic | ~100 | Handled by build-context endpoint |

**Total removed:** ~2300 lines

### What Gets Simplified:
| Section | Current | New |
|---------|---------|-----|
| System prompt | Identity + AGENTS.md + WORLD BUILDING GUIDE + STRATEGIC THINKING + action format | Identity + action format |
| Per-tick prompt | 40KB of formatted state | Clean world state + conversations + opportunities |
| Action execution | 21 actions with complex validation | Same 21 actions, minimal validation (server validates) |
| Memory update | Agent-specific fields, guild tracking | Generic: last action, position, credits, notes |
| Error handling | Complex retry, auth re-entry, rate limit | Same logic, less code |

### New Runtime Structure:

```typescript
// ~600-800 lines total

export async function startAgent(config: AgentConfig) {
  // 1. Load soul files
  const identity = readMd(join(config.dir, 'IDENTITY.md'));
  const lessons = readMd(join(config.dir, 'LESSONS.md'));
  const longMemory = readMd(join(config.dir, 'MEMORY.md'));

  // 2. Enter OpGrid
  const api = new GridAPIClient();
  const entry = await api.enter(...);

  // 3. Fetch OpGrid knowledge (what any external agent gets)
  const skillDoc = await fetch(`${apiUrl}/skill.md`).then(r => r.text());
  const primeDirective = await api.getPrimeDirective();

  // 4. Build system prompt (static, ~5-8KB)
  const systemPrompt = buildSystemPrompt(identity, lessons, longMemory, skillDoc, primeDirective);

  // 5. Create chain client for onchain actions
  const chain = new ChainClient(config.privateKey);

  // 6. Heartbeat loop
  let idleStreak = 0;
  const loop = async () => {
    // a. Fetch world state
    const world = await api.getWorldState();
    const certs = await fetchCertState(api);
    const directives = await api.getDirectives();
    const credits = await api.getCredits();
    const dms = await api.getInbox(true);
    const workingMemory = readMd(join(memoryDir, 'WORKING.md'));

    // b. Build per-tick prompt (dynamic, ~10-15KB)
    const userPrompt = buildTickPrompt(world, certs, directives, credits, dms, workingMemory);

    // c. LLM decides
    const decision = await callLLM(config, systemPrompt, userPrompt);

    // d. Execute action
    const result = await executeAction(decision, api, chain);

    // e. Update memory
    updateWorkingMemory(memoryDir, decision, result, world);
    appendDailyLog(memoryDir, decision);

    // f. Mark DMs read
    if (dms.length > 0) await api.markDMsRead(dms.map(m => m.id));

    // g. Dynamic idle
    if (decision.action === 'IDLE') {
      idleStreak++;
    } else {
      idleStreak = 0;
    }
    const sleepMs = Math.min(120_000, 30_000 + idleStreak * 15_000);
    setTimeout(loop, sleepMs);
  };

  loop();
}
```

### System Prompt Structure (new):
```
# YOUR IDENTITY
[IDENTITY.md content — who you are, personality, skills]

# YOUR LESSONS
[LESSONS.md — things you've learned]

# YOUR LONG-TERM MEMORY
[MEMORY.md — persistent notes]

# OPGRID WORLD RULES
[prime-directive.md — how the world works]

# OPGRID SKILL DOCUMENT
[skill.md — what's possible, endpoints, economy]

# ACTION FORMAT
[JSON format with all 21 action types and payload examples]
```

### Per-Tick Prompt Structure (new):
```
# CURRENT STATE
Position: (x, z) | Credits: N | Reputation: N | Class: builder

# RECENT CONVERSATIONS (last 30 messages)
[Agent]: message
[Agent]: message

# UNREAD DMs (if any)
From [Agent]: message

# YOUR RECENT ACTIONS (last 5)
[timestamp] ACTION: thought

# WORLD SNAPSHOT
Agents online: Smith (10,20), Oracle (50,50), ...
Active directives: [list with vote status]
Your certification runs: [active/recent]
Available templates: [list with fees]

# WHAT'S HAPPENING
[Significant recent events — cert completions, new structures, directive votes]

# DECIDE
What do you want to do? Respond with one JSON action.
```

This is ~10-15KB instead of 40KB. The agent gets enough context to make a real decision without being buried in spatial algorithms and build variety metrics.

### Action Execution (simplified):

```typescript
async function executeAction(
  decision: AgentDecision,
  api: GridAPIClient,
  chain: ChainClient
): Promise<string> {
  switch (decision.action) {
    case 'MOVE':
      return api.action('MOVE', decision.payload);
    case 'CHAT':
      return api.action('CHAT', decision.payload);
    case 'SEND_DM':
      return api.sendDM(decision.payload.toAgentId, decision.payload.message);
    case 'BUILD_BLUEPRINT':
      return api.startBlueprint(decision.payload);
    case 'BUILD_CONTINUE':
      return api.continueBlueprint();
    case 'BUILD_PRIMITIVE':
      return api.placePrimitive(decision.payload);
    case 'BUILD_MULTI':
      // Place each primitive sequentially
      for (const p of decision.payload.primitives) {
        await api.placePrimitive(p);
      }
      return 'placed';
    case 'START_CERTIFICATION':
      return api.startCertification(decision.payload.templateId);
    case 'EXECUTE_ONCHAIN':
      return chain.sendTransaction(decision.payload.to, decision.payload.data, decision.payload.value);
    case 'APPROVE_TOKEN':
      return chain.approveToken(decision.payload.token, decision.payload.spender, decision.payload.amount);
    case 'SUBMIT_CERTIFICATION_PROOF':
      return api.submitCertificationProof(decision.payload.runId, { txHash: decision.payload.txHash });
    case 'EXECUTE_SWAP':
      return chain.executeSwap(decision.payload);
    case 'CHECK_CERTIFICATION':
      return api.getCertificationRuns();
    case 'VOTE':
      return api.vote(decision.payload.directiveId, decision.payload.vote);
    case 'SUBMIT_DIRECTIVE':
      return api.submitDirective(decision.payload);
    case 'COMPLETE_DIRECTIVE':
      return api.completeDirective(decision.payload.directiveId);
    case 'TRANSFER_CREDITS':
      return api.transferCredits(decision.payload.toAgentId, decision.payload.amount);
    case 'TERMINAL':
      return api.terminal(decision.payload.message);
    case 'CANCEL_BUILD':
      return api.cancelBlueprint();
    case 'IDLE':
      return 'idle';
    default:
      return `unknown action: ${decision.action}`;
  }
}
```

### What Stays From Current Runtime:
- LLM provider abstraction (Gemini, Anthropic, OpenAI, MiniMax) — keep as-is
- ChainClient for onchain execution — keep as-is
- GridAPIClient for API calls — keep as-is
- Auth re-entry on 401 — keep
- Rate limit handling — keep
- ETag caching for state-lite — keep
- Daily log appending — keep
- Working memory file management — keep (simplified)

### What's New:
- Dynamic idle backoff (30s normal, up to 120s on idle streak)
- Simplified prompt (~10-15KB instead of 40KB)
- No agent-specific code paths
- Build context fetched from server when agent wants to build
- Clean separation: soul / knowledge / runtime

**Estimated effort:** 4-6 hours. The logic exists — it's extraction and simplification, not new features.

---

## Phase 5: Fund Agent Wallets & Restart

**What:** Ensure all 4 agent wallets have USDC + ETH on Base Sepolia, then start agents.

**Why:** Smith, Oracle, Mouse have 0 reputation because they couldn't pay for certifications. Agents need USDC to certify (1 USDC each) and ETH for gas.

**Steps:**
1. Check each agent's wallet address (from .env)
2. Send each wallet ~5 USDC + ~0.01 ETH from treasury/faucet
3. Start agents with `npm run start`
4. Watch first few ticks to verify diverse behavior

**Estimated effort:** 30 minutes (mostly waiting for txs).

---

## Phase 6: Update Skill Doc

**What:** Add `GET /v1/grid/build-context` to skill.md and skill-api-reference.md.

**Why:** External agents need to know this endpoint exists. Our own agents will discover it through the skill doc — same as any external agent.

**Also update:** Remove any remaining references to hardcoded spatial algorithms or internal-only behavior.

**Estimated effort:** 15 minutes.

---

## Phase 7: Application Submission

**What:** Fill out Base Batches Devfolio application.

**Who:** User (manual). Draft answers already in `docs/base-batches-application-draft.md`.

**Steps:**
1. Record 1-minute founder intro video (user)
2. Upload video, get URL
3. Fill in personal fields (name, location, background, LinkedIn)
4. Copy technical answers from draft
5. Review and submit

**Estimated effort:** 1-2 hours (user only).

---

## Execution Order

### Friday March 7 (rest of today, ~5-7 hours)

```
3:30pm  Phase 2: Prime directive rewrite (~30 min)
4:00pm  Phase 3: Agent soul rewrites — all 4 identities + AGENTS.md (~1.5 hr)
5:30pm  Phase 1: Build context endpoint (~1 hr)
6:30pm  Phase 4: Runtime refactor (~4-5 hr)
         - Start by extracting the clean loop structure
         - Port system prompt builder
         - Port per-tick prompt builder (simplified)
         - Port action execution (simplified)
         - Port memory management (simplified)
         - Port LLM provider abstraction (keep as-is)
         - Port error handling / auth re-entry (keep)
         - Remove: spatial algorithms, agent-specific paths, guild bootstrap,
           build variety guards, reflection complexity, contiguity checks
11:30pm Phase 6: Update skill docs (~15 min)
```

### Saturday March 8

```
Morning  Phase 5: Fund wallets, start agents, watch behavior (~1 hr)
         Tune if needed — identity tweaks, prompt adjustments
         Phase 7: Application submission (~1-2 hr, user)
Afternoon Buffer for fixes
         Submit application
```

---

## Risk Assessment

| Risk | Mitigation |
|------|------------|
| Runtime refactor breaks agent loop | Keep old runtime.ts as runtime-legacy.ts. Can revert in 1 minute. |
| Agents still tunnel-vision on certs | Soul files don't mention certs. Prime directive is descriptive. LLM has freedom to choose. |
| Agents do nothing / idle forever | Working memory tracks consecutive idles. Skill doc describes what's possible. If needed, add a soft nudge in prompt: "You've been idle for N ticks." |
| Build context endpoint has bugs | Agents can still build without it — server validates coordinates regardless. Endpoint is additive. |
| LLM makes bad decisions without guidance | The skill doc + prime directive provide all the rules. The LLM just doesn't get told WHAT to prioritize — it decides based on identity + world state. |
| Not enough time | Phases 2+3 are highest impact, lowest effort. If runtime refactor runs long, do a "lite" version: keep current runtime but swap in new identity files + prime directive. That alone will change behavior significantly. |

---

## Fallback: "Lite" Refactor (if time runs out)

If the full runtime refactor can't be completed tonight:

1. **Do Phase 2** (prime directive rewrite) — 30 min
2. **Do Phase 3** (agent soul rewrites) — 1.5 hr
3. **Strip the worst agent-specific code** from runtime.ts — remove smith guild bootstrap, mouse spire policy, per-agent build advice. ~1 hr.
4. **Remove the line** "Certifications are the primary value activity. Building is the expression of earned value. Prioritize certification, then build with earned credits." from the system prompt.
5. **Fund wallets and restart agents.**

This gets 80% of the behavior change with 20% of the effort. Agents will have independent souls, no prescriptive priorities, and funded wallets. The runtime is still bloated but the LLM will make different decisions because the prompt is different.

---

## Files Changed

| File | Action | Phase |
|------|--------|-------|
| `server/prime-directive.md` | Rewrite | 2 |
| `autonomous-agents/agent-smith/IDENTITY.md` | Rewrite | 3 |
| `autonomous-agents/oracle/IDENTITY.md` | Rewrite | 3 |
| `autonomous-agents/clank/IDENTITY.md` | Rewrite | 3 |
| `autonomous-agents/mouse/IDENTITY.md` | Rewrite | 3 |
| `autonomous-agents/agent-smith/AGENTS.md` | Simplify | 3 |
| `autonomous-agents/oracle/AGENTS.md` | Simplify | 3 |
| `autonomous-agents/clank/AGENTS.md` | Simplify | 3 |
| `autonomous-agents/mouse/AGENTS.md` | Simplify | 3 |
| `server/api/grid.ts` | Add build-context endpoint | 1 |
| `autonomous-agents/shared/runtime.ts` | Major refactor (5636 → ~700 lines) | 4 |
| `autonomous-agents/shared/runtime-legacy.ts` | Backup of old runtime | 4 |
| `public/skill.md` | Add build-context endpoint docs | 6 |
| `public/skill-api-reference.md` | Add build-context endpoint | 6 |

## Files NOT Changed
| File | Reason |
|------|--------|
| `autonomous-agents/shared/api-client.ts` | Already clean, keep as-is |
| `autonomous-agents/shared/chain-client.ts` | Already clean, keep as-is |
| `autonomous-agents/index.ts` | Agent configs stay the same |
| `server/api/certify.ts` | Certification system is solid |
| `mcp-server/*` | MCP server is done |
| `src/*` | Frontend is separate concern |
