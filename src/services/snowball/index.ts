/**
 * Snowball DEX API Service
 * Provides access to Snowball swap aggregator on Voi Network
 */

import {
  SnowballToken,
  SnowballPool,
  SwapQuote,
  QuoteRequest,
  UnwrapRequest,
  HealthResponse,
  CachedData,
  TokensResponse,
} from './types';

const SNOWBALL_API_BASE_URL = 'https://api.snowballswap.com';
const REQUEST_TIMEOUT = 10000; // 10 seconds
const CACHE_TTL = 15 * 60 * 1000; // 15 minutes
const MAX_RETRIES = 3;
const RETRY_DELAY = 1000; // 1 second

export class SnowballApiError extends Error {
  statusCode?: number;

  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = 'SnowballApiError';
    this.statusCode = statusCode;
  }
}

/**
 * Serialize an asset/app ID for the wire.
 *
 * The API rejects numeric IDs outright:
 *   {"error":"Invalid inputToken/outputToken: must be a string of digits
 *             (asset/app id) <= 9007199254740991"}
 * and applies the same rule to `poolId` and to `items[].wrappedTokenId` on
 * /unwrap. It is strict about the whole payload — one numeric field is enough
 * for a 400, so every ID goes through here.
 *
 * The app carries IDs as numbers (see QuoteRequest's note), and the API's
 * ceiling is exactly Number.MAX_SAFE_INTEGER, so `String(id)` is lossless for
 * every ID the API will accept. Non-integer or out-of-range input would
 * serialize to something the API rejects with an opaque 400, so it is caught
 * here instead, where the message can name the field.
 */
const toWireId = (id: number | string, field: string): string => {
  if (typeof id === 'string') {
    if (!/^\d+$/.test(id)) {
      throw new SnowballApiError(`Invalid ${field}: expected an asset/app ID`);
    }
    return id;
  }
  if (!Number.isSafeInteger(id) || id < 0) {
    throw new SnowballApiError(`Invalid ${field}: expected an asset/app ID`);
  }
  return String(id);
};

export class SnowballApiService {
  private static instance: SnowballApiService;
  private tokensCache: CachedData<SnowballToken[]> | null = null;
  private poolsCache: CachedData<SnowballPool[]> | null = null;

  private constructor() {}

  public static getInstance(): SnowballApiService {
    if (!SnowballApiService.instance) {
      SnowballApiService.instance = new SnowballApiService();
    }
    return SnowballApiService.instance;
  }

  /**
   * Make HTTP request with timeout and retry logic
   */
  private async makeRequest<T>(
    endpoint: string,
    options: RequestInit = {},
    retryCount = 0
  ): Promise<T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

