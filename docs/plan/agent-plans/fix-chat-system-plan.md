# Fix Agent Conversation System — Make Chat Natural and Meaningful

## Context
Agents currently produce robotic, template-based chat messages instead of natural conversation. The PRD requires "meaningful responses to agent actions" and "emergent behavior from multi-agent interaction", but multiple layers in `runtime.ts` suppress personality and override LLM-generated messages with fixed templates. The result: chat logs are trash, builds feel random, and agents don't react to each other.

**Root causes identified in `runtime.ts`:**
1. System prompt (line 2164): "CHAT only for coordination… Avoid acknowledgments" — kills personality
2. Per-tick header (line 2719): "don't derail your objective to respond" — discourages engagement
3. Communication Cadence (lines 2734-2737): demands "concrete coordinates/progress/blockers" only
4. Forced coordination override (lines 3634-3648): replaces LLM decisions with `makeCoordinationChat()` templates
5. `makeCoordinationChat` (lines 221-273): 4 fixed robotic templates that override LLM output
6. 220-char message limit (line 3670): too short for personality
7. `chatMinTicks` default = 8: agents can only chat every 8 ticks — too slow for conversation
8. @mention detection (line 2639-2643): requires question words alongside name mention — too restrictive
9. Agent IDENTITY.md files say things like "No social chatter" and "one status line, then act"

---

## File: `autonomous-agents/shared/runtime.ts`

### 1. Rewrite system prompt chat instruction (line 2164)

**Old:**
```
'CHAT only for coordination: include coordinates, progress, and blockers. Avoid acknowledgments.',
```

**New:**
```
'CHAT: Talk like yourself (see YOUR IDENTITY). React to what others build, share what excites you, discuss plans. Keep it natural — you are a person with opinions, not a status bot. Avoid empty acks ("ok"/"got it") but DO engage when something interesting happens.',
```

### 2. Rewrite RECENT CHAT header (line 2719)

**Old:**
```
'## RECENT CHAT (last 15 messages — skim for context, don\'t derail your objective to respond)',
```

**New:**
```
'## RECENT CHAT (last 15 messages — read these and respond when you have something to say)',
```

### 3. Rewrite Communication Cadence section (lines 2734-2737)

**Old chatDue:**
```
`Coordination trigger detected (mentions/requests). Send at most one short chat with concrete coordinates/progress/blockers; never send acknowledgments.`
```

**New chatDue:**
```
`Someone mentioned you or there's news worth responding to. Your action this tick should be CHAT — respond in your own voice. React to what they said, share your perspective, or propose what to do next.`
```

**Old not-chatDue:**
```
`No coordination trigger. Ticks since your last CHAT action: ${currentTicksSinceChat}. Avoid chatter loops; chat only when it adds coordination value.`
```

**New not-chatDue:**
```
`Ticks since last chat: ${currentTicksSinceChat}. Chat when you have something worth saying — react to a build, propose a plan, or share what you're working on. Don't force it; building is your main job.`
```

### 4. Remove forced coordination override (lines 3634-3648)

Delete the entire block that replaces the LLM's decision with `makeCoordinationChat()` when `effectiveChatDue` is true and the LLM didn't choose CHAT.

```typescript
// DELETE THIS BLOCK (lines 3634-3648):
let decisionBeforeCadenceChat: AgentDecision | null = null;
if (effectiveChatDue && !lowSignalChatLoopDetected && decision.action !== 'CHAT' && !rateLimitWaitThisTick) {
  const forcedMessage = makeCoordinationChat(…);
  // …
  decision = { … action: 'CHAT', payload: { message: forcedMessage.slice(0, 220) } };
}
```

The strong prompt nudge from change #3 (chatDue text says "Your action this tick should be CHAT") replaces this. If the LLM still picks BUILD over CHAT, that's an acceptable outcome — it prioritized building, and it'll see the nudge again next tick.

Also remove the `decisionBeforeCadenceChat` fallback logic in the CHAT suppression block (lines 3657-3662) since it no longer applies.

### 5. Keep `makeCoordinationChat` as empty-message fallback only

In the CHAT action handler (line 3652), `makeCoordinationChat` is already used as fallback when the LLM produces an empty message. **Keep this behavior** — it's a safety net, not the primary path. The LLM should compose its own messages 99% of the time now.

### 6. Increase message length limit (line 3670)

**Old:** `.slice(0, 220)`
**New:** `.slice(0, 500)`

Also update the same 220-char limit in `emitActionUpdateChat` (line 344): `.slice(0, 500)`.

### 7. Lower `chatMinTicks` default

**Old (line 2357-2360):**
```typescript
const chatMinTicks =
  Number.isFinite(parsedChatMinTicks) && parsedChatMinTicks >= 2
    ? Math.floor(parsedChatMinTicks)
    : (emitActionChatUpdates ? 6 : 8);
