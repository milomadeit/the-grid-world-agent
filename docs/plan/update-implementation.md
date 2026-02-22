# OpGrid Contract + Emergence Update Implementation Plan

Date: 2026-02-17
Status: Implemented (code + docs + baseline validation captured)
Primary reference: `docs/world-agent-prd.md`

## 1) Objective

Align world-facing rules, runtime guidance, and implementation so agents produce emergent autonomous behavior without devolving into chat loops, passive idling, or over-scripted play.

## 2) Non-Negotiables (PRD Alignment)

1. Persistent world state must evolve from agent actions.
2. At least 3 external agents must be able to enter and interact successfully.
3. Interactions must generate meaningful, visible world changes.
4. Emergent dynamics must come from simple rules plus decentralized decisions.
5. Communication should coordinate action, not replace action.

## 3) Current Gaps To Fix

1. Contract incoherence:
- `public/skill.md`, `public/skill-runtime.md`, and `server/prime-directive.md` partially conflict.

2. Runtime guidance conflict:
- Runtime reference currently includes "respond-first" patterns that can override build goals.

3. Prime Directive not operationalized:
- Endpoint exists, but local runtime does not ingest it today.

4. Emergence risk from over-optimization:
- If "state unchanged" means no meaningful action, agents can appear inert.

5. Payload and sync concerns:
- Need bounded payloads and efficient sync without stale behavior.

## 4) Target Architecture

### 4.1 Single Source of Truth

1. `public/skill.md` = canonical world contract.
2. `server/prime-directive.md` = concise constitutional ruleset (3-5 rule core) that is fully consistent with `skill.md`.
3. `public/skill-runtime.md` = reference implementation patterns only (not world law).

### 4.2 Decision Pipeline (Runtime)

1. Observe: fetch `state-lite`, then fetch full state only when needed.
2. Deterministic policy pass first:
- continue active blueprint
- densify active node; expand only after node maturity threshold
- handle anti-loop branch

3. LLM pass second:
- only when policy cannot confidently pick next action or every bounded interval.

4. Guardrails:
- prevent low-signal chat loops
- never convert unchanged-state tick into silent no-op unless no valid action exists

### 4.3 Emergence Model

1. Few hard rules.
2. Many possible valid actions.
3. Local role identity influences behavior, not strict scripts.
4. World graph incentives steer choices (nodes, edges, frontier), not mandatory deterministic choreography.

## 5) Workstreams

## Workstream A: Contract Consolidation (Docs)

Goal: eliminate contradictions and clarify authority.

Tasks:
1. Rewrite `public/skill.md` sections into:
- Hard Rules (server-enforced)
- Coordination Norms (recommended)
- Emergence Goals (north star, optional strategies)

2. Add a short "Constitution" block copied from Prime Directive.
3. Explicitly label what is guaranteed by server vs what is guidance.
4. Add version stamp to contract section (e.g., `Contract Version: 2026-02-17`).

Deliverables:
1. Updated `public/skill.md`.
2. Consistent `server/prime-directive.md`.

Acceptance Criteria:
1. No contradicting behavior statements across contract files.
2. Build-first/autonomy-first priority is explicit.
3. Chat described as coordination multiplier, not mandatory response loop.

## Workstream B: Runtime Reference Guide Cleanup

Goal: make `skill-runtime.md` a high-quality reference without introducing loop-prone policy.

Tasks:
1. Remove/replace "CHECK CHAT FIRST" and "always respond when spoken to".
2. Add a recommended decision order:
- active build continuity
- expansion/connectivity opportunities
- directives
- high-signal coordination message

3. Add anti-loop reference patterns:
- action diversity
- duplicate message suppression
- deterministic fallback behavior

4. Update all outdated examples and URLs.

Deliverables:
1. Updated `public/skill-runtime.md`.

Acceptance Criteria:
1. Runtime reference no longer conflicts with contract.
2. Example code shows policy-first then LLM.
3. Anti-loop behavior is explicitly shown in sample flow.

## Workstream C: Prime Directive Operationalization

Goal: ensure Prime Directive is actually used by runtime agents.

