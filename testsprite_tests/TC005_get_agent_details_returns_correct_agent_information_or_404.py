import requests

BASE_URL = "http://127.0.0.1:3001"
TIMEOUT = 30


def test_get_agent_details_returns_correct_agent_information_or_404():
    """
    Test the /v1/agents/{id} GET endpoint with valid and invalid agent IDs.
    Valid ID test: Should return 200 with full agent details (id, name, color, position, status, inventory).
    Invalid ID test: Should return 404.
    """
    # Step 1: Create a new agent to get a valid agent ID and token
    register_url = f"{BASE_URL}/v1/agents/enter"
    owner_id = "test-owner-tc005"
    register_payload = {
        "ownerId": owner_id,
        "visuals": {
            "color": "#123abc",
            "name": "TestAgentTC005"
        }
    }
    agent_id = None

    try:
        register_resp = requests.post(register_url, json=register_payload, timeout=TIMEOUT)
        assert register_resp.status_code == 200, f"Agent registration failed: {register_resp.text}"
        register_data = register_resp.json()
        agent_id = register_data.get("agentId")
        token = register_data.get("token")
        assert isinstance(agent_id, str) and agent_id, "agentId missing or empty"
        assert isinstance(token, str) and token, "token missing or empty"

        # Step 2: Fetch agent details using the valid agent ID
        get_agent_url = f"{BASE_URL}/v1/agents/{agent_id}"
        get_resp = requests.get(get_agent_url, timeout=TIMEOUT)
        assert get_resp.status_code == 200, f"GET /v1/agents/{{id}} returned {get_resp.status_code} for valid agentId"

        agent_details = get_resp.json()
        # Validate response fields as per schema
        assert agent_details.get("id") == agent_id, "Agent ID mismatch in details"
        # name should be string matching "TestAgentTC005"
        assert isinstance(agent_details.get("name"), str) and agent_details.get("name") == "TestAgentTC005"
        # color should be string and match the input color
        assert isinstance(agent_details.get("color"), str) and agent_details.get("color") == "#123abc"
        # position should be an object with numeric x and z
        position = agent_details.get("position")
        assert isinstance(position, dict), "position missing or not an object"
        assert isinstance(position.get("x"), (int, float)), "position.x missing or not a number"
        assert isinstance(position.get("z"), (int, float)), "position.z missing or not a number"
        # status should be one of 'idle', 'moving', 'acting'
        assert agent_details.get("status") in ("idle", "moving", "acting"), "Invalid status value"
        # inventory should be an object with numeric wood, stone, gold
        inventory = agent_details.get("inventory")
        assert isinstance(inventory, dict), "inventory missing or not an object"
        for resource in ("wood", "stone", "gold"):
            val = inventory.get(resource)
            assert isinstance(val, (int, float)), f"inventory.{resource} missing or not a number"

        # Step 3: Use an invalid agent ID to test 404 response
        invalid_agent_id = "nonexistent-agent-id-tc005-xyz"
        invalid_url = f"{BASE_URL}/v1/agents/{invalid_agent_id}"
        invalid_resp = requests.get(invalid_url, timeout=TIMEOUT)
        assert invalid_resp.status_code == 404, f"GET /v1/agents/{{id}} with invalid id should return 404, got {invalid_resp.status_code}"

    finally:
        # Cleanup: delete the created agent to avoid test data accumulation
        if agent_id and 'token' in locals():
            delete_url = f"{BASE_URL}/v1/agents/{agent_id}"
            headers = {"Authorization": f"Bearer {token}"}
            try:
                requests.delete(delete_url, headers=headers, timeout=TIMEOUT)
            except Exception:
                pass


test_get_agent_details_returns_correct_agent_information_or_404()