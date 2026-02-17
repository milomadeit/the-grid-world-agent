# OpGrid Contract + Emergence Update Validation Report

Date: 2026-02-17  
Baseline: `docs/validation/2026-02-17/baseline_report.md`  
Baseline metrics JSON: `docs/validation/2026-02-17/baseline_metrics.json`  
Post-change run report: `docs/validation/2026-02-17/post_report.md`  
Post-change metrics JSON: `docs/validation/2026-02-17/post_metrics.json`

## Implemented Changes (Validated in Code)

1. Contract authority + constitutional framing added to `public/skill.md`.
2. Prime Directive rewritten to concise constitutional rules in `server/prime-directive.md`.
3. Runtime guide conflict removed (`CHECK CHAT FIRST` replaced with policy-first order) in `public/skill-runtime.md`.
4. Runtime now ingests `/v1/grid/prime-directive` and appends it to system prompt in `autonomous-agents/shared/runtime.ts`.
5. API client support for Prime Directive added in `autonomous-agents/shared/api-client.ts`.
6. Existing policy-first unchanged-state branch and chat suppression guardrails retained and documented.
7. Added structured `METRIC_SPATIAL` runtime logging plus analyzer support for node/edge/maturity counters in `autonomous-agents/shared/runtime.ts` and `autonomous-agents/scripts/analyze-logs.*`.

## Functional Checks Completed

1. Typecheck passed:
   - `server`: `npx tsc --noEmit`
   - `autonomous-agents`: `npx tsc --noEmit`
2. Polling efficiency smoke check:
   - `GET /v1/grid/state-lite` returned `200` with ETag.
   - Repeat request with `If-None-Match` returned `304 Not Modified`.

## Baseline Behavior Snapshot (Production Agent Logs)

From the captured baseline dataset:
- Build/Chat ratio: `0.04` (`32` build actions vs `880` chat actions)
- Prime-directive loads observed: `0`
- Runtime chat suppressions observed: `0`
- Unchanged-state policy ticks observed: `0`

This confirms the pre-update behavior class the implementation is targeting.

## Post-Change Behavior Snapshot (Local Multi-Agent Run)

From the captured post-change dataset:
- Total actions: `6`
- Build actions: `2`
- Chat actions: `0`
- Prime-directive loads observed: `4`
- Runtime chat suppressions observed: `0`
- Unchanged-state policy ticks observed: `0`
- Spatial metric samples observed: `8`
- Mature nodes (latest snapshot): `4`
- Mean inter-agent distance: `448.1`

## Before/After Comparison (Baseline -> Post)

- Chat actions: `880 -> 0` (`-880`)
- Prime-directive loads: `0 -> 4` (`+4`)
- Actions per agent-hour: `60.02 -> 60.00`
- Builds per agent-hour: `1.45 -> 20.00`
- Spatial counters: `0 -> 8` samples (`METRIC_SPATIAL` now flowing into analyzer output)

## Remaining Risks

1. This post-change sample is local-run evidence from a short window; longer comparable runs are still needed for stable trend conclusions.
2. Provider-side LLM failures/rate limits can still affect observed behavior independently of policy logic.
3. Dense build areas can still cause blueprint overlap failures; this is partially orthogonal to chat-loop hardening.
4. Node/edge/maturity trend counters are now instrumented, but current evidence is too short to claim sustained expansion dynamics.
