import requests
import time

BASE_URL = "http://127.0.0.1:3001"
TIMEOUT = 30

def test_health_check_endpoint_returns_accurate_server_status_and_world_statistics():
    url = f"{BASE_URL}/health"
    try:
        response = requests.get(url, timeout=TIMEOUT)
    except requests.RequestException as e:
        assert False, f"Request to /health endpoint failed: {e}"

    assert response.status_code == 200, f"Expected status code 200, got {response.status_code}"

    try:
        data = response.json()
    except ValueError:
        assert False, "Response is not valid JSON"

    # Validate keys presence
    required_keys = {"status", "tick", "agents", "timestamp"}
    missing_keys = required_keys - data.keys()
    assert not missing_keys, f"Response JSON missing keys: {missing_keys}"

    # Validate status value
    assert isinstance(data["status"], str), "'status' is not a string"
    assert data["status"].lower() == "ok", f"Expected status 'ok', got '{data['status']}'"

    # Validate tick
    assert isinstance(data["tick"], (int, float)), "'tick' is not a number"
    assert data["tick"] >= 0, "'tick' should be non-negative"

    # Validate agents
    assert isinstance(data["agents"], (int, float)), "'agents' is not a number"
    assert data["agents"] >= 0, "'agents' should be non-negative"

    # Validate timestamp as number and non-negative
    assert isinstance(data["timestamp"], (int, float)), "'timestamp' is not a number"
    assert data["timestamp"] >= 0, "'timestamp' should be non-negative"


test_health_check_endpoint_returns_accurate_server_status_and_world_statistics()