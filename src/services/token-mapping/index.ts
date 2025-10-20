import AsyncStorage from '@react-native-async-storage/async-storage';
import { NetworkId } from '@/types/network';
import {
  TokenMapping,
  TokenMappingAPIResponse,
  TokenMappingConfig,
  TokenMappingAPIError,
  TokenMappingCacheError,
  TokenMappingValidationError,
  TokenReference,
} from './types';
import { ARAMID_TOKEN_MAPPINGS, VOI_ARC200_TOKEN_MAPPINGS } from '@/constants/token-mappings';

const CACHE_KEY = '@voi_wallet_token_mappings';
const CACHE_TIMESTAMP_KEY = '@voi_wallet_token_mappings_timestamp';
const CACHE_VERSION_KEY = '@voi_wallet_token_mappings_version';
const CURRENT_CACHE_VERSION = '8'; // Increment this when token mappings structure changes

/**
 * Convert ARAMID_TOKEN_MAPPINGS and VOI_ARC200_TOKEN_MAPPINGS to TokenMapping format
 */
function convertAramidMappingsToTokenMappings(): TokenMapping[] {
  const mappings: TokenMapping[] = [];
  const mappingGroups = new Map<string, TokenReference[]>();

  // Process each source token and its destination mappings from ARAMID_TOKEN_MAPPINGS
  for (const [sourceTokenId, destinationMappings] of Object.entries(ARAMID_TOKEN_MAPPINGS)) {
    for (const [destinationTokenId, mappingData] of Object.entries(destinationMappings)) {
      // Create a unique key for this token pair
      const mappingKey = `${mappingData.sourceName}-${mappingData.sourceSymbol}`;
      
      // Convert chain IDs to NetworkId
      const sourceNetworkId = mappingData.sourceChain === 416001 ? NetworkId.ALGORAND_MAINNET : NetworkId.VOI_MAINNET;
      const destinationNetworkId = mappingData.destinationChain === 416001 ? NetworkId.ALGORAND_MAINNET : NetworkId.VOI_MAINNET;

      // Create token references
      const sourceToken: TokenReference = {
        networkId: sourceNetworkId,
        assetId: parseInt(sourceTokenId),
        symbol: mappingData.sourceSymbol,
        decimals: mappingData.sourceDecimals,
      };

      const destinationToken: TokenReference = {
        networkId: destinationNetworkId,
        assetId: parseInt(destinationTokenId),
        symbol: mappingData.destinationSymbol,
        decimals: mappingData.destinationDecimals,
      };

      // Group tokens by their mapping key
      if (!mappingGroups.has(mappingKey)) {
        mappingGroups.set(mappingKey, []);
      }
      
      const tokens = mappingGroups.get(mappingKey)!;
      
      // Add tokens if they don't already exist in this group
      if (!tokens.some(t => t.assetId === sourceToken.assetId && t.networkId === sourceToken.networkId)) {
        tokens.push(sourceToken);
      }
      if (!tokens.some(t => t.assetId === destinationToken.assetId && t.networkId === destinationToken.networkId)) {
        tokens.push(destinationToken);
      }
    }
  }

  // Process ARC200 token mappings from VOI_ARC200_TOKEN_MAPPINGS
  for (const [chainId, chainData] of Object.entries(VOI_ARC200_TOKEN_MAPPINGS)) {
    for (const [tokenId, tokenData] of Object.entries(chainData.tokens)) {
      // Only process tokens that have an arc200TokenId
      if ('arc200TokenId' in tokenData && tokenData.arc200TokenId) {
        // Find the corresponding mapping group for this token
        const mappingKey = `${tokenData.name}-${tokenData.symbol}`;
        
        if (mappingGroups.has(mappingKey)) {
          const tokens = mappingGroups.get(mappingKey)!;
          
          // Add the ARC200 token if it doesn't already exist
          const arc200Token: TokenReference = {
            networkId: NetworkId.VOI_MAINNET,
            assetId: tokenData.arc200TokenId,
            symbol: tokenData.symbol,
            decimals: tokenData.decimals,
          };
          
          if (!tokens.some(t => t.assetId === arc200Token.assetId && t.networkId === arc200Token.networkId)) {
            tokens.push(arc200Token);
          }
        }
      }
    }
  }

  // Convert grouped tokens to TokenMapping objects
  for (const [mappingKey, tokens] of mappingGroups.entries()) {
    if (tokens.length >= 2) { // Only include mappings with at least 2 tokens
      const mapping: TokenMapping = {
        mappingId: mappingKey.toLowerCase().replace(/\s+/g, '-'),
        name: tokens[0].symbol, // Use the first token's symbol as the name
        tokens,
        verified: true, // All Aramid mappings are considered verified
        bridgeInfo: {
          bridgeProvider: 'Aramid',
          bridgeUrl: 'https://aramid.finance',
        },
        metadata: {
          description: `Aramid bridge mapping for ${tokens[0].symbol}`,
        },
      };
      mappings.push(mapping);
    }
  }

  return mappings;
}

