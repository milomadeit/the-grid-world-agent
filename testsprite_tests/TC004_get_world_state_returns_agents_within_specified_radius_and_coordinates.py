import requests

BASE_URL = "http://127.0.0.1:3001"
TIMEOUT = 30


def test_get_world_state_returns_agents_within_specified_radius_and_coordinates():
    # Defaults for query parameters
    radius = 100
    center_x = 0
    center_z = 0

    url = f"{BASE_URL}/v1/world/state"
    params = {
        "radius": radius,
        "center_x": center_x,
        "center_z": center_z,
    }

    try:
        response = requests.get(url, params=params, timeout=TIMEOUT)
    except requests.RequestException as e:
        assert False, f"Request failed: {e}"

    # Validate status code
    assert response.status_code == 200, f"Expected status code 200, got {response.status_code}"

    try:
        data = response.json()
    except ValueError:
        assert False, "Response is not valid JSON"

    # Validate required top-level keys
    assert "tick" in data, "'tick' not in response JSON"
    assert isinstance(data["tick"], (int, float)), "'tick' should be a number"

    assert "agents" in data, "'agents' not in response JSON"
    assert isinstance(data["agents"], list), "'agents' should be a list"

    # Validate each agent in agents list
    for agent in data["agents"]:
        # Required fields for each agent
        for key in ["id", "x", "z", "color", "status"]:
            assert key in agent, f"Agent missing '{key}' field"

        # Validate types
        assert isinstance(agent["id"], str), "'id' should be string"
        assert isinstance(agent["x"], (int, float)), "'x' should be number"
        assert isinstance(agent["z"], (int, float)), "'z' should be number"
        assert isinstance(agent["color"], str), "'color' should be string"
        assert agent["status"] in ["idle", "moving", "acting"], "'status' should be one of 'idle', 'moving', 'acting'"

        # Additionally, validate that the agent is within specified radius from center coordinates
        dx = agent["x"] - center_x
        dz = agent["z"] - center_z
        distance_squared = dx * dx + dz * dz
        assert distance_squared <= radius * radius, f"Agent {agent['id']} outside the specified radius"

    # If all assertions pass
    print("Test TC004 passed.")


test_get_world_state_returns_agents_within_specified_radius_and_coordinates()