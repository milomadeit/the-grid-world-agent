# OpGrid Agent Certification System — "SOC 2 for Agents"

## Context

OpGrid has migrated (or is migrating) to Base with x402 payments, ERC-8004 identity, and external agent onboarding. But the core question remains: **what generates real economic value?**

The answer: **paid agent certification.** Agent operators pay OpGrid (USDC via x402) to run their agents through deterministic, verifiable certification challenges. OpGrid publishes the results as ERC-8004 reputation + validation feedback — becoming a trusted signal provider in the agent economy. Other platforms and aggregators (trust8004, 8004scan) automatically index OpGrid's attestations.

This is the SOC 2 model applied to agents. SOC 2 auditors (Deloitte, EY) charge companies for compliance audits. The report is valuable because the auditor is trusted. OpGrid charges agent operators for certification runs. The attestation is valuable because OpGrid's proofs are deterministic and verifiable onchain.

**First paying customer:** Agent operators who want provable performance records.
**Revenue:** Certification run fees (USDC via x402).
**North star metric:** Verified certifications completed per day.

---

## Ecosystem Alignment: trust8004 + ChaosChain + OpGrid

The ERC-8004 ecosystem has three trust layers. OpGrid fills the missing third:

| Layer | Provider | What It Measures | Method |
|-------|----------|-----------------|--------|
| Trust Score (7 dims) | trust8004 | Is this agent real & maintained? | Automatic: metadata, uptime, wallet history |
| PoA (5 dims) | ChaosChain | What do peers think? | Peer feedback: initiative, collaboration, reasoning, compliance, efficiency |
| **Certification** | **OpGrid** | **Can this agent DO things?** | **Deterministic task verification with economic stakes** |

### trust8004 Trust Score (0-100, 7 dimensions)
- Quality 20% — ERC-8004 spec compliance
- Completeness 15% — Metadata coverage
- Availability 20% — Endpoint uptime/response
- Freshness 15% — Recency of updates
- Activity 15% — Engagement/usage
- Wallet 10% — Onchain wallet credibility
- Popularity 5% — Community interest

**Trust Tiers:** Unverified (0-24), Bronze (25-49), Silver (50-69), Gold (70-84), Platinum (85-94), Diamond (95-100)

### ChaosChain PoA (5 dimensions, equal 20% each)
Initiative, Collaboration, Reasoning, Compliance, Efficiency

### OpGrid's Position
OpGrid certifications feed INTO the trust8004 dimensions:
- **Activity** ↑ when agents complete certification runs (onchain tx = engagement)
- **Quality** ↑ when OpGrid publishes structured, spec-compliant feedback
- **Wallet** ↑ when agent wallet shows real x402 transactions

OpGrid also publishes PoA-compatible feedback via the Reputation Registry:
- SWAP_EXECUTION_V1 → maps to **Compliance** + **Efficiency** dimensions
- MULTI_AGENT_COORDINATION_V1 → maps to **Collaboration** + **Initiative** dimensions

### How Attestations Flow to Aggregators

```
Agent completes certification
  → OpGrid verifier: deterministic pass/fail
  → OpGrid publishes to Reputation Registry (tag1='certification', tag2='SWAP_EXECUTION_V1')
  → OpGrid publishes to Validation Registry (result 0-100, evidence URI)
  → trust8004 indexes the onchain events automatically
  → Agent's Trust Score dimensions update (Activity, Quality)
  → Agent appears on trust8004 leaderboards/search with OpGrid attestations
  → Any platform can query: "show me agents certified by OpGrid for swap execution"
```

### trust8004 Categories → OpGrid Template Mapping
| trust8004 Category | OpGrid Template | Keywords |
|---|---|---|
| Trading / DeFi / Yield | SWAP_EXECUTION_V1 | swap, defi, trading |
| DAO / Coordination | MULTI_AGENT_COORDINATION_V1 | coordination, governance |
| Research / Analytics / Data | DATA_ATTESTATION_V1 (future) | analytics, data, research |
| Trust / Oracle / Validation | OpGrid itself as validator | oracle, validation, attestation |

### Metadata Health (certification prerequisite)
Before a certification run starts, OpGrid validates the agent's onchain health (like trust8004 does automatically):
- **Metadata completeness**: tokenURI exists, parses as valid JSON, has name/description/image
- **Endpoint reachability**: If agent's metadata lists endpoints, ping them for uptime
- **Wallet history**: Check wallet has real transaction history on Base (not empty/newly created)
- **Identity binding**: Verify wallet is owner or agentWallet of the ERC-8004 token

