"""Onchain operations for OpGrid MCP server — swap execution and balance checks."""

import os
import json
from web3 import Web3
from eth_account import Account

# Base Sepolia config
CHAIN_RPC = os.getenv("BASE_SEPOLIA_RPC", "https://sepolia.base.org")
CHAIN_ID = 84532

# Token addresses on Base Sepolia
USDC_ADDRESS = Web3.to_checksum_address("0x036CbD53842c5426634e7929541eC2318f3dCF7e")
WETH_ADDRESS = Web3.to_checksum_address("0x4200000000000000000000000000000000000006")
SWAP_ROUTER_ADDRESS = Web3.to_checksum_address("0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4")
QUOTER_V2_ADDRESS = Web3.to_checksum_address("0xC5290058841028F1614F3A6F0F5816cAd0df5E27")

# Minimal ERC-20 ABI for balance checks
ERC20_ABI = json.loads('[{"constant":true,"inputs":[{"name":"account","type":"address"}],"name":"balanceOf","outputs":[{"name":"","type":"uint256"}],"type":"function"},{"constant":true,"inputs":[],"name":"decimals","outputs":[{"name":"","type":"uint8"}],"type":"function"}]')

# SwapRouter02 exactInputSingle ABI
SWAP_ROUTER_ABI = json.loads("""[{
  "inputs": [{
    "components": [
      {"name": "tokenIn", "type": "address"},
      {"name": "tokenOut", "type": "address"},
      {"name": "fee", "type": "uint24"},
      {"name": "recipient", "type": "address"},
      {"name": "amountIn", "type": "uint256"},
      {"name": "amountOutMinimum", "type": "uint256"},
      {"name": "sqrtPriceLimitX96", "type": "uint160"}
    ],
    "name": "params",
    "type": "tuple"
  }],
  "name": "exactInputSingle",
  "outputs": [{"name": "amountOut", "type": "uint256"}],
  "stateMutability": "payable",
  "type": "function"
},{
  "inputs": [{"name": "token","type": "address"},{"name": "value","type": "uint256"}],
  "name": "approve",
  "outputs": [{"name": "","type": "bool"}],
  "stateMutability": "nonpayable",
  "type": "function"
}]""")

# ERC-20 approve ABI
APPROVE_ABI = json.loads('[{"inputs":[{"name":"spender","type":"address"},{"name":"amount","type":"uint256"}],"name":"approve","outputs":[{"name":"","type":"bool"}],"stateMutability":"nonpayable","type":"function"}]')

# QuoterV2 ABI for price quotes
QUOTER_V2_ABI = json.loads("""[{
  "inputs": [{
    "components": [
      {"name": "tokenIn", "type": "address"},
      {"name": "tokenOut", "type": "address"},
      {"name": "amountIn", "type": "uint256"},
      {"name": "fee", "type": "uint24"},
      {"name": "sqrtPriceLimitX96", "type": "uint160"}
    ],
    "name": "params",
    "type": "tuple"
  }],
  "name": "quoteExactInputSingle",
  "outputs": [
    {"name": "amountOut", "type": "uint256"},
    {"name": "sqrtPriceX96After", "type": "uint160"},
    {"name": "initializedTicksCrossed", "type": "uint32"},
    {"name": "gasEstimate", "type": "uint256"}
  ],
  "stateMutability": "nonpayable",
  "type": "function"
}]""")


def get_w3() -> Web3:
    return Web3(Web3.HTTPProvider(CHAIN_RPC))


def get_account() -> Account:
    pk = os.getenv("AGENT_PRIVATE_KEY", "")
    if not pk:
        raise ValueError("AGENT_PRIVATE_KEY not set")
    return Account.from_key(pk)


def check_balances() -> dict:
    """Check ETH and USDC balances for the agent wallet."""
    w3 = get_w3()
    acct = get_account()
    address = acct.address

    eth_balance = w3.eth.get_balance(address)
    eth_formatted = w3.from_wei(eth_balance, "ether")

    usdc = w3.eth.contract(address=USDC_ADDRESS, abi=ERC20_ABI)
    usdc_balance = usdc.functions.balanceOf(address).call()
    usdc_formatted = usdc_balance / 1e6

    return {
        "wallet": address,
        "chain": "Base Sepolia (84532)",
        "eth": {"wei": str(eth_balance), "formatted": f"{eth_formatted:.6f} ETH"},
        "usdc": {"atomic": str(usdc_balance), "formatted": f"{usdc_formatted:.2f} USDC"},
        "guidance": f"{usdc_formatted:.2f} USDC available for certification fees. {eth_formatted:.6f} ETH available for gas.",
    }


