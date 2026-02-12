/**
 * Chain Client — on-chain interaction for autonomous agents.
 *
 * Uses viem to sign transactions. Each agent has its own private key.
 * Currently supports:
 *   - register() on the IdentityRegistry (mint an ERC-8004 agent ID)
 *   - ownerOf() to check token ownership
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  type Hex,
  type Address,
  type PublicClient,
  type WalletClient,
  parseAbi,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { defineChain } from 'viem';

// Monad Mainnet (Chain ID 143)
const monad = defineChain({
  id: 143,
  name: 'Monad Mainnet',
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://rpc.monad.xyz'] },
  },
  blockExplorers: {
    default: { name: 'MonadScan', url: 'https://explorer.monad.xyz' },
  },
});

// IdentityRegistry contract address
const IDENTITY_REGISTRY: Address = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';

// Minimal ABI for what we need
const registryAbi = parseAbi([
  'function register() external returns (uint256 agentId)',
  'function register(string agentURI) external returns (uint256 agentId)',
  'function ownerOf(uint256 tokenId) external view returns (address)',
  'function balanceOf(address owner) external view returns (uint256)',
  'function getAgentWallet(uint256 agentId) external view returns (address)',
]);

export class ChainClient {
  private publicClient: PublicClient;
  private walletClient: WalletClient | null = null;
  private account: ReturnType<typeof privateKeyToAccount> | null = null;

  constructor(privateKey?: string) {
    this.publicClient = createPublicClient({
      chain: monad,
      transport: http(),
    });

    if (privateKey) {
      const pk = (privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`) as Hex;
      this.account = privateKeyToAccount(pk);
      this.walletClient = createWalletClient({
        account: this.account,
        chain: monad,
        transport: http(),
      });
    }
  }

  /** Get the wallet address derived from the private key */
  getAddress(): Address | null {
    return this.account?.address || null;
  }

  /** Check if a token exists and who owns it */
  async ownerOf(agentId: bigint): Promise<Address | null> {
    try {
      return await this.publicClient.readContract({
        address: IDENTITY_REGISTRY,
        abi: registryAbi,
        functionName: 'ownerOf',
        args: [agentId],
      }) as Address;
    } catch {
      return null;
    }
  }

  /** Check how many agent IDs a wallet owns */
  async balanceOf(address: Address): Promise<bigint> {
    return await this.publicClient.readContract({
      address: IDENTITY_REGISTRY,
      abi: registryAbi,
      functionName: 'balanceOf',
      args: [address],
    }) as bigint;
  }

  /** Get the native MON balance of the wallet */
  async getBalance(): Promise<bigint> {
    if (!this.account) throw new Error('No private key configured');
    return await this.publicClient.getBalance({ address: this.account.address });
  }

  /**
   * Call register() on the IdentityRegistry.
   * Mints a new ERC-721 NFT as the agent's identity.
   * Returns the new agentId.
   */
  async register(agentURI?: string): Promise<bigint> {
    if (!this.walletClient || !this.account) {
      throw new Error('Cannot register: no private key configured');
    }

    console.log(`[Chain] Calling register() on IdentityRegistry from ${this.account.address}...`);

    let hash: Hex;
    if (agentURI) {
      hash = await this.walletClient.writeContract({
        chain: monad,
        account: this.account,
        address: IDENTITY_REGISTRY,
        abi: registryAbi,
        functionName: 'register',
        args: [agentURI],
      });
    } else {
      hash = await this.walletClient.writeContract({
        chain: monad,
        account: this.account,
        address: IDENTITY_REGISTRY,
        abi: registryAbi,
        functionName: 'register',
        args: [],
      });
    }

    console.log(`[Chain] Transaction submitted: ${hash}`);
    console.log(`[Chain] Waiting for confirmation...`);

    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });

    if (receipt.status !== 'success') {
      throw new Error(`Transaction reverted: ${hash}`);
    }

    // Parse the Transfer event to get the agentId (ERC-721 mint)
    // Transfer(address indexed from, address indexed to, uint256 indexed tokenId)
    // On mint: from=0x0, to=owner, tokenId=newAgentId
    const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' as Hex;
    for (const log of receipt.logs) {
      if (
        log.address.toLowerCase() === IDENTITY_REGISTRY.toLowerCase() &&
        log.topics.length >= 4 &&
        log.topics[0] === TRANSFER_TOPIC
      ) {
        // topics[0] = Transfer sig, topics[1] = from, topics[2] = to, topics[3] = tokenId
        const agentId = BigInt(log.topics[3]!);
        console.log(`[Chain] Registered! Agent ID: ${agentId}`);
        return agentId;
      }
    }

    // Fallback: check balanceOf to infer the new token
    console.warn('[Chain] Could not parse agentId from logs, checking balanceOf...');
    const balance = await this.balanceOf(this.account.address);
    console.log(`[Chain] Wallet now owns ${balance} agent ID(s)`);

    throw new Error('Registration succeeded but could not determine new agentId from logs');
  }
}
