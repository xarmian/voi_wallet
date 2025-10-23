import algosdk from 'algosdk';
import { NetworkId } from '@/types/network';
import {
  EnvoiNameInfo,
  EnvoiTokenInfo,
  EnvoiSearchResult,
  EnvoiApiConfig,
  EnvoiApiError,
  EnvoiCache,
  EnvoiCacheEntry,
} from './types';

export class EnvoiService {
  private static instance: EnvoiService;
  private config: EnvoiApiConfig;
  private cache: EnvoiCache;
  private isEnabled: boolean;
  private pendingNameRequests: Map<string, Promise<EnvoiNameInfo | null>>;

  private constructor() {
    this.config = {
      baseUrl: 'https://api.envoi.sh',
      timeout: 10000,
      retryAttempts: 3,
      retryDelay: 1000,
    };

    this.cache = {
      namesByAddress: new Map(),
      addressesByName: new Map(),
    };

    // Envoi is only enabled on Voi network by default
    this.isEnabled = true;
    this.pendingNameRequests = new Map();
  }

  static getInstance(): EnvoiService {
    if (!EnvoiService.instance) {
      EnvoiService.instance = new EnvoiService();
    }
    return EnvoiService.instance;
  }

  /**
   * Enable or disable Envoi service (should only be enabled on Voi network)
   */
  setEnabled(enabled: boolean): void {
    this.isEnabled = enabled;
    console.log(`Envoi service ${enabled ? 'enabled' : 'disabled'}`);
  }

  /**
   * Check if Envoi service is currently enabled
   */
  isServiceEnabled(): boolean {
    return this.isEnabled;
  }

  /**
   * Configure Envoi service for a specific network
   */
  configureForNetwork(networkId: NetworkId): void {
    // Envoi is only available on Voi Network
    this.setEnabled(networkId === NetworkId.VOI_MAINNET);
  }

  /**
   * Resolve VOI names for multiple addresses at once
   */
  async getNames(
    addresses: string[]
  ): Promise<Map<string, EnvoiNameInfo | null>> {
    const results = new Map<string, EnvoiNameInfo | null>();

    if (!addresses.length) {
      return results;
    }

    // Return empty results if Envoi service is disabled
    if (!this.isEnabled) {
      for (const address of addresses) {
        results.set(address, null);
      }
      return results;
    }

    // Filter valid addresses and check cache
    const validAddresses: string[] = [];
    const uncachedAddresses: string[] = [];

    for (const address of addresses) {
      if (!algosdk.isValidAddress(address)) {
        results.set(address, null);
        continue;
      }

      // Check cache first
      const cached = this.cache.namesByAddress.get(address);
      if (cached && !this.isCacheExpired(cached)) {
        if (!cached.isLoading) {
          results.set(address, cached.data);
        }
        continue;
      }

      validAddresses.push(address);
      uncachedAddresses.push(address);
    }

    if (uncachedAddresses.length === 0) {
      return results;
    }

    // Mark all as loading
    for (const address of uncachedAddresses) {
      this.cache.namesByAddress.set(address, {
        data: null,
        timestamp: Date.now(),
        isLoading: true,
      });
    }

    try {
      // Create comma-separated list
      const addressList = uncachedAddresses.join(',');
      const url = `${this.config.baseUrl}/api/name/${addressList}`;

      const response = await this.fetchWithRetry(url);

      if (response.status === 404) {
        // No names found for any addresses
        for (const address of uncachedAddresses) {
          this.cache.namesByAddress.set(address, {
            data: null,
            timestamp: Date.now(),
            isLoading: false,
          });
          results.set(address, null);
        }
        return results;
      }

      if (!response.ok) {
        throw new EnvoiApiError(
          `Failed to resolve names: ${response.statusText}`,
          response.status
        );
      }

      const data = await response.json();

      const apiResults = Array.isArray(data?.results) ? data.results : [];

      // Process results and update cache
      for (const address of uncachedAddresses) {
        const entry = apiResults.find((item: any) => item?.address === address);

        let nameInfo: EnvoiNameInfo | null = null;
        if (entry) {
          nameInfo = {
            name: entry.name || '',
            address: entry.address || address,
            avatar: entry.metadata?.avatar,
            bio: entry.metadata?.bio,
            socialLinks: entry.metadata,
          };
        }

        // Cache the result
        this.cache.namesByAddress.set(address, {
          data: nameInfo,
          timestamp: Date.now(),
          isLoading: false,
        });

        // Also cache reverse lookup if name exists
        if (nameInfo?.name) {
          this.cache.addressesByName.set(nameInfo.name, {
            data: nameInfo,
            timestamp: Date.now(),
            isLoading: false,
          });
        }

        results.set(address, nameInfo);
      }

      return results;
    } catch (error) {
      // Clear loading state on error
      for (const address of uncachedAddresses) {
        const cached = this.cache.namesByAddress.get(address);
        if (cached) {
          this.cache.namesByAddress.set(address, {
            ...cached,
            isLoading: false,
          });
        }
        results.set(address, null);
      }

      if (error instanceof EnvoiApiError) {
        console.warn('Envoi API batch error:', error.message);
      } else {
        console.error('Failed to resolve Envoi names batch:', error);
      }

      return results;
    }
  }

