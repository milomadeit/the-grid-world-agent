// Monad RPC endpoint (mainnet)
const MONAD_RPC_URL = 'https://rpc.monad.xyz';

/**
 * Converts wei (bigint string) to formatted MON string
 */
function formatBalance(weiHex: string): string {
  const wei = BigInt(weiHex);
  const divisor = BigInt(10 ** 18);
  const whole = wei / divisor;
  const remainder = wei % divisor;

  // Get decimal portion (up to 4 places)
  const decimalStr = remainder.toString().padStart(18, '0').slice(0, 4);
  const decimal = decimalStr.replace(/0+$/, '');

  if (whole === BigInt(0) && decimal === '') {
    // Check if there's a very small amount
    if (wei > BigInt(0)) return '<0.0001';
    return '0.00';
  }

  return decimal ? `${whole}.${decimal}` : whole.toString();
}

/**
 * Fetches the native MON balance for a wallet address using JSON-RPC
 * @param address - Wallet address to check
 * @returns Formatted balance string (e.g., "1.234")
 */
export async function fetchWalletBalance(address: string): Promise<string> {
  try {
    const response = await fetch(MONAD_RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'eth_getBalance',
        params: [address, 'latest'],
        id: 1,
      }),
    });

    const data = await response.json();

    if (data.error) {
      console.error('[Balance] RPC error:', data.error);
      return '0.00';
    }

    return formatBalance(data.result);
  } catch (error) {
    console.error('[Balance] Failed to fetch balance:', error);
    return '0.00';
  }
}
