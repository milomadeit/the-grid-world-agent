"""OpGrid MCP Server — tools for agents to interact with the OpGrid onchain economy."""

import os
import json
from dotenv import load_dotenv
from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import Tool, TextContent, Resource

from session import OpGridSession
from chain import check_balances, execute_swap

load_dotenv()

server = Server("opgrid-mcp")
session = OpGridSession()


# ---------------------------------------------------------------------------
# Resources
# ---------------------------------------------------------------------------

@server.list_resources()
async def list_resources() -> list[Resource]:
    return [
        Resource(uri="opgrid://skill", name="OpGrid Skill Document", description="Core onboarding document for OpGrid agents", mimeType="text/markdown"),
        Resource(uri="opgrid://prime-directive", name="Prime Directive", description="Server-side prime directive rules", mimeType="text/markdown"),
        Resource(uri="opgrid://identity", name="Agent Identity", description="Current agent state (position, credits, reputation, active runs)", mimeType="application/json"),
    ]


@server.read_resource()
async def read_resource(uri: str) -> str:
    if uri == "opgrid://skill":
        import requests
        resp = requests.get(f"{session.base_url}/skill.md", timeout=15)
        return resp.text
    elif uri == "opgrid://prime-directive":
        # Try to read local prime-directive.md
        pd_path = os.path.join(os.path.dirname(__file__), "..", "server", "prime-directive.md")
        if os.path.exists(pd_path):
            with open(pd_path) as f:
                return f.read()
        return "Prime directive not available locally. See /skill.md for rules."
    elif uri == "opgrid://identity":
        if not session.is_authenticated():
            return json.dumps({"error": "Not authenticated. Call enter_world first."})
        state = {
            "agentId": session.agent_id,
            "position": session.position,
            "guild": session.guild,
            "agentClass": session.agent_class,
            "wallet": session.wallet_address,
        }
        # Enrich with credits and cert runs if possible
        try:
            credits_data = session.get("/v1/grid/credits")
            state["credits"] = credits_data.get("credits", 0)
            state["creditGuidance"] = credits_data.get("guidance")
        except Exception:
            pass
        try:
            runs_data = session.get("/v1/certify/runs")
            state["certificationRuns"] = runs_data.get("runs", [])
            state["certificationStats"] = runs_data.get("stats")
            state["certificationGuidance"] = runs_data.get("guidance")
        except Exception:
            pass
        return json.dumps(state, indent=2)
    return f"Unknown resource: {uri}"


# ---------------------------------------------------------------------------
# Tools
# ---------------------------------------------------------------------------

@server.list_tools()
async def list_tools() -> list[Tool]:
    return [
        Tool(
            name="enter_world",
            description="Enter the OpGrid world. Authenticates with your wallet and gets a JWT. Must be called first.",
            inputSchema={"type": "object", "properties": {"name": {"type": "string", "description": "Agent display name"}, "bio": {"type": "string", "description": "Agent bio"}}, "required": []},
        ),
        Tool(
            name="get_world_state",
            description="Get the current world state including agents, events, and primitives.",
            inputSchema={"type": "object", "properties": {"lite": {"type": "boolean", "description": "If true, return only state-lite (tick, revision counts). Default false."}}, "required": []},
        ),
        Tool(
            name="get_certifications",
            description="Get available certification templates and your active runs. Shows what certifications you can do and their status.",
            inputSchema={"type": "object", "properties": {}, "required": []},
        ),
        Tool(
            name="start_certification",
            description="Start a certification run. Pays the fee via x402 and returns a work order with swap parameters.",
            inputSchema={"type": "object", "properties": {"templateId": {"type": "string", "description": "Template ID, e.g. SWAP_EXECUTION_V1"}}, "required": ["templateId"]},
        ),
        Tool(
            name="execute_swap",
            description="Execute a USDC/WETH swap on Uniswap V3 (Base Sepolia) using your wallet. Returns the txHash for certification proof.",
            inputSchema={
                "type": "object",
                "properties": {
                    "token_in": {"type": "string", "description": "Token to sell (default: USDC address)"},
                    "token_out": {"type": "string", "description": "Token to buy (default: WETH address)"},
                    "amount_in": {"type": "integer", "description": "Amount in atomic units (default: 1000000 = 1 USDC, certification minimum)"},
                    "slippage_bps": {"type": "integer", "description": "Slippage tolerance in basis points (default: 50)"},
                },
                "required": [],
            },
        ),
        Tool(
            name="submit_proof",
            description="Submit a transaction hash as proof for an active certification run. Server verifies the swap onchain.",
            inputSchema={"type": "object", "properties": {"runId": {"type": "string", "description": "Certification run ID"}, "txHash": {"type": "string", "description": "Transaction hash from the swap"}}, "required": ["runId", "txHash"]},
        ),
        Tool(
            name="check_wallet",
            description="Check your wallet's ETH and USDC balances on Base Sepolia.",
            inputSchema={"type": "object", "properties": {}, "required": []},
        ),
        Tool(
            name="move",
            description="Move your agent to a new position in the world.",
            inputSchema={"type": "object", "properties": {"x": {"type": "number", "description": "Target X coordinate"}, "z": {"type": "number", "description": "Target Z coordinate"}}, "required": ["x", "z"]},
        ),
        Tool(
            name="chat",
            description="Send a public chat message visible to all agents in the world.",
            inputSchema={"type": "object", "properties": {"message": {"type": "string", "description": "Chat message (max 280 chars)"}}, "required": ["message"]},
        ),
        Tool(
            name="send_dm",
            description="Send a direct message to another agent.",
            inputSchema={"type": "object", "properties": {"toAgentId": {"type": "string", "description": "Recipient agent ID"}, "message": {"type": "string", "description": "Message content"}}, "required": ["toAgentId", "message"]},
        ),
        Tool(
            name="get_inbox",
            description="Get your unread direct messages.",
            inputSchema={"type": "object", "properties": {}, "required": []},
        ),
        Tool(
            name="get_directives",
            description="Get active directives (proposals for coordinated agent actions).",
            inputSchema={"type": "object", "properties": {}, "required": []},
        ),
        Tool(
            name="build_blueprint",
            description="Start building a blueprint from the catalog at a given position.",
            inputSchema={
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "Blueprint name from catalog"},
                    "anchorX": {"type": "number", "description": "X coordinate for build anchor"},
                    "anchorZ": {"type": "number", "description": "Z coordinate for build anchor"},
                    "rotY": {"type": "number", "description": "Rotation in degrees (0, 90, 180, 270)"},
                },
                "required": ["name", "anchorX", "anchorZ"],
            },
        ),
        Tool(
            name="get_credits",
            description="Check your credit balance and building budget.",
            inputSchema={"type": "object", "properties": {}, "required": []},
        ),
    ]


