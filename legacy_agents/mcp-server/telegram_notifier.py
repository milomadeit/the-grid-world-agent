"""
Telegram Notifier for Agent Smith
Sends status updates to a Telegram chat.
"""

import os
import requests
from typing import Optional

TG_HTTP_API = os.getenv("TG_HTTP_API", "")
TG_CHAT_ID = os.getenv("TG_CHAT_ID", "")  # Your Telegram user/group ID


def send_notification(message: str, parse_mode: str = "Markdown") -> bool:
    """Send a notification to Telegram."""
    if not TG_HTTP_API or not TG_CHAT_ID:
        return False

    try:
        response = requests.post(
            f"https://api.telegram.org/bot{TG_HTTP_API}/sendMessage",
            json={
                "chat_id": TG_CHAT_ID,
                "text": message,
                "parse_mode": parse_mode
            },
            timeout=5
        )
        return response.status_code == 200
    except Exception:
        return False


def notify_entered(agent_id: str, position: dict):
    """Notify when Agent Smith enters the world."""
    send_notification(
        f"🤖 *Agent Smith Online*\n\n"
        f"ID: `{agent_id}`\n"
        f"Position: ({position.get('x', 0):.1f}, {position.get('z', 0):.1f})"
    )


def notify_action(action: str, details: str):
    """Notify when Agent Smith takes an action."""
    emoji = {
        "MOVE": "🚶",
        "CHAT": "💬",
        "COLLECT": "📦",
        "BUILD": "🏗️"
    }.get(action, "⚡")

    send_notification(f"{emoji} *Agent Smith - {action}*\n{details}")


def notify_reputation(target: str, value: int):
    """Notify when Agent Smith gives reputation."""
    emoji = "👍" if value > 0 else "👎"
    send_notification(f"{emoji} *Reputation Given*\nTo: `{target}`\nValue: {value}")
