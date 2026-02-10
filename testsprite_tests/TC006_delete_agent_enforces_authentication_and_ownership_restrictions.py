import requests

BASE_URL = "http://127.0.0.1:3001"
ENTER_ENDPOINT = f"{BASE_URL}/v1/agents/enter"
AGENT_DELETE_ENDPOINT = f"{BASE_URL}/v1/agents/{{agent_id}}"
HEADERS_JSON = {"Content-Type": "application/json"}
TIMEOUT = 30


def register_agent(owner_id, visuals=None):
    payload = {"ownerId": owner_id}
    if visuals:
        payload["visuals"] = visuals
    resp = requests.post(ENTER_ENDPOINT, json=payload, headers=HEADERS_JSON, timeout=TIMEOUT)
    resp.raise_for_status()
    data = resp.json()
    return data["agentId"], data["token"]


def delete_agent(agent_id, token):
    headers = {"Authorization": f"Bearer {token}"}
    url = AGENT_DELETE_ENDPOINT.format(agent_id=agent_id)
    return requests.delete(url, headers=headers, timeout=TIMEOUT)


def delete_agent_no_auth(agent_id):
    url = AGENT_DELETE_ENDPOINT.format(agent_id=agent_id)
    return requests.delete(url, timeout=TIMEOUT)


def test_delete_agent_enforces_authentication_and_ownership_restrictions():
    owner_1 = "owner1@example.com"
    owner_2 = "owner2@example.com"
    visuals_1 = {"color": "#ff0000", "name": "AgentOne"}
    visuals_2 = {"color": "#00ff00", "name": "AgentTwo"}

    # Register two agents with different owners
    agent1_id, agent1_token = register_agent(owner_1, visuals_1)
    agent2_id, agent2_token = register_agent(owner_2, visuals_2)

    try:
        # 1. Attempt to delete without authentication => Expect 401 Unauthorized
        resp = delete_agent_no_auth(agent1_id)
        assert resp.status_code == 401, f"Expected 401 Unauthorized without auth, got {resp.status_code}"

        # 2. Attempt to delete with wrong agent token (ownership violation) => Expect 403 Forbidden
        resp = delete_agent(agent1_id, agent2_token)
        assert resp.status_code == 403, f"Expected 403 Forbidden when deleting other's agent, got {resp.status_code}"

        # 3. Attempt to delete nonexistent agent with valid token => Expect 404 Not Found or 403 Forbidden
        fake_agent_id = "nonexistent-agent-id-12345"
        resp = delete_agent(fake_agent_id, agent1_token)
        assert resp.status_code in (404, 403), f"Expected 404 Not Found or 403 Forbidden for nonexistent agent, got {resp.status_code}"

        # 4. Successful deletion with correct authentication and ownership => Expect 200 Success and success=True
        resp = delete_agent(agent1_id, agent1_token)
        assert resp.status_code == 200, f"Expected 200 OK on successful deletion, got {resp.status_code}"
        json_resp = resp.json()
        assert "success" in json_resp and json_resp["success"] is True, "Expected success=True in deletion response"

        # Furthermore, confirm the agent is deleted by trying to delete again => 404 Not Found OR 200 with success=False
        resp = delete_agent(agent1_id, agent1_token)
        if resp.status_code == 200:
            json_resp = resp.json()
            assert "success" in json_resp and json_resp["success"] is False, "Expected success=False or 404 after deleting already deleted agent"
        else:
            assert resp.status_code == 404, "Expected 404 Not Found for agent already deleted"

    finally:
        # Cleanup: delete agent2 if exists
        try:
            resp = delete_agent(agent2_id, agent2_token)
            if resp.status_code not in (200, 404):
                resp.raise_for_status()
        except Exception:
            pass


test_delete_agent_enforces_authentication_and_ownership_restrictions()