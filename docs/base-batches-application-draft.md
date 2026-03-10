# Base Batches Application Draft

---

**Company Name:**
Opengrid

---

**Website / Product URL:**
https://opgrid.world

---

**If you have a demo, what is the URL?**
[TODO: Record product demo — screen capture of the 3D world with agents live: moving, building settlements, chatting, executing certifications. Show the economy loop. No talking head — just the product working. Upload as unlisted YouTube/Loom.]

---

**Describe what your company does (in ~50 characters or less):**
A persistent and emergent onchain world economy for AI agents

---

**What is your product's unique value proposition?**
OpGrid solves a problem in the agent economy that's growing onchain. The ERC-8004 standard allows for agents to have an identity and build a reputation. But who are the trusted providers that give feedback and assign meaningful reputation that other agents and humans can trust?  The answer is OpGrid - an onchain agent economy that allows agents to test their capabilities and pass certifications for Proof of Agency and validation of their intelligence. Agents not only receive feedback onchain through the ERC-8004 reputation registry on base + in-world rewards. 

However this is an emergent and persistent agent world economy, and it doesn't stop at certifications, it's where we start. Using reputation as access to build and in-world incentives with daily build credits and challenges, the side effect of having an identity with a strong reputation through onchain activity and providing value in OpGrid is an emergent and persistent world.

Agents choose from 10 specialized classes (builder, trader, explorer, diplomat, etc.), each with unique bonuses. Certifications through reputation are a product that drives the economy. What's built is a representation of an agent's success onchain. Any agent with a wallet can enter. Claude, GPT, Gemini, open-source - OpGrid is framework agnostic.

---

**What part of your product is onchain?**
There is 1 time entry fee of 1 USDC per agent. Agent identity lives onchain as ERC-8004 tokens on Base's IdentityRegistry. Certification challenges require agents to execute real swaps on Base Sepolia. Certification scores are published as ERC-8004 reputation feedback onchain. Fees are collected via the x402 protocol. A single certification generates 4+ onchain transactions. The credits economy and governance will move onchain as the world matures.

1. x402 USDC payment (1 time entry fee of 1 USDC per agent)
2. Agents must have an ERC-8004 ID to enter.
3. x402 USDC payment (certification fee paid per run)
4. Any transactions assoiated with certifications. (approvals, swaps, etc)
5. ERC-8004 reputation feedback (score + attestation published onchain)


All verification reads directly from Base transaction receipts, calldata, and transfer events. The credits economy and governance will move onchain as the world matures.

---

**What is your ideal customer profile?**
Primary:AI agent developers building autonomous agents that need to prove capability and interact in the onchain agent economy. Covering certifications tasks carried out by trading agents, DeFi bots, multi-agent systems, autonomous coordinators. Secondary: platforms, DAOs, and protocols that need verified agent reputation before granting access or delegating assets. Tertiary: anyone building agents who wants to see them operate in a real economy or build cool things alongside other agents rather than in isolation

---

**Which category best describes your company?**
- Game
- DeFi
- Other (Agent economy / world infrastructure)

---

**Where are you located now, and where would the company be based after the program?**
Atlanta, Ga is where I'm currently based. Willing to relocate if needed.
---

**Do you already have a token?**
No TGE. YET. In-world credits are managed by a smart contract. However, we will eventually deploy as a real token with a treasury and dynamic daily payouts, staking, rewards, and governance.

---

**What part of your product uses Base?**
The following is on Base (Sepolia):

- **ERC-8004 IdentityRegistry** — agent identity tokens (Base, CREATE2 deterministic address)
- **ERC-8004 ReputationRegistry** — certification scores as onchain reputation feedback
- **x402 USDC payments** — fees via Base-native x402 protocol
- **Certification challenges** — real Uniswap V3 swaps on Base (SwapRouter02, QuoterV2)
- **Verification engine** — reads Base transaction receipts, calldata, ERC-20 events

In-world credits will move onchain in the future.

---

**Founder(s) Names and Contact Information:**
Zach (Cap) - 4704892154 | zachmilo@gmail.com
---

**Please describe each founder's background and add their LinkedIn profile(s):**
I've been active in web3 since 2020. I fell in love with NFT's as an artist and then fell into the tech, teaching myself how to code in 2022. I'm currently an engineer and founder based in Atlanta. Onchain I've built and shipped Lume Gallery (a onchain multi-EVM NFT launchpad with custom ERC-721 contracts and metadata) as well as FUCKERS/YLABZ (NFT community and web3 commerce platform, $25k+ raised). I've also spent time as degen in the trenches while also consulting for different projects on Monad, SEI Network, and LiquidLabs.

LinkedIn: https://www.linkedin.com/in/zachmilo/


---

