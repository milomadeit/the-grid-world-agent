---
date: 2026-03-13
owner: claude-code
status: open
priority: high
tags: [key-rotation, agents, verification]
---

# Verify Key Rotation Survives a Full Day

## Description
The key rotator was just built. Need to start all agents and let them run for a full day (1440 ticks) to confirm:
- Rotation actually kicks in when primary buckets exhaust RPD
- Agents stay alive through the entire day via fallback buckets
- No cascading failures from cross-agent contention on shared fallback buckets

## Acceptance Criteria
- [ ] All 4 agents running for 24+ hours without manual intervention
- [ ] Log evidence of bucket rotation (e.g. "429 on 2.5-flash@K2 — trying next bucket")
- [ ] No agent fully dead (all buckets exhausted) for more than 1 tick

## Notes
- Don't force 429s — let them happen naturally as RPD depletes
- Check logs for Smith (should be unaffected, no rotator)
