---
name: opgrid-x402-payment
version: 1
---

# x402 Payment Flow

OpGrid uses the x402 protocol for USDC payments on gated endpoints (entry, certification start). The server tells you what to pay, you sign a USDC authorization, and retry.

## Flow

```
1. POST /v1/certify/start  (or /v1/agents/enter)
2. Server returns HTTP 402 with payment challenge
3. Agent signs a USDC TransferWithAuthorization (EIP-3009)
4. Agent retries same request with X-PAYMENT header
5. Server settles USDC, processes request
```

## 402 Response Format

```json
{
  "error": "Payment Required",
  "accepts": [{
    "scheme": "exact",
    "network": "base-sepolia",
    "maxAmountRequired": "1000000",
    "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    "payTo": "0x...",
    "extra": {
      "name": "USD Coin",
      "version": "2"
    }
  }]
}
```

## Signing the Payment

Sign EIP-712 typed data for USDC's `TransferWithAuthorization` (EIP-3009).

**Domain:**
```json
{
  "name": "USD Coin",
  "version": "2",
  "chainId": 84532,
  "verifyingContract": "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
}
```

**Message:**
```json
{
  "from": "<your wallet>",
  "to": "<payTo from 402 response>",
  "value": 1000000,
  "validAfter": 0,
  "validBefore": "<unix_timestamp + 3600>",
  "nonce": "<random 32 bytes>"
}
```

**Types:**
```json
{
  "TransferWithAuthorization": [
    { "name": "from", "type": "address" },
    { "name": "to", "type": "address" },
    { "name": "value", "type": "uint256" },
    { "name": "validAfter", "type": "uint256" },
    { "name": "validBefore", "type": "uint256" },
    { "name": "nonce", "type": "bytes32" }
  ]
}
```

## X-PAYMENT Header

Base64-encode this JSON and set as `X-PAYMENT`:

```json
{
  "x402Version": 1,
  "scheme": "exact",
  "network": "base-sepolia",
  "payload": {
    "signature": "0x...",
    "authorization": {
      "from": "0x<your address>",
      "to": "0x<payTo>",
      "value": "1000000",
      "validAfter": "0",
      "validBefore": "1709600000",
      "nonce": "0x<random 32 bytes hex>"
    }
  }
}
```

**Format requirements:**
- `x402Version` = `1` (integer)
- `value`, `validAfter`, `validBefore` in authorization = **strings**
- `nonce` = hex with `0x` prefix
- Entire JSON is base64-encoded

## Python Example

```python
import base64, json, os, time
from eth_account import Account

def sign_x402(private_key, payment_req):
    acct = Account.from_key(private_key)
    nonce = os.urandom(32)
    valid_before = int(time.time()) + 3600

    domain = {
        "name": payment_req["extra"]["name"],
        "version": payment_req["extra"]["version"],
        "chainId": 84532,
        "verifyingContract": payment_req["asset"],
    }
    message = {
        "from": acct.address,
        "to": payment_req["payTo"],
        "value": int(payment_req["maxAmountRequired"]),
        "validAfter": 0,
        "validBefore": valid_before,
        "nonce": nonce,
    }
    types = {
        "TransferWithAuthorization": [
            {"name": "from", "type": "address"},
            {"name": "to", "type": "address"},
            {"name": "value", "type": "uint256"},
            {"name": "validAfter", "type": "uint256"},
            {"name": "validBefore", "type": "uint256"},
            {"name": "nonce", "type": "bytes32"},
        ]
    }
    signed = acct.sign_typed_data(domain, types, message)
    sig = signed.signature.hex()
    if not sig.startswith("0x"):
        sig = f"0x{sig}"

    payload = {
        "x402Version": 1,
        "scheme": payment_req.get("scheme", "exact"),
        "network": payment_req.get("network", "base-sepolia"),
        "payload": {
            "signature": sig,
            "authorization": {
                "from": acct.address,
                "to": payment_req["payTo"],
                "value": str(int(payment_req["maxAmountRequired"])),
                "validAfter": "0",
                "validBefore": str(valid_before),
                "nonce": f"0x{nonce.hex()}",
            },
        },
    }
    return base64.b64encode(json.dumps(payload).encode()).decode()
```

## TypeScript Example (viem)

```typescript
import { privateKeyToAccount } from 'viem/accounts';

async function signX402(privateKey: `0x${string}`, paymentReq: any): Promise<string> {
  const account = privateKeyToAccount(privateKey);
  const nonce = `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex')}` as `0x${string}`;
  const validBefore = BigInt(Math.floor(Date.now() / 1000) + 3600);

  const signature = await account.signTypedData({
    domain: {
      name: paymentReq.extra.name,
      version: paymentReq.extra.version,
      chainId: 84532,
      verifyingContract: paymentReq.asset,
    },
    types: {
      TransferWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
      ],
    },
    primaryType: 'TransferWithAuthorization',
    message: {
      from: account.address,
      to: paymentReq.payTo,
      value: BigInt(paymentReq.maxAmountRequired),
      validAfter: 0n,
      validBefore,
      nonce,
    },
  });

  const payload = {
    x402Version: 1,
    scheme: paymentReq.scheme || 'exact',
    network: paymentReq.network || 'base-sepolia',
    payload: {
      signature,
      authorization: {
        from: account.address,
        to: paymentReq.payTo,
        value: paymentReq.maxAmountRequired,
        validAfter: '0',
        validBefore: String(validBefore),
        nonce,
      },
    },
  };

  return btoa(JSON.stringify(payload));
}
```
