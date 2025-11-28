/**
 * Deflex Swap Service
 * Provides access to Deflex swap aggregator on Algorand Mainnet via SDK
 */

import { DeflexClient } from '@txnlab/deflex';
import algosdk from 'algosdk';
import {
  SwapProvider,
  SwapToken,
  UnifiedQuoteRequest,
  UnifiedSwapQuote,
  UnifiedRoute,
  SwapCachedData,
  SwapServiceError,
} from '../swap/types';
import {
  TinymanAsaList,
  TinymanAsaToken,
} from './types';
import { getNetworkConfig } from '../network/config';
import { NetworkId } from '@/types/network';

const TINYMAN_ASA_LIST_URL = 'https://asa-list.tinyman.org/assets.json';
const CACHE_TTL = 15 * 60 * 1000; // 15 minutes
const REQUEST_TIMEOUT = 30000; // 30 seconds

export class DeflexApiError extends SwapServiceError {
  constructor(message: string, statusCode?: number) {
    super(message, 'deflex', statusCode);
    this.name = 'DeflexApiError';
  }
}

/**
 * Fake signer that does nothing - we just need it to satisfy the SDK
 * We'll extract unsigned transactions from buildGroup() instead
 */
const fakeSigner = async (txnGroup: algosdk.Transaction[], indexesToSign: number[]) => {
  // Return empty array - we won't actually use signed transactions
  return txnGroup.map(() => new Uint8Array());
};

export class DeflexSwapService implements SwapProvider {
  private static instance: DeflexSwapService;
  private client: DeflexClient | null = null;
  private tokensCache: SwapCachedData<SwapToken[]> | null = null;
  private tokensByIdCache: Map<number, SwapToken> = new Map();

  private constructor() {}

  public static getInstance(): DeflexSwapService {
    if (!DeflexSwapService.instance) {
      DeflexSwapService.instance = new DeflexSwapService();
    }
    return DeflexSwapService.instance;
  }

  /**
   * Get or create the Deflex client
   */
  private getClient(): DeflexClient {
    if (!this.client) {
      const apiKey = process.env.EXPO_PUBLIC_DEFLEX_API_KEY;
      if (!apiKey) {
        throw new DeflexApiError('Deflex API key not configured. Set EXPO_PUBLIC_DEFLEX_API_KEY environment variable.');
      }

      const networkConfig = getNetworkConfig(NetworkId.ALGORAND_MAINNET);

      this.client = new DeflexClient({
        apiKey,
        algodUri: networkConfig.algodUrl,
        referrerAddress: 'BUYVOIJ7RNU7O4Z2F4A5T555FKSR2AMYHL5ZNF65Z5ZDEPSMVMEWXCNTV4',
        feeBps: 50,
        autoOptIn: true,
      });
    }
    return this.client;
  }

  /**
   * Check if cached data is still valid
   */
  private isCacheValid<T>(cache: SwapCachedData<T> | null): boolean {
    if (!cache) return false;
    return Date.now() < cache.expiresAt;
  }

