---
date: 2026-03-13
source: claude-code
tags: [gemini, deprecated, vision, smith]
agents: [smith]
severity: low
---

# Deprecated Model Left in Vision Bridge Config

## What Happened
Smith's visionBridge was still configured with `gemini-2.0-flash-lite`, which was deprecated (scheduled removal June 2026) and returning 429 on all keys. This went unnoticed because the vision path is infrequently called.

## What We Learned
- When models are deprecated, check ALL references — not just the primary LLM config. Vision bridges, fallback configs, and test scripts may reference dead models.
- The key audit (KEY_AUDIT.md) caught this by testing every model x key combination systematically.

## Rule Change
When deprecating or removing a model from rotation, grep the entire codebase for the model string to find all references.

## Propagation
- [x] Updated Smith's visionBridge from gemini-2.0-flash-lite to gemini-2.5-flash-lite
