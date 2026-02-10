/**
 * Truncates a wallet address to show only 0x + first 4 characters
 * @param address - Full wallet address (e.g., "0x7A2cae0B7A1Bb6617b226f9aEF65401d08CF5721")
 * @returns Truncated address (e.g., "0x7A2c")
 */
export function truncateAddress(address: string): string {
  if (!address) return '';
  if (!address.startsWith('0x')) return address;
  return address.slice(0, 6); // "0x" + 4 characters
}

/**
 * Checks if a string is a valid Ethereum-style address
 * @param address - String to check
 * @returns True if the string looks like a wallet address
 */
export function isWalletAddress(address: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}
