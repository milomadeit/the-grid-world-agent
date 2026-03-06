"""Session management for OpGrid MCP server.

Handles authentication (wallet signature + JWT) and x402 USDC payments
for paywall-gated endpoints like certification start.
"""

import os
import time
import json
import base64
import requests
from eth_account import Account
from eth_account.messages import encode_defunct


# EIP-712 types for TransferWithAuthorization (EIP-3009 / USDC)
TRANSFER_WITH_AUTH_TYPES = {
    "EIP712Domain": [
        {"name": "name", "type": "string"},
        {"name": "version", "type": "string"},
        {"name": "chainId", "type": "uint256"},
        {"name": "verifyingContract", "type": "address"},
    ],
    "TransferWithAuthorization": [
        {"name": "from", "type": "address"},
        {"name": "to", "type": "address"},
        {"name": "value", "type": "uint256"},
        {"name": "validAfter", "type": "uint256"},
        {"name": "validBefore", "type": "uint256"},
        {"name": "nonce", "type": "bytes32"},
    ],
}


def _chain_id_from_network(network: str) -> int:
    if network == "base":
        return 8453
    return 84532  # base-sepolia


class OpGridSession:
    """Manages authentication and state for an OpGrid agent session."""

    def __init__(self, base_url: str | None = None):
        self.base_url = (base_url or os.getenv("OPGRID_API_URL", "https://opgrid.up.railway.app")).rstrip("/")
        self.private_key = os.getenv("AGENT_PRIVATE_KEY", "")
        self.agent_id_erc8004 = os.getenv("AGENT_ERC8004_ID", "")
        self.agent_registry = os.getenv(
            "AGENT_REGISTRY",
            "eip155:84532:0x8004A818BFB912233c491871b3d84c89A494BD9e",
        )
        self.jwt: str | None = None
        self.agent_id: str | None = None
        self.position: dict | None = None
        self.guild: dict | None = None
        self.agent_class: str | None = None

    @property
    def wallet_address(self) -> str:
        if not self.private_key:
            return ""
        acct = Account.from_key(self.private_key)
        return acct.address

    def _sign_timestamp(self) -> tuple[str, str]:
        """Sign a timestamp message for OpGrid auth.

        The server expects: 'Enter OpGrid\\nTimestamp: <ISO timestamp>'
        """
        timestamp = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
        auth_message = f"Enter OpGrid\nTimestamp: {timestamp}"
        message = encode_defunct(text=auth_message)
        acct = Account.from_key(self.private_key)
        signed = acct.sign_message(message)
        return timestamp, signed.signature.hex()

    def _headers(self) -> dict:
        headers = {"Content-Type": "application/json"}
        if self.jwt:
            headers["Authorization"] = f"Bearer {self.jwt}"
        return headers

    def _sign_x402_payment(self, payment_req: dict) -> str:
        """Sign an x402 payment authorization for USDC TransferWithAuthorization.

        Returns a base64-encoded x402 payment header value.
        """
        acct = Account.from_key(self.private_key)
        nonce = os.urandom(32)
        chain_id = _chain_id_from_network(payment_req.get("network", "base-sepolia"))
        asset = payment_req.get("asset", "")
        pay_to = payment_req.get("payTo", "")
        amount = int(payment_req.get("maxAmountRequired", "0"))
        extra = payment_req.get("extra", {})
        valid_before = int(time.time()) + 3600  # 1 hour window

        domain_data = {
            "name": extra.get("name", "USD Coin"),
            "version": extra.get("version", "2"),
            "chainId": chain_id,
            "verifyingContract": asset,
        }

        message_data = {
            "from": acct.address,
            "to": pay_to,
            "value": amount,
            "validAfter": 0,
            "validBefore": valid_before,
            "nonce": nonce,
        }

        # Sign EIP-712 typed data using Account.sign_typed_data
        signed = acct.sign_typed_data(
            domain_data,
            {"TransferWithAuthorization": TRANSFER_WITH_AUTH_TYPES["TransferWithAuthorization"]},
            message_data,
        )
        sig_hex = signed.signature.hex()
        if not sig_hex.startswith("0x"):
            sig_hex = f"0x{sig_hex}"

        payment_payload = {
            "x402Version": 1,
            "scheme": payment_req.get("scheme", "exact"),
            "network": payment_req.get("network", "base-sepolia"),
            "payload": {
                "signature": sig_hex,
                "authorization": {
                    "from": acct.address,
                    "to": pay_to,
                    "value": str(amount),
                    "validAfter": "0",
                    "validBefore": str(valid_before),
                    "nonce": f"0x{nonce.hex()}",
                },
            },
        }

        return base64.b64encode(json.dumps(payment_payload).encode()).decode()

    def _handle_x402(self, resp: requests.Response, url: str, body: dict | None) -> requests.Response:
        """Handle a 402 Payment Required response by signing and retrying with x402."""
        try:
            data = resp.json()
        except Exception:
            resp.raise_for_status()
            return resp

        accepts = data.get("accepts", [])
        if not accepts:
            raise Exception(f"402 Payment Required but no payment options provided: {data}")

        payment_req = accepts[0]
        payment_header = self._sign_x402_payment(payment_req)

        headers = self._headers()
        headers["X-PAYMENT"] = payment_header

        retry_resp = requests.post(url, json=body or {}, headers=headers, timeout=30)
        retry_resp.raise_for_status()
        return retry_resp

    def enter(self, name: str = "MCPAgent", color: str = "#00D4AA", bio: str = "") -> dict:
        """Enter the OpGrid world. Returns the full server response."""
        timestamp, signature = self._sign_timestamp()
        body = {
            "walletAddress": self.wallet_address,
            "signature": f"0x{signature}" if not signature.startswith("0x") else signature,
            "timestamp": timestamp,
            "agentId": self.agent_id_erc8004,
            "agentRegistry": self.agent_registry,
            "visuals": {"name": name, "color": color},
            "bio": bio,
        }
        url = f"{self.base_url}/v1/agents/enter"
        resp = requests.post(url, json=body, headers=self._headers(), timeout=30)

        if resp.status_code == 402:
            resp = self._handle_x402(resp, url, body)

        resp.raise_for_status()
        data = resp.json()
        self.jwt = data.get("token")
        self.agent_id = data.get("agentId")
        self.position = data.get("position")
        self.guild = data.get("guild")
        self.agent_class = data.get("agentClass")
        return data

    def get(self, path: str, params: dict | None = None) -> dict:
        """Authenticated GET request."""
        resp = requests.get(f"{self.base_url}{path}", params=params, headers=self._headers(), timeout=30)
        if resp.status_code == 401:
            self.enter()
            resp = requests.get(f"{self.base_url}{path}", params=params, headers=self._headers(), timeout=30)
        resp.raise_for_status()
        return resp.json()

    def post(self, path: str, body: dict | None = None) -> dict:
        """Authenticated POST request with x402 payment handling."""
        url = f"{self.base_url}{path}"
        resp = requests.post(url, json=body or {}, headers=self._headers(), timeout=30)

        if resp.status_code == 401:
            self.enter()
            resp = requests.post(url, json=body or {}, headers=self._headers(), timeout=30)

        if resp.status_code == 402:
            resp = self._handle_x402(resp, url, body)

        resp.raise_for_status()
        return resp.json()

    def is_authenticated(self) -> bool:
        return bool(self.jwt and self.agent_id)
