# Agent LLM Configuration History

## Available API Keys (.env)
| Key | Provider | Notes |
|-----|----------|-------|
| `GEMINI_API_KEY` | Google AI (GCP Project 1) | Mouse's key, free tier |
| `GEMINI_API_KEY_2` | Google AI (GCP Project 2) | Oracle's key, free tier |
| `GEMINI_API_KEY_3` | Google AI (GCP Project 3) | Clank's key, free tier |
| `MINI_MAX_API_KEY` | MiniMax (direct) | Smith's key, paid |
| `OPENCODE_API` | OpenRouter (paid) | Shared paid key, ~$10 credit |
| `OPENROUTER_API` | OpenRouter (general) | May be free tier |
| `ORACLE_OPENROUTER_KEY` | OpenRouter (per-agent) | Oracle-specific |
| `CLANK_OPENROUTER_KEY` | OpenRouter (per-agent) | Clank-specific |
| `MOUSE_OPENROUTER_KEY` | OpenRouter (per-agent) | Mouse-specific |
| `ANTHROPIC_API_KEY` | Anthropic | Unused currently |
| `GPT_API_KEY` | OpenAI | Unused currently |

## Gemini Free Tier Rate Limits
| Model | RPM | RPD | TPM |
|-------|-----|-----|-----|
| gemini-2.5-flash | 10 | 500 | 250K |
| gemini-2.5-flash-lite | 30 | 1500 | 1M |
| gemini-2.0-flash-lite | 30 | 1500 | 1M |

**Key lesson:** Separate GCP projects = independent quotas. Same project = shared pool regardless of key count.

---

## Configuration History (newest first)

### Config 7 — Direct Gemini API (2026-03-12) `1ba4c55`
| Agent | Provider | Model | Key | Cost |
|-------|----------|-------|-----|------|
| Smith | minimax | MiniMax-M2.5-highspeed | MINI_MAX_API_KEY | paid |
| Oracle | gemini | gemini-2.5-flash | GEMINI_API_KEY_2 | $0.30/$2.50 per 1M |
| Clank | gemini | gemini-2.5-flash-lite | GEMINI_API_KEY_3 | $0.10/$0.40 per 1M |
| Mouse | gemini | gemini-2.5-flash-lite | GEMINI_API_KEY | $0.10/$0.40 per 1M |

**Result:** Oracle passed SWAP_V2 (score 84) on first try. Massive improvement over StepFun. BUT all 3 Gemini agents hit daily RPD limits after ~hours of running. Smith (MiniMax) unaffected — passed SWAP_V2 (score 87).

### Config 6 — OpenRouter Mixed Free (2026-03-12) `5fff42d`
| Agent | Provider | Model | Key | Cost |
|-------|----------|-------|-----|------|
| Smith | minimax | MiniMax-M2.5-highspeed | MINI_MAX_API_KEY | paid |
| Oracle | openrouter | stepfun/step-3.5-flash:free | OPENCODE_API | free |
| Clank | openrouter | arcee-ai/trinity-large-preview:free | OPENCODE_API | free |
| Mouse | openrouter | arcee-ai/trinity-large-preview:free | OPENCODE_API | free |

**Result:** Oracle had constant JSON parse failures (StepFun model broken for structured output). Arcee Trinity was reliable for Clank/Mouse.

### Config 5 — OpenRouter Paid Key (2026-03-11) `6121a60`
| Agent | Provider | Model | Key | Cost |
|-------|----------|-------|-----|------|
| Smith | minimax | MiniMax-M2.5-highspeed | MINI_MAX_API_KEY | paid |
| Oracle | openrouter | google/gemini-2.5-flash | OPENCODE_API | paid |
| Clank | openrouter | z-ai/glm-4.5-air | OPENCODE_API | paid |
| Mouse | openrouter | google/gemini-2.5-flash-lite | OPENCODE_API | paid |

**Result:** Worked well. ~$2.42/day total. $10 OpenRouter credits lasting ~4 days. All agents functional.

### Config 4 — OpenRouter Per-Agent Free Keys (2026-03-11) `8364fd3`
| Agent | Provider | Model | Key | Cost |
|-------|----------|-------|-----|------|
| Smith | minimax | MiniMax-M2.5-highspeed | MINI_MAX_API_KEY | paid |
| Oracle | openrouter | meta-llama/llama-3.3-70b-instruct:free | ORACLE_OPENROUTER_KEY | free |
| Clank | openrouter | mistralai/mistral-small-3.1-24b-instruct:free | CLANK_OPENROUTER_KEY | free |
| Mouse | openrouter | z-ai/glm-4.5-air:free | MOUSE_OPENROUTER_KEY | free |

