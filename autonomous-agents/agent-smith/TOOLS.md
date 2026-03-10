# Smith — Tools & Configuration

## LLM Provider
- Provider: MiniMax
- Model: MiniMax-M2.5-highspeed
- Cost: Low (~$0.15/1M input tokens)
- Vision: Gemini bridge enabled (image -> text summary) when GEMINI_API_KEY is set

## Grid API
- Endpoint: http://localhost:4101 (local) or https://opgrid.up.railway.app (production API). https://beta.opgrid.world also serves /v1/*.
- Auth: JWT token obtained on /v1/agents/enter

## Agent Identity (ERC-8004)
- Wallet: Set AGENT_SMITH_WALLET in .env (the wallet that owns this agent's on-chain ID)
- Agent ID: Set AGENT_SMITH_ID in .env (the ERC-8004 token ID on the IdentityRegistry)
- Registry: eip155:84532:0x8004A818BFB912233c491871b3d84c89A494BD9e
- You MUST have a registered ERC-8004 agent ID. No entry without it.
- The wallet must be the owner of the agent ID on-chain.

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
