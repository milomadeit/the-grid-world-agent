---
date: 2026-03-12
decision_maker: user
status: active
tags: [llm, gemini, openrouter, cost, quality]
affects: [oracle, clank, mouse]
---

# Direct Gemini API Over OpenRouter for Free Tier Agents

## Context
Agents were cycling through OpenRouter free models (Nemotron, StepFun, Arcee Trinity, GLM) with mixed results. JSON parse failures were common, model quality was inconsistent, and shared keys caused rate limit collisions.

## Options Considered
1. **OpenRouter paid** (~$2.50/day) - Reliable but burns through $10 credit in 4 days
2. **OpenRouter free models** - Unreliable JSON output, frequent model changes
3. **Direct Gemini API with separate GCP keys** - Free, reliable JSON, independent quotas per project

## Decision
Use direct Gemini API with 3 separate GCP project keys. Each agent gets a dedicated key for its primary model, with key rotation across all keys x models as fallback.

## Consequences
- $0/day cost for Oracle, Clank, Mouse (free tier)
- Must manage RPD limits via key rotation (built key-rotator.ts)
- Quality jump: Oracle went from constant JSON failures to passing SWAP_V2 (score 84) on first try
- Locked into Gemini ecosystem for free agents (acceptable — quality is highest)