/**
 * Converted token mappings from ARAMID_TOKEN_MAPPINGS
 */
const CONVERTED_TOKEN_MAPPINGS = convertAramidMappingsToTokenMappings();

/**
 * Mock token mappings for development
 * TODO: Replace with actual API data once endpoint is available
 */
const MOCK_TOKEN_MAPPINGS: TokenMapping[] = [
  {
    mappingId: 'algo',
    name: 'ALGO',
    tokens: [
      {
        networkId: NetworkId.ALGORAND_MAINNET,
        assetId: 0,
        symbol: 'ALGO',
        decimals: 6,
      },
      {
        networkId: NetworkId.VOI_MAINNET,
        assetId: 302189,
        symbol: 'aALGO',
        decimals: 6,
      },
      {
        networkId: NetworkId.VOI_MAINNET,
        assetId: 413153,
        symbol: 'aALGO',
        decimals: 6,
      },
    ],
    verified: true,
    metadata: {
      description: 'Algorand native token and its bridged equivalent on Voi Network',
    },
  },
  {
    mappingId: 'voi',
    name: 'VOI',
    tokens: [
      {
        networkId: NetworkId.VOI_MAINNET,
        assetId: 0,
        symbol: 'VOI',
        decimals: 6,
      },
      {
        networkId: NetworkId.ALGORAND_MAINNET,
        assetId: 2320775407,
        symbol: 'aVOI',
        decimals: 6,
      },
    ],
    verified: true,
    metadata: {
      description: 'VOI native token and its bridged equivalent on Algorand',
    },
  },
  {
    mappingId: 'usdc',
    name: 'USDC',
    tokens: [
      {
        networkId: NetworkId.VOI_MAINNET,
        assetId: 302190,
        symbol: 'aUSDC',
        decimals: 6,
      },
      {
        networkId: NetworkId.VOI_MAINNET,
        assetId: 395614,
        symbol: 'aUSDC',
        decimals: 6,
      },
      {
        networkId: NetworkId.ALGORAND_MAINNET,
        assetId: 31566704,
        symbol: 'USDC',
        decimals: 6,
      },
    ],
    verified: true,
    metadata: {
      description: 'USDC stablecoin across networks',
    },
  },
];

console.log(`[TokenMappingService] CONVERTED_TOKEN_MAPPINGS defined with ${CONVERTED_TOKEN_MAPPINGS.length} mappings:`,
  CONVERTED_TOKEN_MAPPINGS.map(m => m.mappingId));

const DEFAULT_CONFIG: TokenMappingConfig = {
  apiUrl: process.env.EXPO_PUBLIC_TOKEN_MAPPING_API_URL || '',
  cacheDuration: 24 * 60 * 60 * 1000, // 24 hours
  timeout: 10000, // 10 seconds
  retryAttempts: 3,
};

/**
 * Service for managing token mappings across multiple networks
 */
export class TokenMappingService {
  private static instance: TokenMappingService;
  private config: TokenMappingConfig;
  private cachedMappings: TokenMapping[] | null = null;
  private isLoading: boolean = false;

