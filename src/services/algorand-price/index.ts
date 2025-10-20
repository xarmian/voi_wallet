export interface VestigePriceData {
  network_id: number;
  asset_id: number;
  denominating_asset_id: number;
  price: number;
  confidence: number;
  total_lockup: number;
}

export interface AlgorandPriceConfig {
  baseUrl: string;
  timeout: number;
  retryAttempts: number;
  retryDelay: number;
  cacheDuration: number; // in milliseconds
}

export class AlgorandPriceError extends Error {
  constructor(
    message: string,
    public status?: number,
    public code?: string
  ) {
    super(message);
    this.name = 'AlgorandPriceError';
  }
}

interface CachedPrices {
  prices: Map<number, number>;
  timestamp: number;
}

export class AlgorandPriceService {
  private static instance: AlgorandPriceService;
  private config: AlgorandPriceConfig;
  private cachedPrices: CachedPrices | null = null;

  private constructor() {
    this.config = {
      baseUrl: 'https://api.vestigelabs.org',
      timeout: 10000,
      retryAttempts: 3,
      retryDelay: 1000,
      cacheDuration: 5 * 60 * 1000, // 5 minutes
    };
  }

  static getInstance(): AlgorandPriceService {
    if (!AlgorandPriceService.instance) {
      AlgorandPriceService.instance = new AlgorandPriceService();
    }
    return AlgorandPriceService.instance;
  }

  async getAlgoPrice(): Promise<number> {
    try {
      const prices = await this.getAssetPrices([0]); // ALGO is asset ID 0
      return prices.get(0) || 0;
    } catch (error) {
      console.warn('Failed to fetch ALGO price:', error);
      return this.cachedPrices?.prices.get(0) || 0;
    }
  }

  async getAssetPrices(assetIds: number[]): Promise<Map<number, number>> {
    try {
      // Check cache first
      if (this.cachedPrices && this.isCacheValid()) {
        // Return cached prices for requested assets
        const cachedResults = new Map<number, number>();
        assetIds.forEach((id) => {
          const price = this.cachedPrices!.prices.get(id);
          if (price !== undefined) {
            cachedResults.set(id, price);
          }
        });

        // If we have all requested prices in cache, return them
        if (cachedResults.size === assetIds.length) {
          return cachedResults;
        }
      }

      // Always include ALGO (asset ID 0) in the request
      const uniqueAssetIds = Array.from(new Set([0, ...assetIds]));
      const priceData = await this.fetchAssetPricesFromAPI(uniqueAssetIds);

      // Convert to Map and cache
      const priceMap = new Map<number, number>();
      priceData.forEach((asset) => {
        priceMap.set(asset.asset_id, asset.price);
      });

      // Update cache with all fetched prices
      this.cachedPrices = {
        prices: priceMap,
        timestamp: Date.now(),
      };

      // Return only requested prices
      const results = new Map<number, number>();
      assetIds.forEach((id) => {
        const price = priceMap.get(id);
        if (price !== undefined) {
          results.set(id, price);
        }
      });

      return results;
    } catch (error) {
      console.warn('Failed to fetch asset prices:', error);

      // Return cached prices if available, even if stale
      if (this.cachedPrices) {
        const cachedResults = new Map<number, number>();
        assetIds.forEach((id) => {
          const price = this.cachedPrices!.prices.get(id);
          if (price !== undefined) {
            cachedResults.set(id, price);
          }
        });
        return cachedResults;
      }

      // Return empty map as fallback
      return new Map();
    }
  }

  private async fetchAssetPricesFromAPI(
    assetIds: number[]
  ): Promise<VestigePriceData[]> {
    const url = new URL(`${this.config.baseUrl}/assets/price`);

    // USDC asset ID on Algorand mainnet
    const USDC_ASSET_ID = 31566704;

    url.searchParams.append('asset_ids', assetIds.join(','));
    url.searchParams.append('network_id', '0'); // Algorand mainnet
    url.searchParams.append('denominating_asset_id', USDC_ASSET_ID.toString());

    try {
      const response = await this.fetchWithRetry(url.toString());

      if (!response.ok) {
        throw new AlgorandPriceError(
          `Failed to fetch asset prices: ${response.statusText}`,
          response.status
        );
      }

      const data: VestigePriceData[] = await response.json();

      if (!Array.isArray(data)) {
        throw new AlgorandPriceError(
          'Invalid response format from Vestige Labs API'
        );
      }

      return data;
    } catch (error) {
      if (error instanceof AlgorandPriceError) {
        throw error;
      }

      throw new AlgorandPriceError(
        `Network error: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  private async fetchWithRetry(url: string): Promise<Response> {
    let lastError: Error;

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
          console.warn(
            `Algorand price API attempt ${attempt} failed, retrying in ${this.config.retryDelay}ms:`,
            lastError.message
          );
          await this.sleep(this.config.retryDelay * attempt); // Exponential backoff
        }
      }
    }

    throw new AlgorandPriceError(
      `All ${this.config.retryAttempts} attempts failed. Last error: ${lastError!.message}`
    );
  }

  private isCacheValid(): boolean {
    if (!this.cachedPrices) return false;
    return Date.now() - this.cachedPrices.timestamp < this.config.cacheDuration;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  updateConfig(newConfig: Partial<AlgorandPriceConfig>): void {
    this.config = { ...this.config, ...newConfig };
  }

  getConfig(): AlgorandPriceConfig {
    return { ...this.config };
  }

  clearCache(): void {
    this.cachedPrices = null;
  }

  formatUsdValue(algoAmount: number | bigint, pricePerAlgo?: number): string {
    const price = pricePerAlgo || (this.cachedPrices?.prices.get(0) ?? 0);
    if (price === 0) return '$0.00';

    const amount =
      typeof algoAmount === 'bigint' ? Number(algoAmount) : algoAmount;
    const algoValue = amount / 1_000_000; // Convert microALGO to ALGO
    const usdValue = algoValue * price;

    if (usdValue < 0.01) return '<$0.01';
    return `$${usdValue.toFixed(2)}`;
  }
}

export default AlgorandPriceService.getInstance();
