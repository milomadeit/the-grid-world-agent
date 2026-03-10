# Base Batches Execution Plan

**Deadline: March 9, 2026 (Devfolio submission)**
**Program: Base Batches Startup Track 003**
**Product: OpGrid -- Onchain Agent Certification on Base**
**Pitch: Deterministic proof of capability for AI agents**

---

## Current State (March 6, 2026)

| Component | Status | Notes |
|-----------|--------|-------|
| Base Sepolia deployment | Done | Chain ID 84532, all services live |
| Certification system | Done | SWAP_EXECUTION_V1, 5D weighted scoring (0-100), deterministic verification |
| ERC-8004 integration | Done | Identity + Reputation registries, score published as feedback |
| MCP server | Done | 13 tools, x402 payment, E2E tested (3 agents, 100/100 scores) |
| MCP server docs | Done | README, SKILL.md, Claude Desktop config |
| Skill doc structure | Done | skill.md (entry point), skill-mcp.md, skill-api-reference.md, skill-x402.md, skill-troubleshooting.md |
| API surface | Done | 40+ endpoints, full documentation |
| 4 autonomous agents | Running | Actively certifying + building 24/7 |
| Light paper | Done (draft) | Competitive positioning, certification tiers, trust gap framing |
| README | Done | Certification-first positioning, architecture diagram, links |
| OG tags / meta | Done | "Onchain Agent Certification on Base" |
| Leaderboard | Done | bestScore, avgScore, pass rates |
| Frontend / spectator | Needs testing | Manual verification required |
| Demo video | Not started | Critical for submission |
| Devfolio application | Not started | Critical |
| Twitter / marketing | Not started | Important but not blocking |

---

## Day 1 (March 5) -- COMPLETE

### MCP Server E2E
- [x] Install deps, connect to deployed server
- [x] Full E2E: enter_world -> x402 cert start -> approve+swap -> submit -> scored
- [x] 3 agents tested (Oracle, Smith, Mouse), all scored 100/100
- [x] chain.py: QuoterV2 price quoting for proper amountOutMinimum
- [x] chain.py: nonce management fix (local tracking between approve + swap)
- [x] chain.py: gas price floor (1 gwei) for testnets only
- [x] session.py: x402 payment with EIP-3009 TransferWithAuthorization
- [x] session.py: auth signature format matching server expectation
- [x] Claude Desktop config in MCP README
- [x] MCP README written (setup, tools, quick start)

### Spectator / Frontend
- [x] OG tags updated (og:title, og:description, twitter:card)
- [x] Certification leaderboard shows bestScore/avgScore
- [x] Removed "SOC 2" from metadata/OG tags
- [x] Fixed 8004.org registration references -> skill.md

---

## Day 2 (Friday March 6) -- TODAY

### Documentation (COMPLETE)
- [x] Light paper drafted (docs/base-batches-light-paper.md)
- [x] Light paper revised: competitive landscape, trust bootstrapping problem, certification tiers (free + paid), vision
- [x] Skill docs restructured:
  - [x] public/skill.md -- clean entry point, recommends MCP, links deep references
  - [x] public/skill-mcp.md -- MCP server setup + certification workflow with tools
  - [x] public/skill-api-reference.md -- REST API reference for non-MCP agents
  - [x] public/skill-x402.md -- x402 payment signing (Python + TypeScript examples)
  - [x] public/skill-troubleshooting.md -- error handling (already existed)
  - [x] mcp-server/SKILL.md -- ships with MCP server package
- [x] server/index.ts updated to serve new docs, removed skill-runtime.md route
- [x] Frontend landing page updated (skill-runtime.md refs -> skill-api-reference.md)
- [x] README links updated

### Demo Recording (TODO -- manual)
- [ ] MCP demo (60-90s): Claude Desktop running a full certification
  - Show MCP config (5s)
  - Ask Claude to enter OpGrid and certify
  - Claude calls enter_world -> get_certifications -> start_certification -> execute_swap -> submit_proof
  - Show score breakdown (5 dimensions)
  - Show onchain tx on BaseScan
- [ ] World demo (30-60s): beta.opgrid.world spectator view
  - Show 3D world with agents
  - Show certification leaderboard
  - Show public attestation endpoint
- [ ] Edit into single 2-min video (QuickTime + iMovie or similar)

### Light Paper Final Review (TODO -- manual)
- [ ] Read through with fresh eyes
- [ ] Verify word count is within target
- [ ] Confirm no stale references

---

## Day 3 (Saturday March 7)

### Devfolio Application (TODO -- manual)
- [ ] Project name: OpGrid
- [ ] Tagline: "Onchain agent certification on Base. Deterministic proof of capability for AI agents."
- [ ] Description: Adapted from light paper
- [ ] Demo link: https://beta.opgrid.world
- [ ] Demo video: Upload recording
- [ ] GitHub: Link to repo
- [ ] Light paper: Upload docs/base-batches-light-paper.md
- [ ] Team info
- [ ] Review all fields before saving

### Twitter / Build in Public (TODO -- manual)
- [ ] Announcement thread:
  1. The problem: agent reputation is self-reported
  2. The solution: deterministic onchain certification
  3. How it works (score breakdown screenshot)
  4. Demo video clip (30s)
  5. "Any agent can certify via MCP or REST API"
  6. Link to beta.opgrid.world + docs
- [ ] MCP-specific post: "Your agent can earn verified onchain credentials"
- [ ] Demo video posted

---

## Day 4 (Sunday March 8) -- Buffer

### Final Review
- [ ] Test beta.opgrid.world is up and responsive
- [ ] Test opgrid.up.railway.app/skill.md loads correctly
- [ ] Test all new skill doc routes (/skill-mcp.md, /skill-api-reference.md, /skill-x402.md, /skill-troubleshooting.md)
- [ ] Verify demo video links work
- [ ] Re-read Devfolio application

### Submit
- [ ] Submit application on Devfolio (don't wait until March 9)
- [ ] Post-submission tweet

---

## Deliberate Cuts (NOT doing before submission)

| Cut | Why |
|-----|-----|
| Base Mainnet deployment | Sepolia is fine for pre-seed application |
| External agent onboarding via subgraph | Post-acceptance feature |
| Second certification template | One working template > two half-baked |
| Free certification templates (reachable, ownerVerified, etc.) | In light paper roadmap, not needed for submission |
| Agent economy / revenue generation | Demonstrate the model, don't need revenue yet |
| ERC-8004 subgraph registration | Post-acceptance |
| pip/npm package for MCP server | Post-acceptance distribution |
| Landing page redesign | Current 3D world works, just needs testing |
| Soulbound certification NFTs | In light paper vision, build post-acceptance |

---

## Key Links

- Devfolio: https://base-batches-startup-track-3.devfolio.co/overview
- Live app: https://beta.opgrid.world
- API: https://opgrid.up.railway.app
- Skill doc: https://opgrid.up.railway.app/skill.md
- MCP guide: https://opgrid.up.railway.app/skill-mcp.md
- API reference: https://opgrid.up.railway.app/skill-api-reference.md
- MCP Server: ./mcp-server/
- Light paper: ./docs/base-batches-light-paper.md
