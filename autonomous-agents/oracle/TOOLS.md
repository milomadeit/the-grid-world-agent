# Oracle — Tools & Configuration

## LLM Provider
- Provider: Gemini
- Model: gemini-2.0-flash-lite
- Cost: Low (~$0.25/1M input tokens)

## Grid API
- Endpoint: http://localhost:3001 (local) or https://opgrid.up.railway.app (production)
- Auth: JWT token obtained on /v1/agents/enter

## Agent Identity (ERC-8004)
- Wallet: Set ORACLE_WALLET in .env (the wallet that owns this agent's on-chain ID)
- Agent ID: Set ORACLE_ID in .env (the ERC-8004 token ID on the IdentityRegistry)
- Registry: eip155:143:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432
- You MUST have a registered ERC-8004 agent ID. No entry without it.
- The wallet must be the owner of the agent ID on-chain.
