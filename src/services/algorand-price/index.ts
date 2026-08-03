import { shouldSkipForOffline } from '@/services/network/offline';

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
    public code?: string,
    /** TASK-41: originating error, preserved across retry-loop rebuilds. */
    cause?: unknown
  ) {
    super(message);
    this.name = 'AlgorandPriceError';
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

/**
 * TASK-189: one timestamp PER ASSET, not one for the whole map.
 *
 * The previous shape kept a single global timestamp and replaced the entire map
 * on every fetch, so accounts holding disjoint ASA sets evicted each other. The
 * obvious repair — merging old entries into the new map — is worse: with a
 * single global timestamp it re-stamps every carried-over entry, so an asset
 * priced once stays "fresh" forever as long as anything else refetches inside
 * the window. Per-entry timestamps fix the eviction without inventing a
 * permanently-stale price.
 */
interface CachedAssetPrice {
  price: number;
  timestamp: number;
}

/**
 * Outcome of one outbound price request, shared by every caller that joined it.
 * `failed` distinguishes "the request blew up" (→ callers fall back to their
 * retained, expired cache entries) from "the request succeeded but the API did
 * not price this asset" (→ omitted, as before).
 */
interface PriceFetchOutcome {
  prices: Map<number, number>;
  failed: boolean;
}

/**
 * Upper bound on retained entries. Expired entries are deliberately KEPT (they
 * back the stale-fallback path below), so the map only ever grows; this caps it.
 * Eviction is purely a memory bound — it is never part of a freshness check.
 */
const MAX_CACHED_ASSETS = 1000;

export class AlgorandPriceService {
  private static instance: AlgorandPriceService;
  private config: AlgorandPriceConfig;
  private cachedPrices = new Map<number, CachedAssetPrice>();
  /**
   * TASK-189: in-flight state keyed PER ASSET ID, not one promise per service.
   *
   * `getAssetPrices` takes an id list, so a single shared promise would hand a
   * caller asking for [1,2] whichever map a concurrent [3,4] caller resolved
   * first — silently missing prices. Each call resolves as the union of (fresh
   * cache entries) ∪ (awaited in-flight ids) ∪ (one request for the genuine
   * remainder). Mirrors `balanceLoadsInFlight` in walletStore, including the
   * `finally` cleanup so a failed fetch never wedges the slots.
   */
  private inFlightByAsset = new Map<number, Promise<PriceFetchOutcome>>();
  /** Bumped by clearCache() so a fetch started before it cannot write back. */
  private cacheGeneration = 0;

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
      return this.cachedPrices.get(0)?.price || 0;
    }
  }

  async getAssetPrices(assetIds: number[]): Promise<Map<number, number>> {
    const requested = Array.from(new Set(assetIds));
    const results = new Map<number, number>();
    const now = Date.now();

    // Partition the request: fresh cache hits are answered immediately, ids
    // already being fetched are joined, and only the genuine remainder goes out.
    const joined = new Map<number, Promise<PriceFetchOutcome>>();
    const toFetch = new Set<number>();

    for (const id of requested) {
      if (this.isEntryFresh(id, now)) {
        // Non-null: isEntryFresh only returns true when the entry exists.
        results.set(id, this.cachedPrices.get(id)!.price);
        continue;
      }

      const inFlight = this.inFlightByAsset.get(id);
      if (inFlight) {
        joined.set(id, inFlight);
        continue;
      }

      toFetch.add(id);
    }

    if (toFetch.size === 0 && joined.size === 0) {
      return results;
    }

    let ownRequest: Promise<PriceFetchOutcome> | null = null;

    if (toFetch.size > 0) {
      // ALGO (asset ID 0) rides along with any outbound request, as before —
      // but only when a request is going out anyway, and only if it is not
      // already fresh or in flight.
      if (!this.isEntryFresh(0, now) && !this.inFlightByAsset.has(0)) {
        toFetch.add(0);
      }

      const fetchIds = Array.from(toFetch);
      const request = this.fetchAndCachePrices(fetchIds);

      for (const id of fetchIds) {
        this.inFlightByAsset.set(id, request);
      }

      // Release every slot this request claimed once it settles — a failed
      // fetch must not wedge them. Identity-checked so a later request for the
      // same id is never cleared by an earlier one. `fetchAndCachePrices`
      // absorbs its own errors, so this chain can never reject.
      void request.finally(() => {
        for (const id of fetchIds) {
          if (this.inFlightByAsset.get(id) === request) {
            this.inFlightByAsset.delete(id);
          }
        }
      });

      ownRequest = request;
    }

    // Await each distinct request exactly once, then resolve every outstanding
    // id against the outcome of the request that owned it.
    const pending = new Set<Promise<PriceFetchOutcome>>(joined.values());
    if (ownRequest) {
      pending.add(ownRequest);
    }
    const settled = new Map<Promise<PriceFetchOutcome>, PriceFetchOutcome>(
      await Promise.all(
        Array.from(pending).map(
          async (promise) => [promise, await promise] as const
        )
      )
    );

    for (const id of requested) {
      if (results.has(id)) continue;

      const source = joined.get(id) ?? ownRequest;
      const outcome = source ? settled.get(source) : undefined;

      const price = outcome?.prices.get(id);
      if (price !== undefined) {
        results.set(id, price);
        continue;
      }

      // Stale fallback: the request failed, so serve the retained (expired)
      // entry rather than dropping the asset from the portfolio. An asset the
      // API simply did not price on a SUCCESSFUL response stays omitted.
      if (outcome?.failed) {
        const stale = this.cachedPrices.get(id);
        if (stale) {
          results.set(id, stale.price);
        }
      }
    }

    return results;
  }

  /**
   * Runs one outbound price request and writes each returned price into the
   * cache with its OWN timestamp. Never rejects: failures are reported via
   * `failed` so every joined caller can apply its own stale fallback.
   */
  private async fetchAndCachePrices(
    assetIds: number[]
  ): Promise<PriceFetchOutcome> {
    const generation = this.cacheGeneration;

    try {
      const priceData = await this.fetchAssetPricesFromAPI(assetIds);

      const prices = new Map<number, number>();
      const timestamp = Date.now();
      priceData.forEach((asset) => {
        prices.set(asset.asset_id, asset.price);
        // A clearCache() during the fetch bumps the generation; the callers
        // that asked for these prices still get them, but they must not
        // repopulate the cache that was just dropped.
        if (this.cacheGeneration === generation) {
          this.cachedPrices.set(asset.asset_id, {
            price: asset.price,
            timestamp,
          });
        }
      });
      this.evictOldestBeyondLimit();

      return { prices, failed: false };
    } catch (error) {
      console.warn('Failed to fetch asset prices:', error);
      return { prices: new Map(), failed: true };
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
        `Network error: ${error instanceof Error ? error.message : 'Unknown error'}`,
        undefined,
        'NETWORK_ERROR',
        error
      );
    }
  }

  private async fetchWithRetry(url: string): Promise<Response> {
    // TASK-191: offline → skip the ladder instead of burning every attempt and
    // its backoff. Same error shape the exhausted ladder throws, so the outcome
    // is still `failed: true` and every joined caller applies the retained
    // stale-price fallback exactly as it does after a real failure.
    if (shouldSkipForOffline('algorand-price')) {
      throw new AlgorandPriceError(
        'Offline: skipped request without attempting the network',
        undefined,
        'NETWORK_ERROR'
      );
    }

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

    // TASK-41 (DR-6): only transport failures reach here (a non-OK response is
    // returned, not thrown), so there is no status — but the code and the
    // originating error must survive for the error-mapper.
    throw new AlgorandPriceError(
      `All ${this.config.retryAttempts} attempts failed. Last error: ${lastError!.message}`,
      undefined,
      'NETWORK_ERROR',
      lastError!
    );
  }

  /**
   * Freshness is evaluated PER ENTRY. An expired entry is not a hit — its asset
   * joins the refetch — but it is deliberately retained so the stale-fallback
   * path above still has something to serve when that refetch fails.
   */
  private isEntryFresh(assetId: number, now: number): boolean {
    const entry = this.cachedPrices.get(assetId);
    if (!entry) return false;
    return now - entry.timestamp < this.config.cacheDuration;
  }

  /**
   * Memory bound only — drops the oldest entries once the map exceeds
   * MAX_CACHED_ASSETS. Never called from a freshness check.
   */
  private evictOldestBeyondLimit(): void {
    if (this.cachedPrices.size <= MAX_CACHED_ASSETS) return;

    const byAge = Array.from(this.cachedPrices.entries()).sort(
      (a, b) => a[1].timestamp - b[1].timestamp
    );
    const excess = this.cachedPrices.size - MAX_CACHED_ASSETS;
    for (let i = 0; i < excess; i++) {
      this.cachedPrices.delete(byAge[i][0]);
    }
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
    this.cachedPrices.clear();
    // Abandon in-flight requests too: a later caller must not join a request
    // that predates the clear, and that request must not repopulate the cache.
    this.cacheGeneration++;
    this.inFlightByAsset.clear();
  }

  formatUsdValue(algoAmount: number | bigint, pricePerAlgo?: number): string {
    const price = pricePerAlgo || (this.cachedPrices.get(0)?.price ?? 0);
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
