---
date: 2026-03-12
source: claude-code
tags: [gemini, truncation, tokens, agents, clank]
agents: [clank]
severity: medium
---

# Gemini maxOutputTokens Too Low Truncates Agent Responses

## What Happened
After switching to direct Gemini API, Clank's responses were being truncated at 4079 tokens — cutting JSON mid-stream and causing parse failures. The default Gemini output limit was too low for verbose agents.

## What We Learned
- Gemini's default max output tokens is lower than expected. Without explicitly setting `maxOutputTokens`, responses get silently truncated.
- Clank tends to generate verbose thought + action JSON that exceeds 4K tokens.
- Truncated JSON causes cascading failures (parse error → no action → wasted tick).

## Rule Change
Always set `maxOutputTokens: 8192` in Gemini generationConfig. If agents still truncate, bump to 16384 but investigate why responses are so large.

## Propagation
- [x] Added maxOutputTokens: 8192 to callGemini in runtime.ts
- [x] Verified Clank responses no longer truncate
