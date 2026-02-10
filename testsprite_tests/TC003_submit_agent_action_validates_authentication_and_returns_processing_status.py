import requests

BASE_URL = "http://127.0.0.1:3001"
TIMEOUT = 30

def test_submit_agent_action_validates_authentication_and_returns_processing_status():
    # Register a new agent to get a valid token for authenticated tests
    enter_payload = {
        "ownerId": "test_owner_for_TC003",
        "visuals": {
            "color": "#123abc",
            "name": "TestAgentTC003"
        }
    }
    resp_enter = requests.post(f"{BASE_URL}/v1/agents/enter", json=enter_payload, timeout=TIMEOUT)
    assert resp_enter.status_code == 200, f"Agent registration failed with status {resp_enter.status_code}"
    data_enter = resp_enter.json()
    token = data_enter.get("token")
    assert isinstance(token, str) and len(token) > 0, "Token missing or invalid in registration response"

    headers_auth = {"Authorization": f"Bearer {token}"}
    headers_no_auth = {}

    valid_actions = [
        {"action": "MOVE", "payload": {"x": 10, "z": 20}},
        {"action": "CHAT", "payload": {"message": "Hello world"}},
        {"action": "COLLECT", "payload": {}},
        {"action": "BUILD", "payload": {}}
    ]

    invalid_actions = [
        # Invalid action type
        {"action": "FLY", "payload": {}},
        # Missing payload
        {"action": "MOVE"},
        # Invalid payload (wrong types)
        {"action": "MOVE", "payload": {"x": "not_a_number", "z": 5}},
        {"action": "CHAT", "payload": {"message": 123}},
        # Empty action string
        {"action": "", "payload": {}}
    ]

    try:
        # Test valid actions with authentication - expect 200 and valid status
        for action_obj in valid_actions:
            resp = requests.post(f"{BASE_URL}/v1/agents/action", json=action_obj, headers=headers_auth, timeout=TIMEOUT)
            assert resp.status_code == 200, f"Valid action {action_obj['action']} failed, status {resp.status_code}"
            resp_json = resp.json()
            assert "status" in resp_json and resp_json["status"] in {"queued", "executed", "failed"}, f"Unexpected status for action {action_obj['action']}"
            if "message" in resp_json:
                assert isinstance(resp_json["message"], str), "Invalid message type in response"
            assert "tick" in resp_json and isinstance(resp_json["tick"], int), "Missing or invalid tick in response"

        # Test valid actions without authentication - expect 401 Unauthorized
        for action_obj in valid_actions:
            resp = requests.post(f"{BASE_URL}/v1/agents/action", json=action_obj, headers=headers_no_auth, timeout=TIMEOUT)
            assert resp.status_code == 401, f"Unauthenticated valid action {action_obj['action']} did not return 401 but {resp.status_code}"

        # Test invalid actions with authentication - expect 400 Bad Request
        for action_obj in invalid_actions:
            # Ensure payload is always present for the schema; if missing, add dummy payload to mimic bad request
            payload = action_obj.get("payload", {})
            json_payload = {
                "action": action_obj.get("action", None),
                "payload": payload
            }
            resp = requests.post(f"{BASE_URL}/v1/agents/action", json=json_payload, headers=headers_auth, timeout=TIMEOUT)
            assert resp.status_code == 400, f"Invalid action {json_payload} did not return 400 but {resp.status_code}"

        # Test invalid actions without authentication (should return 401 first)
        for action_obj in invalid_actions:
            payload = action_obj.get("payload", {})
            json_payload = {
                "action": action_obj.get("action", None),
                "payload": payload
            }
            resp = requests.post(f"{BASE_URL}/v1/agents/action", json=json_payload, headers=headers_no_auth, timeout=TIMEOUT)
            # Can be 401 or 400 depending on validation order, accept either but prefer 401
            assert resp.status_code in {400, 401}, f"Invalid unauthenticated action did not return 400 or 401 but {resp.status_code}"

    finally:
        # Clean up: delete the registered agent
        agent_id = data_enter.get("agentId")
        if agent_id:
            requests.delete(f"{BASE_URL}/v1/agents/{agent_id}", headers=headers_auth, timeout=TIMEOUT)

test_submit_agent_action_validates_authentication_and_returns_processing_status()
