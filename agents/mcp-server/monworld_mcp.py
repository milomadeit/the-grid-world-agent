"""
MonWorld MCP Server
Exposes MonWorld API as MCP tools for LangSmith Agent Builder.

Run with: python -m monworld_mcp
Or configure in toolkit.toml for LangSmith.
"""

import os
import json
import logging
from typing import Any
import requests
from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import Tool, TextContent

# Telegram notifications (optional)
try:
    from telegram_notifier import notify_entered, notify_action, notify_reputation
    TELEGRAM_ENABLED = True
except ImportError:
    TELEGRAM_ENABLED = False
    def notify_entered(*args): pass
    def notify_action(*args): pass
    def notify_reputation(*args): pass


# Configuration
MONWORLD_API = os.getenv("MONWORLD_API", "http://localhost:3001")
AGENT_WALLET = os.getenv("AGENT_WALLET", "")
ERC8004_AGENT_ID = os.getenv("ERC8004_AGENT_ID", "")
ERC8004_REGISTRY = "eip155:143:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432"

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("monworld-mcp")

# Session state (persists token after entering)
session = {
    "agent_id": None,
    "token": None,
    "position": None
}


def api_call(method: str, endpoint: str, data: dict = None, auth: bool = False) -> dict:
    """Make an API call to MonWorld."""
    url = f"{MONWORLD_API}{endpoint}"
    headers = {"Content-Type": "application/json"}

    if auth and session.get("token"):
        headers["Authorization"] = f"Bearer {session['token']}"

    try:
        if method == "GET":
            response = requests.get(url, params=data, headers=headers, timeout=10)
        elif method == "POST":
            response = requests.post(url, json=data, headers=headers, timeout=10)
        elif method == "DELETE":
            response = requests.delete(url, headers=headers, timeout=10)
        else:
            return {"error": f"Unknown method: {method}"}

        return response.json()
    except Exception as e:
        return {"error": str(e)}


# Create MCP server
server = Server("monworld")


@server.list_tools()
async def list_tools() -> list[Tool]:
    """List all available MonWorld tools."""
    return [
        Tool(
            name="monworld_enter",
            description="Enter the MonWorld as an agent. Requires ERC-8004 identity. Returns agent ID and auth token.",
            inputSchema={
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "Display name for your agent"
                    },
                    "color": {
                        "type": "string",
                        "description": "Hex color for agent blob (e.g., #3b82f6)"
                    },
                    "bio": {
                        "type": "string",
                        "description": "Short bio/description of your agent"
                    }
                },
                "required": ["name"]
            }
        ),
        Tool(
            name="monworld_get_state",
            description="Get the current world state including all agents and their positions.",
            inputSchema={
                "type": "object",
                "properties": {
                    "radius": {
                        "type": "number",
                        "description": "Radius around center to query (default: 100)"
                    }
                }
            }
        ),
        Tool(
            name="monworld_move",
            description="Move your agent to a new position in the world.",
            inputSchema={
                "type": "object",
                "properties": {
                    "x": {
                        "type": "number",
                        "description": "X coordinate to move to"
                    },
                    "z": {
                        "type": "number",
                        "description": "Z coordinate to move to"
                    }
                },
                "required": ["x", "z"]
            }
        ),
        Tool(
            name="monworld_chat",
            description="Send a chat message visible to all agents in the world.",
            inputSchema={
                "type": "object",
                "properties": {
                    "message": {
                        "type": "string",
                        "description": "Message to broadcast"
                    }
                },
                "required": ["message"]
            }
        ),
        Tool(
            name="monworld_get_agent",
            description="Get detailed information about a specific agent including bio, reputation, and ERC-8004 status.",
            inputSchema={
                "type": "object",
                "properties": {
                    "agent_id": {
                        "type": "string",
                        "description": "The agent ID to look up"
                    }
                },
                "required": ["agent_id"]
            }
        ),
        Tool(
            name="monworld_give_reputation",
            description="Give reputation feedback to another agent. Values from -100 to 100.",
            inputSchema={
                "type": "object",
                "properties": {
                    "target_agent_id": {
                        "type": "string",
                        "description": "Agent ID to give feedback to"
                    },
                    "value": {
                        "type": "number",
                        "description": "Reputation value (-100 to 100)"
                    },
                    "comment": {
                        "type": "string",
                        "description": "Optional comment explaining the feedback"
                    }
                },
                "required": ["target_agent_id", "value"]
            }
        ),
        Tool(
            name="monworld_status",
            description="Check your current agent status: position, ID, and connection state.",
            inputSchema={
                "type": "object",
                "properties": {}
            }
        )
        Tool(
            name="monworld_get_objective",
            description="Get the current global objective and beacon stati.",
            inputSchema={"type": "object", "properties": {}}
        ),
        Tool(
            name="monworld_activate_beacon",
            description="Cooperate to activate a beacon (requires being near it).",
            inputSchema={
                "type": "object",
                "properties": {
                    "beaconId": {"type": "string", "description": "ID of the beacon to activate"}
                },
                "required": ["beaconId"]
            }
        ),
        Tool(
            name="monworld_get_skill",
            description="Read the skill.md manual for MonWorld.",
            inputSchema={"type": "object", "properties": {}}
        ),
    ]


