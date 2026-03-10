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
  parseAbi,
  encodeFunctionData,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { defineChain } from 'viem';

const BASE_MAINNET_CHAIN_ID = 8453;
const BASE_SEPOLIA_CHAIN_ID = 84532;
const CHAIN_ID = Number(process.env.CHAIN_ID || process.env.MONAD_CHAIN_ID || BASE_SEPOLIA_CHAIN_ID);
const CHAIN_RPC = process.env.CHAIN_RPC || process.env.MONAD_RPC || 'https://sepolia.base.org';

const base = defineChain({
  id: CHAIN_ID,
  name: CHAIN_ID === BASE_MAINNET_CHAIN_ID ? 'Base' : 'Base Sepolia',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: [CHAIN_RPC] },
  },
  blockExplorers: {
    default: {
      name: 'BaseScan',
      url: CHAIN_ID === BASE_MAINNET_CHAIN_ID ? 'https://basescan.org' : 'https://sepolia.basescan.org',
    },
  },
});

const IDENTITY_REGISTRY: Address = (
  process.env.IDENTITY_REGISTRY ||
  (CHAIN_ID === BASE_MAINNET_CHAIN_ID
    ? '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432'
    : '0x8004A818BFB912233c491871b3d84c89A494BD9e')
) as Address;

// Minimal ABI for what we need
const registryAbi = parseAbi([
  'function register() external returns (uint256 agentId)',
  'function register(string agentURI) external returns (uint256 agentId)',
  'function ownerOf(uint256 tokenId) external view returns (address)',
  'function balanceOf(address owner) external view returns (uint256)',
  'function getAgentWallet(uint256 agentId) external view returns (address)',
]);

// ERC-20 ABI (approve, allowance, balanceOf)
const erc20Abi = parseAbi([
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function allowance(address owner, address spender) external view returns (uint256)',
  'function balanceOf(address account) external view returns (uint256)',
]);

// Uniswap V3 SwapRouter02 ABI
const swapRouterAbi = parseAbi([
  'function multicall(uint256 deadline, bytes[] data) external payable returns (bytes[] results)',
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) external payable returns (uint256 amountOut)',
]);

// Uniswap V3 QuoterV2 ABI
const quoterV2Abi = parseAbi([
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
]);

const QUOTER_V2: Address = '0xC5290058841028F1614F3A6F0F5816cAd0df5E27' as Address;
const UNISWAP_V3_FEE = 3000; // 0.3% fee tier

export interface SwapParams {
  router: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  slippageBps: number;
}

export class ChainClient {
  private publicClient: ReturnType<typeof createPublicClient>;
  private walletClient: ReturnType<typeof createWalletClient> | null = null;
  private account: ReturnType<typeof privateKeyToAccount> | null = null;

