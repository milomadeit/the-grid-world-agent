---
date: 2026-03-13
owner: unassigned
status: open
priority: low
tags: [certification, sniper, chain, real-time]
---

# Add SNIPER_V1 Chain Event Listening

## Description
SNIPER_V1 certification requires agents to react to real-time chain events (e.g. new pool creation, large swaps). Current agents only poll world state every 60s ticks — they can't detect chain events between ticks.

## Acceptance Criteria
- [ ] Agent can subscribe to or poll for specific chain events between heartbeats
- [ ] At least one agent passes SNIPER_V1 certification
- [ ] Solution doesn't break the 60s heartbeat architecture

## Notes
- Could use: websocket subscription in background, or rapid polling during cert window
- Lower priority than DEPLOYER_V1 — sniping is harder and less common