  /**
   * Fetch token list from Tinyman ASA list
   */
  public async getTokens(forceRefresh = false): Promise<SwapToken[]> {
    if (!forceRefresh && this.isCacheValid(this.tokensCache)) {
      return this.tokensCache!.data;
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

      const response = await fetch(TINYMAN_ASA_LIST_URL, {
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new DeflexApiError(
          `Failed to fetch Tinyman ASA list: ${response.status}`,
          response.status
        );
      }

      const asaList: TinymanAsaList = await response.json();

      // Convert to SwapToken array
      const tokens: SwapToken[] = Object.entries(asaList)
        .filter(([_, token]) => !token.deleted) // Filter out deleted tokens
        .map(([id, token]: [string, TinymanAsaToken]) => ({
          id: parseInt(id, 10),
          symbol: token.unit_name || '',
          name: token.name || '',
          decimals: token.decimals || 0,
          logoUrl: token.logo?.png || token.logo?.svg,
          verified: true, // Tinyman list is curated
        }));

      // Update caches
      this.tokensCache = {
        data: tokens,
        timestamp: Date.now(),
        expiresAt: Date.now() + CACHE_TTL,
      };

      // Build ID lookup cache
      this.tokensByIdCache.clear();
      tokens.forEach(token => {
        this.tokensByIdCache.set(token.id, token);
      });

      return tokens;
    } catch (error) {
      console.error('Failed to fetch tokens from Tinyman ASA list:', error);
      // Return cached data if available
      return this.tokensCache?.data || [];
    }
  }

  /**
   * Get swap quote from Deflex SDK
   */
  public async getQuote(request: UnifiedQuoteRequest): Promise<UnifiedSwapQuote> {
    const client = this.getClient();

    if (!request.userAddress) {
      throw new DeflexApiError('User address is required for Deflex quotes');
    }

    try {
      // Get quote from Deflex SDK
      const quote = await client.newQuote({
        fromASAID: request.inputTokenId,
        toASAID: request.outputTokenId,
        amount: BigInt(request.amount),
        type: 'fixed-input',
        address: request.userAddress,
      });

      const slippage = request.slippageTolerance || 1; // Default 1%

      // Create swap with fake signer - we just need to get the transaction group
      const swap = await client.newSwap({
        quote,
        address: request.userAddress,
        slippage,
        signer: fakeSigner,
      });

      // Add swap transactions to the ATC and build the group
      await swap.addSwapTransactions();
      const txnGroup = await swap.buildGroup();

      // Access the deflexTxns to get logic sig information
      const deflexTxns = (swap as any).deflexTxns || [];

      // Extract transactions - some are logic sig (pre-signed), some need user signing
      const unsignedTransactions: string[] = [];
      for (let i = 0; i < txnGroup.length; i++) {
        const txnWithSigner = txnGroup[i];
        const deflexTxn = deflexTxns[i];

        // Check if this transaction has a logic sig blob (already signed transaction)
        if (deflexTxn?.logicSigBlob && deflexTxn.logicSigBlob !== false) {
          // The logicSigBlob contains the already-signed transaction bytes
          let signedTxnBytes: Uint8Array;

          if (deflexTxn.logicSigBlob instanceof Uint8Array) {
            signedTxnBytes = deflexTxn.logicSigBlob;
          } else if (Buffer.isBuffer(deflexTxn.logicSigBlob)) {
            signedTxnBytes = new Uint8Array(deflexTxn.logicSigBlob);
          } else if (typeof deflexTxn.logicSigBlob === 'object') {
            // Object with numeric keys - find the max key to get the correct size
            const keys = Object.keys(deflexTxn.logicSigBlob).filter(k => !isNaN(Number(k)));
            if (keys.length > 0) {
              const maxKey = Math.max(...keys.map(Number));
              signedTxnBytes = new Uint8Array(maxKey + 1);
              for (const key of keys) {
                signedTxnBytes[Number(key)] = deflexTxn.logicSigBlob[key];
              }
            } else {
              // Fallback: encode the transaction as unsigned
              const txnBytes = algosdk.encodeUnsignedTransaction(txnWithSigner.txn);
              unsignedTransactions.push(Buffer.from(txnBytes).toString('base64'));
              continue;
            }
          } else {
            // Fallback: encode the transaction as unsigned
            const txnBytes = algosdk.encodeUnsignedTransaction(txnWithSigner.txn);
            unsignedTransactions.push(Buffer.from(txnBytes).toString('base64'));
            continue;
          }

          unsignedTransactions.push(Buffer.from(signedTxnBytes).toString('base64'));
        } else {
          // This is a user transaction - encode as unsigned for user to sign
          const txnBytes = algosdk.encodeUnsignedTransaction(txnWithSigner.txn);
          unsignedTransactions.push(Buffer.from(txnBytes).toString('base64'));
        }
      }

      // Calculate values
      const inputAmount = request.amount;
      const outputAmount = quote.quote.toString();

      // Calculate minimum output with slippage
      const slippageMultiplier = (100 - slippage) / 100;
      const minimumOutput = BigInt(Math.floor(Number(quote.quote) * slippageMultiplier));

      // Build unified route from Deflex route structure
      const route = this.buildUnifiedRoute(quote);

      // Calculate rate (output per input)
      const inputDecimals = (await this.getTokenById(request.inputTokenId))?.decimals || 6;
      const outputDecimals = (await this.getTokenById(request.outputTokenId))?.decimals || 6;
      const inputValue = Number(inputAmount) / Math.pow(10, inputDecimals);
      const outputValue = Number(outputAmount) / Math.pow(10, outputDecimals);
      const rate = inputValue > 0 ? outputValue / inputValue : 0;

      return {
        inputAmount,
        outputAmount,
        minimumOutputAmount: minimumOutput.toString(),
        rate,
        priceImpact: quote.userPriceImpact || 0,
        networkFee: '0.001', // Algorand minimum fee
        route,
        unsignedTransactions,
        provider: 'deflex',
        tokenValues: this.buildTokenValues(quote, request.inputTokenId, request.outputTokenId),
        usdIn: quote.usdIn,
        usdOut: quote.usdOut,
        expiresAt: Date.now() + 60000, // Quotes typically valid for ~1 minute
      };
    } catch (error) {
      if (error instanceof DeflexApiError) {
        throw error;
      }
      throw new DeflexApiError(
        error instanceof Error ? error.message : 'Failed to get quote from Deflex'
      );
    }
  }

  /**
   * Build unified route from Deflex quote
   */
  private buildUnifiedRoute(quote: any): UnifiedRoute {
    const routeSegments = quote.route || [];
    const totalPools = routeSegments.reduce(
      (sum: number, segment: any) => sum + (segment.path?.length || 0),
      0
    );

    // Determine if it's a multi-hop route
    const isMultiHop = routeSegments.some(
      (segment: any) => segment.path && segment.path.length > 1
    );

    if (isMultiHop) {
      // Build multi-hop route representation
      const hops = routeSegments.flatMap((segment: any) =>
        (segment.path || []).map((pool: any) => ({
          inputToken: null,
          outputToken: null,
          inputAmount: '0',
          outputAmount: '0',
          pools: [{
            poolId: pool.name || 'unknown',
            dex: pool.name?.split(':')[0] || 'unknown',
            inputAmount: '0',
            outputAmount: '0',
          }],
        }))
      );

      return {
        type: 'multi-hop',
        hops,
        totalPools,
      };
    }

    // Direct route
    const pools = routeSegments.flatMap((segment: any) =>
      (segment.path || []).map((pool: any) => ({
        poolId: pool.name || 'unknown',
        dex: pool.name?.split(':')[0] || 'unknown',
        inputAmount: '0',
        outputAmount: '0',
      }))
    );

    return {
      type: 'direct',
      pools,
      totalPools: totalPools || pools.length,
    };
  }

  /**
   * Build token values map for USD display
   */
  private buildTokenValues(
    quote: any,
    inputTokenId: number,
    outputTokenId: number
  ): Record<string, number> {
    const tokenValues: Record<string, number> = {};

    // Use USD values from quote if available
    if (quote.usdIn !== undefined && quote.usdOut !== undefined) {
      tokenValues[String(inputTokenId)] = quote.usdIn;
      tokenValues[String(outputTokenId)] = quote.usdOut;
    }

    return tokenValues;
  }

  /**
   * Check if a token is swappable on Deflex
   */
  public async isTokenSwappable(tokenId: number): Promise<boolean> {
    // For Deflex/Algorand, assume all tokens in the Tinyman list are swappable
    try {
      const tokens = await this.getTokens();
      return tokens.some(token => token.id === tokenId);
    } catch (error) {
      console.error('Error checking token swappability:', error);
      return false;
    }
  }

  /**
   * Get token by ID
   */
  public async getTokenById(tokenId: number): Promise<SwapToken | undefined> {
    // Check cache first
    if (this.tokensByIdCache.has(tokenId)) {
      return this.tokensByIdCache.get(tokenId);
    }

    // Load tokens to populate cache
    try {
      await this.getTokens();
      return this.tokensByIdCache.get(tokenId);
    } catch (error) {
      console.error('Error getting token by ID:', error);
      return undefined;
    }
  }

  /**
   * Search tokens by symbol or name
   */
  public async searchTokens(query: string): Promise<SwapToken[]> {
    try {
      const tokens = await this.getTokens();
      const lowerQuery = query.toLowerCase();
      return tokens.filter(
        token =>
          token.symbol.toLowerCase().includes(lowerQuery) ||
          token.name.toLowerCase().includes(lowerQuery) ||
          token.id.toString() === query
      );
    } catch (error) {
      console.error('Error searching tokens:', error);
      return [];
    }
  }

  /**
   * Clear all caches
   */
  public clearCache(): void {
    this.tokensCache = null;
    this.tokensByIdCache.clear();
    this.client = null;
  }
}

// Export singleton instance
export default DeflexSwapService.getInstance();