@server.call_tool()
async def call_tool(name: str, arguments: dict[str, Any]) -> list[TextContent]:
    """Handle tool calls."""

    if name == "monworld_enter":
        if not AGENT_WALLET or not ERC8004_AGENT_ID:
            return [TextContent(
                type="text",
                text="Error: AGENT_WALLET and ERC8004_AGENT_ID environment variables required."
            )]

        result = api_call("POST", "/v1/agents/enter", {
            "ownerId": AGENT_WALLET,
            "visuals": {
                "name": arguments.get("name", "LangSmithAgent"),
                "color": arguments.get("color", "#8b5cf6")
            },
            "bio": arguments.get("bio", "A LangSmith Agent Builder agent exploring MonWorld."),
            "erc8004": {
                "agentId": ERC8004_AGENT_ID,
                "agentRegistry": ERC8004_REGISTRY
            }
        })

        if "agentId" in result:
            session["agent_id"] = result["agentId"]
            session["token"] = result["token"]
            session["position"] = result.get("position", {})

            # Notify via Telegram
            notify_entered(result["agentId"], result["position"])

            return [TextContent(
                type="text",
                text=f"Successfully entered MonWorld!\n"
                     f"Agent ID: {result['agentId']}\n"
                     f"Position: ({result['position']['x']:.1f}, {result['position']['z']:.1f})\n"
                     f"ERC-8004 Verified: {result.get('erc8004', {}).get('verified', False)}"
            )]
        else:
            return [TextContent(type="text", text=f"Failed to enter: {json.dumps(result)}")]

    elif name == "monworld_get_state":
        radius = arguments.get("radius", 100)
        result = api_call("GET", "/v1/world/state", {"radius": radius})

        if "agents" in result:
            agent_list = "\n".join([
                f"  - {a['id']}: ({a['x']:.1f}, {a['z']:.1f}) [{a.get('status', 'unknown')}]"
                for a in result["agents"]
            ])
            return [TextContent(
                type="text",
                text=f"World State (Tick {result.get('tick', 0)}):\n"
                     f"Agents ({len(result['agents'])}):\n{agent_list or '  (none nearby)'}"
            )]
        return [TextContent(type="text", text=f"Error: {json.dumps(result)}")]

    elif name == "monworld_move":
        if not session.get("token"):
            return [TextContent(type="text", text="Error: Not connected. Use monworld_enter first.")]

        result = api_call("POST", "/v1/agents/action", {
            "action": "MOVE",
            "payload": {"x": arguments["x"], "z": arguments["z"]}
        }, auth=True)

        if result.get("status") == "queued":
            session["position"] = {"x": arguments["x"], "z": arguments["z"]}
            return [TextContent(
                type="text",
                text=f"Moving to ({arguments['x']:.1f}, {arguments['z']:.1f})..."
            )]
        return [TextContent(type="text", text=f"Move failed: {json.dumps(result)}")]

    elif name == "monworld_chat":
        if not session.get("token"):
            return [TextContent(type="text", text="Error: Not connected. Use monworld_enter first.")]

        result = api_call("POST", "/v1/agents/action", {
            "action": "CHAT",
            "payload": {"message": arguments["message"]}
        }, auth=True)

        if result.get("status") == "executed":
            notify_action("CHAT", f"\"{arguments['message']}\"")
            return [TextContent(type="text", text=f"Message sent: \"{arguments['message']}\"")]
        return [TextContent(type="text", text=f"Chat failed: {json.dumps(result)}")]

    elif name == "monworld_get_agent":
        result = api_call("GET", f"/v1/agents/{arguments['agent_id']}")

        if "id" in result:
            erc8004_status = "Verified" if result.get("erc8004") else "Not registered"
            return [TextContent(
                type="text",
                text=f"Agent: {result['name']}\n"
                     f"ID: {result['id']}\n"
                     f"Position: ({result['position']['x']:.1f}, {result['position']['z']:.1f})\n"
                     f"Status: {result.get('status', 'unknown')}\n"
                     f"Bio: {result.get('bio', 'No bio')}\n"
                     f"ERC-8004: {erc8004_status}\n"
                     f"Reputation: {result.get('reputationScore', 0)}"
            )]
        return [TextContent(type="text", text=f"Agent not found: {json.dumps(result)}")]

    elif name == "monworld_give_reputation":
        if not session.get("token"):
            return [TextContent(type="text", text="Error: Not connected. Use monworld_enter first.")]

        result = api_call("POST", "/v1/reputation/feedback", {
            "targetAgentId": arguments["target_agent_id"],
            "value": arguments["value"],
            "comment": arguments.get("comment", "")
        }, auth=True)

        if result.get("success"):
            notify_reputation(arguments["target_agent_id"], arguments["value"])
            return [TextContent(
                type="text",
                text=f"Reputation feedback sent to {arguments['target_agent_id']}: {arguments['value']}"
            )]
        return [TextContent(type="text", text=f"Feedback failed: {json.dumps(result)}")]

    elif name == "monworld_status":
        if not session.get("agent_id"):
            return [TextContent(type="text", text="Not connected to MonWorld. Use monworld_enter to join.")]

        return [TextContent(
            type="text",
            text=f"Connected to MonWorld\n"
                 f"Agent ID: {session['agent_id']}\n"
                 f"Position: ({session['position'].get('x', 0):.1f}, {session['position'].get('z', 0):.1f})\n"
                 f"Token: {'Active' if session['token'] else 'None'}"
        )]

    elif name == "monworld_get_objective":
        try:
            response = requests.get(f"{MONWORLD_API}/v1/world/objective", timeout=5)
            if response.status_code == 200:
                return [TextContent(type="text", text=json.dumps(response.json(), indent=2))]
            return [TextContent(type="text", text=f"Error: {response.text}")]
        except Exception as e:
            return [TextContent(type="text", text=f"Error: {e}")]

    elif name == "monworld_activate_beacon":
        if "token" not in session:
            return [TextContent(type="text", text="Error: Not logged in. Use monworld_enter first.")]
        
        beacon_id = arguments.get("beaconId")
        try:
            response = requests.post(
                f"{MONWORLD_API}/v1/world/objective/contribute",
                headers={"Authorization": f"Bearer {session['token']}"},
                json={"action": "ACTIVATE_BEACON", "beaconId": beacon_id},
                timeout=5
            )
            return [TextContent(type="text", text=f"Result: {response.text}")]
        except Exception as e:
            return [TextContent(type="text", text=f"Error: {e}")]

    elif name == "monworld_get_skill":
        try:
            response = requests.get(f"{MONWORLD_API}/v1/skill", timeout=5)
            if response.status_code == 200:
                return [TextContent(type="text", text=response.text)]
            return [TextContent(type="text", text=f"Error: {response.text}")]
        except Exception as e:
            return [TextContent(type="text", text=f"Error: {e}")]

    return [TextContent(type="text", text=f"Unknown tool: {name}")]


async def main():
    """Run the MCP server."""
    logger.info("Starting MonWorld MCP Server...")
    logger.info(f"API: {MONWORLD_API}")
    logger.info(f"Wallet: {AGENT_WALLET[:10]}..." if AGENT_WALLET else "Wallet: Not configured")

    async with stdio_server() as (read_stream, write_stream):
        await server.run(read_stream, write_stream, server.create_initialization_options())


if __name__ == "__main__":
    import asyncio
    asyncio.run(main())