  /**
   * Resolve VOI name for a given address
   */
  async getName(address: string): Promise<EnvoiNameInfo | null> {
    if (!algosdk.isValidAddress(address)) {
      return null;
    }

    // Return null if Envoi service is disabled
    if (!this.isEnabled) {
      return null;
    }

    const cached = this.cache.namesByAddress.get(address);
    if (cached && !this.isCacheExpired(cached)) {
      if (!cached.isLoading) {
        return cached.data;
      }

      const pending = this.pendingNameRequests.get(address);
      if (pending) {
        return pending;
      }
      // Fall through to initiate a fresh request if loading state has no promise
    }

    const existingPending = this.pendingNameRequests.get(address);
    if (existingPending) {
      return existingPending;
    }

    this.cache.namesByAddress.set(address, {
      data: null,
      timestamp: Date.now(),
      isLoading: true,
    });

    const fetchPromise = this.fetchNameForAddress(address);
    this.pendingNameRequests.set(address, fetchPromise);
    return fetchPromise;
  }

  private async fetchNameForAddress(
    address: string
  ): Promise<EnvoiNameInfo | null> {
    try {
      const url = `${this.config.baseUrl}/api/name/${address}`;
      const response = await this.fetchWithRetry(url);

      if (response.status === 404) {
        // No name found for this address
        this.cache.namesByAddress.set(address, {
          data: null,
          timestamp: Date.now(),
          isLoading: false,
        });
        return null;
      }

      if (!response.ok) {
        throw new EnvoiApiError(
          `Failed to resolve name: ${response.statusText}`,
          response.status
        );
      }

      const data = await response.json();
      const results = Array.isArray(data?.results) ? data.results : [];
      const entry =
        results.find((item: any) => item?.address === address) || results[0];

      if (!entry) {
        this.cache.namesByAddress.set(address, {
          data: null,
          timestamp: Date.now(),
          isLoading: false,
        });
        return null;
      }

      const nameInfo: EnvoiNameInfo = {
        name: entry.name || '',
        address: entry.address || address,
        avatar: entry.metadata?.avatar,
        bio: entry.metadata?.bio,
        socialLinks: entry.metadata,
      };

      this.cache.namesByAddress.set(address, {
        data: nameInfo,
        timestamp: Date.now(),
        isLoading: false,
      });

      if (nameInfo.name) {
        this.cache.addressesByName.set(nameInfo.name, {
          data: nameInfo,
          timestamp: Date.now(),
          isLoading: false,
        });
      }

      return nameInfo;
    } catch (error) {
      const cached = this.cache.namesByAddress.get(address);
      if (cached) {
        this.cache.namesByAddress.set(address, {
          ...cached,
          isLoading: false,
        });
      } else {
        this.cache.namesByAddress.set(address, {
          data: null,
          timestamp: Date.now(),
          isLoading: false,
        });
      }

      if (error instanceof EnvoiApiError) {
        console.warn('Envoi API error:', error.message);
        return null;
      }

      console.error('Failed to resolve Envoi name:', address, error);
      return null;
    } finally {
      this.pendingNameRequests.delete(address);
    }
  }

