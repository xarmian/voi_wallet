export interface VoiMarketData {
  trading_pair_id: number;
  exchange: string;
  pair: string;
  type: string;
  network: string;
  url: string | null;
  pool_url: string | null;
  base_token_id: number;
  quote_token_id: number | null;
  price: number;
  volume_24h: number;
  tvl: number;
  high_24h: number | null;
  low_24h: number | null;
  price_change_24h: number | null;
  price_change_percentage_24h: number | null;
  lastUpdated: string;
}

export interface VoiPriceAggregates {
  totalVolume: number;
  totalTvl: number;
  weightedAveragePrice: number;
}

export interface VoiCirculatingSupply {
  circulatingSupply: number;
  percentDistributed: number;
}

export interface VoiPriceResponse {
  marketData: VoiMarketData[];
  aggregates: VoiPriceAggregates;
  circulatingSupply: VoiCirculatingSupply;
}

export interface VoiPriceConfig {
  baseUrl: string;
  timeout: number;
  retryAttempts: number;
  retryDelay: number;
  cacheDuration: number; // in milliseconds
}

export class VoiPriceError extends Error {
  constructor(
    message: string,
    public status?: number,
    public code?: string
  ) {
    super(message);
    this.name = 'VoiPriceError';
  }
}

interface CachedPrice {
  price: number;
  timestamp: number;
}

export class VoiPriceService {
  private static instance: VoiPriceService;
  private config: VoiPriceConfig;
  private cachedPrice: CachedPrice | null = null;

  private constructor() {
    this.config = {
      baseUrl: 'https://voirewards.com/api',
      timeout: 10000,
      retryAttempts: 3,
      retryDelay: 1000,
      cacheDuration: 5 * 60 * 1000, // 5 minutes
    };
  }

  static getInstance(): VoiPriceService {
    if (!VoiPriceService.instance) {
      VoiPriceService.instance = new VoiPriceService();
    }
    return VoiPriceService.instance;
  }

  async getVoiPrice(): Promise<number> {
    try {
      // Check cache first
      if (this.cachedPrice && this.isCacheValid()) {
        return this.cachedPrice.price;
      }

      const response = await this.fetchVoiMarketData();
      const price = response.aggregates.weightedAveragePrice;

      // Cache the price
      this.cachedPrice = {
        price,
        timestamp: Date.now(),
      };

      return price;
    } catch (error) {
      console.warn('Failed to fetch VOI price:', error);

      // Return cached price if available, even if stale
      if (this.cachedPrice) {
        return this.cachedPrice.price;
      }

      // Default fallback price
      return 0;
    }
  }

  async getVoiMarketData(): Promise<VoiPriceResponse> {
    try {
      return await this.fetchVoiMarketData();
    } catch (error) {
      console.error('Failed to fetch VOI market data:', error);
      throw error;
    }
  }

  private async fetchVoiMarketData(): Promise<VoiPriceResponse> {
    const url = `${this.config.baseUrl}/markets?token=VOI`;

    try {
      const response = await this.fetchWithRetry(url);

      if (!response.ok) {
        throw new VoiPriceError(
          `Failed to fetch VOI price: ${response.statusText}`,
          response.status
        );
      }

      const data: VoiPriceResponse = await response.json();

      if (
        !data.aggregates ||
        typeof data.aggregates.weightedAveragePrice !== 'number'
      ) {
        throw new VoiPriceError('Invalid response format from VOI price API');
      }

      return data;
    } catch (error) {
      if (error instanceof VoiPriceError) {
        throw error;
      }

      throw new VoiPriceError(
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
            `VOI price API attempt ${attempt} failed, retrying in ${this.config.retryDelay}ms:`,
            lastError.message
          );
          await this.sleep(this.config.retryDelay * attempt); // Exponential backoff
        }
      }
    }

    throw new VoiPriceError(
      `All ${this.config.retryAttempts} attempts failed. Last error: ${lastError!.message}`
    );
  }

  private isCacheValid(): boolean {
    if (!this.cachedPrice) return false;
    return Date.now() - this.cachedPrice.timestamp < this.config.cacheDuration;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  updateConfig(newConfig: Partial<VoiPriceConfig>): void {
    this.config = { ...this.config, ...newConfig };
  }

  getConfig(): VoiPriceConfig {
    return { ...this.config };
  }

  clearCache(): void {
    this.cachedPrice = null;
  }

  formatUsdValue(voiAmount: number | bigint, pricePerVoi?: number): string {
    const price = pricePerVoi || (this.cachedPrice?.price ?? 0);
    if (price === 0) return '$0.00';

    const amount =
      typeof voiAmount === 'bigint' ? Number(voiAmount) : voiAmount;
    const voiValue = amount / 1_000_000; // Convert microVOI to VOI
    const usdValue = voiValue * price;

    if (usdValue < 0.01) return '<$0.01';
    return `$${usdValue.toFixed(2)}`;
  }
}

export default VoiPriceService.getInstance();
