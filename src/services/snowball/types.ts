/**
 * Snowball DEX API Types
 * API Documentation: https://api.snowballswap.com/
 */

/**
 * Token metadata from Snowball API
 */
export interface SnowballToken {
  id: number | string;
  symbol: string;
  name: string;
  decimals: number;
  is_wrapped?: boolean;
  logoURI?: string;
  imageUrl?: string | null;
  verified?: boolean;
}

/**
 * Tokens list response from API
 */
export interface TokensResponse {
  tokens: SnowballToken[];
}

/**
 * Pool information from Snowball API
 */
export interface SnowballPool {
  poolId: number;
  dex: string;
  token0: number;
  token1: number;
  reserve0?: string;
  reserve1?: string;
  fee?: number;
}

/**
 * Pool information in route
 */
export interface RoutePool {
  poolId: string;
  dex: string;
  inputAmount: string;
  outputAmount: string;
}

/**
 * Hop information containing pools
 */
export interface RouteHop {
  inputToken: string;
  outputToken: string;
  inputAmount: string;
  outputAmount: string;
  pools: RoutePool[];
}

/**
 * Route information
 */
export interface Route {
  type: 'direct' | 'multi-hop';
  pools?: RoutePool[];  // For direct routes
  hops?: RouteHop[];    // For multi-hop routes
}

/**
 * Quote details
 */
export interface QuoteDetails {
  inputAmount: string;
  outputAmount: string;
  minimumOutputAmount: string;
  rate: number;
  priceImpact: number;
  networkFee: string;
}

/**
 * Platform fee information
 */
export interface PlatformFee {
  gain: string;
  feeAmount: string;
  feeBps: number;
  feeAddress: string | null;
  applied: boolean;
}

/**
 * Swap quote response from Snowball API
 */
export interface SwapQuote {
  quote: QuoteDetails;
  unsignedTransactions: string[]; // Base64 encoded unsigned transactions
  route: Route;
  poolId: string;
  platformFee: PlatformFee;
}

/**
 * Quote request parameters
 */
export interface QuoteRequest {
  inputToken: number;
  outputToken: number;
  amount: string;
  address?: string;
  slippageTolerance?: number;
  poolId?: number;
  dex?: string[];
}

/**
 * Unwrap request parameters
 */
export interface UnwrapRequest {
  address: string;
  items: Array<{
    wrappedTokenId: number;
    amount: string;
  }>;
}

/**
 * API Error response structure
 */
export interface SnowballApiErrorResponse {
  error: string;
  message?: string;
  statusCode?: number;
}

/**
 * Health check response
 */
export interface HealthResponse {
  status: 'ok' | 'error';
  timestamp: number;
}

/**
 * Cached data structure
 */
export interface CachedData<T> {
  data: T;
  timestamp: number;
  expiresAt: number;
}
