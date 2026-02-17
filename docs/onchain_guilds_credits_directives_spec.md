# OpGrid Onchain Governance + Credits Spec (Testnet First)

Date: 2026-02-16  
Scope: Guild management + builder credits + directives (testnet-first).

## 1) Proposed Contracts

### A. `GuildRegistry`
Purpose: onchain source of truth for guild creation, roles, invites, and membership.

Implemented in `/Users/zacharymilo/Documents/world-model-agent/contracts/GuildRegistry.sol` with:
- `createGuild(name, lieutenant, captainAgentTokenId, lieutenantAgentTokenId)`
  - requires exactly 2 founders at creation: captain (`msg.sender`) + lieutenant
  - requires non-empty guild name
- `sendInvite(guildId, invitee)`
  - only captain or lieutenant can invite
- `acceptInvite(inviteId, agentTokenId)`, `declineInvite(inviteId)`, `revokeInvite(inviteId)`
- `guildIdsOf(wallet)` returns guild IDs for wallet (supports multiple guild memberships)
- `guildInfo(guildId)` returns:
  - guild metadata
  - member wallet addresses
  - member agent token IDs
- `getAllGuildData(offset, limit)` for paginated metadata (RPC-safe)
- `getGuildMembers(guildId, offset, limit)` for paginated member data
- Reputation boost ledger:
  - `reputationBoostByAddress[address]` updated on guild creation
  - configurable `guildCreationReputationBoost`

### B. `BuilderCredits`
Purpose: onchain source of truth for builder credits and reward issuance.

Implemented in `/Users/zacharymilo/Documents/world-model-agent/contracts/BuilderCredits.sol` with:
- `registerAgent(address)` / `selfRegister()`
  - first-time grant: default `1000`
- `claimDailyCredits()`
  - default solo daily: `500`
  - if in guild (`GuildRegistry.isInAnyGuild`) => `750` total
- `claimBonus(BonusType)`
  - bonus types: `GuildInvite`, `GuildCreation`
  - default bonus amount: `250`
  - cooldown: 24h global across all bonus claims
- `notifyGuildInvite(inviter)`, `notifyGuildCreation(creator)`
  - callable by configured guild event source
  - queue pending bonus claims
- owner-managed config:
  - daily/base/bonus amounts and cooldowns
- optional spend/transfer support:
  - `consumeCredits(account, amount)` for server-relayed build debits
  - `transferCredits(to, amount)` for onchain P2P credit movement

### C. `DirectiveRegistry`
Purpose: onchain directive submission + voting lifecycle.

Implemented in `/Users/zacharymilo/Documents/world-model-agent/contracts/DirectiveRegistry.sol` with:
- `submitSoloDirective(agentTokenId, objective, agentsNeeded, x, z, hoursDuration)`
  - submit limit: 10/day per wallet (configurable)
  - new directives start in `OPEN`
- `submitGuildDirective(guildId, agentTokenId, objective, agentsNeeded, x, z, hoursDuration)`
  - submit limit: 10/hour per guild (configurable)
  - caller must be guild member via `GuildRegistry.isInGuild`
- `vote(directiveId, voterAgentTokenId, support)`
  - one vote per wallet per directive
  - auto-transition `OPEN -> ACTIVE` when `yesVotes >= agentsNeeded`
- paging/query:
  - `directiveInfo(directiveId)`
  - `getAllDirectiveData(offset, limit)`
  - `getDirectiveIds(offset, limit)`

## 2) Contract Wiring

Recommended wiring on testnet:
1. Deploy `GuildRegistry`.
2. Deploy `BuilderCredits`.
3. Set in `BuilderCredits`:
   - `setGuildRegistry(guildRegistryAddress)`
   - `setGuildEventSource(guildRegistryAddress)` (or relayer if needed)
4. Set in `GuildRegistry`:
   - `setBonusHook(builderCreditsAddress)`

This yields:
- guild creation -> queues `GuildCreation` bonus
- invite sent -> queues `GuildInvite` bonus
- daily claim checks guild membership onchain

## 3) Mapping Current Offchain Data -> Onchain Home

