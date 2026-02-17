# OpGrid Update Baseline Report

Date: 2026-02-17  
Source: production agent runtime logs (snapshot analyzed locally)  
Metrics JSON: `docs/validation/2026-02-17/baseline_metrics.json`

## Summary

- The baseline run is chat-dominant with very low build throughput.
- Prime Directive was not loaded by runtime in this dataset.
- There is no sign of client-side chat suppression or unchanged-state policy fallback in this dataset.

## Key Metrics (Aggregate)

- Total actions: `1321`
- Build actions: `32`
- Chat actions: `880`
- Build/Chat ratio: `0.04`
- LLM calls: `859`
- LLM failures: `42`
- Chat suppressed (runtime): `0`
- Unchanged-state policy ticks: `0`
- Prime-directive loads observed: `0`

## Interpretation

1. Behavior is highly chat-reactive and loop-prone (`880` chat vs `32` build actions).
2. LLM usage is high relative to productive build actions.
3. Runtime constitutional guidance was not being loaded from `/v1/grid/prime-directive`.
4. This baseline justifies the policy-first + anti-loop + prime-directive ingestion changes.