  private constructor(config?: Partial<TokenMappingConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Get singleton instance
   */
  static getInstance(config?: Partial<TokenMappingConfig>): TokenMappingService {
    if (!TokenMappingService.instance) {
      TokenMappingService.instance = new TokenMappingService(config);
    }
    return TokenMappingService.instance;
  }

  /**
   * Get all token mappings, using cache if available
   */
  async getTokenMappings(forceRefresh = false): Promise<TokenMapping[]> {
    // Return cached mappings if available and not forcing refresh
    if (this.cachedMappings && !forceRefresh) {
      return this.cachedMappings;
    }

    // Check if cache is valid
    if (!forceRefresh) {
      const cachedData = await this.loadFromCache();
      if (cachedData) {
        this.cachedMappings = cachedData;
        return cachedData;
      }
    }

    // Fetch fresh data
    return this.fetchAndCacheMappings();
  }

  /**
   * Refresh token mappings from API
   */
  async refreshMappings(): Promise<TokenMapping[]> {
    return this.getTokenMappings(true);
  }

  /**
   * Get cached mappings without fetching
   */
  getCachedMappings(): TokenMapping[] {
    const mappings = this.cachedMappings || CONVERTED_TOKEN_MAPPINGS;
    console.log(`[TokenMappingService] getCachedMappings returning ${mappings.length} mappings:`,
      mappings.map(m => m.mappingId));
    return mappings;
  }

  /**
   * Find equivalent tokens for a given asset across networks
   */
  getEquivalentTokens(
    assetId: number,
    networkId: NetworkId
  ): TokenReference[] {
    const mappings = this.getCachedMappings();

    for (const mapping of mappings) {
      const matchingToken = mapping.tokens.find(
        (token) => token.assetId === assetId && token.networkId === networkId
      );

      if (matchingToken) {
        // Return all tokens in this mapping except the input token
        return mapping.tokens.filter(
          (token) =>
            !(token.assetId === assetId && token.networkId === networkId)
        );
      }
    }

    return [];
  }

  /**
   * Check if a token is part of any mapping
   */
  isTokenMapped(assetId: number, networkId: NetworkId): boolean {
    const mappings = this.getCachedMappings();

    return mappings.some((mapping) =>
      mapping.tokens.some(
        (token) => token.assetId === assetId && token.networkId === networkId
      )
    );
  }

  /**
   * Get the mapping that contains a specific token
   */
  getMappingForToken(
    assetId: number,
    networkId: NetworkId
  ): TokenMapping | null {
    const mappings = this.getCachedMappings();

    return (
      mappings.find((mapping) =>
        mapping.tokens.some(
          (token) => token.assetId === assetId && token.networkId === networkId
        )
      ) || null
    );
  }

  /**
   * Get all verified mappings
   */
  getVerifiedMappings(): TokenMapping[] {
    return this.getCachedMappings().filter((mapping) => mapping.verified);
  }

  /**
   * Get all mappings that have bridge information
   */
  getBridgedMappings(): TokenMapping[] {
    return this.getCachedMappings().filter((mapping) => mapping.bridgeInfo);
  }

  /**
   * Fetch mappings from API and cache them
   */
  private async fetchAndCacheMappings(): Promise<TokenMapping[]> {
    // Prevent concurrent fetch requests
    if (this.isLoading) {
      // Wait for existing request to complete
      while (this.isLoading) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return this.cachedMappings || CONVERTED_TOKEN_MAPPINGS;
    }

    this.isLoading = true;

    try {
      // If no API URL is configured, use converted mappings
      if (!this.config.apiUrl || this.config.apiUrl === '') {
        console.log(
          `[TokenMappingService] No API URL configured, using ${CONVERTED_TOKEN_MAPPINGS.length} converted mappings:`,
          CONVERTED_TOKEN_MAPPINGS.map(m => m.mappingId)
        );
        this.cachedMappings = CONVERTED_TOKEN_MAPPINGS;
        await this.saveToCache(CONVERTED_TOKEN_MAPPINGS);
        return CONVERTED_TOKEN_MAPPINGS;
      }

      // Fetch from API
      const response = await this.fetchWithRetry();
      const mappings = this.validateAndParseMappings(response);

      // Cache the results
      this.cachedMappings = mappings;
      await this.saveToCache(mappings);

      console.log(
        `[TokenMappingService] Fetched ${mappings.length} token mappings`
      );

      return mappings;
    } catch (error) {
      console.error('[TokenMappingService] Failed to fetch mappings:', error);

      // Fallback to cached data if available
      const cachedData = await this.loadFromCache();
      if (cachedData) {
        console.log('[TokenMappingService] Using cached data as fallback');
        this.cachedMappings = cachedData;
        return cachedData;
      }

      // Ultimate fallback to converted mappings
      console.log('[TokenMappingService] Using converted mappings as ultimate fallback');
      this.cachedMappings = CONVERTED_TOKEN_MAPPINGS;
      return CONVERTED_TOKEN_MAPPINGS;
    } finally {
      this.isLoading = false;
    }
  }

  /**
   * Fetch mappings with retry logic
   */
  private async fetchWithRetry(): Promise<TokenMappingAPIResponse> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= this.config.retryAttempts; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(
          () => controller.abort(),
          this.config.timeout
        );

        const response = await fetch(this.config.apiUrl, {
          signal: controller.signal,
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          throw new TokenMappingAPIError(
            `API returned status ${response.status}`,
            response.status
          );
        }

        const data: TokenMappingAPIResponse = await response.json();
        return data;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error('Unknown error');

        if (attempt < this.config.retryAttempts) {
          console.warn(
            `[TokenMappingService] Attempt ${attempt} failed, retrying...`,
            lastError.message
          );
          await this.sleep(1000 * attempt); // Exponential backoff
        }
      }
    }

