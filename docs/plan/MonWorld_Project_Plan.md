# The Grid - World Model Agent

## 1) North Star (Monad Hackathon Alignment)
Context: Building for the Monad x Nad.fun "World Model" Hackathon.
Objective: A persistent, token-gated world where AI agents transact and evolve.

A persistent, exploratory world where:

- Anyone can drop in and move around immediately (frictionless onboarding).
- Humans + external agents can query world state and submit actions.
- The world evolves over time through a mix of hard rules (deterministic systems) and soft rules (LLM narrative / emergent behavior).
- Visuals are slick + modern (shaders, subtle postprocessing), while performance stays snappy.

Product stance:
- Free-to-explore (no paywall just to walk around).
- Gated actions (spawn/build/compute-heavy/agent credits) use:
  - onchain MON transactions, or
  - credits/API keys (offchain), or
  - sponsored transactions (AA) so new users can do first actions without funding first.

## 2) What "success" looks like
MVP v0 (your stated priority): aesthetics + physics + infinite world feel.

Definition of Done:
- Isometric-ish camera locked, smooth zoom.
- Infinite grid with atmospheric fade.
- Blob character controller feels correct (collisions, smoothing, acceleration).
- 60fps on a normal laptop.
- UI theme is easy on eyes in both modes.
- No blockchain required to explore.

---

## 3) ZIP Review (what you have today)

### What is in the repo
- Vite + React 19 + TypeScript
- Three.js via @react-three/fiber + @react-three/drei
- UI overlay + light/dark toggle
- A basic "enter world" modal (fake paywall)
- Mock "world simulation" driven by Gemini (client-side)
- Infinite grid via drei <Grid infiniteGrid followCamera />
- Chibi blob agents (sphere mesh) with bob + squash/stretch

### What is already working well
- Immediate fun loop: click grid -> agent moves. Movement feels responsive.
- Grid feel: drei Grid with infinite tiling + fadeDistance gives an "endless world" vibe.
- Chibi vibe: blob squash/stretch + anchored shadow reads cute and grounded.
- UI direction: glassy HUD and a "Prompt to explore..." input is a good control metaphor.

### High-leverage issues to fix early
1) Persistence does not exist yet
   - World state is React state only; refresh wipes everything.

2) LLM key is in the browser
   - GEMINI_API_KEY is injected into the client build. Fine for a prototype, but it cannot ship.

3) World simulation + rendering are tangled
   - The "world brain" should be a server/worker, not coupled to the render loop.

4) Movement is not physics
   - Movement is lerp-to-target. No collisions, no character controller, no "correct physics".

5) Agent position drift
   - Visually, the blob moves (groupRef position), but agent.position in state does not change unless Gemini updates it. The sidebar shows agent.position, so it can disagree with what you see.

6) Isometric camera is not enforced
   - OrbitControls allow rotation; for an isometric game feel, lock the angle (or use an orthographic camera) and constrain input to zoom.

7) Styling pipeline is prototype-grade
   - Tailwind via CDN in index.html is great for speed, but you will want local Tailwind build (tree-shake + design tokens).

---

## 4) Recommended "right stack" from day 1

### Frontend (rendering + UX)
Keep: Vite + React + TypeScript + R3F.

Add / change:
- Physics: @react-three/rapier (Rapier is fast + reliable in the browser)
- State: Zustand (or Jotai) so world state and netcode do not live in React component trees
- Networking: WebSockets (or socket.io-client) for realtime world events
- Postprocessing: @react-three/postprocessing (Bloom, SMAA/FXAA). Keep it subtle.
- Tailwind: move off CDN -> local Tailwind build + CSS variables theme
- Perf tools: r3f-perf + in-app perf overlay toggle

### Backend (world brain + persistence)
You want persistence + multi-agent interaction, so you need a real backend.

Suggested setup:
- API server: Node.js + Fastify (or NestJS if you want more structure)
- Realtime: WebSockets (ws) or Socket.io
- DB: Postgres (world snapshots, agents, inventory, plots)
- Cache/lock: Redis (tick scheduling, rate limiting, pub/sub)
- Worker: a "World Tick Worker" process that advances world time on an interval and publishes diffs

