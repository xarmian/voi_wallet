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
        throw new SnowballApiError(
          errorData.message || `HTTP ${response.status}: ${response.statusText}`,
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
          (error instanceof SnowballApiError && error.statusCode && error.statusCode >= 500))
      ) {
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY * (retryCount + 1)));
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
        console.error('Invalid response from Snowball API - expected tokens array, got:', typeof tokens);
        return this.tokensCache?.data || [];
      }

      // Normalize token IDs to numbers
      const normalizedTokens = tokens.map(token => ({
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
    return await this.makeRequest<SwapQuote>('/quote', {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }

  /**
   * Build unwrap transaction group
   */
  public async unwrap(request: UnwrapRequest): Promise<{ transactions: string[] }> {
    return await this.makeRequest<{ transactions: string[] }>('/unwrap', {
      method: 'POST',
      body: JSON.stringify(request),
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

      return tokens.some(token => token.id === tokenId);
    } catch (error) {
      console.error('Error checking token swappability:', error);
      return false;
    }
  }

  /**
   * Get token by ID
   */
  public async getTokenById(tokenId: number): Promise<SnowballToken | undefined> {
    try {
      const tokens = await this.getTokens();
      if (!Array.isArray(tokens)) {
        return undefined;
      }
      return tokens.find(token => token.id === tokenId);
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
        token =>
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