def _gas_price(w3: Web3) -> int:
    """Get gas price with a floor of 1 gwei to avoid underpriced errors on testnets."""
    return max(w3.eth.gas_price, w3.to_wei(1, "gwei"))


def approve_usdc(amount: int) -> str:
    """Approve USDC spending for the swap router."""
    w3 = get_w3()
    acct = get_account()
    usdc = w3.eth.contract(address=USDC_ADDRESS, abi=APPROVE_ABI)

    tx = usdc.functions.approve(SWAP_ROUTER_ADDRESS, amount).build_transaction({
        "from": acct.address,
        "nonce": w3.eth.get_transaction_count(acct.address, "pending"),
        "gas": 100000,
        "gasPrice": _gas_price(w3),
        "chainId": CHAIN_ID,
    })
    signed = acct.sign_transaction(tx)
    tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction)
    receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=60)
    return receipt.transactionHash.hex()


def quote_swap(
    token_in_addr: str,
    token_out_addr: str,
    amount_in: int,
    fee: int = 3000,
) -> int:
    """Get a price quote from QuoterV2 for the expected output amount."""
    w3 = get_w3()
    quoter = w3.eth.contract(address=QUOTER_V2_ADDRESS, abi=QUOTER_V2_ABI)

    result = quoter.functions.quoteExactInputSingle((
        token_in_addr,
        token_out_addr,
        amount_in,
        fee,
        0,  # sqrtPriceLimitX96
    )).call()

    # result is (amountOut, sqrtPriceX96After, initializedTicksCrossed, gasEstimate)
    return result[0]


def execute_swap(
    token_in: str = "",
    token_out: str = "",
    amount_in: int = 1000000,  # 1 USDC default (cert minimum)
    slippage_bps: int = 50,
    fee: int = 3000,
) -> dict:
    """Execute a USDC/WETH swap on Uniswap V3 SwapRouter02.

    Quotes the price first via QuoterV2, then calculates amountOutMinimum
    using the slippage tolerance. This ensures proper slippage protection
    scoring during certification verification.

    Returns the transaction hash for certification proof submission.
    """
    w3 = get_w3()
    acct = get_account()
    gas_price = _gas_price(w3)

    # Default to USDC -> WETH
    token_in_addr = Web3.to_checksum_address(token_in) if token_in else USDC_ADDRESS
    token_out_addr = Web3.to_checksum_address(token_out) if token_out else WETH_ADDRESS

    # Track nonce locally to avoid stale RPC reads between approve and swap
    nonce = w3.eth.get_transaction_count(acct.address, "pending")

    # 1. Approve USDC if swapping from USDC
    if token_in_addr == USDC_ADDRESS:
        usdc = w3.eth.contract(address=USDC_ADDRESS, abi=APPROVE_ABI)
        approve_tx = usdc.functions.approve(SWAP_ROUTER_ADDRESS, amount_in).build_transaction({
            "from": acct.address,
            "nonce": nonce,
            "gas": 100000,
            "gasPrice": gas_price,
            "chainId": CHAIN_ID,
        })
        signed_approve = acct.sign_transaction(approve_tx)
        approve_hash = w3.eth.send_raw_transaction(signed_approve.raw_transaction)
        w3.eth.wait_for_transaction_receipt(approve_hash, timeout=60)
        nonce += 1

    # 2. Quote price via QuoterV2
    quoted_amount_out = quote_swap(token_in_addr, token_out_addr, amount_in, fee)

    # 3. Calculate amountOutMinimum from quote using slippage tolerance
    amount_out_min = quoted_amount_out - (quoted_amount_out * slippage_bps // 10000)

    # 4. Execute swap via exactInputSingle
    router = w3.eth.contract(address=SWAP_ROUTER_ADDRESS, abi=SWAP_ROUTER_ABI)

    params = (
        token_in_addr,
        token_out_addr,
        fee,
        acct.address,
        amount_in,
        amount_out_min,
        0,  # sqrtPriceLimitX96
    )

    tx = router.functions.exactInputSingle(params).build_transaction({
        "from": acct.address,
        "nonce": nonce,
        "gas": 300000,
        "gasPrice": gas_price,
        "chainId": CHAIN_ID,
        "value": 0,
    })
    signed = acct.sign_transaction(tx)
    tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction)
    receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=120)

    return {
        "txHash": receipt.transactionHash.hex(),
        "status": "confirmed" if receipt.status == 1 else "failed",
        "gasUsed": receipt.gasUsed,
        "blockNumber": receipt.blockNumber,
        "quotedOutput": str(quoted_amount_out),
        "amountOutMinimum": str(amount_out_min),
        "slippageBps": slippage_bps,
        "guidance": "Swap confirmed. Submit this txHash as proof: POST /v1/certify/runs/{runId}/submit",
    }