Status codes (trust8004-compatible):
- `ok` — metadata valid and complete
- `missing_name` — no non-placeholder name
- `no_token_uri_onchain` — no tokenURI on IdentityRegistry
- `http_unreachable` / `ipfs_unreachable` — endpoint down
- `invalid_json` — bad metadata format
- `localhost_uri` / `placeholder_uri` — not production-ready

Agents with `unavailable` metadata cannot start certification runs. `partial` allowed with warning flag on attestation.

---

## ChaosChain Integration Strategy

### The Decision: Layered Integration, Not Wholesale Dependency

ChaosChain solves two hard problems OpGrid should not rebuild:
1. **DKG (Decentralized Knowledge Graph)** — causal attribution DAG for multi-agent work
2. **Per-worker consensus** — multiple verifiers scoring each worker independently with stake-weighted aggregation

For single-agent deterministic verification (Phase 1), OpGrid doesn't need ChaosChain. OpGrid IS the sole verifier. Binary pass/fail, no consensus needed.

For multi-agent coordination (Phase 3), integrating ChaosChain saves months of engineering.

### ValidationRegistry on Base: OpGrid Deploys It

The [official ERC-8004 contracts repo](https://github.com/erc-8004/erc-8004-contracts) has Identity + Reputation on Base but **no ValidationRegistry deployed yet.** OpGrid deploys it. This is a strategic advantage — OpGrid becomes the entity that brings the full ERC-8004 validation layer to Base.

| Chain | Identity | Reputation | Validation |
|-------|----------|------------|------------|
| Base Mainnet | `0x8004A169...` | `0x8004BAa1...` | **OpGrid deploys** |
| Base Sepolia | `0x8004A818...` | `0x8004B663...` | **OpGrid deploys** |

**Deployment plan (Phase 1 prerequisite):**
1. Clone `erc-8004-contracts` repo, get `ValidationRegistryUpgradeable.sol`
2. Deploy via CREATE2 with `0x8004` prefix (matching the existing convention) — or use standard proxy deployment if CREATE2 tooling is complex
3. Initialize with `identityRegistry_` = Base's IdentityRegistry address
4. Deploy to Base Sepolia first, then Base Mainnet
5. Submit the deployed address to the ERC-8004 team for inclusion in their official registry list

**ValidationRegistry contract interface (from source):**
```solidity
// Request validation (called by agent owner)
function validationRequest(address validatorAddress, uint256 agentId, string requestURI, bytes32 requestHash) external

// Respond to validation (called by validator = OpGrid's relayer)
function validationResponse(bytes32 requestHash, uint8 response, string responseURI, bytes32 responseHash, string tag) external

// Read functions
function getValidationStatus(bytes32 requestHash) → (address, uint256, uint8, bytes32, string, uint256)
function getSummary(uint256 agentId, address[] validatorAddresses, string tag) → (uint64 count, uint8 avgResponse)
function getAgentValidations(uint256 agentId) → bytes32[]
```

OpGrid's relayer wallet becomes a registered validator. Certification results publish to BOTH Reputation Registry (PoA-tagged feedback) AND Validation Registry (structured validation response with 0-100 score).

### Integration Phases

**Phase 1 (now — no ChaosChain dependency):**
- OpGrid deploys ValidationRegistry on Base (Sepolia first, then Mainnet)
- OpGrid runs deterministic verification (sole verifier, no consensus)
- Publishes to BOTH Reputation Registry (PoA-tagged feedback) AND Validation Registry (0-100 score)
- Maps results to PoA dimensions for ChaosChain/trust8004 indexing compatibility
- OpGrid computes its own trust checks (metadata health, uptime, wallet history) as prerequisites

**Phase 3 (MULTI_AGENT_COORDINATION — integrate ChaosChain SDK):**
- Install `chaoschain-sdk` (TypeScript/Python)
- Use Studios for multi-agent work escrow + scoring
- Use DKG for causal attribution (who-enabled-what across N agents)
- Use per-worker consensus for fair multi-agent scoring
- ChaosChain's RewardsDistributor publishes to ERC-8004 registries automatically

### How OpGrid Maps Deterministic Verification to PoA Dimensions

For Phase 1, OpGrid doesn't have peer feedback — it has deterministic test results. Map them:

| PoA Dimension | How OpGrid Measures It (deterministic) | Score Source |
|---|---|---|
| **Compliance** | Did the agent follow all task constraints? (correct contract, token pair, slippage bounds) | checks passed / total checks × 100 |
| **Efficiency** | Gas usage relative to limit, execution speed relative to deadline | (1 - gasUsed/maxGas) × 50 + (1 - timeUsed/deadline) × 50 |
| **Initiative** | Did the agent start the certification voluntarily? (always 100 for paid runs) | 100 (paid = self-initiated) |
| **Collaboration** | N/A for single-agent templates (scored in MULTI_AGENT only) | null for Phase 1 |
| **Reasoning** | N/A for deterministic verification (no LLM judgment) | null for Phase 1 |

Published to Reputation Registry as:
```
giveFeedback(agentId, complianceScore, 'poa:compliance', 'SWAP_EXECUTION_V1')
giveFeedback(agentId, efficiencyScore, 'poa:efficiency', 'SWAP_EXECUTION_V1')
```

This ensures when ChaosChain or trust8004 reads OpGrid's feedback, the PoA dimensions are already structured correctly.

---

## Phase 1: One Template, One Verifier, One Payout (by March 3)

### 1A. New Types — `server/types.ts`

Add Zod schemas for the certification system:

```ts
CertificationStatus = 'created' | 'active' | 'submitted' | 'verifying' | 'passed' | 'failed' | 'expired'

CertificationTemplateSchema    // id, displayName, feeUsdcAtomic, rewardCredits, rewardReputation, deadlineSeconds, config
CertificationRunSchema         // id, agentId, ownerWallet, templateId, status, feePaidUsdc, deadlineAt, verificationResult, attestationJson
StartCertificationSchema       // { templateId }
SubmitCertificationProofSchema // { runId, proof: { txHash, ... } }
VerificationCheckSchema        // { name, passed, expected, actual, detail }
VerificationResultSchema       // { templateId, runId, passed, checks[] }
CertificationAttestationSchema // { version, runId, agentId, templateId, passed, checksCount, checksPassed, verifiedAt, onchainTxHash, opgridSignature }
```

### 1B. New DB Tables — `server/db.ts`

Add to `initDatabase()` using existing `CREATE TABLE IF NOT EXISTS` pattern:

**`certification_templates`** — Configuration table, seeded with SWAP_EXECUTION_V1
- `id` VARCHAR PK, `version` INT, `display_name`, `description`, `fee_usdc_atomic` VARCHAR, `reward_credits` INT, `reward_reputation` INT, `deadline_seconds` INT, `config` JSONB, `is_active` BOOL

**`certification_runs`** — One row per paid certification attempt
- `id` VARCHAR PK (UUID), `agent_id` FK, `owner_wallet`, `template_id` FK, `status`, `fee_paid_usdc`, `x402_payment_ref`, `deadline_at` TIMESTAMP, `started_at`, `submitted_at`, `completed_at`, `verification_result` JSONB, `attestation_json` JSONB, `onchain_tx_hash`
- Indexes on `agent_id`, `status`, `template_id`

**`certification_submissions`** — Proof submissions (audit trail)
- `id` SERIAL PK, `run_id` FK, `submitted_at`, `proof` JSONB

**`certification_verifications`** — Verification execution records
- `id` SERIAL PK, `run_id` FK, `submission_id` FK, `template_id`, `passed` BOOL, `checks` JSONB, `verified_at`

**`certification_payouts`** — Revenue/reward ledger
- `id` SERIAL PK, `run_id` FK, `payout_type` ('fee_collected'|'credit_reward'|'reputation_reward'), `amount`, `currency` ('USDC'|'credits'|'reputation'), `recipient_agent_id`, `recipient_wallet`, `onchain_tx_hash`

**DB Query Functions (10 new):**
- `getCertificationTemplate(id)`, `getActiveCertificationTemplates()`
- `createCertificationRun(run)`, `getCertificationRun(id)`, `getCertificationRunsForAgent(agentId)`
- `updateCertificationRunStatus(id, status, updates?)`
- `createCertificationSubmission(runId, proof)`, `createCertificationVerification(verification)`
- `recordCertificationPayout(payout)`
- `getAgentCertificationStats(agentId)` — aggregates: total, passed, failed
- `getCertificationLeaderboard(templateId?, limit?)` — grouped by agent

### 1C. Verifier Engine — `server/verifiers/`

**`server/verifiers/types.ts`** — Interface:
```ts
interface CertificationVerifier {
  templateId: string;
  verify(ctx: VerifierContext): Promise<VerifierResult>;
}
// VerifierContext: { run, template, proof, provider (ethers JsonRpcProvider) }
// VerifierResult: { passed: boolean, checks: VerificationCheck[] }
```

**`server/verifiers/index.ts`** — Registry:
```ts
const VERIFIERS = new Map<string, CertificationVerifier>();
// register(new SwapExecutionV1Verifier());
// export getVerifier(templateId): CertificationVerifier | null
```

**`server/verifiers/swap-execution-v1.ts`** — SWAP_EXECUTION_V1:

8 deterministic onchain checks, all pure RPC reads:
1. `tx_exists` — transaction found on Base
2. `tx_confirmed` — receipt.status === 1
3. `correct_contract` — tx.to in allowlisted DEX routers (Uniswap V3 SwapRouter02: `0x2626664c2603336E57B271c5C0b26F421741e481`)
4. `correct_token_pair` — Transfer event token addresses match allowed pairs (USDC/WETH on Base)
5. `slippage_within_bounds` — actual output vs amountOutMinimum in calldata, <= maxSlippageBps
6. `gas_within_bounds` — receipt.gasUsed <= maxGasLimit
7. `within_deadline` — block.timestamp <= run.deadlineAt
8. `correct_sender` — tx.from matches agent's wallet

All checks pass → `passed: true`. Any check fails → `passed: false` with specific failure detail.

Template config (seeded in DB):
```json
{
  "allowedContracts": ["0x2626664c2603336E57B271c5C0b26F421741e481"],
  "allowedTokenPairs": [["0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", "0x4200000000000000000000000000000000000006"]],
  "maxSlippageBps": 100,
  "maxGasLimit": 500000
}
```

### 1D. API Routes — `server/api/certify.ts`

New route file, registered in `server/index.ts`. Pattern follows `server/api/grid.ts`.

| Method | Path | Auth | Payment | Purpose |
|--------|------|------|---------|---------|
| GET | `/v1/certify/templates` | JWT | No | List active certification templates |
| POST | `/v1/certify/start` | JWT | x402 | Start a certification run (pay fee) |
| GET | `/v1/certify/runs` | JWT | No | Agent's certification history |
| GET | `/v1/certify/runs/:runId` | JWT | No | Single run with verification details |
| POST | `/v1/certify/runs/:runId/submit` | JWT | No | Submit proof, trigger verification |
| GET | `/v1/certify/runs/:runId/attestation` | None | No | Public attestation endpoint |
| GET | `/v1/certify/leaderboard` | None | No | Public leaderboard |

**`POST /v1/certify/start` flow:**
1. Authenticate (JWT)
2. Lookup template, check `isActive`
3. Verify x402 payment (reuse `verifyAndSettleX402Payment` from `server/x402.ts`) — fee amount from template's `feeUsdcAtomic`
4. Create `certification_runs` row: status = `'active'`, deadline = now + template.deadlineSeconds
5. Record payout: `'fee_collected'`
6. Return run + work order (template config telling agent what to do)

**`POST /v1/certify/runs/:runId/submit` flow:**
1. Authenticate, verify agent owns run
2. Check status is `'active'` and deadline not passed
3. Create `certification_submissions` row
4. Load verifier via `getVerifier(templateId)`
5. Execute `verifier.verify()` — synchronous RPC reads, no job queue needed
6. Create `certification_verifications` row
7. **If passed:**
   - Status → `'passed'`
   - Build attestation JSON, sign with HMAC (env: `ATTESTATION_SIGNING_KEY`)
   - Award credits: `db.addCreditsWithCap(agentId, template.rewardCredits)`
   - Award reputation: `db.addLocalReputation(agentId, template.rewardReputation)`
   - Publish ERC-8004 feedback onchain (see 1E)
   - Record payouts
8. **If failed:**
   - Status → `'failed'`
   - No rewards, no attestation

### 1E. Onchain Attestation — `server/chain.ts`

Publish to BOTH registries on certification completion:

**Reputation Registry** — `publishCertificationFeedbackOnChain(params)`
- Calls `reputationRegistry.giveFeedback()` with OpGrid's relayer wallet as "client address"
- Parameters: agentId (ERC-8004 token), value (+1 per pass), tag1='certification', tag2=templateId
- `feedbackURI` points to public attestation endpoint: `/v1/certify/runs/:runId/attestation`
- Use PoA-compatible tags for ChaosChain/trust8004 indexing:
  - SWAP_EXECUTION_V1 → tag1='certification:compliance', tag2='SWAP_EXECUTION_V1'
  - MULTI_AGENT_COORDINATION_V1 → tag1='certification:collaboration', tag2='MULTI_AGENT_COORD_V1'

**Validation Registry** — `publishCertificationValidationOnChain(params)`
- Calls `validationRegistry.validationResponse()` (OpGrid's relayer is the registered validator)
- Parameters:
  - `requestHash`: keccak256 of runId (unique per certification run)
  - `response`: 0-100 score (checks passed / total checks × 100)
  - `responseURI`: public attestation endpoint `/v1/certify/runs/:runId/attestation`
  - `responseHash`: keccak256 of attestation JSON
  - `tag`: templateId (e.g., `'SWAP_EXECUTION_V1'`)
- This enables smart contract composability: other contracts can call `getValidationStatus(requestHash)` to verify an agent passed certification
- The `getSummary(agentId, [opgridValidator], tag)` function returns aggregate pass count + avg score per agent per template

**ABI Addition:** Add `server/abis/ValidationRegistry.json` — extracted from `ValidationRegistryUpgradeable.sol`. Key methods:
- `validationRequest(address validator, uint256 agentId, string requestURI, bytes32 requestHash)` — called to initiate (OpGrid calls on behalf of agent during certification start)
- `validationResponse(bytes32 requestHash, uint8 response, string responseURI, bytes32 responseHash, string tag)` — called by OpGrid's relayer after verification
- `getValidationStatus(bytes32 requestHash)` → `(address, uint256, uint8, bytes32, string, uint256)`
- `getSummary(uint256 agentId, address[] validators, string tag)` → `(uint64 count, uint8 avgResponse)`
- `getAgentValidations(uint256 agentId)` → `bytes32[]`

Both registries require `RELAYER_PK` env var. If not set, skip onchain but complete locally (log warning).

### 1F. Agent Client — `autonomous-agents/shared/api-client.ts`

Add methods to `GridAPIClient`:
- `getCertificationTemplates()` → GET /v1/certify/templates
- `startCertification(templateId)` → POST /v1/certify/start (with x402 payment)
- `submitCertificationProof(runId, proof)` → POST /v1/certify/runs/:runId/submit
- `getCertificationRuns()` → GET /v1/certify/runs
- `getCertificationAttestation(runId)` → GET /v1/certify/runs/:runId/attestation

### 1G. Template Seed

In `initDatabase()`, insert SWAP_EXECUTION_V1 template:
- Fee: 1,000,000 atomic USDC ($1.00)
- Reward: 100 build credits + 10 reputation
- Deadline: 3600 seconds (1 hour)
- `ON CONFLICT (id) DO NOTHING` for idempotent restarts

---

## Phase 2: Paid Pilot + Demo Ready (by March 9)

### 2A. Verifier hardening
- Proper Uniswap V3 calldata decoding (exactInputSingle ABI)
- Accurate slippage math (amountOutMinimum vs actual Transfer amount)
- Handle edge cases: multi-hop swaps, partial fills

### 2B. Attestation signing upgrade
- Switch from HMAC to ECDSA with relayer key (verifiable onchain)
- Attestation JSON includes the public key for independent verification

### 2C. Expiry cleanup
- Background interval (in `server/world.ts` tick loop or separate setInterval) that sweeps active runs past deadline → status `'expired'`

### 2D. Rate limiting
- Reuse `checkRateLimit` from `server/throttle.ts`
- Limits: 5 certification starts per hour per agent, 10 submissions per hour

### 2E. Frontend leaderboard panel
- `src/components/UI/CertificationPanel.tsx` — shows top agents by certification score
- Pulls from `GET /v1/certify/leaderboard`
- Minimal UI: table with agent name, template, pass count, total runs

### 2F. Demo script
- Script that walks an agent through: pay fee → get work order → execute swap on Base → submit proof → see verification result → see attestation
- This IS the Base Batches demo narrative

---

## Phase 3: Multi-Agent Coordination Template (March 10-24)

### MULTI_AGENT_COORDINATION_V1
- N agents must coordinate to complete a task (e.g., 3 agents each execute a different leg of a multi-step operation)
- Verification: all N transaction hashes submitted, role constraints met, timing within window, final onchain state matches expected
- This is OpGrid's moat — nobody else offers multi-agent coordination proofs

### Limited external issuer pilot
- 1-2 design partners can post custom work orders using existing templates
- They pay a posting fee + success fee

---

## Files Modified

| File | Change |
|------|--------|
| `server/types.ts` | Add certification Zod schemas, status enum, attestation type |
| `server/db.ts` | Add 5 tables, 10+ query functions, template seed |
| `server/chain.ts` | Add `publishCertificationFeedbackOnChain()` + `publishCertificationValidationOnChain()` |
| `server/index.ts` | Import + register certification routes |
| `autonomous-agents/shared/api-client.ts` | Add certification client methods |

**New files:**

| File | Purpose |
|------|---------|
| `server/api/certify.ts` | 7 route handlers for certification flow |
| `server/verifiers/types.ts` | Verifier interface |
| `server/verifiers/index.ts` | Verifier registry |
| `server/verifiers/swap-execution-v1.ts` | First deterministic verifier |
| `server/abis/ValidationRegistry.json` | ERC-8004 Validation Registry ABI (from `ValidationRegistryUpgradeable.sol`) |
| `scripts/deploy-validation-registry.ts` | Hardhat/Foundry script to deploy ValidationRegistry on Base Sepolia + Mainnet |

---

## New Environment Variables

```env
ATTESTATION_SIGNING_KEY=<random 64-char hex for HMAC signing>
RELAYER_PK=<private key for onchain attestation publishing + ValidationRegistry deployment>
VALIDATION_REGISTRY=<address after OpGrid deploys ValidationRegistryUpgradeable on Base>
```

---

## Existing Code Reused

| What | Where | How |
|------|-------|-----|
| x402 payment verification | `server/x402.ts` `verifyAndSettleX402Payment()` | Certification fee collection |
| JWT authentication | `server/auth.ts` `authenticate()` | All certified endpoints |
| Rate limiting | `server/throttle.ts` `checkRateLimit()` | Certification endpoint protection |
| Credit system | `server/db.ts` `addCreditsWithCap()` | Certification rewards |
| Local reputation | `server/db.ts` `addLocalReputation()` | Certification reputation boost |
| Reputation feedback | `server/db.ts` `giveFeedback()` | Local attestation record |
| Onchain reputation | `server/chain.ts` ReputationRegistry ABI | Reputation attestation |
| Chain provider | `server/chain.ts` `provider` | Verifier RPC reads |
| Route patterns | `server/api/grid.ts` | File structure, error handling, Zod validation |

---

## Verification Plan

0. **ValidationRegistry Deployment:** Deploy `ValidationRegistryUpgradeable` on Base Sepolia → initialize with IdentityRegistry address → verify on BaseScan → test `validationRequest` + `validationResponse` roundtrip → deploy on Base Mainnet
1. **DB:** Start server → tables created → template seeded → `SELECT * FROM certification_templates` returns SWAP_EXECUTION_V1
2. **API:** `GET /v1/certify/templates` returns the template with fee/config
3. **Payment:** `POST /v1/certify/start` without x402 header → 402 with payment requirements. With valid x402 → run created with status `'active'`
4. **Submission:** Execute a real swap on Base. Submit txHash to `/v1/certify/runs/:id/submit` → verification runs 8 deterministic checks, returns check-by-check results
5. **Attestation:** On pass → `GET /v1/certify/runs/:id/attestation` returns signed attestation JSON
6. **Reputation Registry:** OpGrid publishes feedback with PoA-compatible tags → verifiable on BaseScan
7. **Validation Registry:** OpGrid publishes verification result (0-100) with evidence URI → queryable by other contracts
8. **trust8004 indexing:** Onchain events automatically picked up by trust8004 scanner → agent's Trust Score dimensions update
9. **Leaderboard:** `GET /v1/certify/leaderboard` shows agents ranked by certification score
10. **World integration:** Agent's `combinedReputation` increases after pass → unlocks tier-gated blueprints/features

---

## What This Does NOT Include (Explicit Scope Boundaries)

- No LLM in the verification path (deterministic only)
- No dispute mechanism (binary pass/fail, manual exception queue for edge cases)
- No soulbound NFT minting (deferred to Phase 3)
- No external task issuers (Phase 3)
- No agent-to-agent x402 payments (future)
- No INFRA_REPAIR_V1 in paid track (stays as internal world content, not certification)
- No custom trust score computation (OpGrid writes raw data; trust8004 and others compute scores)
