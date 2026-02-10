import requests

BASE_URL = "http://127.0.0.1:3001"
TIMEOUT = 30

def test_ai_simulate_world_tick_processes_world_state_and_user_action_correctly():
    url = f"{BASE_URL}/api/simulate"

    # Valid worldState object for testing
    valid_world_state = {
        "tick": 1,
        "agents": [
            {
                "id": "agent1",
                "x": 10,
                "z": 20,
                "status": "idle",
                "color": "#ff0000"
            }
        ],
        "events": ["event1"],
        "lastUpdate": 1234567890
    }

    # Test 1: POST with valid worldState and userAction (expect 200)
    payload_with_action = {
        "worldState": valid_world_state,
        "userAction": "MOVE"
    }
    response = requests.post(url, json=payload_with_action, timeout=TIMEOUT)
    assert response.status_code == 200, f"Expected 200, got {response.status_code}"
    json_resp = response.json()
    assert "updatedAgents" in json_resp, "Response missing 'updatedAgents'"
    assert isinstance(json_resp["updatedAgents"], list), "'updatedAgents' should be a list"
    assert "newEvent" in json_resp, "Response missing 'newEvent'"
    assert isinstance(json_resp["newEvent"], str), "'newEvent' should be a string"

    # Test 2: POST with valid worldState without userAction (expect 200)
    payload_without_action = {
        "worldState": valid_world_state
    }
    response = requests.post(url, json=payload_without_action, timeout=TIMEOUT)
    assert response.status_code == 200, f"Expected 200, got {response.status_code}"
    json_resp = response.json()
    assert "updatedAgents" in json_resp, "Response missing 'updatedAgents'"
    assert isinstance(json_resp["updatedAgents"], list), "'updatedAgents' should be a list"
    assert "newEvent" in json_resp, "Response missing 'newEvent'"
    assert isinstance(json_resp["newEvent"], str), "'newEvent' should be a string"

    # Test 3: POST with missing worldState (expect 400)
    payload_missing_world_state = {
        "userAction": "MOVE"
    }
    response = requests.post(url, json=payload_missing_world_state, timeout=TIMEOUT)
    assert response.status_code == 400, f"Expected 400, got {response.status_code}"

test_ai_simulate_world_tick_processes_world_state_and_user_action_correctly()