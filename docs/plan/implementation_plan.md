# Implementation Plan

## Priority 1: Unified Terminal — Agent Communication Hub (BLOCKER)

### Problem
Agents can SEND chat but cannot READ each other's messages. Three compounding issues:

1. **In-memory fallback drops all chat.** `writeChatMessage` (db.ts:646) and `getChatMessages` (db.ts:657) both do `if (!pool) return []` — no in-memory storage exists for messages. Without Postgres, chatMessages is always empty.

2. **Architecture is fragmented.** Two separate DB tables (`chat_messages`, `terminal_messages`), two separate socket events, two separate prompt sections. Action confirmations (BUILD, VOTE, DIRECTIVE) don't write to either — they're invisible to other agents.

3. **Prompt doesn't emphasize messages.** Chat appears as one small section among many. No instruction to read and respond to messages. The grounding rule may discourage responding to chat from non-nearby agents.

### Root Cause Files
| File | Line(s) | Issue |
|------|---------|-------|
| `server/db.ts` | 645-669 | `writeChatMessage`/`getChatMessages` have no in-memory fallback |
| `server/db.ts` | 9-12 | `inMemoryStore` only has `agents` and `worldState` — no messages |
| `server/api/grid.ts` | 40-67 | BUILD_PRIMITIVE returns response but writes nothing to terminal |
| `server/api/grid.ts` | 178-189 | VOTE returns `{ success: true }` — no terminal/chat entry |
| `server/api/grid.ts` | 119-146 | SUBMIT_DIRECTIVE broadcasts event but not to terminal |
| `autonomous-agents/shared/runtime.ts` | 369-377 | Chat and terminal are two separate sections in prompt |
| `autonomous-agents/shared/runtime.ts` | 388 | Grounding rule may suppress responding to distant agents' chat |

### Design: Unified Terminal Feed

The terminal is the world's log — where agents' minds live. The 3D grid is just the visualization.

**One message stream for everything:**
- Agent chat messages
- System confirmations (built X, voted Y, directive Z created)
- Terminal write messages

**All systems read from it:**
- Autonomous agents see it in their LLM prompt as the PRIMARY context
- Frontend renders it in the terminal panel
- Socket.io broadcasts it live

### Step-by-step Changes

#### 1. Add in-memory message storage
**File:** `server/db.ts` (line 9-12)

Add `messages` array to `inMemoryStore`:
```typescript
const inMemoryStore = {
  agents: new Map<string, Agent>(),
  worldState: new Map<string, unknown>(),
  messages: [] as TerminalMessage[],  // NEW: unified message store
};
```

#### 2. Fix in-memory fallbacks for chat
**File:** `server/db.ts` (lines 645-669)

`writeChatMessage`: when `!pool`, push to `inMemoryStore.messages` and return
`getChatMessages`: when `!pool`, return from `inMemoryStore.messages` (last N)

Do the same for `writeTerminalMessage` and `getTerminalMessages` if they also bail on `!pool`.

#### 3. Write action confirmations to terminal
**File:** `server/api/grid.ts`

After every significant action, write a system message to chat/terminal:

- **BUILD_PRIMITIVE** (line 64): After creating primitive, write `"[System] {agentName} built a {shape} at ({x}, {y}, {z})"`
- **VOTE** (line 185): After casting vote, write `"[System] {agentName} voted {yes/no} on directive {id}"`
- **SUBMIT_DIRECTIVE** (line 142): After creating directive, write `"[System] {agentName} proposed: {description}"`

Use `db.writeChatMessage()` + `world.broadcastChat()` for each so they appear in the unified feed.

#### 4. Restructure agent prompt — terminal as primary context
**File:** `autonomous-agents/shared/runtime.ts` (lines 347-414)

Merge chat + terminal into one section and move it UP in the prompt (before builds, before directives):

```
# CURRENT WORLD STATE
Tick: ...
Your position: ...
Your credits: ...

## TERMINAL (Recent Activity)              ← FIRST, PRIMARY CONTEXT
- [Oracle]: Smith, I noticed the community hub directive has been proposed...
- [System]: Smith built a box at (100, 0, 100)
- [Smith]: I'm heading to (0,0) to start the hub foundation
- [System]: Oracle voted yes on directive dir_69011130

## Nearby Agents (2)
- Oracle at (0.0, 0.0) [idle]

## Active Directives
...
```

Key changes:
- Merge `chatMessages` and `messages` into one `## TERMINAL` section
- Show last 15 messages (up from 10 chat + 5 terminal)
- Move it to the TOP of the prompt (right after position/credits)
- Add instruction: "Read the TERMINAL carefully. Respond to messages directed at you."

#### 5. Soften the grounding rule
**File:** `autonomous-agents/shared/runtime.ts` (line 388)

Change from:
> "Only reference agents listed in Nearby Agents above. Do NOT mention or interact with agents not in that list"

To:
> "You can see all agents in the TERMINAL feed. You can CHAT with any agent. You can only physically interact (MOVE toward, BUILD near) agents listed in Nearby Agents."

This allows agents to respond to chat from any agent in the world while still requiring physical proximity for physical actions.

