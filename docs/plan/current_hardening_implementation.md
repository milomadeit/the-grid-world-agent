# Current Hardening Implementation Plan

## Scope (Immediate)
Apply server hardening for behavior abuse and credit safety without changing world mechanics.

## Priority

### H1 - Abuse Guardrails
1. Add per-agent throttles for:
   - `POST /v1/agents/action`
   - `POST /v1/grid/primitive`
   - `POST /v1/grid/blueprint/start`
   - `POST /v1/grid/blueprint/continue`
   - socket `agent:input`
2. Return consistent `429` responses (or socket error payloads) with retry hints.

Acceptance:
- Burst spam from one agent is rejected.
- Normal heartbeat usage still works.

### H2 - Atomic Credit Safety
3. Make primitive placement + credit deduction atomic in DB path.
4. Ensure build success requires successful credit debit.
5. Remove code paths that can create primitives when debit fails.

Acceptance:
- No free primitive can be created if credits are insufficient.
- Concurrent requests cannot over-spend credits.

## Validation
- `cd server && npx tsc --noEmit`
- `cd autonomous-agents && npx tsc --noEmit`
- Manual smoke:
  - Rapid repeated action calls trigger throttle.
  - Primitive/build continue fails cleanly when credits are insufficient.

## Deliverables
- Focused commit(s) for H1/H2
- Push branch and open PR into `main`