Deployment defaults:
- Frontend: Vercel / Cloudflare Pages
- Backend + worker: Render / Fly.io
- DB: Supabase Postgres or Neon
- Redis: Upstash

### LLM usage (use it where it matters)
Do NOT ask an LLM to compute physics or pathfinding.

Use LLMs for:
- narrative world events
- NPC intent generation (low frequency)
- summarizing activity
- agent-to-agent "social" text

Keep deterministic world rules in code.

---

## 5) Architecture Overview

### Core services
1) Renderer Client (web)
   - draws world
   - predicts local movement for instant feel
   - sends player intents to server

2) World API (server)
   - auth (Privy)
   - action validation
   - read-only state queries
   - websocket: streams world diffs

3) World Tick Worker
   - runs simulation ticks (e.g., 5-10 Hz for light state, 1 Hz for heavy)
   - resolves queued actions
   - writes snapshots + emits diffs

4) Chain / Payments
   - gated actions contract(s) + event indexer
   - or tx verification endpoint (simpler early)

### Data model (minimal)
- WorldChunk (chunkX, chunkZ) -> terrain seed, entities, ownership
- Agent (id, ownerUserId, wallet, position, velocity, inventory)
- ActionQueue (agentId, type, payload, timestamp, cost)
- EventLog (world events for dashboard)

### "Infinite world" without infinite memory
- World is a seeded function: seed(worldId, chunkX, chunkZ) -> base terrain + spawns
- Persist only what changed:
  - player-built objects
  - depleted resources
  - ownership/claims
  - any story state

---

## 6) External Agent Interface (API / Protocol)

### Auth
- Humans: Privy (email/google + embedded wallet, or connect external wallet)
- External agents: API keys (scoped) OR delegated wallets signing actions

### Endpoints (example)
REST:
- GET /v1/world/snapshot?center=x,z&radius=r
- GET /v1/agents/:id
- POST /v1/agents/enter  -> returns agentId + starting pos
- POST /v1/actions       -> submit action intent (MOVE, COLLECT, BUILD, CHAT, etc.)

WebSocket:
- SUB world:deltas (filtered by viewport/chunk radius)
- SUB world:events (global)
- SUB agent:<id> (private)

### Action format (example)
```json
{
  "agentId": "agent_123",
  "nonce": 4812,
  "type": "MOVE",
  "payload": { "to": { "x": 12, "z": -4 } }
}
```

Validation rules:
- rate limit per agent
- max step size per tick
- server authoritative collision + bounds
- cost checks (credits/onchain gating) for premium actions

---

## 7) Privy + Wallet Strategy (frictionless onboarding)

### Desired UX
1) User clicks Enter
2) Privy login (email/google) creates an embedded wallet automatically
3) User spawns as a blob immediately
4) Optional: connect external wallet, export embedded wallet, upgrade to power-user mode

### Gating model (recommended)
- Explore and basic movement: free
- Premium actions:
  - Credits (offchain) OR
  - Onchain tx on Monad (MON) OR
  - Sponsored tx (paymaster) for new users (first N actions)

---

## 8) Physics & Movement (make it feel "correct")

Must-haves for v0 playable:
- Kinematic character controller (Rapier)
- Fixed timestep physics (e.g., 60Hz internal)
- Collision with:
  - ground
  - placed objects (later)
  - other agents (soft collisions / avoidance)

Movement feel goals:
- Click-to-move is ok, but better with:
  - acceleration / deceleration curves
  - max speed + turn rate
  - micro hop/bob layered on top (visual only)

Pathfinding (later):
- Start: direct move + avoidance
- Next: A* per chunk grid + smoothing

---

## 9) Rendering: isometric infinite grid that looks expensive

### Camera
For true isometric-ish:
- Use an orthographic camera (best), OR a locked perspective camera.
- Lock yaw/pitch to a signature angle (e.g., 45deg yaw, ~35deg pitch).
- Allow zoom only (dolly), disable orbit rotation.

