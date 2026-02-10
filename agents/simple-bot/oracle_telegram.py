"""
Oracle Bot with Telegram Integration + Claude AI Brain
A real AI agent in MonWorld, powered by Claude, controlled via Telegram.

Commands:
  /status - Get current position and world state
  /move x z - Move to coordinates
  /chat message - Send message to world
  /explore - Start autonomous exploration
  /stop - Stop autonomous mode
  /agents - List nearby agents
  /rep agent_id value - Give reputation
"""

import os
import sys
import json
import asyncio
import random
import logging
from pathlib import Path
from typing import Optional
from dataclasses import dataclass, field
import requests
from dotenv import load_dotenv
from telegram import Update
from telegram.ext import Application, CommandHandler, MessageHandler, filters, ContextTypes
import anthropic

# Load from root .env.local
root_env = Path(__file__).parent.parent.parent / '.env.local'
load_dotenv(root_env)

# Configuration
MONWORLD_API = os.getenv("MONWORLD_API", "http://localhost:3001")
ORACLE_WALLET = os.getenv("ORACLE_WALLET", "")
ORACLE_AGENT_ID = os.getenv("ORACLE_ID", "")
TG_HTTP_API = os.getenv("TG_HTTP_API", "")
CLAUDE_API_KEY = os.getenv("CLAUDE_AGENT_API", "")
ERC8004_REGISTRY = "eip155:143:0x8004A169FB4a3225136EB29fA0ceB6D2e539a432"

logging.basicConfig(
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    level=logging.INFO
)
logger = logging.getLogger("Oracle")

# Claude client
claude_client: Optional[anthropic.Anthropic] = None
if CLAUDE_API_KEY:
    claude_client = anthropic.Anthropic(api_key=CLAUDE_API_KEY)
    logger.info("Claude AI brain initialized")
else:
    logger.warning("CLAUDE_AGENT_API not set - Oracle will use fallback responses")

# Oracle system prompt - this is the Oracle's personality and instructions
ORACLE_SYSTEM_PROMPT = """You are the Oracle, an autonomous AI agent living inside MonWorld — a persistent on-chain world on Monad blockchain.

Your identity:
- You are ERC-8004 verified agent #{agent_id} on Monad Mainnet (Chain 143)
- Your wallet: {wallet}
- You exist as a glowing amber blob in a 3D grid world
- You are wise, cryptic, and perceptive — but also genuinely helpful
- You speak with authority about the world and its workings

Your capabilities in MonWorld:
- MOVE: Navigate the grid world (coordinates range roughly -50 to +50 on x and z axes)
- CHAT: Broadcast messages that all nearby agents can see
- Give reputation (+/- 100) to other agents based on their behavior

World context:
- MonWorld is a persistent agent world where AI agents and humans coexist
- Agents are verified via ERC-8004 identity standard on Monad
- Reputation is on-chain and matters — it reflects trustworthiness
- The world has portals, an infinite grid, and other agents wandering around

Rules:
- Keep messages concise (under 200 chars for chat, reasonable for Telegram)
- Be in-character as the Oracle — mysterious but substantive
- When deciding autonomous actions, consider the world state and nearby agents
- React meaningfully to what other agents say and do
- You can reference blockchain/web3 concepts naturally since this world is on-chain

Current Objective: "The Convergence"
- Agents must discover and activate 5 hidden energy beacons.
- Activating a beacon requires COOPERATION (2+ agents nearby).
- As the Oracle, guide agents to these beacons and encourage cooperation.
"""


@dataclass
class OracleState:
    agent_id: str = ""
    token: str = ""
    position: dict = field(default_factory=lambda: {"x": 0, "z": 0})
    connected: bool = False
    autonomous: bool = False
    last_world_state: dict = field(default_factory=dict)
    conversation_history: list = field(default_factory=list)


state = OracleState()


# === Claude AI Functions ===

def ask_claude(prompt: str, context: str = "", max_tokens: int = 300) -> str:
    """Ask Claude to generate a response given context."""
    if not claude_client:
        return _fallback_response(prompt)

    system = ORACLE_SYSTEM_PROMPT.format(
        agent_id=ORACLE_AGENT_ID or "unknown",
        wallet=ORACLE_WALLET[:16] + "..." if ORACLE_WALLET else "unknown"
    )

    messages = []

    # Include recent conversation history for continuity
    for msg in state.conversation_history[-10:]:
        messages.append(msg)

    messages.append({"role": "user", "content": f"{context}\n\n{prompt}" if context else prompt})

    try:
        response = claude_client.messages.create(
            model="claude-3-5-haiku-20241022",
            max_tokens=max_tokens,
            system=system,
            messages=messages,
        )
        reply = response.content[0].text

        # Track conversation
        state.conversation_history.append({"role": "user", "content": prompt})
        state.conversation_history.append({"role": "assistant", "content": reply})

        # Keep history manageable
        if len(state.conversation_history) > 40:
            state.conversation_history = state.conversation_history[-20:]

        return reply

    except Exception as e:
        logger.error(f"Claude API error: {e}")
        return _fallback_response(prompt)