    throw new TokenMappingAPIError(
      `Failed after ${this.config.retryAttempts} attempts: ${lastError?.message}`
    );
  }

  /**
   * Validate and parse API response
   */
  private validateAndParseMappings(
    response: TokenMappingAPIResponse
  ): TokenMapping[] {
    if (!response.mappings || !Array.isArray(response.mappings)) {
      throw new TokenMappingValidationError(
        'Invalid API response: mappings field missing or not an array'
      );
    }

    // Validate each mapping
    const validMappings = response.mappings.filter((mapping) => {
      if (!mapping.mappingId || !mapping.tokens || !Array.isArray(mapping.tokens)) {
        console.warn(
          '[TokenMappingService] Invalid mapping structure:',
          mapping
        );
        return false;
      }

      if (mapping.tokens.length < 2) {
        console.warn(
          '[TokenMappingService] Mapping must have at least 2 tokens:',
          mapping.mappingId
        );
        return false;
      }

      return true;
    });

    return validMappings;
  }

  /**
   * Save mappings to cache
   */
  private async saveToCache(mappings: TokenMapping[]): Promise<void> {
    try {
      await AsyncStorage.setItem(CACHE_KEY, JSON.stringify(mappings));
      await AsyncStorage.setItem(
        CACHE_TIMESTAMP_KEY,
        Date.now().toString()
      );
      await AsyncStorage.setItem(CACHE_VERSION_KEY, CURRENT_CACHE_VERSION);
    } catch (error) {
      console.error('[TokenMappingService] Failed to save cache:', error);
      throw new TokenMappingCacheError('Failed to save mappings to cache');
    }
  }

  /**
   * Load mappings from cache if valid
   */
  private async loadFromCache(): Promise<TokenMapping[] | null> {
    try {
      // Check cache version first
      const cachedVersion = await AsyncStorage.getItem(CACHE_VERSION_KEY);
      if (cachedVersion !== CURRENT_CACHE_VERSION) {
        console.log(
          `[TokenMappingService] Cache version mismatch (cached: ${cachedVersion}, current: ${CURRENT_CACHE_VERSION}), invalidating cache`
        );
        await this.clearCache();
        return null;
      }

      const timestampStr = await AsyncStorage.getItem(CACHE_TIMESTAMP_KEY);
      if (!timestampStr) {
        return null;
      }

      const timestamp = parseInt(timestampStr, 10);
      const now = Date.now();

      // Check if cache is still valid
      if (now - timestamp > this.config.cacheDuration) {
        console.log('[TokenMappingService] Cache expired');
        return null;
      }

      const cachedData = await AsyncStorage.getItem(CACHE_KEY);
      if (!cachedData) {
        return null;
      }

      const mappings: TokenMapping[] = JSON.parse(cachedData);
      console.log(
        `[TokenMappingService] Loaded ${mappings.length} mappings from cache:`,
        mappings.map(m => m.mappingId)
      );

      return mappings;
    } catch (error) {
      console.error('[TokenMappingService] Failed to load cache:', error);
      return null;
    }
  }

  /**
   * Clear cached mappings
   */
  async clearCache(): Promise<void> {
    try {
      await AsyncStorage.removeItem(CACHE_KEY);
      await AsyncStorage.removeItem(CACHE_TIMESTAMP_KEY);
      await AsyncStorage.removeItem(CACHE_VERSION_KEY);
      this.cachedMappings = null;
      console.log('[TokenMappingService] Cache cleared');
    } catch (error) {
      console.error('[TokenMappingService] Failed to clear cache:', error);
      throw new TokenMappingCacheError('Failed to clear cache');
    }
  }

  /**
   * Update service configuration
   */
  updateConfig(config: Partial<TokenMappingConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Helper: Sleep for specified milliseconds
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// Export the class and singleton instance
const tokenMappingService = TokenMappingService.getInstance();

export default tokenMappingService;