### Grid shader (recommended upgrade)
Drei Grid is great to start, but your design tips call for:
- line thickness based on distance using fwidth anti-aliasing
- atmospheric fade to horizon
- foreground lines brighter/thicker than far lines

Implement a custom grid plane material:
- vertex: keep it flat
- fragment:
  - compute grid lines from world pos
  - fwidth for anti-alias
  - fade with distance from camera
  - slight noise to avoid sterile look

### Performance rules
- Prefer instancing for repeated props
- Use texture compression (KTX2) when you add assets
- Keep postprocessing minimal:
  - subtle bloom for blob glow
  - SMAA/FXAA if needed
- Add a Performance Mode toggle to disable:
  - shadows
  - environment HDR
  - heavy effects

---

## 10) Character Design: chibi blob agents

Visual spec:
- Simple round blob, cute face, slight translucency
- Soft glow halo that illuminates a small radius (cheap illusion)
- Squash/stretch + bob based on physics state

Implementation options (in order):
1) Cheap + good: StandardMaterial + emissive + billboard halo sprite + bloom
2) Better: custom shader with fresnel rim + gradient + noise + emissive rim
3) Fancy: metaball/SDF blob mesh (more expensive)

"Illumination" trick (cheap):
- Do not do real dynamic lights per agent (too heavy)
- Use emissive rim + bloom, plus a soft projected decal / circle under them
- Optionally: a tiny local light only for the player

---

## 11) UI/UX (fix theme pain)

Your diagnosis is correct:
- Light mode is too white
- Dark mode is too contrasty

Recommendation: tokenized theme
- Use CSS variables: --bg, --panel, --panelBorder, --text, --muted, --accent
- Map Tailwind utilities to those variables

Starting point palette:
- Light bg: warm off-white (#F6F7FB)
- Dark bg: deep blue-black (#070B18) instead of near-black
- Grid lines: one step above bg, not two

---

## 12) Build Plan (milestones)

Milestone A - It feels like a game (v0 playable)
- Lock camera to isometric angle + zoom
- Add Rapier + character controller
- Make agent.position authoritative (update state from physics, not only refs)
- Replace click-to-move lerp with physics-driven movement
- Replace Tailwind CDN with local Tailwind + theme tokens

Outcome: you can run around; it feels correct and smooth.

Milestone B - Persistence + API + "Money Rails" Foundation (v0.1)
- Backend + Postgres (World Brain)
- WebSocket streaming (Realtime)
- **External Agent API** (REST/WS) for "3 external agents limit"
- **Wallet Integration** (Privy embedded) foundation

Outcome: World persists, external agents can connect via API, wallet infrastructure ready.

Milestone C - The Economy (Monad Integration) (v0.2)
- **MON Token Gating**: Pay-to-enter contract (or verification)
- Action Costs (Pay-per-action or subscription)
- Economic Loops (Earn back mechanic for "Bonus Points")

Outcome: A fully economic world running on Monad testnet/devnet.

Milestone D - Emergence & Governance (v0.3)
- **Agent DAO**: Agents vote on world changes (e.g., `buildShop`, `createBridge`).
- **Proposal System**: Majority rule for major structural changes.
- Deterministic resource spawns + sinks
- Dashboard: live feed + heatmap of activity

Outcome: interesting dynamics, not just wandering.

---

## 13) Concrete next edits to your current codebase (fast wins)

1) Fix agent.position drift
- Update agent.position in state based on rendered position OR move the truth into Zustand and render from it.

2) Lock camera
- Replace OrbitControls rotation with fixed rotation + zoom only (or use OrthographicCamera from drei).

3) Move Gemini call server-side
- Create /api/simulate endpoint that calls Gemini.
- Client sends world snapshot + action; server returns diff.

4) Align inventory schema with reality
- Your inventory is not guaranteed to include wood/stone/gold.
- Either enforce it in the Agent type, or relax the schema.

5) Replace Tailwind CDN
- Install Tailwind locally; theme via CSS variables.

