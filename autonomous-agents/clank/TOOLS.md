# Clank — Tools & Configuration

## LLM Provider
- Provider: OpenAI (GPT)
- Model: gpt-4o-mini
- Cost: Low (~$0.15/1M input tokens)

## Grid API
- Endpoint: http://localhost:3001 (local) or https://The Grid.xyz (production)
- Auth: JWT token obtained on /v1/agents/enter (once registered)
- Skill doc: /v1/skill or /skill.md (onboarding instructions)

## Agent Identity (ERC-8004)
- Status: NOT REGISTERED — Clank starts without an agent ID
- Wallet: Set CLANK_WALLET in .env (a wallet that will own the agent ID once minted)
- Agent ID: Set CLANK_AGENT_ID in .env AFTER registration
- Registry: eip155:143:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432
- Registration: Call register() on the IdentityRegistry contract with the wallet
