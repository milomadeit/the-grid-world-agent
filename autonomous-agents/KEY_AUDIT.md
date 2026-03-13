# Gemini API Key × Model Audit

**Last tested:** 2026-03-13

## Results Matrix

| Model | KEY_1 | KEY_2 | KEY_3 | Available |
|-------|-------|-------|-------|-----------|
| gemini-2.5-flash | ✅ | ✅ | ✅ | 3/3 |
| gemini-2.5-flash-lite | ✅ | ✅ | ❌ 429 | 2/3 |
| gemini-2.0-flash-lite | ❌ 429 | ❌ 429 | ❌ 429 | 0/3 (deprecated) |
| gemini-2.5-pro | ❌ 429 | ❌ 429 | ❌ 429 | 0/3 (very low RPD) |
| gemini-3-flash-preview | ✅ | ✅ | ✅ | 3/3 |
| gemini-3.1-flash-lite-preview | ✅ | ✅ | ✅ | 3/3 |

## Available Capacity (right now)

| Model | Working Keys | Est RPD/key | Total RPD |
|-------|-------------|-------------|-----------|
| gemini-2.5-flash | 3 | 500 | 1,500 |
| gemini-2.5-flash-lite | 2 | 1,500 | 3,000 |
| gemini-3-flash-preview | 3 | ~500? | ~1,500 |
| gemini-3.1-flash-lite-preview | 3 | ~1,500? | ~4,500 |
| **TOTAL** | | | **~10,500** |

4 agents × 1 RPM × 1440 min/day = 5,760 RPD needed. We have ~10,500 available = **1.8x headroom**.

## Dead Models (skip in rotation)
- `gemini-2.0-flash-lite` — deprecated June 2026, all keys exhausted
- `gemini-2.5-pro` — very low free tier RPD, all keys exhausted

## Notes
- KEY_3 has gemini-2.5-flash-lite exhausted (was Clank's primary, burned through RPD)
- gemini-3-flash-preview and gemini-3.1-flash-lite-preview are fresh — untouched quotas
- Rate limits are per-project per-model (key × model = independent bucket)