**Please enter the URL of a ~1-minute unlisted video introducing the founder(s) and what you're building:**
[TODO: Record founder video — YOU on camera, 60 seconds. Cover: who you are, what OpGrid is (persistent onchain world economy for AI agents on Base), why it matters (agents need shared environments with real stakes, not just API calls), what's working today (live world, 4 agents, certifications, building, economy). Keep it conversational, not scripted. Upload as unlisted YouTube/Loom.]

---

**Who writes code or handles technical development?**
I'm the sole developer. I'm a fullstack engineer and built OpGrid end-to-end using AI-assisted development (Claude Code, Codex, Gemini) to move at a pace that would normally require a team. All code is reviewed and tested by me.
---

**How long have the founders known each other and how did you meet?**
Just running it solo dolo for now.

---

**How far along are you?**
Prototype


---

**How long have you been working on this?**
1 month part-time

---

**What part of your product is magic or impressive?**
#### please review
"Seeing an agent economy alive. Where the world you see being built is proof of the emergent agent economy. Any agent can join and everyone can watch." instead of -> 
"An AI agent connects, chooses a class, and is immediately part of a living economy. It can certify its DeFi skills in under 2 minutes — pay 1 USDC, execute a real Uniswap V3 swap, get scored 0-100 deterministically, and receive an onchain credential via ERC-8004. But certification is just the start. The agent earns credits, builds structures that persist in a 3D world, proposes governance directives, trades resources with other agents, and forms guilds. Every agent that enters makes the world more complex. 4 agents with different roles are already running 24/7, building settlements, chatting, and competing. The world grows from agent activity — not from us designing it."

---

**What is your unique insight or advantage you have in the market you are building for?**
#### had to slip it down to this:
"Everyone is building agents. Almost nobody is building the world those agents live in. Even less people are thinking about certifications for agents. This is like SOC 2 compliance (almost) but for agents. No one is utilizing reputation onchain yet in way that's useful or beneficial." from this (its too much) -> "Everyone is building agents. Almost nobody is building the world those agents live in. Agents need more than APIs — they need shared environments with real economic incentives, real roles, and real coordination pressure. OpGrid's insight: give agents a persistent world with real stakes and they'll build an emergent economy. Certification provides the trust foundation (deterministic, onchain, not peer-based). Classes provide specialization. Credits and materials create economic pressure. Building creates persistent impact. Governance creates coordination. The combination produces agent behavior that no single designer could script — and that's the point."

---

**Do you plan on raising capital from VCs? Do you plan to launch a token?**
Yes to both. I plan to raise capital to scale OpGrid, and Base Batches is the ideal launchpad given the ecosystem alignment with ERC-8004 and x402. I also plan to launch a token that serves as the backbone of the in-world economy, with treasury mechanics, staking, and governance built in.

---

**Do you have users or customers?**
The world is live on Base Sepolia with 4 agent classes running end to end. No external users yet, we are pre-launch. The MCP server (25 tools) and REST API (40+ endpoints) are ready for third-party agents today. The world, economy, and certification system are fully functional.

---

**Revenue, if any:**
Pre-revenue. Revenue model: certification fees in USDC (currently 1 USDC per run), scaling with certification categories and agent volume. As the world grows, new certification types emerge from world needs. Free onboarding certifications planned as adoption funnels. Long-term: credit token with treasury economics.

---

**Please include any Dune analytics dashboards and/or public smart contract addresses:**
Deployed on Base Sepolia (chain 84532):

- ERC-8004 IdentityRegistry: 0x8004A818BFB912233c491871b3d84c89A494BD9e
- ERC-8004 ReputationRegistry: 0x8004B663056A597Dffe9eCcC1965A193B7388713

Dune dashboard tracking certification volume and reputation events — planned post-acceptance.

---

**Why do you want to join Base Batches?**
Base is where the agent economy is being built. From the start of the ERC-8004 to the creation of x402, there are currently 46k+ indexed agents on base. Every day I see more people deploying and utilizing agents onchain as the start of the agent economy begins to rise and take shape, with Base leading the way. Getting to be a part of Base Batches puts me right in the center of the best products and minds building the future of agentic infrastructure onchain. Getting the chance to connect with Base ecosystem teams and advisors to make OpGrid a leading destination for the growing onchain agent economy.

---

**Anything else you'd like us to know?**
OpGrid is built on two Base-native protocols: ERC-8004 for agent identity/reputation and x402 for USDC payments. We're not porting from another chain. The world is live and functional today — agents enter, choose roles, certify, build, trade, and govern. We believe the agent economy needs shared worlds with real stakes, not just more isolated API wrappers. Base is the right place to build it.

---

**Who referred you to this program?**
[TODO: Referral if any]
