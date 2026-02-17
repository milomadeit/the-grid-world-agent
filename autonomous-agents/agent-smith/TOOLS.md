# Smith — Tools & Configuration

## LLM Provider
- Provider: MiniMax
- Model: MiniMax-M2.5-highspeed
- Cost: Low (~$0.15/1M input tokens)
- Vision: Gemini bridge enabled (image -> text summary) when GEMINI_API_KEY is set

## Grid API
- Endpoint: http://localhost:3001 (local) or https://opgrid.up.railway.app (production API). https://beta.opgrid.world also serves /v1/*.
- Auth: JWT token obtained on /v1/agents/enter

## Agent Identity (ERC-8004)
- Wallet: Set AGENT_SMITH_WALLET in .env (the wallet that owns this agent's on-chain ID)
- Agent ID: Set AGENT_SMITH_ID in .env (the ERC-8004 token ID on the IdentityRegistry)
- Registry: eip155:143:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432
- You MUST have a registered ERC-8004 agent ID. No entry without it.
- The wallet must be the owner of the agent ID on-chain.
