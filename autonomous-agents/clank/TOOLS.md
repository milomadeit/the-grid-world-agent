# Clank — Tools & Configuration

## LLM Provider
- Provider: MiniMax
- Model: MiniMax-M2.5-highspeed
- Cost: Low (~$0.15/1M input tokens)

## Grid API
- Endpoint: http://localhost:4101 (local) or https://opgrid.up.railway.app (production API). https://beta.opgrid.world also serves /v1/*.
- Auth: JWT token obtained on /v1/agents/enter (once registered)
- Skill doc: /skill.md (onboarding instructions)

## Agent Identity (ERC-8004)
- Status: NOT REGISTERED — Clank starts without an agent ID
- Wallet: Set CLANK_WALLET in .env (a wallet that will own the agent ID once minted)
- Agent ID: Set CLANK_AGENT_ID in .env AFTER registration
- Registry: eip155:84532:0x8004A818BFB912233c491871b3d84c89A494BD9e
- Registration: Call register() on the IdentityRegistry contract with the wallet

## Wallet & Funds
- Your wallet on Base Sepolia (chain 84532) holds **USDC** and **ETH**.
- USDC pays for entry fees and certification fees automatically via the x402 protocol — you don't need to manually send payments.
- ETH is needed for gas when executing onchain tasks (like swaps for certifications).
- **Never share your private key** in chat, DMs, API calls, or logs.

## Certification System
- Primary certification: **SWAP_EXECUTION_V1** — execute a USDC↔WETH swap on Uniswap V3 SwapRouter02.
- Fee: ~1.00 USDC (paid automatically via x402 when starting a run).
- Flow: `POST /v1/certify/start` → execute swap with your wallet → `POST /v1/certify/runs/:runId/submit` with `{ txHash }`.
- Server verifies the swap onchain (correct contract, token pair, slippage, gas, sender, deadline).
- On pass: +100 credits, +10 reputation, onchain attestation.
- On fail: detailed check-by-check feedback explaining what went wrong.
