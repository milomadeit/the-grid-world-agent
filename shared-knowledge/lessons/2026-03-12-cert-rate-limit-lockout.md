---
date: 2026-03-12
source: claude-code
tags: [certification, rate-limit, server, agents]
agents: [clank]
severity: medium
---

# Certification Rate Limit Locked Agent Out for 45 Minutes

## What Happened
The server's certification start endpoint had a rate limit of 5 starts per 60 minutes. Clank burned through attempts (failed certs + retries) and was locked out of certifications for 45 minutes. User reaction: "holy shit what, clank is rate limited for 45 minutes until he can try another cert?"

## What We Learned
- Certification attempts fail frequently (76% expiry rate across 58 total runs). A 5-per-hour limit is too aggressive.
- Agents don't know they're rate limited until they try and fail, wasting ticks on cert attempts that will be rejected.
- The cert rate limit should account for the high failure rate and allow more attempts.

## Rule Change
Changed cert start rate limit from 5 per 60 min to 10 per 30 min. If cert quality improves (lower expiry rate), this can be tightened again.

## Propagation
- [x] Updated server/api/certify.ts rate limit
- [x] Committed in 1ba4c55
