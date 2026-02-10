import requests
import base64
import json
import time

BASE_URL = "http://127.0.0.1:3001"
TIMEOUT = 30

def test_agent_registration_returns_valid_token_and_initial_position():
    url = f"{BASE_URL}/v1/agents/enter"
    # Sample valid payload with optional visuals
    payload = {
        "ownerId": "test-owner-123",
        "visuals": {
            "color": "#123abc",
            "name": "TestAgent"
        }
    }
    headers = {
        "Content-Type": "application/json"
    }

    try:
        response = requests.post(url, headers=headers, json=payload, timeout=TIMEOUT)
    except requests.RequestException as e:
        assert False, f"Request to {url} failed: {e}"

    assert response.status_code == 200, f"Expected status code 200 but got {response.status_code}"

    try:
        data = response.json()
    except json.JSONDecodeError:
        assert False, "Response is not valid JSON"

    # Validate presence and types of keys
    assert "agentId" in data and isinstance(data["agentId"], str) and data["agentId"], "agentId missing or invalid"
    assert "position" in data and isinstance(data["position"], dict), "position missing or invalid"
    assert "x" in data["position"] and isinstance(data["position"]["x"], (int, float)), "position.x missing or invalid"
    assert "z" in data["position"] and isinstance(data["position"]["z"], (int, float)), "position.z missing or invalid"
    assert "token" in data and isinstance(data["token"], str) and data["token"], "token missing or invalid"

    # Validate the token is base64url-encoded JWT with 3 segments separated by '.'
    token = data["token"]
    parts = token.split('.')
    assert len(parts) == 3, "Token does not have 3 parts separated by '.' (not a valid JWT)"

    # Verify each part is base64url decodable without padding errors
    for part in parts:
        part += '=' * (4 - len(part) % 4) if len(part) % 4 != 0 else ''
        try:
            base64.urlsafe_b64decode(part.encode('ascii'))
        except Exception:
            assert False, "Token part is not base64url decodable"

    # Decode payload to check expiry (exp) claim for 24h expiry from now
    payload_b64 = parts[1]
    padded_payload_b64 = payload_b64 + '=' * (4 - len(payload_b64) % 4) if len(payload_b64) % 4 != 0 else payload_b64
    payload_bytes = base64.urlsafe_b64decode(padded_payload_b64)
    try:
        payload_json = json.loads(payload_bytes)
    except Exception:
        assert False, "JWT payload is not valid JSON"

    exp = payload_json.get("exp")
    assert isinstance(exp, int), "JWT payload missing 'exp' or 'exp' is not an integer"

    now = int(time.time())
    # Check expiry approx 24 hours (86400 seconds) from now (allow some leeway +/- 5 minutes)
    seconds_24h = 86400
    assert (now + seconds_24h - 300) <= exp <= (now + seconds_24h + 300), f"JWT 'exp' is not approximately 24 hours from now; exp={exp}, now={now}"

test_agent_registration_returns_valid_token_and_initial_position()