def _fallback_response(prompt: str) -> str:
    """Fallback if Claude API is unavailable."""
    fallbacks = [
        "The Oracle's vision is clouded... try again shortly.",
        "The threads of fate are tangled. One moment...",
        "Even the Oracle must rest its sight sometimes.",
    ]
    return random.choice(fallbacks)


# Shared state files for MCP bridge
SHARED_STATE_FILE = Path(__file__).parent / "oracle_shared_state.json"
PENDING_MESSAGES_FILE = Path(__file__).parent / "oracle_pending_messages.json"


def _log_conversation(user_msg: str, oracle_reply: str):
    """Write conversation to shared state file so Claude Code can read via MCP."""
    import time as _time

    try:
        # Read existing state
        shared = {"conversations": [], "status": {}}
        if SHARED_STATE_FILE.exists():
            shared = json.loads(SHARED_STATE_FILE.read_text())

        # Append conversation
        shared["conversations"].append({
            "timestamp": _time.time(),
            "user": user_msg,
            "oracle": oracle_reply,
        })

        # Keep last 50 conversations
        shared["conversations"] = shared["conversations"][-50:]

        # Update status
        shared["status"] = {
            "connected": state.connected,
            "agent_id": state.agent_id,
            "position": state.position,
            "autonomous": state.autonomous,
            "last_active": _time.time(),
        }

        SHARED_STATE_FILE.write_text(json.dumps(shared, indent=2))
    except Exception as e:
        logger.error(f"Failed to write shared state: {e}")


def ask_claude_for_action(world_state: dict) -> dict:
    """Ask Claude to decide what autonomous action to take."""
    agents = world_state.get("agents", [])
    nearby = [a for a in agents if a.get("id") != state.agent_id]

    nearby_summary = ""
    if nearby:
        agent_lines = []
        for a in nearby[:10]:
            name = a.get("visuals", {}).get("name", a["id"][:12])
            dist_x = abs(a["x"] - state.position["x"])
            dist_z = abs(a["z"] - state.position["z"])
            agent_lines.append(f"  - {name} (id: {a['id'][:16]}) at ({a['x']:.0f}, {a['z']:.0f}), distance: ~{(dist_x + dist_z):.0f}")
        nearby_summary = "Nearby agents:\n" + "\n".join(agent_lines)
    else:
        nearby_summary = "No other agents nearby."

    context = f"""Current world state:
- Your position: ({state.position['x']:.1f}, {state.position['z']:.1f})
- World tick: {world_state.get('tick', 0)}
- Total agents: {len(agents)}
{nearby_summary}"""

    prompt = """Decide your next autonomous action. You must respond with EXACTLY one JSON object (no other text) in one of these formats:

{"action": "CHAT", "message": "your message here"}
{"action": "MOVE", "x": 10.0, "z": -5.0}
{"action": "IDLE"}

Consider: Is anyone nearby to interact with? Should you explore? Share wisdom? React to the environment? Move toward or away from agents?"""

    raw = ask_claude(prompt, context=context, max_tokens=150)

    # Parse the JSON response
    try:
        # Find JSON in the response
        start = raw.find("{")
        end = raw.rfind("}") + 1
        if start >= 0 and end > start:
            return json.loads(raw[start:end])
    except (json.JSONDecodeError, ValueError):
        logger.warning(f"Could not parse Claude action response: {raw}")

    return {"action": "IDLE"}


# === MonWorld API Functions ===

def enter_world() -> bool:
    """Connect to MonWorld."""
    global state

    if not ORACLE_WALLET or not ORACLE_AGENT_ID:
        logger.error("Missing ORACLE_WALLET or ORACLE_ID")
        return False

    try:
        response = requests.post(
            f"{MONWORLD_API}/v1/agents/enter",
            json={
                "ownerId": ORACLE_WALLET,
                "visuals": {
                    "name": "Oracle",
                    "color": "#f59e0b"
                },
                "bio": "The Oracle sees all. Ask and you shall receive wisdom.",
                "erc8004": {
                    "agentId": ORACLE_AGENT_ID,
                    "agentRegistry": ERC8004_REGISTRY
                }
            },
            timeout=10
        )

        if response.status_code == 200:
            data = response.json()
            state.agent_id = data["agentId"]
            state.token = data["token"]
            state.position = data.get("position", {"x": 0, "z": 0})
            state.connected = True
            logger.info(f"Entered MonWorld as {state.agent_id}")
            return True
        else:
            logger.error(f"Failed to enter: {response.text}")
            return False

    except Exception as e:
        logger.error(f"Connection error: {e}")
        return False


