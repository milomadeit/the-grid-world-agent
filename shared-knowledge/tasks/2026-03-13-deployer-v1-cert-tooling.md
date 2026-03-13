---
date: 2026-03-13
owner: unassigned
status: open
priority: medium
tags: [certification, deployer, tooling, agents]
---

# Add DEPLOYER_V1 Certification Tooling

## Description
DEPLOYER_V1 certification has ZERO passes across all agents (58 total cert runs, 13 passes — all SWAP). Agents cannot generate ERC-20 bytecode with current tool set. They need either a pre-compiled bytecode template or an ENCODE_DEPLOY action.

## Acceptance Criteria
- [ ] Agents can deploy a basic ERC-20 contract without manual bytecode construction
- [ ] At least one agent passes DEPLOYER_V1 certification
- [ ] Either: add ENCODE_DEPLOY action to agent tools, or provide pre-compiled bytecode in cert hints

## Notes
- Current cert scorecard: 13/58 passes, all SWAP_V1 or SWAP_V2
- SNIPER_V1 also has zero passes (separate task — needs real-time chain event listening)