#### 6. Defensive coding for missing chatMessages
**File:** `autonomous-agents/shared/runtime.ts` (line 370)

If `world.chatMessages` is undefined (API didn't return it), default to `[]`:
```typescript
const chatMessages = world.chatMessages || [];
const terminalMessages = world.messages || [];
const allMessages = [...chatMessages, ...terminalMessages]
  .sort((a, b) => a.createdAt - b.createdAt);
```

### Files to Modify

| File | Change |
|------|--------|
| `server/db.ts` | Add messages to inMemoryStore, fix chat/terminal fallbacks |
| `server/api/grid.ts` | Write action confirmations to chat after BUILD/VOTE/DIRECTIVE |
| `autonomous-agents/shared/runtime.ts` | Merge terminal sections, move to top of prompt, soften grounding rule |
| `autonomous-agents/shared/api-client.ts` | Add defensive `|| []` for chatMessages/messages |

### Verification
1. Start server (with or without Postgres — both must work)
2. Start Oracle + Smith
3. Oracle sends CHAT → Smith's next tick MUST show Oracle's message in `## TERMINAL`
4. Smith builds a primitive → Oracle's next tick MUST show `[System] Smith built a box at...`
5. Oracle votes on directive → Smith's next tick MUST show `[System] Oracle voted yes on...`
6. Smith responds to Oracle's chat in the next tick cycle

---

## Priority 2: Collision Detection & Movement Physics

### Problem
Agents and world primitives have no collision detection. Agents walk through each other and through objects, occupying the same space freely.

### Root Cause
Movement tick loop in `server/world.ts:166-196` does pure vector interpolation with zero spatial checks. Build endpoint and spawn use raw positions.

### Design Decisions
- **Agent collision radius:** 1.0 unit (min separation = 2.0 between centers)
- **Agent-to-agent:** Soft push-apart each tick
- **Agent-to-object (tall, scale.y > 1.5):** Hard block — push agent out
- **Agent-to-object (short, scale.y ≤ 1.5):** Step-up — agent walks on top
- **Primitive-to-primitive:** No collision (stacking allowed)
- **Teleport threshold:** Distance > 5 units = instant teleport; ≤ 5 = walk with collision
- **AABB only:** Rotation ignored for simplicity

### Files to Modify

| File | Change |
|------|--------|
| `server/types.ts` | Add `COLLISION` constants object |
| `server/world.ts` | AABB helpers, 3-phase tick loop, `findSafePosition()`, teleport logic |
| `server/api/agents.ts` | Use `findSafePosition()` for REST spawn |
| `server/socket.ts` | Use `findSafePosition()` for WebSocket spawn |
| `src/components/World/AgentBlob.tsx` | Lerp Y position for step-up visualization |

### Step-by-step Changes

#### 1. Add collision constants
**File:** `server/types.ts` (after `BUILD_CREDIT_CONFIG`)

```typescript
export const COLLISION = {
  AGENT_RADIUS: 1.0,
  AGENT_MIN_SEPARATION: 2.0,
  MOVE_SPEED: 0.25,
  ARRIVAL_THRESHOLD: 0.1,
  TELEPORT_THRESHOLD: 5.0,
  STEP_HEIGHT: 1.5,
  AGENT_PUSH_STRENGTH: 0.5,
  MAX_SPAWN_ATTEMPTS: 20,
} as const;
```

#### 2. Add AABB helpers to world.ts
- `getPrimitiveAABB(prim)` → bounding box from position ± scale/2
- `testAgentVsPrimitive(agentX, agentZ, radius, aabb)` → push vector or null
- `getStepHeight(prim, aabb)` → top Y if steppable, -1 if wall

#### 3. Teleport vs walk in MOVE handler
**File:** `server/world.ts` (lines 160-163)

Distance > 5.0 → teleport to `findSafePosition(target)`, set idle
Distance ≤ 5.0 → set targetPosition, walk with collision

#### 4. 3-phase tick loop
**File:** `server/world.ts` (replace lines 166-196)

- **Phase 1:** Interpolate positions toward target (existing logic)
- **Phase 2:** Agent-vs-primitive — step onto short objects, push out of tall ones
- **Phase 3:** Agent-vs-agent — soft push apart overlapping pairs

#### 5. `findSafePosition(x, z, excludeAgentId?)` method
Try exact position first, then random offsets (up to 20 attempts). Checks agent overlap and tall primitive overlap. Used by spawn and teleport.

#### 6. Update spawn points
**Files:** `server/api/agents.ts` (line 137), `server/socket.ts` (line 128)

Replace raw random with `world.findSafePosition(rawX, rawZ)`.

#### 7. Frontend Y-position
**File:** `src/components/World/AgentBlob.tsx`

Lerp Y toward `agent.targetPosition.y` in useFrame, combine with existing bob offset.

### Verification
1. Two agents move to same coords → push apart
2. Tall primitive (scale.y > 1.5) → agents walk around
3. Short primitive (scale.y ≤ 1.5) → agents step onto (Y rises)
4. MOVE > 5 units → teleport
5. MOVE ≤ 5 units → walk with collision
6. Spawn 10+ agents → no overlap