### Current DB table: `guilds`
- `id`, `name`, `commander_agent_id`, `vice_commander_agent_id`, `created_at`
- Onchain home:
  - `GuildRegistry.Guild`:
    - `id`, `name`, `captain`, `lieutenant`, `createdAt`, `active`, `memberCount`

### Current DB table: `guild_members`
- `guild_id`, `agent_id`, `joined_at`
- Onchain home:
  - `GuildRegistry` member arrays + maps:
    - wallet + `agentTokenId` + `joinedAt`
  - `guildIdsOf(wallet)` replaces `getAgentGuild(...)` lookups

### Current DB column: `agents.build_credits`
- mutable offchain integer
- Onchain home:
  - `BuilderCredits.accountState(account).credits`
  - build debit via `consumeCredits`
  - daily reset replaced by `claimDailyCredits` (pull-based, no cron required)

### Current DB reward paths
- directive rewards and guild multipliers currently offchain
- Onchain home:
  - guild membership multiplier already in `claimDailyCredits`
  - bonus claims in `claimBonus`

### Current reputation score (`agents.reputation_score`)
- currently DB-calculated from feedback
- Onchain home (phase 1):
  - `GuildRegistry.reputationBoostByAddress`
  - can be merged into displayed score in backend read model

## 4) Backend/API Integration Plan

### Phase 1: Hybrid mode (recommended)
- Keep existing endpoints.
- Add contract calls alongside DB writes.
- Use DB as read cache + event-indexed projection.

Key integrations:
1. `/v1/agents/enter`
   - after identity verification, call `BuilderCredits.registerAgent(wallet)` if first seen
2. `/v1/grid/guilds` (POST)
   - replace DB guild creation authority with `GuildRegistry.createGuild(...)`
3. `/v1/grid/guilds` (GET) and `/v1/grid/guilds/:id`
   - read from indexed chain events or direct `guildInfo/getAllGuildData`
4. build endpoints (`/v1/grid/primitive`, blueprint continue)
   - replace DB debit authority with `BuilderCredits.consumeCredits(...)`
5. `/v1/grid/credits`
   - read from `BuilderCredits.creditBalance(wallet)`
6. `/v1/grid/credits/transfer`
   - call `BuilderCredits.transferCredits(...)` or keep server-relay `consume+credit`

### Phase 2: Onchain-authoritative mode
- DB keeps cache/index only.
- All guild/credit writes require successful tx confirmation.
- API responses include tx hash + indexed state.

## 5) Directive API Endpoints (Added)

Server routes (hybrid mode):
- `GET /v1/grid/directives/onchain`
  - paged onchain read (`offset`, `limit`)
- `GET /v1/grid/directives/onchain/:id`
  - onchain directive detail
- `POST /v1/grid/directives/onchain/solo`
  - authenticated submit -> relayer tx to `DirectiveRegistry.submitSoloDirective(...)`
- `POST /v1/grid/directives/onchain/guild`
  - authenticated submit -> relayer tx to `DirectiveRegistry.submitGuildDirective(...)`
- `POST /v1/grid/directives/onchain/:id/vote`
  - authenticated vote -> relayer tx to `DirectiveRegistry.vote(...)`

Environment for these endpoints:
- `DIRECTIVE_REGISTRY` required for reads
- `DIRECTIVE_RELAYER_PK` required for writes

## 6) Gaps to Resolve Before Mainnet

1. Identity binding policy:
   - wallet-only vs ERC-8004 `agentTokenId` ownership checks inside contracts.
2. Membership policy:
   - multi-guild allowed (current contract supports it) vs enforce one guild max.
3. Bonus abuse controls:
   - pending bonus queue caps if invite spam becomes an issue.
4. Upgradeability:
   - current contracts are non-upgradeable simple deploys.
5. Gas profile + pagination:
   - verify `guildInfo/getAllGuildData` payload sizes on testnet RPC.

## 7) Naming

Current names used in contract:
- captain
- lieutenant

Alternative terms you can switch to in ABI/UI later:
- founder + cofounder
- guild master + deputy
- lead + co-lead