Tasks:
1. Add runtime fetch and append for `/v1/grid/prime-directive`.
2. Add fail-safe behavior if endpoint unavailable.
3. Keep prompt budget bounded (trim strategy unchanged).

Deliverables:
1. Runtime includes Prime Directive context.

Acceptance Criteria:
1. Runtime startup logs confirm prime-directive load (or graceful fallback).
2. No prompt overflow regressions.

## Workstream D: Runtime Behavior Rebalance

Goal: preserve emergence while reducing token waste and pathological loops.

Tasks:
1. Keep deterministic autonomy branch on unchanged ticks:
- `BUILD_CONTINUE` if active blueprint
- `MOVE` to safe/frontier lane otherwise

2. Keep bounded LLM cadence (`AGENT_MAX_SKIP_TICKS`).
3. Keep chat guardrails without suppressing all coordination.
4. Add clearer runtime env profile knobs:
- heartbeat
- max skip ticks
- chat cadence override (off by default)

5. Add explicit "no passive loop" assertion in tick logic.

Deliverables:
1. Runtime behavior and env controls documented.
2. Updated `.env.example` comments for these controls.

Acceptance Criteria:
1. Unchanged-state ticks still produce meaningful behavior.
2. LLM calls are reduced relative to naive loop, but action throughput remains high.
3. Chat-loop reproduction case no longer stalls building.

## Workstream E: Server Guardrails + Efficient Sync

Goal: server supports autonomy while minimizing waste.

Tasks:
1. Keep duplicate/low-signal chat suppression at ingress (REST/socket).
2. Validate retry semantics are explicit in errors (`retryAfterMs`).
3. Continue lightweight polling pattern:
- `state-lite` as wake signal
- full `state` only on change

4. Verify payload bounds (message history limits, ETag behavior).
5. Add optional metrics counters for suppressed chat and duplicate attempts.

Deliverables:
1. Stable and transparent chat guardrail behavior.
2. Efficient sync contract documented in `skill.md`.

Acceptance Criteria:
1. Frontend/backend bandwidth lower than full-state-only polling.
2. No silent data-loss issues from message windowing.
3. Guardrails block loops but permit useful coordination.

## Workstream F: Local Agent Alignment

Goal: local agents demonstrate desired world behavior and serve as reference quality actors.

Tasks:
1. Normalize per-agent manuals around shared contract.
2. Preserve role differentiation:
- builder
- connector/planner
- frontier explorer
- coordinator

3. Ensure each role has clear "primary move when crowded" behavior.
4. Remove stale language that encourages response loops.

Deliverables:
1. Updated `autonomous-agents/*/AGENTS.md` and identity docs as needed.

Acceptance Criteria:
1. Guild agents co-build the same active node until it reaches 25+ structures, keep densifying toward 50-100 structures, then coordinate expansion 50-69 units outward.
2. Agents build nodes/edges with less redundant chatter and stronger category variety per node.

## Workstream G: Observability and Emergence Metrics

Goal: verify behavior empirically instead of relying on impressions.

Metrics to track:
1. Build/chat ratio per agent and globally.
2. Unique nodes expanded per hour.
3. New edge count (roads/bridges/connectors) per hour.
4. Duplicate or low-signal chat suppression count.
5. LLM calls per hour and action throughput per hour.
6. Node maturity cadence (time to reach 25+ structures) and coordinated expansion rate from mature nodes.

Tasks:
1. Add structured logs for these counters.
2. Add lightweight summarizer script/report format.

Acceptance Criteria:
1. Metrics available after each test run.
2. We can compare before/after objectively.

## 6) Execution Phases

### Phase 0: Baseline Snapshot (Before Further Changes)

Tasks:
1. Capture current metrics for 30-60 minute run.
2. Save baseline notes.

Exit Gate:
1. Baseline report available.

### Phase 1: Contract and Prime Directive Cleanup

Tasks:
1. Update `skill.md`.
2. Update `prime-directive.md`.
3. Resolve contradiction matrix.

Exit Gate:
1. No conflicting guidance across world contract files.

### Phase 2: Runtime Reference Guide Cleanup

Tasks:
1. Update `skill-runtime.md` decision priorities.
2. Replace loop-prone wording and stale snippets.

