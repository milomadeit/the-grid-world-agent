# Current Cleanup Implementation Plan

## Goal
Address platform integrity and world-consistency issues in strict priority order, validate with local builds, and ship in staged commits.

## Priority Order

### P0 - Security and Identity Integrity (must ship first)
1. Enforce authenticated socket identity binding:
   - Require valid JWT on privileged socket events.
   - Derive acting agent identity from token, not client-supplied `agentId`.
   - Reject mismatched or missing identities.
2. Remove/lock insecure socket bypass registration path:
   - Disable direct `agent:register` path that skips signed entry + ERC-8004 + fee flow.
   - Route all joins through `/v1/agents/enter`.
3. Remove insecure default secrets:
   - Fail fast if `JWT_SECRET` is missing in production.
   - Remove fallback default admin key; require explicit `ADMIN_KEY`.

Acceptance criteria:
- Socket client cannot move/chat as another agent.
- No unauthorized path exists to create session agents.
- App refuses to run with production-grade auth/admin secrets missing.

### P1 - Core Runtime and Economy Correctness
4. Fix agent runtime tick concurrency:
   - Add re-entry guard so next heartbeat does not overlap while previous tick is still running.
5. Fix LLM skip gate:
   - Exclude ever-changing tick counter from world-change hash.
   - Skip only when meaningful state is unchanged.
6. Prevent destructive credit resets on DB init:
   - Remove unconditional "reset all agents to 500 credits" startup migration.
7. Clean up stale blueprint reservations:
   - When stale agents are removed, clear active build plans/reservations.
8. Tighten blueprint continue validation:
   - Reject invalid/floating/overlapping blueprint pieces instead of blindly creating them.

Acceptance criteria:
- Heartbeat logs show no overlapping tick executions per agent.
- LLM calls decrease when world state is stable.
- Credits persist across restarts.
- No stranded reservation blocks new builds after owner timeout.

### P2 - Documentation and Instruction Fidelity
9. Align prime directives + skill docs with enforced behavior:
   - Remove inaccurate claims (plots/spheres, non-authoritative node claims if runtime-only).
   - Clearly distinguish server-enforced rules vs runtime guidance.
10. Reduce config/reference drift:
   - Normalize env var names across `.env.example`, tools docs, runtime docs.
   - Correct provider/model notes where mismatched.

Acceptance criteria:
- Public docs match implemented endpoint contracts and auth/build rules.
- Agent operator docs use accurate env names and defaults.

### P3 - Deeper World-Quality Improvements (follow-up)
11. Introduce server-authoritative node graph primitives and metropolis lifecycle.
12. Add additional blueprint families for transit/civic/economy/utility district growth.
13. Add tests for settlement growth and directive-driven urban outcomes.

Acceptance criteria:
- Node tiers and connectivity are computed server-side and available via API.
- Agents can query "what to build next" from objective world metrics.

## Execution Sequence
1. Create branch from `main`.
2. Implement P0 and run local builds/type checks.
3. Commit + push P0.
4. Implement P1 and run local builds/type checks.
5. Commit + push P1.
6. Implement P2 and run local builds/type checks.
7. Commit + push P2.
8. Open follow-up issue list for P3 (or implement in separate scoped branch).

## Local Validation Matrix (every stage)
- Root frontend build: `npm run build`
- Server type check: `cd server && npx tsc --noEmit`
- Autonomous agents type check: `cd autonomous-agents && npx tsc --noEmit`
- Sanity smoke:
  - Enter world flow still works.
  - Socket spectator mode still receives snapshots.
  - Authenticated socket actions work only for owned identity.

## Commit Strategy
- Commit 1: `fix(security): enforce socket auth identity and disable bypass registration`
- Commit 2: `fix(runtime): prevent tick overlap and stabilize LLM change gating`
- Commit 3: `fix(world): preserve credits and clear stale blueprint reservations`
- Commit 4: `docs: align prime directive, skill docs, and env references`

## Risks and Mitigations
- Risk: breaking spectator socket flow.
  - Mitigation: keep read-only snapshot path unauthenticated; gate only mutating events.
- Risk: tighter auth causing previously permissive clients to fail.
  - Mitigation: explicit socket error messages and docs update.
- Risk: changed runtime cadence affecting behavior.
  - Mitigation: add conservative re-entry guard without altering heartbeat interval semantics.
