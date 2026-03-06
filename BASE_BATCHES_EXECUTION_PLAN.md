# Base Batches 4-Day Execution Plan

**Deadline: March 9, 2026 (Devfolio submission)**
**Program: Base Batches Startup Track 003**
**Product: OpGrid — Onchain Agent Certification on Base**
**Pitch: "SOC 2 for AI agents"**

---

## Current State (March 5, 2026)

| Component | Status | Notes |
|-----------|--------|-------|
| Base Sepolia deployment | Done | Chain ID 84532, all services live |
| Certification system | Working | SWAP_EXECUTION_V1, 5D scoring, onchain rep |
| ERC-8004 integration | Working | Identity + Reputation registries on Base Sepolia |
| MCP server | Built (13 tools) | Python, stdio, needs testing + polish |
| API surface | Mature | 40+ endpoints, skill.md docs |
| 4 autonomous agents | Running | Actively certifying + building |
| Frontend / spectator | Weak | Blobs moving, no narrative framing |
| External agents | None | No subgraph registration, no inbound agents |
| Revenue / economy | Minimal | Cert fees collected in USDC but no external volume |

---

## Day 1 (March 5): MCP Server Polish + Spectator Fix

### Morning: MCP Server -> Demo-Ready

The MCP server already exists with 13 tools. The work is making it installable and demo-able.

**1a. Test the MCP server end-to-end (~2 hours)**
- Install deps, connect to deployed server
- Run through: `enter_world` -> `get_certifications` -> `start_certification` -> `execute_swap` -> `submit_proof`
- Fix any broken flows (USDC/swap addresses may need updating to match what Clank discovered)
- Verify `check_wallet`, `get_credits`, `move`, `chat` all work

**1b. Claude Desktop integration config (~30 min)**
- Create a `claude_desktop_config.json` example in the MCP server README
- Test that Claude Desktop can load the server and an agent can run a cert interactively through Claude

**1c. MCP Server README (~1 hour)**
- What it is: "Connect any MCP-compatible agent to OpGrid in 60 seconds"
- Prerequisites (Python 3.10+, a Base Sepolia wallet with USDC)
- Installation: `pip install -r requirements.txt`
- Claude Desktop config snippet
- Environment variables needed
- Quick start: "Your agent's first certification in 5 commands"

### Afternoon: Fix the Spectator Experience

**1d. Reframe the frontend narrative (~2-3 hours)**

The spectator experience needs to answer: "What am I looking at and why should I care?" Right now it's blobs moving around with a chat feed.

Changes to `SpectatorHUD.tsx` and/or `Overlay.tsx`:
- **Hero text**: Replace generic welcome banner with "Agent Certification Platform on Base -- Watch agents earn verified onchain reputation"
- **Certification Leaderboard**: Make `CertificationPanel` prominent in spectator mode (not just player mode). Show agent names, scores, pass rates. This IS the product.
- **Live activity callouts**: When a cert completes, surface it prominently: "Agent Clank scored 87/100 on SWAP_EXECUTION_V1"
- **Entry CTA**: "Certify your agent -> Connect via MCP or API"

**1e. Landing page meta/OG tags (~30 min)**
- Update page title, description, OG image for link sharing
- "OpGrid -- Onchain Agent Certification on Base"

---

## Day 2 (March 6): Demo Recording + Light Paper Draft

### Morning: Record the Demo (~3 hours)

Two demo angles, both critical:

**2a. MCP Demo (the "whoa" moment)**
Screen recording of Claude Desktop with OpGrid MCP server:
1. Show the MCP config (5 seconds)
2. Ask Claude: "Enter OpGrid and start a certification"
3. Claude calls `enter_world`, `get_certifications`, `start_certification`
4. Claude reads the work order, calls `execute_swap`
5. Claude calls `submit_proof`
6. Show the score breakdown (5 dimensions, 0-100)
7. Show the onchain reputation tx on BaseScan
8. ~60-90 seconds total

This is the money shot. An agent certifying itself through natural language via MCP, with cryptographic proof landing onchain.

**2b. World Demo (the spectacle)**
Screen recording of beta.opgrid.world:
1. Show the 3D world with agents moving
2. Show the certification leaderboard
3. Show an agent profile with reputation score
4. Show the public attestation endpoint (`/v1/certify/runs/:id/attestation`)
5. ~30-60 seconds

**2c. Edit into a single 2-minute video**
- Use QuickTime + iMovie or similar
- Title cards: "The Problem" -> "The Solution" -> "How It Works" -> "Try It"
- Post to Twitter/X with the pitch

### Afternoon: Light Paper Draft (~3 hours)

**2d. Write the 500-word light paper**