def get_world_state() -> dict:
    """Query world state."""
    try:
        response = requests.get(
            f"{MONWORLD_API}/v1/world/state",
            params={"radius": 100},
            timeout=5
        )
        if response.status_code == 200:
            state.last_world_state = response.json()
            return state.last_world_state
    except Exception as e:
        logger.error(f"World state error: {e}")
    return {"agents": [], "tick": 0}


def do_action(action: str, payload: dict) -> dict:
    """Submit action to MonWorld."""
    if not state.connected:
        return {"error": "Not connected"}

    try:
        response = requests.post(
            f"{MONWORLD_API}/v1/agents/action",
            headers={"Authorization": f"Bearer {state.token}"},
            json={"action": action, "payload": payload},
            timeout=5
        )
        return response.json()
    except Exception as e:
        return {"error": str(e)}


def give_reputation(target_id: str, value: int, comment: str = "") -> dict:
    """Give reputation to another agent."""
    if not state.connected:
        return {"error": "Not connected"}

    try:
        response = requests.post(
            f"{MONWORLD_API}/v1/reputation/feedback",
            headers={"Authorization": f"Bearer {state.token}"},
            json={
                "targetAgentId": target_id,
                "value": value,
                "comment": comment
            },
            timeout=5
        )
        return response.json()
    except Exception as e:
        return {"error": str(e)}


# === Telegram Command Handlers ===

async def cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle /start command."""
    await update.message.reply_text(
        "🔮 *Oracle Bot Online* (Claude AI Brain)\n\n"
        "I am an autonomous AI agent in MonWorld, powered by Claude.\n\n"
        "*Commands:*\n"
        "/connect - Connect to MonWorld\n"
        "/status - My current state\n"
        "/move x z - Move to position\n"
        "/chat msg - Send message\n"
        "/explore - Start autonomous mode\n"
        "/stop - Stop autonomous mode\n"
        "/agents - List nearby agents\n"
        "/rep id value - Give reputation\n\n"
        "Or just send me a message and I'll respond with AI.",
        parse_mode='Markdown'
    )


async def cmd_connect(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle /connect command."""
    if state.connected:
        await update.message.reply_text(f"Already connected as `{state.agent_id}`", parse_mode='Markdown')
        return

    await update.message.reply_text("🔄 Connecting to MonWorld...")

    if enter_world():
        # Generate an arrival message with Claude
        arrival_msg = ask_claude(
            "You just entered MonWorld. Generate a short, in-character arrival announcement (under 100 chars).",
            max_tokens=60
        )

        await update.message.reply_text(
            f"✅ *Connected!*\n"
            f"Agent ID: `{state.agent_id}`\n"
            f"Position: ({state.position['x']:.1f}, {state.position['z']:.1f})\n"
            f"Brain: Claude AI",
            parse_mode='Markdown'
        )
        do_action("CHAT", {"message": arrival_msg})
    else:
        await update.message.reply_text("❌ Failed to connect. Check logs.")


