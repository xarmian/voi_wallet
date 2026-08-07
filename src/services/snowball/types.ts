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
  pools?: RoutePool[]; // For direct routes
  hops?: RouteHop[]; // For multi-hop routes
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
  tokenValues?: Record<string, number>; // Token ID -> USD value per token
  timestamp?: number;
  expiresAt?: number;
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
 *
 * NOTE: the API answers HTTP 200 even when it priced the swap but could not
 * BUILD it — `unsignedTransactions` comes back empty and the reason is carried
 * in `error`/`simulationError`. See `SnowballSwapAdapter.getQuote`.
 */
export interface SwapQuote {
  quote: QuoteDetails;
  unsignedTransactions: string[]; // Base64 encoded unsigned transactions
  route: Route;
  poolId: string | null; // null when the route is multi-hop or unpinned
  platformFee: PlatformFee;
  /** Why transaction building failed, on an otherwise-200 response. */
  error?: string | null;
  /** Why simulating the built group failed, on an otherwise-200 response. */
  simulationError?: string | null;
  /** True when the quote was priced over a reduced set of pools. */
  routeDegraded?: boolean;
  skippedPools?: unknown[];
}

/**
 * Quote request parameters.
 *
 * IDs are numbers here — the app normalizes every token ID to a number
 * (`SnowballToken.id`, `SwapToken.id`), because /config/tokens returns them
 * inconsistently ("0" as a string, 300279 as a number). The API requires them
 * as strings of digits on the wire; that conversion happens once, in
 * `SnowballApiService`, so the wire format stays a concern of the service that
 * owns the wire.
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
 * Unwrap request parameters. `wrappedTokenId` is stringified on the wire for
 * the same reason as `QuoteRequest`'s IDs.
 */
export interface UnwrapRequest {
  address: string;
  items: {
    wrappedTokenId: number;
    amount: string;
  }[];
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