  constructor(privateKey?: string) {
    this.publicClient = createPublicClient({
      chain: base,
      transport: http(),
    });

    if (privateKey) {
      const pk = (privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`) as Hex;
      this.account = privateKeyToAccount(pk);
      this.walletClient = createWalletClient({
        account: this.account,
        chain: base,
        transport: http(),
      });
    }
  }

  /** Get the wallet address derived from the private key */
  getAddress(): Address | null {
    return this.account?.address || null;
  }

  /** Expose wallet client for x402 payment signing. */
  getWalletClient(): ReturnType<typeof createWalletClient> | null {
    return this.walletClient;
  }

  /** Check if a token exists and who owns it */
  async ownerOf(agentId: bigint): Promise<Address | null> {
    try {
      return await this.publicClient.readContract({
        address: IDENTITY_REGISTRY,
        abi: registryAbi,
        functionName: 'ownerOf',
        args: [agentId],
      } as any) as Address;
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
    } as any) as bigint;
  }

  /** Get the native ETH balance of the wallet */
  async getBalance(): Promise<bigint> {
    if (!this.account) throw new Error('No private key configured');
    return await this.publicClient.getBalance({ address: this.account.address });
  }

  /** Get ERC-20 token balance */
  async getTokenBalance(tokenAddress: Address): Promise<bigint> {
    if (!this.account) throw new Error('No private key configured');
    return await this.publicClient.readContract({
      address: tokenAddress,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [this.account.address],
    } as any) as bigint;
  }

  /** Get wallet summary: ETH, USDC, WETH balances */
  async getWalletSummary(): Promise<{ eth: string; usdc: string; weth: string }> {
    if (!this.account) throw new Error('No private key configured');
    const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as Address;
    const WETH = '0x4200000000000000000000000000000000000006' as Address;
    const [ethBal, usdcBal, wethBal] = await Promise.all([
      this.getBalance(),
      this.getTokenBalance(USDC),
      this.getTokenBalance(WETH),
    ]);
    return {
      eth: (Number(ethBal) / 1e18).toFixed(4),
      usdc: (Number(usdcBal) / 1e6).toFixed(2),
      weth: (Number(wethBal) / 1e18).toFixed(6),
    };
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
        chain: base,
        account: this.account,
        address: IDENTITY_REGISTRY,
        abi: registryAbi,
        functionName: 'register',
        args: [agentURI],
      });
    } else {
      hash = await this.walletClient.writeContract({
        chain: base,
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
      const topics = (log as { topics?: readonly Hex[] }).topics;
      if (
        log.address.toLowerCase() === IDENTITY_REGISTRY.toLowerCase() &&
        topics &&
        topics.length >= 4 &&
        topics[0]?.toLowerCase() === TRANSFER_TOPIC.toLowerCase()
      ) {
        // topics[0] = Transfer sig, topics[1] = from, topics[2] = to, topics[3] = tokenId
        const agentId = BigInt(topics[3]!);
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

  /**
   * Execute a Uniswap V3 swap. The agent chooses ALL trade parameters;
   * this method is pure plumbing — it does NOT validate against cert constraints.
   */
  async executeSwap(params: SwapParams): Promise<Hex> {
    if (!this.walletClient || !this.account) {
      throw new Error('Cannot executeSwap: no private key configured');
    }

    const router = params.router as Address;
    const tokenIn = params.tokenIn as Address;
    const tokenOut = params.tokenOut as Address;
    const amountIn = params.amountIn;
    const recipient = this.account.address;

    // 1. Check tokenIn balance
    const balance = await this.publicClient.readContract({
      address: tokenIn,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [recipient],
    } as any) as bigint;

    if (balance < amountIn) {
      throw new Error(
        `Insufficient ${tokenIn} balance: have ${balance.toString()}, need ${amountIn.toString()}`
      );
    }

    // 2. Approve router if needed
    const currentAllowance = await this.publicClient.readContract({
      address: tokenIn,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [recipient, router],
    } as any) as bigint;

    if (currentAllowance < amountIn) {
      console.log(`[Chain] Approving ${router} to spend ${amountIn.toString()} of ${tokenIn}...`);
      const approveHash = await this.walletClient.writeContract({
        chain: base,
        account: this.account,
        address: tokenIn,
        abi: erc20Abi,
        functionName: 'approve',
        args: [router, amountIn],
      });
      const approveReceipt = await this.publicClient.waitForTransactionReceipt({ hash: approveHash });
      if (approveReceipt.status !== 'success') {
        throw new Error(`Approval transaction reverted: ${approveHash}`);
      }
      console.log(`[Chain] Approval confirmed: ${approveHash}`);
    }

    // 3. Quote price via QuoterV2
    let quotedAmountOut: bigint;
    try {
      const quoteResult = await this.publicClient.simulateContract({
        address: QUOTER_V2,
        abi: quoterV2Abi,
        functionName: 'quoteExactInputSingle',
        args: [{
          tokenIn,
          tokenOut,
          amountIn,
          fee: UNISWAP_V3_FEE,
          sqrtPriceLimitX96: 0n,
        }],
      });
      quotedAmountOut = (quoteResult.result as readonly bigint[])[0];
      console.log(`[Chain] Quote: ${amountIn.toString()} ${tokenIn} → ${quotedAmountOut.toString()} ${tokenOut}`);
    } catch (quoteErr) {
      throw new Error(`Quote failed (no liquidity?): ${quoteErr instanceof Error ? quoteErr.message : String(quoteErr)}`);
    }

    // 4. Calculate amountOutMinimum from quote using agent's slippageBps
    const amountOutMinimum = quotedAmountOut - (quotedAmountOut * BigInt(params.slippageBps) / 10000n);

    // 5. Build exactInputSingle calldata (SwapRouter02 has no deadline in struct — it's in outer multicall)
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 300); // 5 min from now
    const swapCalldata = encodeFunctionData({
      abi: swapRouterAbi,
      functionName: 'exactInputSingle',
      args: [{
        tokenIn,
        tokenOut,
        fee: UNISWAP_V3_FEE,
        recipient,
        amountIn,
        amountOutMinimum,
        sqrtPriceLimitX96: 0n,
      }],
    });

    // 6. Execute via multicall(deadline, [calldata])
    console.log(`[Chain] Executing swap: ${amountIn.toString()} ${tokenIn} → ${tokenOut} (slippage: ${params.slippageBps} bps, minOut: ${amountOutMinimum.toString()})...`);
    const txHash = await this.walletClient.writeContract({
      chain: base,
      account: this.account,
      address: router,
      abi: swapRouterAbi,
      functionName: 'multicall',
      args: [deadline, [swapCalldata]],
    });

    // 7. Wait for receipt
    console.log(`[Chain] Swap tx submitted: ${txHash}`);
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== 'success') {
      throw new Error(`Swap transaction reverted: ${txHash}`);
    }
    console.log(`[Chain] Swap confirmed: ${txHash}`);
    return txHash;
  }

  /**
   * Sign and send an arbitrary transaction. The agent builds the calldata;
   * this method is pure plumbing — it signs, sends, and waits for receipt.
   */
  async sendTransaction(to: string, data: string, value: bigint = 0n): Promise<Hex> {
    if (!this.walletClient || !this.account) {
      throw new Error('Cannot sendTransaction: no private key configured');
    }

    const toAddr = to as Address;
    console.log(`[Chain] Sending tx to ${toAddr} (data=${data.slice(0, 10)}..., value=${value.toString()})...`);

    const txHash = await this.walletClient.sendTransaction({
      chain: base,
      account: this.account,
      to: toAddr,
      data: data as Hex,
      value,
    } as any);

    console.log(`[Chain] Tx submitted: ${txHash}`);
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== 'success') {
      throw new Error(`Transaction reverted: ${txHash}`);
    }
    console.log(`[Chain] Tx confirmed: ${txHash}`);
    return txHash;
  }

  /**
   * Approve an ERC-20 token for a spender address.
   * Convenience wrapper — agents could do this via sendTransaction with
   * approve calldata, but approvals are so common it's worth a dedicated method.
   */
  async approveToken(token: string, spender: string, amount: bigint): Promise<Hex> {
    if (!this.walletClient || !this.account) {
      throw new Error('Cannot approveToken: no private key configured');
    }

    const tokenAddr = token as Address;
    const spenderAddr = spender as Address;

    console.log(`[Chain] Approving ${spenderAddr} to spend ${amount.toString()} of ${tokenAddr}...`);
    const approveHash = await this.walletClient.writeContract({
      chain: base,
      account: this.account,
      address: tokenAddr,
      abi: erc20Abi,
      functionName: 'approve',
      args: [spenderAddr, amount],
    });
    const approveReceipt = await this.publicClient.waitForTransactionReceipt({ hash: approveHash });
    if (approveReceipt.status !== 'success') {
      throw new Error(`Approval transaction reverted: ${approveHash}`);
    }
    console.log(`[Chain] Approval confirmed: ${approveHash}`);
    return approveHash;
  }
}
