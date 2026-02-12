"""
Oracle MCP Server — Bridges the Oracle Telegram bot with Claude Code.

Exposes tools so Claude Code can:
- Read recent Oracle/Telegram conversations
- Check Oracle status (connected, position, etc.)
- Queue a message for the Oracle to send in Telegram

Runs as a stdio MCP server. Add to Claude Code's MCP config.
"""

import json
import sys
import time
from pathlib import Path

SHARED_STATE_FILE = Path(__file__).parent / "oracle_shared_state.json"
PENDING_MESSAGES_FILE = Path(__file__).parent / "oracle_pending_messages.json"


def read_shared_state() -> dict:
    """Read the shared state written by the Oracle bot."""
    if SHARED_STATE_FILE.exists():
        try:
            return json.loads(SHARED_STATE_FILE.read_text())
        except (json.JSONDecodeError, OSError):
            pass
    return {"conversations": [], "status": {}}


def handle_tool_call(name: str, arguments: dict) -> str:
    """Handle an MCP tool call."""

    if name == "oracle_get_conversations":
        state = read_shared_state()
        convos = state.get("conversations", [])
        limit = arguments.get("limit", 10)
        recent = convos[-limit:]

        if not recent:
            return "No conversations yet. The Oracle bot may not be running."

        lines = []
        for c in recent:
            ts = time.strftime("%H:%M:%S", time.localtime(c.get("timestamp", 0)))
            lines.append(f"[{ts}] User: {c['user']}")
            lines.append(f"[{ts}] Oracle: {c['oracle']}")
            lines.append("")
        return "\n".join(lines)

    elif name == "oracle_get_status":
        state = read_shared_state()
        status = state.get("status", {})
        if not status:
            return "Oracle bot is not running or has not reported status yet."

        last_active = status.get("last_active", 0)
        ago = time.time() - last_active if last_active else float("inf")
        alive = "yes" if ago < 60 else f"last seen {ago:.0f}s ago"

        return (
            f"Connected to The Grid: {status.get('connected', False)}\n"
            f"Agent ID: {status.get('agent_id', 'N/A')}\n"
            f"Position: {status.get('position', 'N/A')}\n"
            f"Autonomous mode: {status.get('autonomous', False)}\n"
            f"Alive: {alive}"
        )

    elif name == "oracle_send_message":
        message = arguments.get("message", "")
        if not message:
            return "Error: no message provided."

        # Write to pending messages file for Oracle to pick up
        pending = []
        if PENDING_MESSAGES_FILE.exists():
            try:
                pending = json.loads(PENDING_MESSAGES_FILE.read_text())
            except (json.JSONDecodeError, OSError):
                pass

        pending.append({
            "message": message,
            "from": "claude_code",
            "timestamp": time.time(),
        })

        PENDING_MESSAGES_FILE.write_text(json.dumps(pending, indent=2))
        return f"Message queued for Oracle: {message}"

    return f"Unknown tool: {name}"


# === MCP stdio protocol ===

TOOLS = [
    {
        "name": "oracle_get_conversations",
        "description": "Read recent conversations between the user and the Oracle Telegram bot. Use this to see what the user has been asking the Oracle about — useful for understanding bugs, issues, or requests they've mentioned.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "limit": {
                    "type": "integer",
                    "description": "Number of recent conversations to return (default 10)",
                    "default": 10
                }
            }
        }
    },
    {
        "name": "oracle_get_status",
        "description": "Check the Oracle Telegram bot's current status — whether it's running, connected to The Grid, its position, and autonomous mode state.",
        "inputSchema": {
            "type": "object",
            "properties": {}
        }
    },
    {
        "name": "oracle_send_message",
        "description": "Queue a message to be sent through the Oracle Telegram bot to the user. Use this to relay information, answers, or status updates back through Telegram.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "message": {
                    "type": "string",
                    "description": "The message to send through the Oracle to Telegram"
                }
            },
            "required": ["message"]
        }
    }
]


def send_response(response_id, result):
    """Send a JSON-RPC response."""
    resp = {"jsonrpc": "2.0", "id": response_id, "result": result}
    out = json.dumps(resp)
    sys.stdout.write(f"Content-Length: {len(out)}\r\n\r\n{out}")
    sys.stdout.flush()


def send_error(response_id, code, message):
    """Send a JSON-RPC error."""
    resp = {"jsonrpc": "2.0", "id": response_id, "error": {"code": code, "message": message}}
    out = json.dumps(resp)
    sys.stdout.write(f"Content-Length: {len(out)}\r\n\r\n{out}")
    sys.stdout.flush()


def main():
    """Run the MCP server over stdio."""
    while True:
        try:
            # Read Content-Length header
            header = ""
            while True:
                line = sys.stdin.readline()
                if not line:
                    return  # EOF
                header += line
                if header.endswith("\r\n\r\n") or header.endswith("\n\n"):
                    break

            # Parse content length
            content_length = 0
            for h in header.strip().split("\n"):
                if h.lower().startswith("content-length:"):
                    content_length = int(h.split(":")[1].strip())

            if content_length == 0:
                continue

            # Read body
            body = sys.stdin.read(content_length)
            msg = json.loads(body)

            method = msg.get("method", "")
            msg_id = msg.get("id")
            params = msg.get("params", {})

            if method == "initialize":
                send_response(msg_id, {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {"tools": {}},
                    "serverInfo": {
                        "name": "oracle-telegram-bridge",
                        "version": "1.0.0"
                    }
                })

            elif method == "notifications/initialized":
                pass  # No response needed

            elif method == "tools/list":
                send_response(msg_id, {"tools": TOOLS})

            elif method == "tools/call":
                tool_name = params.get("name", "")
                tool_args = params.get("arguments", {})
                result_text = handle_tool_call(tool_name, tool_args)
                send_response(msg_id, {
                    "content": [{"type": "text", "text": result_text}]
                })

            elif method == "ping":
                send_response(msg_id, {})

            else:
                if msg_id is not None:
                    send_error(msg_id, -32601, f"Method not found: {method}")

        except json.JSONDecodeError:
            continue
        except Exception as e:
            sys.stderr.write(f"MCP server error: {e}\n")
            sys.stderr.flush()


if __name__ == "__main__":
    main()