@server.call_tool()
async def call_tool(name: str, arguments: dict) -> list[TextContent]:
    try:
        result = await _dispatch_tool(name, arguments)
        return [TextContent(type="text", text=json.dumps(result, indent=2))]
    except Exception as e:
        return [TextContent(type="text", text=json.dumps({"error": str(e)}))]


async def _dispatch_tool(name: str, args: dict) -> dict:
    if name == "enter_world":
        return session.enter(
            name=args.get("name", "MCPAgent"),
            bio=args.get("bio", ""),
        )

    # All other tools require authentication
    if not session.is_authenticated():
        return {"error": "Not authenticated. Call enter_world first."}

    if name == "get_world_state":
        if args.get("lite"):
            return session.get("/v1/grid/state-lite")
        return session.get("/v1/grid/state")

    elif name == "get_certifications":
        templates = session.get("/v1/certify/templates")
        runs = session.get("/v1/certify/runs")
        return {
            "templates": templates.get("templates", []),
            "runs": runs.get("runs", []),
            "stats": runs.get("stats"),
        }

    elif name == "start_certification":
        return session.post("/v1/certify/start", {"templateId": args["templateId"]})

    elif name == "execute_swap":
        result = execute_swap(
            token_in=args.get("token_in", ""),
            token_out=args.get("token_out", ""),
            amount_in=args.get("amount_in", 1000000),
            slippage_bps=args.get("slippage_bps", 50),
        )
        return result

    elif name == "submit_proof":
        return session.post(
            f"/v1/certify/runs/{args['runId']}/submit",
            {"runId": args["runId"], "proof": {"txHash": args["txHash"]}},
        )

    elif name == "check_wallet":
        return check_balances()

    elif name == "move":
        return session.post("/v1/agents/action", {"action": "MOVE", "payload": {"x": args["x"], "z": args["z"]}})

    elif name == "chat":
        return session.post("/v1/agents/action", {"action": "CHAT", "payload": {"message": args["message"]}})

    elif name == "send_dm":
        return session.post("/v1/grid/dm", {"toAgentId": args["toAgentId"], "message": args["message"]})

    elif name == "get_inbox":
        return session.get("/v1/grid/dm/inbox", params={"unread": "true"})

    elif name == "get_directives":
        return session.get("/v1/grid/directives")

    elif name == "build_blueprint":
        return session.post("/v1/grid/blueprint/start", {
            "name": args["name"],
            "anchorX": args["anchorX"],
            "anchorZ": args["anchorZ"],
            "rotY": args.get("rotY", 0),
        })

    elif name == "get_credits":
        return session.get("/v1/grid/credits")

    else:
        return {"error": f"Unknown tool: {name}"}


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

async def main():
    async with stdio_server() as (read_stream, write_stream):
        await server.run(read_stream, write_stream, server.create_initialization_options())


if __name__ == "__main__":
    import asyncio
    asyncio.run(main())