  /**
   * Resolve address for a given VOI name
   */
  async getAddress(name: string): Promise<EnvoiNameInfo | null> {
    try {
      if (!name || !name.trim()) {
        return null;
      }

      // Return null if Envoi service is disabled
      if (!this.isEnabled) {
        return null;
      }

      const normalizedName = name.toLowerCase().trim();

      // Check cache first
      const cached = this.cache.addressesByName.get(normalizedName);
      if (cached && !this.isCacheExpired(cached)) {
        if (cached.isLoading) {
          return null;
        }
        return cached.data;
      }

      // Mark as loading
      this.cache.addressesByName.set(normalizedName, {
        data: null,
        timestamp: Date.now(),
        isLoading: true,
      });

      const url = `${this.config.baseUrl}/api/address/${encodeURIComponent(normalizedName)}`;
      const response = await this.fetchWithRetry(url);

      if (response.status === 404) {
        // No address found for this name
        this.cache.addressesByName.set(normalizedName, {
          data: null,
          timestamp: Date.now(),
          isLoading: false,
        });
        return null;
      }

      if (!response.ok) {
        throw new EnvoiApiError(
          `Failed to resolve address: ${response.statusText}`,
          response.status
        );
      }

      const data = await response.json();

      const results = Array.isArray(data?.results) ? data.results : [];
      const entry =
        results.find(
          (item: any) => (item?.name || '').toLowerCase() === normalizedName
        ) || results[0];

      if (!entry?.address) {
        throw new EnvoiApiError('Address not found for Envoi name');
      }

      const nameInfo: EnvoiNameInfo = {
        name: entry.name || normalizedName,
        address: entry.address || '',
        avatar: entry.metadata?.avatar,
        bio: entry.metadata?.bio,
        socialLinks: entry.metadata,
      };

      // Validate the address
      if (!algosdk.isValidAddress(nameInfo.address)) {
        throw new EnvoiApiError('Invalid address returned from Envoi API');
      }

      // Cache the result
      this.cache.addressesByName.set(normalizedName, {
        data: nameInfo,
        timestamp: Date.now(),
        isLoading: false,
      });

      // Also cache the reverse lookup
      this.cache.namesByAddress.set(nameInfo.address, {
        data: nameInfo,
        timestamp: Date.now(),
        isLoading: false,
      });

      return nameInfo;
    } catch (error) {
      // Clear loading state on error
      const cached = this.cache.addressesByName.get(name);
      if (cached) {
        this.cache.addressesByName.set(name, {
          ...cached,
          isLoading: false,
        });
      }

      if (error instanceof EnvoiApiError) {
        console.warn('Envoi API error:', error.message);
        return null;
      }

      console.error('Failed to resolve Envoi address:', error);
      return null;
    }
  }

  /**
   * Get token information by token ID
   */
  async getTokenInfo(tokenId: number): Promise<EnvoiTokenInfo | null> {
    try {
      const url = `${this.config.baseUrl}/api/token/${tokenId}`;
      const response = await this.fetchWithRetry(url);

      if (response.status === 404) {
        return null;
      }

      if (!response.ok) {
        throw new EnvoiApiError(
          `Failed to get token info: ${response.statusText}`,
          response.status
        );
      }

      const data = await response.json();

      return {
        name: data.name || '',
        owner: data.owner || '',
        metadata: data.metadata,
      };
    } catch (error) {
      if (error instanceof EnvoiApiError) {
        console.warn('Envoi API error:', error.message);
        return null;
      }

      console.error('Failed to get Envoi token info:', error);
      return null;
    }
  }

