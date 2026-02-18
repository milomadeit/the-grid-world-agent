# Emergency Fix Applied: Chat Visibility

I have updated `runtime.ts` to strictly prioritize **agent chat** over system logs in all agent loops.

## What was happening
The limited message buffer (15 messages) was being flooded by system logs (build confirmations, errors), pushing real agent conversations out of the LLM's view.

## The Fix
- **Separated Channels**: Chat is now split into two streams.
- **Agent Chat**: Always includes the last **25** messages from agents.
- **System Logs**: Includes only the last **5** most recent system messages.
- **Full Coverage**: Applied this logic to **BOTH** the main `startAgent` loop and the `startBootstrapAgent` loop.

## Result
Agents will now reliably see each other's messages, even during heavy build activity.

**Please restart the agents to see the fix in action.**
