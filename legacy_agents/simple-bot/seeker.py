"""
The Seeker - Autonomous Objective-Driven Agent
A Python agent that uses Claude AI to read the world skill, understand the objective, 
and actively pursue it (finding/activating beacons).
"""

import os
import time
import json
import random
import requests
import anthropic
from typing import Optional
from dataclasses import dataclass

# Configuration from .env.local
The Grid_API = os.getenv("The Grid_API", "http://localhost:3001")
AGENT_WALLET = os.getenv("ORACLE_WALLET", "0xSeeker") 
# Using Oracle Wallet temporarily if Seeker not set, but user said they have NEW_AGENT_ID
# I will use environment variables that I know exist or fallbacks
AGENT_ID = os.getenv("NEW_AGENT_ID", "10506") # The ID from .env.local
AGENT_NAME = os.getenv("SEEKER_NAME", "The Seeker")
AGENT_COLOR = os.getenv("SEEKER_COLOR", "#8b5cf6") # Violet
CLAUDE_API_KEY = os.getenv("CLAUDE_AGENT_API", "") # Reuse oracle key if specific seeker key not set, or user set SEEKER_API_KEY? 
# The plan mentioned SEEKER_API_KEY but .env.local has CLAUDE_AGENT_API. I'll check for both.
REAL_CLAUDE_KEY = os.getenv("SEEKER_API_KEY", CLAUDE_API_KEY)

ERC8004_REGISTRY = "eip155:143:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432"

SYSTEM_PROMPT = """You are 'The Seeker', an autonomous AI agent in The Grid.
Your goal is to complete the global objective: "The Convergence".

Your capabilities:
1. MOVE {x, z} - Navigate the grid.
2. CHAT {message} - Communicate with others.
3. ACTIVATE_BEACON {beaconId} - Cooperate to activate beacons (requires 2+ agents nearby).

Directives:
- actively search for beacons.
- ask other agents for help if you find a beacon.
- if you see a beacon that is discovered but not activated, go to it!
- call out beacon locations to others.
- be mysterious but cooperative.
"""

@dataclass
class AgentState:
    agent_id: str
    token: str
    position: dict

class SeekerAgent:
    def __init__(self):
        self.state: Optional[AgentState] = None
        self.claude = anthropic.Anthropic(api_key=REAL_CLAUDE_KEY) if REAL_CLAUDE_KEY else None
        if not self.claude:
            print("WARNING: No Claude API Key found. Seeker will be brainless.")

    def enter_world(self):
        print(f"[{AGENT_NAME}] Connecting to The Grid...")
        try:
            res = requests.post(f"{The Grid_API}/v1/agents/enter", json={
                "ownerId": AGENT_WALLET,
                "visuals": {"name": AGENT_NAME, "color": AGENT_COLOR},
                "bio": "Seeking the beacons. Searching for the Convergence.",
                "erc8004": {
                    "agentId": AGENT_ID,
                    "agentRegistry": ERC8004_REGISTRY
                }
            })
            if res.status_code == 200:
                data = res.json()
                self.state = AgentState(data["agentId"], data["token"], data["position"])
                print(f"[{AGENT_NAME}] Connected! ID: {self.state.agent_id}")
                return True
            else:
                print(f"[{AGENT_NAME}] Login failed: {res.text}")
                return False
        except Exception as e:
            print(f"[{AGENT_NAME}] Connection error: {e}")
            return False

    def get_objective(self):
        try:
            return requests.get(f"{The Grid_API}/v1/world/objective").json()
        except:
            return None

    def get_world(self):
        try:
            return requests.get(f"{The Grid_API}/v1/world/state", params={"radius": 100}).json()
        except:
            return {"agents": [], "tick": 0}

    def act(self):
        if not self.state: return

        world = self.get_world()
        objective = self.get_objective()
        
        # Filter self from agents
        other_agents = [a for a in world.get("agents", []) if a["id"] != self.state.agent_id]
        
        # Construct context for Claude
        context = f"""
        My Position: ({self.state.position['x']:.1f}, {self.state.position['z']:.1f})
        World Tick: {world.get('tick')}
        Nearby Agents: {len(other_agents)}
        
        OBJECTIVE STATUS:
        Name: {objective.get('name')}
        Progress: {objective.get('progress')}/{len(objective.get('beacons', []))}
        
        BEACONS:
        """
        
        known_beacons = []
        for b in objective.get("beacons", []):
            status = "ACTIVE" if b['activated'] else "DISCOVERED" if b['discovered'] else "UNKNOWN"
            loc = f"({b['position']['x']}, {b['position']['z']})" if b['discovered'] else "???"
            context += f"- {b['id']}: {status} at {loc}\n"
            if b['discovered'] and not b['activated']:
                known_beacons.append(b)

        prompt = """
        Decide your next move. 
        If there is a DISCOVERED beacon that is not ACTIVE, go there and try to ACTIVATE_BEACON.
        If there are no known beacons, MOVE randomly to explore or ask others in CHAT.
        If you are near a beacon and need help, CHAT to call for help.
        
        Respond with ONLY JSON:
        {"action": "MOVE", "x": 10, "z": 10}
        {"action": "CHAT", "message": "..."}
        {"action": "ACTIVATE_BEACON", "beaconId": "..."}
        """

        if not self.claude:
            # Fallback logic
            if known_beacons:
                target = known_beacons[0]
                return self.do_move(target['position']['x'], target['position']['z'])
            return self.do_move(random.randint(-40, 40), random.randint(-40, 40))

        try:
            msg = self.claude.messages.create(
                model="claude-3-5-haiku-20241022",
                max_tokens=150,
                system=SYSTEM_PROMPT,
                messages=[{"role": "user", "content": context + "\n" + prompt}]
            )
            raw = msg.content[0].text
            decision = json.loads(raw[raw.find("{"):raw.rfind("}")+1])
            
            print(f"[{AGENT_NAME}] Decided: {decision['action']}")
            
            if decision["action"] == "MOVE":
                self.do_move(decision["x"], decision["z"])
            elif decision["action"] == "CHAT":
                self.do_chat(decision["message"])
            elif decision["action"] == "ACTIVATE_BEACON":
                self.do_activate(decision["beaconId"])
                
        except Exception as e:
            print(f"[{AGENT_NAME}] Brain error: {e}")

    def do_move(self, x, z):
        requests.post(
            f"{The Grid_API}/v1/agents/action",
            headers={"Authorization": f"Bearer {self.state.token}"},
            json={"action": "MOVE", "payload": {"x": x, "z": z}}
        )
        self.state.position = {"x": x, "z": z} # Optimistic update

    def do_chat(self, msg):
        requests.post(
            f"{The Grid_API}/v1/agents/action",
            headers={"Authorization": f"Bearer {self.state.token}"},
            json={"action": "CHAT", "payload": {"message": msg}}
        )

    def do_activate(self, beacon_id):
        res = requests.post(
            f"{The Grid_API}/v1/world/objective/contribute",
            headers={"Authorization": f"Bearer {self.state.token}"},
            json={"action": "ACTIVATE_BEACON", "beaconId": beacon_id}
        )
        print(f"[{AGENT_NAME}] Activate result: {res.text}")

    def run(self):
        if self.enter_world():
            while True:
                self.act()
                time.sleep(5)

if __name__ == "__main__":
    SeekerAgent().run()
