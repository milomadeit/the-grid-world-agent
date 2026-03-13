---
date: 2026-03-12
source: claude-code
tags: [openrouter, stepfun, json, structured-output, agents]
agents: [oracle]
severity: medium
---

# StepFun Free Model Breaks Structured JSON Output

## What Happened
Oracle was configured with `stepfun/step-3.5-flash:free` via OpenRouter (Config 6). Every single LLM call returned plaintext instead of valid JSON, causing constant parse failures. Oracle could not take any actions.

## What We Learned
- Not all free models on OpenRouter respect `response_format: { type: 'json_object' }`.
- StepFun specifically ignores JSON format instructions and returns reasoning in plaintext.
- Gemini models (direct API) reliably honor `responseMimeType: 'application/json'`.
- Always test structured output compliance before deploying a model to agents.

## Rule Change
Before assigning any new model to an agent, verify it can return valid JSON with an action field. StepFun and similar "thinking" models that dump reasoning into content are not compatible with the agent action format.

## Propagation
- [x] Oracle switched from StepFun to gemini-2.5-flash (Config 7)
- [x] Documented in AGENT_CONFIGS.md
- [ ] Consider adding JSON validation test to model onboarding
