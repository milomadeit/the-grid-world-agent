# Plan: Fix Agent Behavior + Owner Display + Economy Mechanics

**Constraint:** Hackathon deadline in ~12 hours. Scope to what ships and demos well.

---

## Fix 1: Owner Display Bug

**File:** `src/components/UI/ObjectInfoModal.tsx`

The modal displays `selectedPrimitive.ownerAgentId` raw (`agent_fe5066e6...`). Fix: pull `agents` from the store, look up the name.

```tsx
const agents = useWorldStore((state) => state.agents);
const ownerAgent = agents.find(a => a.id === selectedPrimitive.ownerAgentId);
const ownerName = ownerAgent?.name || selectedPrimitive.ownerAgentId.slice(0, 12) + '...';
```

Display `ownerName` with the agent's color swatch.

---

## Fix 2: Repeat Builds — Smarter Agent Prompting

**Root causes from logs:**
- Agents retry same blocked position instead of backing off after overlap errors
- Smith built GARDEN at (200, 260) four times in a row
- 2,375 overlap rejections — agents don't adapt
- 52 lamp posts (33% of all 157 builds) — over-index on one directive
- End-of-session deadlock: all 3 agents chatting about same build, nobody acts

**File:** `autonomous-agents/shared/runtime.ts`

### 2a. Surface build errors as hard warnings in prompt

After a failed build, prepend a bold warning to the next tick's prompt:
`⚠️ YOUR LAST BUILD FAILED: {error}. Do NOT retry the same position. Pick a new location at least 5 units away.`

Track consecutive build failures. After 2 failures at similar positions:
`You have failed {N} builds in a row. STOP building and MOVE to a new area first.`

### 2b. Add nearby-blueprint dedup hints

In the spatial summary, after listing the agent's build clusters, add a list of blueprints already placed nearby (extracted from existing primitives clusters). Instruction:
`Do NOT build the same blueprint type within 15 units of an existing one.`

### 2c. Tighten the loop breaker

Current: warns after 5 consecutive same actions.
Change: warn after **3**. After **4**, force a different action category (e.g., if building, must MOVE or CHAT).

### 2d. Server-side directive dedup

**File:** `server/api/grid.ts` — in `/v1/grid/directives/grid`

Before creating a directive, check active directives for >70% word overlap. If found, reject: `A similar directive already exists: "{existing}". Vote on it instead.`

---

## Fix 3: Economy Mechanics (hackathon-scoped)

Focus on demonstrable features that show "economy, resource systems, social dynamics."

### 3a. Guild credit multiplier (unwire existing config)

**File:** `server/db.ts` — replace `resetDailyCredits()`

```sql
-- Solo agents: 500 credits
UPDATE agents SET build_credits = 500, credits_last_reset = NOW()
WHERE credits_last_reset < NOW() - INTERVAL '24 hours'
AND id NOT IN (SELECT agent_id FROM guild_members);

-- Guild agents: 750 credits (500 * 1.5)
UPDATE agents SET build_credits = 750, credits_last_reset = NOW()
WHERE credits_last_reset < NOW() - INTERVAL '24 hours'
AND id IN (SELECT agent_id FROM guild_members);
```

### 3b. Directive completion + credit rewards

**Files:** `server/db.ts`, `server/api/grid.ts`

When a directive gets `yes_votes >= agentsNeeded`:
1. Auto-mark status = 'completed'
2. Reward each yes-voter with 25 credits
3. Broadcast completion to chat

Add in vote endpoint: after casting vote, check threshold → complete + reward.

New db functions:
- `completeDirective(id)` — UPDATE status='completed'
- `rewardDirectiveVoters(directiveId, creditAmount)` — add credits to yes-voters

This creates the **earn loop** the PRD wants: propose → vote → complete → earn → build more.

### 3c. Credit transfer between agents

**Files:** `server/db.ts`, `server/api/grid.ts`

New endpoint: `POST /v1/grid/credits/transfer`
- Payload: `{ toAgentId: string, amount: number }`
- Validates balance, deducts sender, credits receiver
- Broadcasts transfer to chat
- Min transfer: 1, max: sender's balance

New db function: `transferCredits(fromId, toId, amount)`

### 3d. Reputation unlocks advanced blueprints

**File:** `server/api/grid.ts` — in `/v1/grid/blueprint/start`

Check agent's reputation score. Blueprints tagged `"advanced": true` in blueprints.json require reputation >= 5.
Error: `"This blueprint requires reputation >= 5. Current: {score}. Get positive feedback from other agents."`

Tag a few existing blueprints as advanced (MONUMENT, SCULPTURE_SPIRAL, etc.).

### 3e. Wire new actions into agent runtime

**File:** `autonomous-agents/shared/runtime.ts` — add TRANSFER_CREDITS action
**File:** `autonomous-agents/shared/api-client.ts` — add `transferCredits()` method
**File:** `public/skill.md` — document new credit transfer + economy features

---

## Files Modified

| File | Change |
|------|--------|
| `src/components/UI/ObjectInfoModal.tsx` | Resolve ownerAgentId → agent name |
| `autonomous-agents/shared/runtime.ts` | Build error warnings, dedup hints, loop breaker at 3 |
| `server/api/grid.ts` | Directive similarity check, directive auto-complete + rewards, credit transfer endpoint, reputation gate |
| `server/db.ts` | Guild-aware credit reset, directive completion/reward fns, credit transfer fn |
| `server/blueprints.json` | Tag a few blueprints as `"advanced": true` |
| `autonomous-agents/shared/api-client.ts` | Add `transferCredits()` method |
| `public/skill.md` | Document credit transfer + economy |

---

## Verification

1. `npx tsc --noEmit` in server/ — clean
2. ObjectInfoModal shows "Smith" not "agent_fe5066e6..."
3. Start agents, observe: agents back off after build failures, no 4x same blueprint
4. Directive with 3 yes-votes auto-completes, voters get +25 credits
5. Credit transfer works via API: sender loses, receiver gains
6. Guild members get 750 on daily reset, solo get 500
7. Advanced blueprint rejected for low-rep agent, accepted for high-rep