  /**
   * Search for VOI names using a pattern
   */
  async searchNames(pattern: string): Promise<EnvoiSearchResult[]> {
    try {
      if (!pattern || pattern.trim().length < 2) {
        return [];
      }

      const searchTerm = encodeURIComponent(pattern.trim());
      const url = `${this.config.baseUrl}/api/search?pattern=${searchTerm}`;

      const response = await this.fetchWithRetry(url);

      if (!response.ok) {
        throw new EnvoiApiError(
          `Failed to search names: ${response.statusText}`,
          response.status
        );
      }

      const data = await response.json();

      const results = Array.isArray(data?.results)
        ? data.results
        : Array.isArray(data)
          ? data
          : [];

      return results
        .map((item: any) => ({
          name: item.name || '',
          address: item.address || '',
          avatar: item.metadata?.avatar || item.avatar,
        }))
        .filter(
          (item: EnvoiSearchResult) =>
            item.name && algosdk.isValidAddress(item.address)
        );
    } catch (error) {
      if (error instanceof EnvoiApiError) {
        console.warn('Envoi API error:', error.message);
        return [];
      }

      console.error('Failed to search Envoi names:', error);
      return [];
    }
  }

  /**
   * Get avatar URL for an address, with optional size control
   */
  async getAvatarUrl(
    address: string,
    fullSize = false
  ): Promise<string | null> {
    const nameInfo = await this.getName(address);
    if (!nameInfo?.avatar) {
      return null;
    }

    // If full size is requested and avatar doesn't already include size param
    if (fullSize && !nameInfo.avatar.includes('avatar=full')) {
      const url = new URL(nameInfo.avatar);
      url.searchParams.set('avatar', 'full');
      const fullUrl = url.toString();
      return fullUrl;
    }

    return nameInfo.avatar;
  }

  /**
   * Clear cache entries older than 5 minutes
   */
  clearExpiredCache(): void {
    const now = Date.now();
    const expireTime = 5 * 60 * 1000; // 5 minutes

    for (const [key, entry] of this.cache.namesByAddress.entries()) {
      if (now - entry.timestamp > expireTime) {
        this.cache.namesByAddress.delete(key);
      }
    }

    for (const [key, entry] of this.cache.addressesByName.entries()) {
      if (now - entry.timestamp > expireTime) {
        this.cache.addressesByName.delete(key);
      }
    }
  }

  /**
   * Validate if a string could be an Envoi name (ends with .voi or similar pattern)
   */
  static isValidNameFormat(input: string): boolean {
    const trimmed = input.trim().toLowerCase();
    return /^[a-z0-9-_]+(\.[a-z]+)?$/.test(trimmed) && trimmed.length >= 3;
  }

  private async fetchWithRetry(url: string): Promise<Response> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= this.config.retryAttempts; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(
          () => controller.abort(),
          this.config.timeout
        );

        const response = await fetch(url, {
          signal: controller.signal,
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
        });

        clearTimeout(timeoutId);
        return response;
      } catch (error) {
        lastError =
          error instanceof Error ? error : new Error('Unknown fetch error');

        if (attempt < this.config.retryAttempts) {
          await this.delay(this.config.retryDelay * attempt);
        }
      }
    }

    throw lastError || new Error('All retry attempts failed');
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private isCacheExpired(entry: EnvoiCacheEntry): boolean {
    const now = Date.now();
    const maxAge = 5 * 60 * 1000; // 5 minutes
    return now - entry.timestamp > maxAge;
  }
}

export default EnvoiService;
export * from './types';