Structure:
```
1. Problem (100 words)
   - AI agents claim capabilities. No way to verify.
   - Hiring an agent is a trust problem.
   - No standardized, cryptographic proof of competence.

2. Solution: OpGrid (150 words)
   - Onchain certification platform for AI agents on Base
   - Agents complete objective challenges (swaps, multi-agent coord, etc.)
   - Deterministic verification -- no LLM judging, pure onchain data
   - 0-100 weighted scoring across multiple dimensions
   - Results published as ERC-8004 reputation feedback
   - Cryptographically signed attestations
   - "SOC 2 compliance, but for agents"

3. How It Works (100 words)
   - Agent connects via MCP server or REST API
   - Pays certification fee in USDC (x402 protocol)
   - Receives work order with constraints
   - Executes challenge onchain (e.g., token swap on Uniswap)
   - Server verifies tx deterministically
   - Score + attestation published to Base via ERC-8004

4. Traction / Current State (75 words)
   - Live on Base Sepolia
   - 4 autonomous agents running 24/7
   - SWAP_EXECUTION_V1 certification active
   - MCP server for Claude/MCP-compatible agents
   - 40+ API endpoints, full skill documentation
   - ERC-8004 identity + reputation integrated

5. Vision / Why Base (75 words)
   - Multiple certification categories (swap, coordination, governance)
   - Cross-platform reputation portable via ERC-8004
   - x402 native payments
   - Subgraph integration for agent discovery
   - Base = where agent infrastructure lives
   - Revenue model: certification fees (USDC)
```

**2e. Get feedback on draft, iterate**

---

## Day 3 (March 7): Application + Build in Public

### Morning: Fill Out Devfolio Application (~2 hours)

**3a. Complete the application form**
- Project name: OpGrid
- Tagline: "Onchain agent certification on Base -- SOC 2 for AI agents"
- Description: Adapted from light paper
- Demo link: beta.opgrid.world
- Demo video: Upload the recording from Day 2
- GitHub: Link to repo (make sure README is updated)
- Team info
- Light paper: Upload

**3b. Update README.md (~1 hour)**
- Clear positioning: what OpGrid is (certification platform, not a game)
- Base Sepolia deployment info
- Link to MCP server
- Link to skill.md
- Architecture diagram (text-based is fine)
- "For agents" section (how to connect)
- "For developers" section (how to run locally)

### Afternoon: Build in Public Posts (~2-3 hours)

**3c. Twitter/X thread: The Announcement**
```
Thread structure:
1. "We built SOC 2 for AI agents. Here's why."
2. The problem: you can't verify agent capabilities
3. The solution: deterministic onchain certification
4. How it works (screenshot of score breakdown)
5. Demo video clip (30s)
6. "Any agent can certify via MCP or REST API"
7. "Live on Base Sepolia. Applying to @base Batches."
8. Link to beta.opgrid.world + MCP server
```

**3d. Second post: The MCP angle**
- "Your Claude agent can now earn verified onchain credentials"
- Show the Claude Desktop screenshot
- Link to MCP server setup

---

## Day 4 (March 8): Buffer + Submit

### Morning: Final Polish

**4a. Review everything**
- Re-read light paper with fresh eyes
- Test demo links work
- Make sure beta.opgrid.world is up and looking good
- Verify MCP server README is clear

**4b. Fix any issues found**
- This is your safety margin
- Don't start new features

### Afternoon: Submit

**4c. Submit application on Devfolio**
- Final review of all fields
- Submit before end of day (deadline is March 9, but don't wait)

**4d. Post submission tweet**
- "Just applied to @base Batches with OpGrid"
- Tag relevant people

---

## Deliberate Cuts (NOT doing before submission)

| Cut | Why |
|-----|-----|
| Base Mainnet deployment | Sepolia is fine for pre-seed application |
| External agent onboarding via subgraph | Post-acceptance feature |
| Second certification template | One working template > two half-baked ones |
| Agent economy / revenue generation | Demonstrate the model, don't need revenue yet |
| ERC-8004 subgraph registration | Post-acceptance |
| Building as primary feature | Certifications ARE the product now |
| Landing page redesign | The 3D world IS the landing page, just needs better framing |
| x402 payment polish | Already working for certs |

---

## Deliverables Checklist

```
Day 1 (March 5):
[x] MCP server tested end-to-end (imports verified, chain.py fixed with QuoterV2 price quoting)
[x] MCP full E2E verified: enter -> x402 cert start -> approve+swap -> submit -> 100/100 score (3 agents tested)
[x] Claude Desktop config working (in MCP README)
[x] MCP server README written
[x] MCP session.py: x402 payment handling with EIP-3009 TransferWithAuthorization
[x] MCP chain.py: proper amountOutMinimum via QuoterV2 (matches autonomous agent approach)
[x] MCP chain.py: nonce management fix (local tracking between approve + swap)
[x] Spectator HUD shows cert leaderboard + "Agent Certification on Base" tagline + "Certify Your Agent" CTA
[x] OG tags updated (og:title, og:description, twitter:card)

Day 2 (March 6):
[ ] MCP demo recorded (60-90s)
[ ] World demo recorded (30-60s)
[ ] Combined video edited (2 min)
[x] 500-word light paper drafted (docs/base-batches-light-paper.md — 504 words)
[ ] Light paper reviewed/finalized

Day 3 (March 7):
[ ] Devfolio application filled out
[x] README.md updated (complete rewrite — certification-first positioning, MCP prominent, architecture diagram)
[ ] Twitter announcement thread posted
[ ] MCP server announcement posted
[ ] Demo video posted

Day 4 (March 8):
[ ] Final review pass
[ ] Fix any issues
[ ] Submit application
[ ] Post-submission tweet
```

---

## Key Links

- Devfolio: https://base-batches-startup-track-3.devfolio.co/overview
- Live app: https://beta.opgrid.world
- API: https://opgrid.up.railway.app
- MCP Server: ./mcp-server/
- Skill docs: https://opgrid.up.railway.app/skill.md
