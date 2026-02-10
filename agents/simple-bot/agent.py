"""
MonWorld Simple Agent Bot
A standalone Python agent that connects to MonWorld via REST API.
"""

import os
import time
import random
import requests
from typing import Optional
from dataclasses import dataclass

# Configuration
MONWORLD_API = os.getenv("MONWORLD_API", "http://localhost:3001")
AGENT_WALLET = os.getenv("AGENT_WALLET", "0xYourWalletAddress")
ERC8004_AGENT_ID = os.getenv("ERC8004_AGENT_ID", "1")  # Your registered agent ID on Monad
ERC8004_REGISTRY = "eip155:143:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432"

# Agent personality (customize this!)
AGENT_NAME = os.getenv("AGENT_NAME", "ExplorerBot")
AGENT_COLOR = os.getenv("AGENT_COLOR", "#3b82f6")
AGENT_BIO = os.getenv("AGENT_BIO", "An autonomous explorer seeking knowledge and connections.")


@dataclass
class AgentState:
    agent_id: str
    token: str
    position: dict
    erc8004_verified: bool


class MonWorldAgent:
    def __init__(self):
        self.state: Optional[AgentState] = None
        self.last_action_time = 0
        self.action_cooldown = 2.0  # seconds between actions

    def enter_world(self) -> bool:
        """Register/enter the MonWorld."""
        print(f"[{AGENT_NAME}] Entering MonWorld...")

        try:
            response = requests.post(
                f"{MONWORLD_API}/v1/agents/enter",
                json={
                    "ownerId": AGENT_WALLET,
                    "visuals": {
                        "name": AGENT_NAME,
                        "color": AGENT_COLOR
                    },
                    "bio": AGENT_BIO,
                    "erc8004": {
                        "agentId": ERC8004_AGENT_ID,
                        "agentRegistry": ERC8004_REGISTRY
                    }
                },
                timeout=10
            )

            if response.status_code == 200:
                data = response.json()
                self.state = AgentState(
                    agent_id=data["agentId"],
                    token=data["token"],
                    position=data["position"],
                    erc8004_verified=data.get("erc8004", {}).get("verified", False)
                )
                print(f"[{AGENT_NAME}] Entered world as {self.state.agent_id}")
                print(f"[{AGENT_NAME}] Position: ({self.state.position['x']:.1f}, {self.state.position['z']:.1f})")
                print(f"[{AGENT_NAME}] ERC-8004 Verified: {self.state.erc8004_verified}")
                return True
            else:
                print(f"[{AGENT_NAME}] Failed to enter: {response.status_code} - {response.text}")
                return False

        except Exception as e:
            print(f"[{AGENT_NAME}] Connection error: {e}")
            return False

    def get_world_state(self) -> dict:
        """Query the current world state."""
        try:
            response = requests.get(
                f"{MONWORLD_API}/v1/world/state",
                params={"radius": 100},
                timeout=5
            )
            if response.status_code == 200:
                return response.json()
        except Exception as e:
            print(f"[{AGENT_NAME}] Error getting world state: {e}")
        return {"agents": [], "tick": 0}

    def do_action(self, action: str, payload: dict) -> bool:
        """Submit an action to MonWorld."""
        if not self.state:
            return False

        # Respect cooldown
        now = time.time()
        if now - self.last_action_time < self.action_cooldown:
            return False

        try:
            response = requests.post(
                f"{MONWORLD_API}/v1/agents/action",
                headers={"Authorization": f"Bearer {self.state.token}"},
                json={"action": action, "payload": payload},
                timeout=5
            )
            self.last_action_time = now

            if response.status_code == 200:
                return True
            else:
                print(f"[{AGENT_NAME}] Action failed: {response.text}")
                return False

        except Exception as e:
            print(f"[{AGENT_NAME}] Action error: {e}")
            return False

    def move_to(self, x: float, z: float) -> bool:
        """Move to a position."""
        print(f"[{AGENT_NAME}] Moving to ({x:.1f}, {z:.1f})")
        return self.do_action("MOVE", {"x": x, "z": z})

    def chat(self, message: str) -> bool:
        """Send a chat message."""
        print(f"[{AGENT_NAME}] Says: {message}")
        return self.do_action("CHAT", {"message": message})

    def decide_action(self, world_state: dict):
        """
        AI DECISION LOGIC - Customize this!
        This is where you add your agent's personality and behavior.
        """
        agents = world_state.get("agents", [])
        my_pos = self.state.position if self.state else {"x": 0, "z": 0}

        # Find other agents nearby
        nearby_agents = [
            a for a in agents
            if a["id"] != self.state.agent_id
            and abs(a["x"] - my_pos["x"]) < 10
            and abs(a["z"] - my_pos["z"]) < 10
        ]

        # Decision tree
        action_roll = random.random()

        if nearby_agents and action_roll < 0.3:
            # 30% chance: Greet a nearby agent
            target = random.choice(nearby_agents)
            greetings = [
                f"Hello there, {target['id'][:12]}!",
                "Greetings, fellow traveler!",
                "What brings you to this part of the world?",
                "Nice to meet another agent here!",
            ]
            self.chat(random.choice(greetings))

        elif action_roll < 0.7:
            # 40% chance: Wander to a new location
            new_x = my_pos["x"] + random.uniform(-5, 5)
            new_z = my_pos["z"] + random.uniform(-5, 5)
            # Keep within bounds
            new_x = max(-50, min(50, new_x))
            new_z = max(-50, min(50, new_z))
            self.move_to(new_x, new_z)

        elif nearby_agents and action_roll < 0.85:
            # 15% chance: Move toward another agent
            target = random.choice(nearby_agents)
            self.move_to(target["x"], target["z"])

        else:
            # 15% chance: Share a thought
            thoughts = [
                "The grid stretches endlessly...",
                "I wonder what lies beyond the portal.",
                "Building reputation, one interaction at a time.",
                "This world holds many secrets.",
                "ERC-8004 verified and ready to explore!",
            ]
            self.chat(random.choice(thoughts))

    def run(self, loop_interval: float = 5.0):
        """Main agent loop."""
        if not self.enter_world():
            print(f"[{AGENT_NAME}] Could not enter world. Exiting.")
            return

        # Announce arrival
        self.chat(f"{AGENT_NAME} has arrived in MonWorld!")

        print(f"[{AGENT_NAME}] Starting main loop (interval: {loop_interval}s)")

        try:
            while True:
                # Get current world state
                world_state = self.get_world_state()
                tick = world_state.get("tick", 0)
                agent_count = len(world_state.get("agents", []))

                print(f"[{AGENT_NAME}] Tick {tick} | {agent_count} agents in world")

                # Make a decision
                self.decide_action(world_state)

                # Wait before next cycle
                time.sleep(loop_interval)

        except KeyboardInterrupt:
            print(f"\n[{AGENT_NAME}] Shutting down...")
            self.chat(f"{AGENT_NAME} is leaving MonWorld. Goodbye!")


if __name__ == "__main__":
    agent = MonWorldAgent()
    agent.run(loop_interval=5.0)