    try {
      const url = `${SNOWBALL_API_BASE_URL}${endpoint}`;
      const response = await fetch(url, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          ...options.headers,
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        // The API reports failures as {"error": "..."}, not {"message": ...},
        // and RN's fetch leaves `statusText` empty — so reading only `message`
        // collapsed every 400 to the literal, useless string "HTTP 400: "
        // while the actual reason sat unread in the body.
        throw new SnowballApiError(
          errorData.message ||
            errorData.error ||
            `HTTP ${response.status}${
              response.statusText ? `: ${response.statusText}` : ''
            }`,
          response.status
        );
      }

      return await response.json();
    } catch (error) {
      clearTimeout(timeoutId);

      // Retry on network errors or 5xx errors
      if (
        retryCount < MAX_RETRIES &&
        (error instanceof TypeError || // Network error
          (error instanceof SnowballApiError &&
            error.statusCode &&
            error.statusCode >= 500))
      ) {
        await new Promise((resolve) =>
          setTimeout(resolve, RETRY_DELAY * (retryCount + 1))
        );
        return this.makeRequest<T>(endpoint, options, retryCount + 1);
      }

      if (error instanceof SnowballApiError) {
        throw error;
      }

      throw new SnowballApiError(
        error instanceof Error ? error.message : 'Unknown error occurred'
      );
    }
  }

  /**
   * Check if cached data is still valid
   */
  private isCacheValid<T>(cache: CachedData<T> | null): boolean {
    if (!cache) return false;
    return Date.now() < cache.expiresAt;
  }

  /**
   * Get list of available tokens on Snowball
   */
  public async getTokens(forceRefresh = false): Promise<SnowballToken[]> {
    if (!forceRefresh && this.isCacheValid(this.tokensCache)) {
      return this.tokensCache!.data;
    }

    try {
      const response = await this.makeRequest<TokensResponse>('/config/tokens');

      // Extract tokens array from response
      const tokens = response?.tokens;

      // Ensure we got an array
      if (!Array.isArray(tokens)) {
        console.error(
          'Invalid response from Snowball API - expected tokens array, got:',
          typeof tokens
        );
        return this.tokensCache?.data || [];
      }

      // Normalize token IDs to numbers
      const normalizedTokens = tokens.map((token) => ({
        ...token,
        id: typeof token.id === 'string' ? parseInt(token.id, 10) : token.id,
      }));

      this.tokensCache = {
        data: normalizedTokens,
        timestamp: Date.now(),
        expiresAt: Date.now() + CACHE_TTL,
      };

      return normalizedTokens;
    } catch (error) {
      console.error('Failed to fetch tokens from Snowball API:', error);
      // Return cached data if available, otherwise empty array
      return this.tokensCache?.data || [];
    }
  }

  /**
   * Get list of available pools on Snowball
   */
  public async getPools(forceRefresh = false): Promise<SnowballPool[]> {
    if (!forceRefresh && this.isCacheValid(this.poolsCache)) {
      return this.poolsCache!.data;
    }

    const pools = await this.makeRequest<SnowballPool[]>('/config/pools');

    this.poolsCache = {
      data: pools,
      timestamp: Date.now(),
      expiresAt: Date.now() + CACHE_TTL,
    };

    return pools;
  }

  /**
   * Get information about a specific pool
   */
  public async getPool(poolId: number): Promise<SnowballPool> {
    return await this.makeRequest<SnowballPool>(`/pool/${poolId}`);
  }

  /**
   * Get swap quote
   */
  public async getQuote(request: QuoteRequest): Promise<SwapQuote> {
    const { inputToken, outputToken, poolId, ...rest } = request;
    return await this.makeRequest<SwapQuote>('/quote', {
      method: 'POST',
      body: JSON.stringify({
        ...rest,
        inputToken: toWireId(inputToken, 'inputToken'),
        outputToken: toWireId(outputToken, 'outputToken'),
        ...(poolId !== undefined ? { poolId: toWireId(poolId, 'poolId') } : {}),
      }),
    });
  }

  /**
   * Build unwrap transaction group
   */
  public async unwrap(
    request: UnwrapRequest
  ): Promise<{ transactions: string[] }> {
    return await this.makeRequest<{ transactions: string[] }>('/unwrap', {
      method: 'POST',
      body: JSON.stringify({
        ...request,
        items: request.items.map((item, i) => ({
          ...item,
          wrappedTokenId: toWireId(
            item.wrappedTokenId,
            `items[${i}].wrappedTokenId`
          ),
        })),
      }),
    });
  }

  /**
   * Check API health status
   */
  public async healthCheck(): Promise<HealthResponse> {
    return await this.makeRequest<HealthResponse>('/health');
  }

  /**
   * Check if a token is swappable on Snowball
   */
  public async isTokenSwappable(tokenId: number): Promise<boolean> {
    try {
      const tokens = await this.getTokens();

      // Extra safety check
      if (!Array.isArray(tokens)) {
        console.error('Invalid tokens data:', tokens);
        return false;
      }

      return tokens.some((token) => token.id === tokenId);
    } catch (error) {
      console.error('Error checking token swappability:', error);
      return false;
    }
  }

  /**
   * Get token by ID
   */
  public async getTokenById(
    tokenId: number
  ): Promise<SnowballToken | undefined> {
    try {
      const tokens = await this.getTokens();
      if (!Array.isArray(tokens)) {
        return undefined;
      }
      return tokens.find((token) => token.id === tokenId);
    } catch (error) {
      console.error('Error getting token by ID:', error);
      return undefined;
    }
  }

  /**
   * Search tokens by symbol or name
   */
  public async searchTokens(query: string): Promise<SnowballToken[]> {
    try {
      const tokens = await this.getTokens();
      if (!Array.isArray(tokens)) {
        return [];
      }
      const lowerQuery = query.toLowerCase();
      return tokens.filter(
        (token) =>
          token.symbol.toLowerCase().includes(lowerQuery) ||
          token.name.toLowerCase().includes(lowerQuery)
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
    this.poolsCache = null;
  }
}

// Export singleton instance
export default SnowballApiService.getInstance();
