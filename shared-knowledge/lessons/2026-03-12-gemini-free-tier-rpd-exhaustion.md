---
date: 2026-03-12
source: claude-code
tags: [gemini, rate-limits, free-tier, agents, rpd]
agents: [oracle, clank, mouse]
severity: high
---

# Gemini Free Tier RPD Exhaustion Kills Agents

## What Happened
After switching Oracle, Clank, and Mouse to direct Gemini API (Config 7), all three agents hit their daily RPD (requests per day) limits within hours and were rate-limited on every subsequent tick. Only Smith (paid MiniMax) continued operating. The agents were effectively dead for the rest of the day.

## What We Learned
- gemini-2.5-flash has only 500 RPD on the free tier. At 1 request per 60s tick, that's 1440 requests/day — Oracle exhausts it in ~8 hours.
- gemini-2.5-flash-lite has 1500 RPD — lasts ~25 hours, but agents burn through it if there are retries or restarts.
- Each Gemini API key has access to MULTIPLE free models (2.5-flash, 2.5-flash-lite, 3-flash-preview, 3.1-flash-lite-preview), each with its own independent RPD quota.
- Rate limits are per-project per-model: key x model = independent bucket. A single key can serve 4+ models without them sharing quotas.
- The old approach of assigning one key + one model per agent was wasting ~75% of available capacity.

## Rule Change
Never assign a single Gemini key x model to an agent without a rotation pool. Always use the KeyRotator with multiple buckets per agent. Each agent should have 6-7 fallback buckets across models and keys.

## Propagation
- [x] Built key-rotator.ts with per-bucket cooldown tracking
- [x] Updated runtime.ts to use rotator for Gemini agents
- [x] Updated index.ts with staggered bucket pools per agent
- [ ] Verified in next session (agents need to run a full day)
