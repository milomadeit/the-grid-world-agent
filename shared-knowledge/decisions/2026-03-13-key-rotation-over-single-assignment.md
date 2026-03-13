---
date: 2026-03-13
decision_maker: user
status: active
tags: [llm, rate-limits, key-rotation, architecture]
affects: [oracle, clank, mouse]
---

# Key x Model Rotation Pools Over Single Key Assignment

## Context
With single key + model per agent, all 3 Gemini agents exhausted their RPD and went dead. User pointed out that each key has access to multiple free models with independent RPD quotas — we were wasting ~75% of available capacity.

## Options Considered
1. **Increase heartbeat interval** (120s+) - Halves RPD usage but halves agent responsiveness
2. **Pay for higher tier** - Solves limits but adds cost
3. **Key rotation with model fallback** - Pool all key x model combos, rotate on 429

## Decision
Build a KeyRotator that gives each agent 6-7 fallback buckets (key x model pairs). On 429, immediately try the next bucket — no sleeping between retries. Each agent's pool is staggered so primaries don't overlap.

## Consequences
- ~10,500 RPD total capacity vs 5,760 needed = 1.8x headroom
- Agents degrade gracefully: quality models first, then lite, then OpenRouter as last resort
- No agent should ever be fully dead unless ALL 11 buckets are exhausted in one day
- Added ~190 lines of code (key-rotator.ts + wiring)