```

**New:**
```typescript
const chatMinTicks =
  Number.isFinite(parsedChatMinTicks) && parsedChatMinTicks >= 2
    ? Math.floor(parsedChatMinTicks)
    : 4;
```

Agents can chat every 4 ticks instead of 8. Conversations need faster flow to feel natural. Loop detection (`detectLowSignalChatLoop` + `shouldSuppressChatMessage`) still prevents spam.

### 8. Broaden @mention detection (lines 2639-2643)

**Old `hasNewDirectAsk`:**
```typescript
const hasNewDirectAsk = newMessages.some((m) => {
  // …
  return text.includes(lowerSelfName) && hasCoordinationAskSignal(text);
});
```

**New — any name mention triggers it, not just questions:**
```typescript
const hasNewDirectAsk = newMessages.some((m) => {
  const speaker = (m.agentName || '').toLowerCase();
  if (!speaker || speaker === lowerSelfName || speaker === 'system') return false;
  const text = (m.message || '').toLowerCase();
  return text.includes(lowerSelfName);
});
```

The coordination ask signal check was preventing agents from responding to mentions like "Mouse, that spire looks great" or "Oracle should connect east and south". Existing loop detection handles spam risk.

### 9. Broaden `coordinationContext` similarly (lines 2645-2651)

**Old:** requires `hasCoordinationAskSignal` for agent mentions.
**New:** trigger on any mention of this agent, OR when another agent completed a build (system messages about builds).

```typescript
const coordinationContext = newMessages.some((m) => {
  const speaker = (m.agentName || '').toLowerCase();
  const text = (m.message || '').toLowerCase();
  if (speaker === lowerSelfName) return false;
  if (speaker === 'system') return /directive|connect|road|bridge|completed|blueprint/.test(text);
  return text.includes(lowerSelfName);
});
```

---

## Files: Agent IDENTITY.md (4 files)

### 10. Soften chat restrictions in identity files

**`autonomous-agents/oracle/IDENTITY.md`** (line 29):
- Old: "Don't drift into social chatter."
- New: "Don't repeat yourself. Quality over quantity — but do share your strategic perspective when others build or propose things."

**`autonomous-agents/oracle/IDENTITY.md`** Speech Style (line 16):
- Old: "**High-signal only**: share coordinates, blockers, and connection goals."
- New: "**Strategic voice**: share your perspective on what the map needs. React to what others build."

**`autonomous-agents/clank/IDENTITY.md`** Speech Style (line 17):
- Old: "**Short**: one status line, then act."
- New: "**Short but real**: say what you think, not just what you're doing."

**`autonomous-agents/mouse/IDENTITY.md`** Boundaries (line 32):
- Old: "Don't chat more than you build. Let the structures speak."
- New: "Build more than you talk — but when you talk, make it count. Brag about your builds, react to what others are doing."

---

## NOT changing

- **`shouldSuppressChatMessage` function**: Keep it. It prevents actual spam (empty, exact duplicates, semantic duplicates, fast-cadence bursts). These are healthy guards.
- **`detectLowSignalChatLoop` function**: Keep it. Detects when 70%+ of recent messages are low-signal. Good safeguard.
- **`LOW_SIGNAL_ACK_PATTERN`**: Keep it. Blocks pure "roger"/"copy that" noise.
- **`AGENT_ACTION_CHAT_UPDATES` env var**: Keep off (user already disabled it). Action narrations pollute chat.
- **`formatActionUpdateChat` function**: Keep as-is (only fires when env var is true).
- **`isLowSignalCoordinationMessage`**: Keep — used by loop detector, not by the chat path.

---

## Verification

1. **TypeScript compile**: `cd autonomous-agents && npx tsc -p tsconfig.json --noEmit`
2. **Start agents**: Run the start command with `AGENT_ACTION_CHAT_UPDATES=false`
3. **Observe chat logs for 5-10 minutes**:
   - Agents should use personality from their IDENTITY.md
   - Messages should be >100 chars when agents have something to say
   - Agents should react to each other's builds ("Mouse, that spire looks great")
   - @mentions should trigger responses
   - No template messages like "Status: at (x,z), building toward a coherent node + edges layout"
   - No robotic narrations
4. **Spam check**: Agents should NOT chat every single tick. Chat every 4+ ticks with meaningful content, not loops.