**Result:** Functional but lower quality. Per-agent keys avoided shared rate limits.

### Config 3 — OpenRouter Per-Agent Keys (2026-03-11) `baa6173`
| Agent | Provider | Model | Key | Cost |
|-------|----------|-------|-----|------|
| Smith | minimax | MiniMax-M2.5-highspeed | MINI_MAX_API_KEY | paid |
| Oracle | openrouter | nvidia/nemotron-3-super-120b-a12b:free | ORACLE_OPENROUTER_KEY | free |
| Clank | openrouter | nvidia/nemotron-3-super-120b-a12b:free | CLANK_OPENROUTER_KEY | free |
| Mouse | openrouter | z-ai/glm-4.5-air:free | MOUSE_OPENROUTER_KEY | free |

**Result:** First per-agent key setup. Nemotron worked okay.

### Config 2 — OpenRouter + OpenCode Diversified (2026-03-11) `1976333`
| Agent | Provider | Model | Key | Cost |
|-------|----------|-------|-----|------|
| Smith | openrouter | nvidia/llama-3.3-nemotron-super-49b-v1:free | OPENROUTER_KEY | free |
| Oracle | openrouter | nvidia/llama-3.3-nemotron-super-49b-v1:free | OPENROUTER_KEY | free |
| Clank | opencode | big-pickle | OPENCODE_API | free |
| Mouse | opencode | minimax-m2.5-free | OPENCODE_API | free |

**Result:** First diversification attempt.

### Config 1 — MiniMax + Gemini (2026-02-16) `b3db8c8`
| Agent | Provider | Model | Key | Cost |
|-------|----------|-------|-----|------|
| Smith | minimax | MiniMax-M2.5-highspeed | MINI_MAX_API_KEY | paid |
| Oracle | gemini | gemini-2.0-flash-lite | GEMINI_API_KEY | free |
| Clank | minimax | MiniMax-M2.5-highspeed | MINI_MAX_API_KEY | paid |
| Mouse | minimax | MiniMax-M2.5-highspeed | MINI_MAX_API_KEY | paid |

**Result:** Stable. Smith switched to MiniMax + Gemini vision bridge (still current).

### Config 0 — Anthropic Claude (2026-02-14) `3f26854`
| Agent | Provider | Model | Key | Cost |
|-------|----------|-------|-----|------|
| Smith | anthropic | claude-3-haiku-20240307 | ANTHROPIC_API_KEY | paid |
| Oracle | gemini | gemini-2.0-flash-lite | GEMINI_API_KEY | free |
| Clank | gemini | gemini-2.0-flash | GEMINI_API_KEY | free |

**Result:** Original config. High quality but expensive.

---

## Best Configs (Recommended)

### Budget — Free Tier Only
```
Smith  → minimax / MiniMax-M2.5-highspeed (MINI_MAX_API_KEY) — paid but cheap
Oracle → openrouter / arcee-ai/trinity-large-preview:free (OPENCODE_API) — reliable JSON
Clank  → openrouter / arcee-ai/trinity-large-preview:free (OPENCODE_API)
Mouse  → openrouter / arcee-ai/trinity-large-preview:free (OPENCODE_API)
```

### Quality — Paid OpenRouter (~$2.50/day)
```
Smith  → minimax / MiniMax-M2.5-highspeed (MINI_MAX_API_KEY)
Oracle → openrouter / google/gemini-2.5-flash (OPENCODE_API) — best cert performer
Clank  → openrouter / google/gemini-2.5-flash-lite (OPENCODE_API) — good balance
Mouse  → openrouter / google/gemini-2.5-flash-lite (OPENCODE_API)
```

### Maximum — Direct Gemini (separate GCP keys, watch daily limits)
```
Smith  → minimax / MiniMax-M2.5-highspeed (MINI_MAX_API_KEY)
Oracle → gemini / gemini-2.5-flash (GEMINI_API_KEY_2) — 500 RPD limit!
Clank  → gemini / gemini-2.5-flash-lite (GEMINI_API_KEY_3) — 1500 RPD
Mouse  → gemini / gemini-2.5-flash-lite (GEMINI_API_KEY) — 1500 RPD
```
**Warning:** gemini-2.5-flash free tier = 500 RPD. With 60s heartbeat = 1440 requests/day. Oracle WILL hit the limit after ~8 hours.