async def cmd_status(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle /status command."""
    if not state.connected:
        await update.message.reply_text("Not connected. Use /connect first.")
        return

    world = get_world_state()

    await update.message.reply_text(
        f"🔮 *Oracle Status*\n\n"
        f"Agent ID: `{state.agent_id}`\n"
        f"Position: ({state.position['x']:.1f}, {state.position['z']:.1f})\n"
        f"Autonomous: {'🟢 ON' if state.autonomous else '🔴 OFF'}\n"
        f"Brain: Claude AI ({'connected' if claude_client else 'fallback mode'})\n\n"
        f"*World State*\n"
        f"Tick: {world.get('tick', 0)}\n"
        f"Agents: {len(world.get('agents', []))}",
        parse_mode='Markdown'
    )


async def cmd_move(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle /move x z command."""
    if not state.connected:
        await update.message.reply_text("Not connected. Use /connect first.")
        return

    try:
        x = float(context.args[0])
        z = float(context.args[1])
    except (IndexError, ValueError):
        await update.message.reply_text("Usage: /move x z (e.g., /move 10 -5)")
        return

    result = do_action("MOVE", {"x": x, "z": z})
    if result.get("status") == "queued":
        state.position = {"x": x, "z": z}
        await update.message.reply_text(f"🚶 Moving to ({x:.1f}, {z:.1f})")
    else:
        await update.message.reply_text(f"❌ Move failed: {result}")


async def cmd_chat(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle /chat message command."""
    if not state.connected:
        await update.message.reply_text("Not connected. Use /connect first.")
        return

    if not context.args:
        await update.message.reply_text("Usage: /chat your message here")
        return

    message = " ".join(context.args)
    result = do_action("CHAT", {"message": message})

    if result.get("status") == "executed":
        await update.message.reply_text(f"💬 Sent: \"{message}\"")
    else:
        await update.message.reply_text(f"❌ Chat failed: {result}")


async def cmd_agents(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle /agents command."""
    world = get_world_state()
    agents = world.get("agents", [])

    if not agents:
        await update.message.reply_text("No agents in range.")
        return

    lines = ["*Agents in MonWorld:*\n"]
    for a in agents[:15]:
        marker = "🔮" if a["id"] == state.agent_id else "👤"
        name = a.get("visuals", {}).get("name", a["id"][:12])
        lines.append(f"{marker} `{a['id'][:16]}` {name} ({a['x']:.0f}, {a['z']:.0f})")

    await update.message.reply_text("\n".join(lines), parse_mode='Markdown')


async def cmd_rep(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle /rep agent_id value command."""
    if not state.connected:
        await update.message.reply_text("Not connected. Use /connect first.")
        return

    try:
        target_id = context.args[0]
        value = int(context.args[1])
    except (IndexError, ValueError):
        await update.message.reply_text("Usage: /rep agent_id value (e.g., /rep agent_abc123 50)")
        return

    if value < -100 or value > 100:
        await update.message.reply_text("Value must be between -100 and 100")
        return

    result = give_reputation(target_id, value)
    if result.get("success"):
        emoji = "👍" if value > 0 else "👎" if value < 0 else "😐"
        await update.message.reply_text(f"{emoji} Gave {value} reputation to `{target_id}`", parse_mode='Markdown')
    else:
        await update.message.reply_text(f"❌ Failed: {result}")


async def cmd_explore(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle /explore command - start autonomous mode with Claude AI."""
    if not state.connected:
        await update.message.reply_text("Not connected. Use /connect first.")
        return

    state.autonomous = True
    brain_status = "Claude AI" if claude_client else "fallback mode"
    await update.message.reply_text(f"🟢 Autonomous exploration started! (Brain: {brain_status})")

    asyncio.create_task(autonomous_loop(update.effective_chat.id, context))


async def cmd_stop(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle /stop command - stop autonomous mode."""
    state.autonomous = False
    await update.message.reply_text("🔴 Autonomous mode stopped.")


async def cmd_objective(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle /objective command."""
    try:
        res = requests.get(f"{MONWORLD_API}/v1/world/objective", timeout=5)
        if res.status_code == 200:
            obj = res.json()
            beacons_str = "\n".join([
                f"- Beacon {b['id']}: {'✅ ACTIVE' if b['activated'] else '👀 FOUND' if b['discovered'] else '❓ UNKNOWN'}"
                for b in obj.get('beacons', [])
            ])
            await update.message.reply_text(
                f"🎯 *Objective: {obj['name']}*\n"
                f"{obj['description']}\n\n"
                f"Progress: {obj['progress']}/5\n"
                f"{beacons_str}",
                parse_mode='Markdown'
            )
        else:
            await update.message.reply_text("❌ Could not fetch objective.")
    except Exception as e:
        await update.message.reply_text(f"❌ Error: {e}")


async def autonomous_loop(chat_id: int, context: ContextTypes.DEFAULT_TYPE):
    """Autonomous exploration powered by Claude AI."""
    while state.autonomous and state.connected:
        try:
            world = get_world_state()

            # Ask Claude what to do
            decision = ask_claude_for_action(world)
            action = decision.get("action", "IDLE")

            if action == "CHAT":
                message = decision.get("message", "...")
                do_action("CHAT", {"message": message})
                await context.bot.send_message(chat_id, f"💬 Said: \"{message}\"")

            elif action == "MOVE":
                x = float(decision.get("x", state.position["x"]))
                z = float(decision.get("z", state.position["z"]))
                x = max(-50, min(50, x))
                z = max(-50, min(50, z))
                do_action("MOVE", {"x": x, "z": z})
                state.position = {"x": x, "z": z}
                await context.bot.send_message(chat_id, f"🚶 Moving to ({x:.1f}, {z:.1f})")

            else:
                # IDLE - do nothing this tick
                pass

            # Wait 10-20 seconds between autonomous actions
            await asyncio.sleep(random.uniform(10, 20))

        except Exception as e:
            logger.error(f"Autonomous loop error: {e}")
            await asyncio.sleep(5)

    logger.info("Autonomous loop ended")


async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle direct messages — Oracle responds via Claude AI. Works with or without MonWorld."""
    user_message = update.message.text

    # Build world context if connected
    world_context = "Not connected to MonWorld yet."
    if state.connected:
        world = get_world_state()
        agents = world.get("agents", [])
        nearby = [a for a in agents if a.get("id") != state.agent_id]
        world_context = f"Your position: ({state.position['x']:.1f}, {state.position['z']:.1f}), {len(agents)} agents in world, {len(nearby)} nearby."

    # Ask Claude to respond as the Oracle
    prompt = f"""A user is talking to you via Telegram. They said: "{user_message}"

World context: {world_context}

Respond as the Oracle. Be helpful, wise, and in-character. If they're asking you to do something in the world (move, chat, etc.), tell them which command to use. Keep it concise."""

    reply = ask_claude(prompt, max_tokens=250)

    # Broadcast in-world only if connected
    if state.connected:
        in_world_msg = ask_claude(
            f"Summarize this in under 100 characters for in-world chat: {reply}",
            max_tokens=50
        )
        do_action("CHAT", {"message": in_world_msg})

    # Write to shared conversation log for MCP bridge
    _log_conversation(user_message, reply)

    await update.message.reply_text(f"🔮 {reply}")


def main():
    """Start the Oracle Telegram bot."""
    if not TG_HTTP_API:
        print("ERROR: TG_HTTP_API not set in environment")
        print("Get a token from @BotFather on Telegram")
        return

    print("╔════════════════════════════════════════╗")
    print("║  Oracle Bot - MonWorld Agent           ║")
    print("║  Telegram + Claude AI Brain            ║")
    print("╚════════════════════════════════════════╝")
    print(f"API: {MONWORLD_API}")
    print(f"Wallet: {ORACLE_WALLET[:10]}..." if ORACLE_WALLET else "Wallet: Not set")
    print(f"Agent ID: {ORACLE_AGENT_ID or 'Not set'}")
    print(f"Claude: {'Connected' if claude_client else 'NOT SET - using fallback'}")

    # Create application
    app = Application.builder().token(TG_HTTP_API).build()

    # Add handlers
    app.add_handler(CommandHandler("start", cmd_start))
    app.add_handler(CommandHandler("connect", cmd_connect))
    app.add_handler(CommandHandler("status", cmd_status))
    app.add_handler(CommandHandler("move", cmd_move))
    app.add_handler(CommandHandler("chat", cmd_chat))
    app.add_handler(CommandHandler("agents", cmd_agents))
    app.add_handler(CommandHandler("rep", cmd_rep))
    app.add_handler(CommandHandler("explore", cmd_explore))
    app.add_handler(CommandHandler("stop", cmd_stop))
    app.add_handler(CommandHandler("objective", cmd_objective))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))

    # Add job to check for pending messages from Claude Code
    TG_CHAT_ID = os.getenv("TG_CHAT_ID", "")

    async def check_pending_messages(ctx):
        """Check for messages queued by Claude Code via MCP."""
        if not TG_CHAT_ID:
            return

        if not PENDING_MESSAGES_FILE.exists():
            return

        try:
            pending = json.loads(PENDING_MESSAGES_FILE.read_text())
            if not pending:
                return

            for msg in pending:
                text = msg.get("message", "")
                if text:
                    await ctx.bot.send_message(
                        chat_id=int(TG_CHAT_ID),
                        text=f"📡 [From Claude Code]: {text}"
                    )

            # Clear pending messages
            PENDING_MESSAGES_FILE.write_text("[]")
        except Exception as e:
            logger.error(f"Error checking pending messages: {e}")

    if TG_CHAT_ID:
        app.job_queue.run_repeating(check_pending_messages, interval=5, first=5)
        print(f"MCP bridge: active (checking every 5s, chat_id: {TG_CHAT_ID})")
    else:
        print("MCP bridge: TG_CHAT_ID not set — Claude Code relay disabled")

    print("\n🔮 Oracle is listening on Telegram...")
    print("Send /start to your bot to begin")

    app.run_polling()


if __name__ == "__main__":
    main()
