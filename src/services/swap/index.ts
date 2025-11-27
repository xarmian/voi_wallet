/**
 * Unified Swap Service
 * Factory for network-aware swap provider selection
 */

import {
  SwapProvider,
  SwapToken,
  UnifiedQuoteRequest,
  UnifiedSwapQuote,
  UnifiedRoute,
  SwapServiceError,
} from './types';
import SnowballApiService from '../snowball';
import { SnowballToken, SwapQuote, Route, RoutePool, RouteHop } from '../snowball/types';
import { DeflexSwapService } from '../deflex';
import { NetworkId } from '@/types/network';
import { useNetworkStore } from '@/store/networkStore';

/**
 * Adapter to make SnowballApiService conform to SwapProvider interface
 */
class SnowballSwapAdapter implements SwapProvider {
  private service = SnowballApiService;

  /**
   * Convert SnowballToken to SwapToken
   */
  private convertToken(token: SnowballToken): SwapToken {
    return {
      id: typeof token.id === 'string' ? parseInt(token.id, 10) : token.id,
      symbol: token.symbol,
      name: token.name,
      decimals: token.decimals,
      logoUrl: token.imageUrl || token.logoURI || undefined,
      verified: token.verified,
    };
  }

  /**
   * Convert Snowball Route to UnifiedRoute
   */
  private convertRoute(route: Route): UnifiedRoute {
    const totalPools = route.type === 'direct'
      ? (route.pools?.length || 0)
      : (route.hops?.reduce((sum, hop) => sum + (hop.pools?.length || 0), 0) || 0);

    if (route.type === 'multi-hop' && route.hops) {
      return {
        type: 'multi-hop',
        hops: route.hops.map((hop: RouteHop) => ({
          inputToken: null, // Would need to fetch token details
          outputToken: null,
          inputAmount: hop.inputAmount,
          outputAmount: hop.outputAmount,
          pools: hop.pools.map((pool: RoutePool) => ({
            poolId: pool.poolId,
            dex: pool.dex,
            inputAmount: pool.inputAmount,
            outputAmount: pool.outputAmount,
          })),
        })),
        totalPools,
      };
    }

    // Direct route
    return {
      type: 'direct',
      pools: route.pools?.map((pool: RoutePool) => ({
        poolId: pool.poolId,
        dex: pool.dex,
        inputAmount: pool.inputAmount,
        outputAmount: pool.outputAmount,
      })),
      totalPools,
    };
  }

  async getTokens(): Promise<SwapToken[]> {
    const tokens = await this.service.getTokens();

    // Ensure we have an array
    if (!Array.isArray(tokens)) {
      return [];
    }

    return tokens
      .filter(t => !t.is_wrapped) // Filter out wrapped tokens
      .map(t => this.convertToken(t));
  }

  async getQuote(request: UnifiedQuoteRequest): Promise<UnifiedSwapQuote> {
    const quote: SwapQuote = await this.service.getQuote({
      inputToken: request.inputTokenId,
      outputToken: request.outputTokenId,
      amount: request.amount,
      address: request.userAddress,
      // Snowball uses decimal slippage (0.01 = 1%), unified uses percentage (1 = 1%)
      slippageTolerance: request.slippageTolerance
        ? request.slippageTolerance / 100
        : undefined,
    });

    return {
      inputAmount: quote.quote.inputAmount,
      outputAmount: quote.quote.outputAmount,
      minimumOutputAmount: quote.quote.minimumOutputAmount,
      rate: quote.quote.rate,
      priceImpact: quote.quote.priceImpact,
      networkFee: quote.quote.networkFee,
      route: this.convertRoute(quote.route),
      unsignedTransactions: quote.unsignedTransactions,
      provider: 'snowball',
      tokenValues: quote.quote.tokenValues,
      expiresAt: quote.quote.expiresAt,
    };
  }

  async isTokenSwappable(tokenId: number): Promise<boolean> {
    return this.service.isTokenSwappable(tokenId);
  }

  async getTokenById(tokenId: number): Promise<SwapToken | undefined> {
    const token = await this.service.getTokenById(tokenId);
    return token ? this.convertToken(token) : undefined;
  }

  async searchTokens(query: string): Promise<SwapToken[]> {
    const tokens = await this.service.searchTokens(query);
    return tokens.map(t => this.convertToken(t));
  }

  clearCache(): void {
    this.service.clearCache();
  }
}

/**
 * Unified SwapService that routes to the appropriate provider based on network
 */
export class SwapService {
  private static voiProvider: SnowballSwapAdapter | null = null;
  private static algorandProvider: DeflexSwapService | null = null;

  /**
   * Get the swap provider for a given network
   */
  static getProvider(networkId?: NetworkId): SwapProvider {
    const currentNetwork = networkId || useNetworkStore.getState().currentNetwork;

    switch (currentNetwork) {
      case NetworkId.VOI_MAINNET:
        if (!this.voiProvider) {
          this.voiProvider = new SnowballSwapAdapter();
        }
        return this.voiProvider;

      case NetworkId.ALGORAND_MAINNET:
        if (!this.algorandProvider) {
          this.algorandProvider = DeflexSwapService.getInstance();
        }
        return this.algorandProvider;

      default:
        throw new SwapServiceError(`Swap not supported on network: ${currentNetwork}`);
    }
  }

  /**
   * Check if swap is available on a given network
   */
  static isSwapAvailable(networkId?: NetworkId): boolean {
    const currentNetwork = networkId || useNetworkStore.getState().currentNetwork;
    return [NetworkId.VOI_MAINNET, NetworkId.ALGORAND_MAINNET].includes(currentNetwork);
  }

  /**
   * Get provider info for branding
   */
  static getProviderInfo(networkId?: NetworkId): {
    name: string;
    url: string;
    provider: 'snowball' | 'deflex';
  } {
    const currentNetwork = networkId || useNetworkStore.getState().currentNetwork;

    switch (currentNetwork) {
      case NetworkId.ALGORAND_MAINNET:
        return {
          name: 'Deflex',
          url: 'https://deflex.fi',
          provider: 'deflex',
        };

      case NetworkId.VOI_MAINNET:
      default:
        return {
          name: 'SnowballSwap',
          url: 'https://snowballswap.com',
          provider: 'snowball',
        };
    }
  }

  /**
   * Clear all provider caches
   */
  static clearAllCaches(): void {
    this.voiProvider?.clearCache();
    this.algorandProvider?.clearCache();
  }
}

// Re-export types for convenience
export * from './types';