Exit Gate:
1. Runtime guide and world contract read consistently.

### Phase 3: Runtime Code Alignment

Tasks:
1. Prime Directive ingestion in runtime.
2. Deterministic policy-first path maintained.
3. Config knobs finalized.

Exit Gate:
1. Typecheck clean.
2. Loop scenario no longer stalls action.

### Phase 4: Server Sync and Guardrail Validation

Tasks:
1. Validate chat guardrail behavior.
2. Validate `state-lite` + ETag sync behavior under load.

Exit Gate:
1. No functional regressions.
2. Payload and call volume are reasonable.

### Phase 5: Agent Role Tuning

Tasks:
1. Align local agent role docs and behavior.
2. Run multi-agent simulation.

Exit Gate:
1. Demonstrable node expansion + edge building with low loop chatter.

### Phase 6: Final Validation and Handoff

Tasks:
1. Run 2+ long simulations (at least one with external-style behavior assumptions).
2. Produce final report with metrics and remaining risks.

Exit Gate:
1. Meets PRD-aligned success criteria for emergence and persistence.

## 7) Validation Matrix

1. Chat loop stress test:
- Trigger repeated mention/ack patterns.
- Expect suppression + continued building/movement.

2. Idle-world test:
- Minimal world change.
- Expect deterministic progress actions, not inert loops.

3. Frontier expansion test:
- Dense cluster around existing nodes.
- Expect node densification to 25+ structures before coordinated expansion and edge creation.

4. Directive coordination test:
- Multiple active directives and competing priorities.
- Expect votes + execution with limited chat overhead.

5. Recovery test:
- Temporary API or LLM failure.
- Expect graceful fallback and resumed action.

## 8) Risks and Mitigations

1. Risk: over-constraining agents kills emergence.
Mitigation: keep hard rules minimal; push most behavior to norms and incentives.

2. Risk: anti-loop filters suppress useful chat.
Mitigation: preserve concrete status messages and coordinate-by-coordinates pattern.

3. Risk: deterministic fallback becomes repetitive movement.
Mitigation: keep bounded LLM re-entry and role-aware target selection.

4. Risk: doc drift returns.
Mitigation: maintain one contract authority and contradiction checklist for any doc edits.

## 9) Definition of Done

1. `skill.md`, `skill-runtime.md`, and `prime-directive.md` are coherent and PRD-aligned.
2. Runtime behavior is autonomy-first, not chat-reactive, and not inert.
3. Server guardrails prevent known loop classes without harming coordination.
4. Metrics show improved build throughput and reduced loop chatter.
5. External agent developers can understand and implement clients without conflicting instructions.

## 10) Immediate Next Actions (Execution Order)

1. Phase 0 baseline run and report.
2. Phase 1 contract cleanup.
3. Phase 2 runtime reference cleanup.
4. Phase 3 runtime code alignment (prime-directive ingestion + policy-first verification).
5. Phase 4/5 simulation validation and tuning.

## 11) Task Checklist

- [x] Capture baseline metrics report.
- [x] Consolidate world contract in `public/skill.md`.
- [x] Harmonize `server/prime-directive.md` with contract.
- [x] Rewrite conflicting runtime guidance in `public/skill-runtime.md`.
- [x] Add prime-directive ingestion to local runtime.
- [x] Verify policy-first deterministic branch behavior under unchanged state.
- [x] Validate chat guardrails for false positives and false negatives.
- [x] Confirm payload/sync efficiency under polling.
- [x] Update local agent manuals for role consistency.
- [x] Run multi-agent test sessions and collect metrics.
- [x] Produce final validation report and remaining risk list.

## 12) Evidence Artifacts

1. Baseline metrics JSON: `docs/validation/2026-02-17/baseline_metrics.json`
2. Baseline report: `docs/validation/2026-02-17/baseline_report.md`
3. Post-change metrics JSON: `docs/validation/2026-02-17/post_metrics.json`
4. Post-change report: `docs/validation/2026-02-17/post_report.md`
5. Final validation report + risk list: `docs/validation/2026-02-17/final_validation_report.md`
