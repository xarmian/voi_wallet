/**
 * Unified Swap Service Types
 * Network-agnostic interfaces for swap operations across multiple DEX providers
 */

import { NetworkId } from '@/types/network';

/**
 * Unified token representation for swap operations
 */
export interface SwapToken {
  id: number;
  symbol: string;
  name: string;
  decimals: number;
  logoUrl?: string;
  verified?: boolean;
}

/**
 * Quote request parameters (network-agnostic)
 */
export interface UnifiedQuoteRequest {
  inputTokenId: number;
  outputTokenId: number;
  amount: string; // In base units
  userAddress?: string;
  slippageTolerance?: number; // Percentage (e.g., 1 for 1%)
}

/**
 * Pool information in a route
 */
export interface UnifiedRoutePool {
  poolId: string;
  dex: string;
  inputAmount: string;
  outputAmount: string;
}

/**
 * Route hop for multi-hop swaps
 */
export interface UnifiedRouteHop {
  inputToken: SwapToken | null;
  outputToken: SwapToken | null;
  inputAmount: string;
  outputAmount: string;
  pools: UnifiedRoutePool[];
}

/**
 * Simplified route for display
 */
export interface UnifiedRoute {
  type: 'direct' | 'multi-hop';
  pools?: UnifiedRoutePool[]; // For direct routes
  hops?: UnifiedRouteHop[]; // For multi-hop routes
  totalPools: number;
}

/**
 * Unified quote response
 */
export interface UnifiedSwapQuote {
  inputAmount: string;
  outputAmount: string;
  minimumOutputAmount: string;
  rate: number;
  priceImpact: number;
  networkFee: string;
  route: UnifiedRoute;
  unsignedTransactions: string[]; // Base64 encoded
  expiresAt?: number;
  provider: 'snowball' | 'deflex';
  tokenValues?: Record<string, number>; // Token ID -> USD value per token
  usdIn?: number; // USD value of input amount
  usdOut?: number; // USD value of output amount
}

/**
 * Swap provider interface
 * Implemented by both SnowballSwapAdapter and DeflexSwapService
 */
export interface SwapProvider {
  /**
   * Get list of available tokens for swapping
   */
  getTokens(): Promise<SwapToken[]>;

  /**
   * Get a swap quote
   */
  getQuote(request: UnifiedQuoteRequest): Promise<UnifiedSwapQuote>;

  /**
   * Check if a token is swappable on this provider
   */
  isTokenSwappable(tokenId: number): Promise<boolean>;

  /**
   * Get token by ID
   */
  getTokenById(tokenId: number): Promise<SwapToken | undefined>;

  /**
   * Search tokens by symbol or name
   */
  searchTokens(query: string): Promise<SwapToken[]>;

  /**
   * Clear any cached data
   */
  clearCache(): void;
}

/**
 * Cached data structure for swap services
 */
export interface SwapCachedData<T> {
  data: T;
  timestamp: number;
  expiresAt: number;
}

/**
 * Swap service error
 */
export class SwapServiceError extends Error {
  statusCode?: number;
  provider?: 'snowball' | 'deflex';

  constructor(message: string, provider?: 'snowball' | 'deflex', statusCode?: number) {
    super(message);
    this.name = 'SwapServiceError';
    this.provider = provider;
    this.statusCode = statusCode;
  }
}
