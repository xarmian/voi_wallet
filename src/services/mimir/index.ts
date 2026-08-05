import { shouldSkipForOffline } from '@/services/network/offline';

export interface MimirAsset {
  name: string;
  symbol: string;
  balance: string;
  decimals: number;
  imageUrl: string;
  usdValue: string;
  verified: number;
  accountId: string;
  assetType: 'arc200' | 'asa';
  contractId: number;
}

export interface MimirAssetsResponse {
  balances: MimirAsset[];
  'next-token': string | null;
  'total-count': number;
  'current-round': number;
}

export interface Arc200Transfer {
  transactionId: string;
  contractId: number;
  timestamp: number;
  round: number;
  sender: string;
  receiver: string;
  amount: string;
  note?: string | Uint8Array;
}

export interface Arc200TransfersResponse {
  transfers: Arc200Transfer[];
  'next-token'?: string; // Keep for backward compatibility
  hasMore?: boolean; // New field for offset-based pagination
}

export interface Arc200TokenMetadata {
  name: string;
  symbol: string;
  creator: string;
  deleted: number;
  tokenId: string | null;
  decimals: number;
  imageUrl: string;
  verified: number;
  mintRound: number;
  contractId: number;
  globalState: {
    key: string;
    value: any;
  }[];
  totalSupply: string;
}

export interface Arc200TokensResponse {
  tokens: Arc200TokenMetadata[];
  'next-token': string | null;
  'total-count': number;
  'current-round': number;
}

export interface Arc200Approval {
  owner: string;
  round: number;
  amount: string;
  spender: string;
  timestamp: number;
  contractId: number;
  transactionId: string;
}

export interface Arc200ApprovalsResponse {
  approvals: Arc200Approval[];
  'next-token': string | null;
  'total-count': number;
  'current-round': number;
}

export interface Arc200BalanceResponse {
  balances: {
    accountId: string;
    contractId: number;
    balance: string;
  }[];
  'current-round': number;
}

/**
 * Result of a batched ARC-200 balance lookup.
 *
 * Both collections are keyed `${contractId}_${owner}`. A pair whose lookup
 * failed is present in `failed` and ABSENT from `balances` — it is deliberately
 * NOT recorded as '0', because a caller cannot tell a genuine zero balance from
 * a failed request and would render a claimable token as un-claimable
 * ("Insufficient") on a transient network error (TASK-188).
 */
export interface Arc200BatchBalancesResult {
  balances: Map<string, string>;
  failed: Set<string>;
}

export interface MimirApiConfig {
  baseUrl: string;
  timeout: number;
  retryAttempts: number;
  retryDelay: number;
}

export class MimirApiError extends Error {
  constructor(
    message: string,
    public status?: number,
    public code?: string,
    /**
     * TASK-41: originating error, preserved when the retry loop or the outer
     * catch rebuilds the failure. The error-mapper reads it to distinguish an
     * abort/timeout from a DNS failure.
     */
    cause?: unknown
  ) {
    super(message);
    this.name = 'MimirApiError';
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

export class MimirApiService {
  private static instance: MimirApiService;
  private config: MimirApiConfig;

  private constructor() {
    this.config = {
      baseUrl: 'https://voi-mainnet-mimirapi.voirewards.com',
      timeout: 10000,
      retryAttempts: 3,
      retryDelay: 1000,
    };
  }

  static getInstance(): MimirApiService {
    if (!MimirApiService.instance) {
      MimirApiService.instance = new MimirApiService();
    }
    return MimirApiService.instance;
  }

  async getAccountAssets(
    address: string,
    nextToken?: string
  ): Promise<MimirAssetsResponse> {
    try {
      const url = new URL(`${this.config.baseUrl}/account/assets`);
      url.searchParams.append('accountId', address);

      if (nextToken) {
        url.searchParams.append('next-token', nextToken);
      }

      const response = await this.fetchWithRetry(url.toString());

      if (!response.ok) {
        throw new MimirApiError(
          `Failed to fetch assets: ${response.statusText}`,
          response.status
        );
      }

      const data: MimirAssetsResponse = await response.json();

      if (!data.balances || !Array.isArray(data.balances)) {
        throw new MimirApiError('Invalid response format from Mimir API');
      }

      return data;
    } catch (error) {
      if (error instanceof MimirApiError) {
        throw error;
      }

      console.error('Mimir API request failed:', error);
      throw new MimirApiError(
        `Network error: ${error instanceof Error ? error.message : 'Unknown error'}`,
        undefined,
        'NETWORK_ERROR',
        error
      );
    }
  }

  async getAllAccountAssets(address: string): Promise<MimirAsset[]> {
    const allAssets: MimirAsset[] = [];
    let nextToken: string | null = null;
    let attempts = 0;
    const maxPages = 10; // Prevent infinite loops

    try {
      do {
        attempts++;
        if (attempts > maxPages) {
          console.warn(
            'Mimir API pagination limit reached, some assets may be missing'
          );
          break;
        }

        const response = await this.getAccountAssets(
          address,
          nextToken || undefined
        );
        allAssets.push(...response.balances);
        nextToken = response['next-token'];
      } while (nextToken);

      return allAssets;
    } catch (error) {
      console.error('Failed to fetch all assets from Mimir API:', error);
      throw error;
    }
  }

  async getArc200Transfers(
    address: string,
    contractId?: number,
    offset?: number,
    limit?: number
  ): Promise<Arc200TransfersResponse> {
    try {
      const url = new URL(`${this.config.baseUrl}/arc200/transfers`);
      url.searchParams.append('user', address);

      if (contractId !== undefined) {
        url.searchParams.append('contractId', contractId.toString());
      }

      if (limit !== undefined) {
        url.searchParams.append('limit', limit.toString());
      }

      if (offset !== undefined) {
        url.searchParams.append('offset', offset.toString());
      }

      const response = await this.fetchWithRetry(url.toString());

      if (!response.ok) {
        throw new MimirApiError(
          `Failed to fetch ARC-200 transfers: ${response.statusText}`,
          response.status
        );
      }

      const data: Arc200TransfersResponse = await response.json();

      if (!data.transfers || !Array.isArray(data.transfers)) {
        throw new MimirApiError(
          'Invalid response format from Mimir API for ARC-200 transfers'
        );
      }

      // Calculate hasMore based on whether we got a full page
      const hasMore = limit ? data.transfers.length >= limit : false;

      return {
        ...data,
        hasMore,
      };
    } catch (error) {
      if (error instanceof MimirApiError) {
        throw error;
      }

      console.error('Mimir API ARC-200 transfers request failed:', error);
      throw new MimirApiError(
        `Network error: ${error instanceof Error ? error.message : 'Unknown error'}`,
        undefined,
        'NETWORK_ERROR',
        error
      );
    }
  }

  async getAllArc200Transfers(
    address: string,
    contractId?: number
  ): Promise<Arc200Transfer[]> {
    const allTransfers: Arc200Transfer[] = [];
    let offset = 0;
    let attempts = 0;
    const maxPages = 10;
    const limit = 50;

    try {
      do {
        attempts++;
        if (attempts > maxPages) {
          console.warn(
            'Mimir API ARC-200 transfers pagination limit reached, some transfers may be missing'
          );
          break;
        }

        const response = await this.getArc200Transfers(
          address,
          contractId,
          offset,
          limit
        );
        allTransfers.push(...response.transfers);
        offset += response.transfers.length;

        // Stop if we got fewer transfers than requested (no more data)
        if (!response.hasMore || response.transfers.length < limit) {
          break;
        }
      } while (true);

      return allTransfers;
    } catch (error) {
      console.error(
        'Failed to fetch all ARC-200 transfers from Mimir API:',
        error
      );
      throw error;
    }
  }

  async getAllUserArc200Transfers(address: string): Promise<Arc200Transfer[]> {
    // This method fetches ALL ARC-200 transfers for a user across all contracts
    // by not providing a contractId parameter
    return this.getAllArc200Transfers(address);
  }

  async getArc200TokensMetadata(
    contractIds: number[]
  ): Promise<Arc200TokensResponse> {
    try {
      if (contractIds.length === 0) {
        return {
          tokens: [],
          'next-token': null,
          'total-count': 0,
          'current-round': 0,
        };
      }

      const url = new URL(`${this.config.baseUrl}/arc200/tokens`);
      url.searchParams.append('contractId', contractIds.join(','));

      const response = await this.fetchWithRetry(url.toString());

      if (!response.ok) {
        throw new MimirApiError(
          `Failed to fetch ARC-200 token metadata: ${response.statusText}`,
          response.status
        );
      }

      const data: Arc200TokensResponse = await response.json();

      if (!data.tokens || !Array.isArray(data.tokens)) {
        throw new MimirApiError(
          'Invalid response format from Mimir API tokens endpoint'
        );
      }

      return data;
    } catch (error) {
      if (error instanceof MimirApiError) {
        throw error;
      }

      console.error('Mimir API tokens request failed:', error);
      throw new MimirApiError(
        `Network error: ${error instanceof Error ? error.message : 'Unknown error'}`,
        undefined,
        'NETWORK_ERROR',
        error
      );
    }
  }

  private async fetchWithRetry(
    url: string,
    init?: RequestInit
  ): Promise<Response> {
    // TASK-191: while the device is definitely offline, skip the ladder
    // outright rather than burning `retryAttempts` fetches plus their backoff
    // on a request that cannot reach the network. Deliberately the SAME error
    // shape the exhausted ladder throws (MimirApiError / NETWORK_ERROR) — this
    // is a faster failure, not a new one callers must learn to handle.
    if (shouldSkipForOffline('mimir')) {
      throw new MimirApiError(
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
          // Caller-supplied method/body (e.g. a POST batch) override the
          // GET default; headers below are merged over any the caller passes so
          // Accept/Content-Type stay set. Existing GET callers pass no init and
          // are unaffected.
          ...init,
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            ...init?.headers,
          },
        });

        clearTimeout(timeoutId);
        return response;
      } catch (error) {
        lastError =
          error instanceof Error ? error : new Error('Unknown fetch error');

        if (attempt < this.config.retryAttempts) {
          console.warn(
            `Mimir API attempt ${attempt} failed, retrying in ${this.config.retryDelay}ms:`,
            lastError.message
          );
          await this.sleep(this.config.retryDelay * attempt); // Exponential backoff
        }
      }
    }

    // TASK-41 (DR-6): the retry loop only ever sees transport failures (a
    // non-OK response is returned, not thrown), so there is no status to
    // carry — but the code and the originating error must survive, otherwise
    // the mapper cannot tell an offline device from an aborted request.
    throw new MimirApiError(
      `All ${this.config.retryAttempts} attempts failed. Last error: ${lastError!.message}`,
      undefined,
      'NETWORK_ERROR',
      lastError!
    );
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  updateConfig(newConfig: Partial<MimirApiConfig>): void {
    this.config = { ...this.config, ...newConfig };
  }

  getConfig(): MimirApiConfig {
    return { ...this.config };
  }

  async getAccountInfo(address: string): Promise<any> {
    try {
      const url = new URL(`${this.config.baseUrl}/account/info`);
      url.searchParams.append('accountId', address);

      const response = await this.fetchWithRetry(url.toString());

      if (!response.ok) {
        throw new MimirApiError(
          `Failed to fetch account info: ${response.statusText}`,
          response.status
        );
      }

      const data = await response.json();
      return data;
    } catch (error) {
      if (error instanceof MimirApiError) {
        throw error;
      }

      console.error('Mimir API account info request failed:', error);
      throw new MimirApiError(
        `Network error: ${error instanceof Error ? error.message : 'Unknown error'}`,
        undefined,
        'NETWORK_ERROR',
        error
      );
    }
  }

  /**
   * Check if Mimir API is available (configured with a valid base URL)
   */
  isAvailable(): boolean {
    return Boolean(this.config.baseUrl && this.config.baseUrl !== 'disabled');
  }

  /**
   * Fetch ARC-200 approvals where the specified address is the spender
   * This returns tokens that the user can claim (transferFrom)
   */
  async getArc200ApprovalsForSpender(
    spenderAddress: string
  ): Promise<Arc200ApprovalsResponse> {
    try {
      const url = new URL(`${this.config.baseUrl}/arc200/approvals`);
      url.searchParams.append('spender', spenderAddress);

      const response = await this.fetchWithRetry(url.toString());

      if (!response.ok) {
        throw new MimirApiError(
          `Failed to fetch ARC-200 approvals: ${response.statusText}`,
          response.status
        );
      }

      const data: Arc200ApprovalsResponse = await response.json();

      if (!data.approvals || !Array.isArray(data.approvals)) {
        throw new MimirApiError(
          'Invalid response format from Mimir API approvals endpoint'
        );
      }

      return data;
    } catch (error) {
      if (error instanceof MimirApiError) {
        throw error;
      }

      console.error('Mimir API approvals request failed:', error);
      throw new MimirApiError(
        `Network error: ${error instanceof Error ? error.message : 'Unknown error'}`,
        undefined,
        'NETWORK_ERROR',
        error
      );
    }
  }

  /**
   * Fetch ARC-200 balance for a specific account and contract
   * Used to validate that token owners have sufficient balance for claims
   */
  async getArc200Balance(
    contractId: number,
    accountId: string
  ): Promise<string> {
    try {
      const url = new URL(`${this.config.baseUrl}/arc200/balances`);
      url.searchParams.append('contractId', contractId.toString());
      url.searchParams.append('accountId', accountId);

      const response = await this.fetchWithRetry(url.toString());

      if (!response.ok) {
        throw new MimirApiError(
          `Failed to fetch ARC-200 balance: ${response.statusText}`,
          response.status
        );
      }

      const data: Arc200BalanceResponse = await response.json();

      if (!data.balances || !Array.isArray(data.balances)) {
        throw new MimirApiError(
          'Invalid response format from Mimir API balances endpoint'
        );
      }

      // Find the balance for the requested account
      const balance = data.balances.find(
        (b) => b.accountId === accountId && b.contractId === contractId
      );

      return balance?.balance ?? '0';
    } catch (error) {
      if (error instanceof MimirApiError) {
        throw error;
      }

      console.error('Mimir API balance request failed:', error);
      throw new MimirApiError(
        `Network error: ${error instanceof Error ? error.message : 'Unknown error'}`,
        undefined,
        'NETWORK_ERROR',
        error
      );
    }
  }

  /**
   * Maximum accounts sent in one batched balance request. Matches the
   * documented cap of the server's `accountIds` parameter and keeps the POST
   * body well under its 64 KB limit (~100 × 58-char address ≈ 6 KB). Owners
   * beyond this are split across additional requests.
   */
  private static readonly MAX_BATCH_ACCOUNTS = 100;

  /**
   * Fetch balances for many owners of ONE contract in a single request, using
   * the server's `accountIds` batch parameter (mimir-api TASK-282).
   *
   * Returns a map of owner → balance. An owner ABSENT from the map held a zero
   * balance or had no row — the caller maps that to '0', exactly as the
   * single-account `getArc200Balance` returns '0' for a missing account. `limit`
   * is set to the chunk size so the result is never truncated (the response
   * excludes zero balances, so at most `owners.length` rows can come back).
   *
   * `owners` must be non-empty and no larger than MAX_BATCH_ACCOUNTS; callers
   * chunk before calling. Throws on network/HTTP/shape errors so the caller can
   * fall back to per-owner requests.
   */
  private async fetchArc200BalancesForOwners(
    contractId: number,
    owners: string[]
  ): Promise<Map<string, string>> {
    const response = await this.fetchWithRetry(
      `${this.config.baseUrl}/arc200/balances`,
      {
        method: 'POST',
        body: JSON.stringify({
          contractId,
          accountIds: owners,
          limit: owners.length,
        }),
      }
    );

    if (!response.ok) {
      throw new MimirApiError(
        `Failed to fetch ARC-200 balances: ${response.statusText}`,
        response.status
      );
    }

    const data: Arc200BalanceResponse = await response.json();

    if (!data.balances || !Array.isArray(data.balances)) {
      throw new MimirApiError(
        'Invalid response format from Mimir API balances endpoint'
      );
    }

    const result = new Map<string, string>();
    for (const b of data.balances) {
      if (b.contractId === contractId) {
        result.set(b.accountId, b.balance);
      }
    }
    return result;
  }

  /**
   * Batch fetch ARC-200 balances for multiple owner/contract pairs
   * More efficient than individual calls when validating multiple approvals
   *
   * Issues ONE request per contract (chunked at MAX_BATCH_ACCOUNTS) via the
   * server's `accountIds` parameter, collapsing the previous per-(contract,
   * owner) fan-out — the claimable-approvals path that fired on every Home
   * account-change, ClaimableTokens focus and pull-to-refresh (F-20 / PLAN-279
   * Phase E). If a batched request fails, it falls back to per-owner requests
   * for that chunk, so one failure cannot make a whole contract's balances
   * unknown and per-owner failures stay isolated.
   *
   * Per-pair failures are reported through `failed` rather than being flattened
   * to '0' — see `Arc200BatchBalancesResult`. Callers that do not care about
   * failures can read `balances` alone and behave exactly as before, except
   * that a failed pair now reads as missing instead of falsely zero.
   */
  async batchGetArc200Balances(
    pairs: { owner: string; contractId: number }[]
  ): Promise<Arc200BatchBalancesResult> {
    const balanceMap = new Map<string, string>();
    const failed = new Set<string>();

    // Group by contractId and dedup owners (unchanged from before).
    const byContract = new Map<number, string[]>();
    for (const pair of pairs) {
      const owners = byContract.get(pair.contractId) || [];
      if (!owners.includes(pair.owner)) {
        owners.push(pair.owner);
      }
      byContract.set(pair.contractId, owners);
    }

    await Promise.all(
      Array.from(byContract.entries()).map(async ([contractId, owners]) => {
        for (
          let i = 0;
          i < owners.length;
          i += MimirApiService.MAX_BATCH_ACCOUNTS
        ) {
          const chunk = owners.slice(i, i + MimirApiService.MAX_BATCH_ACCOUNTS);
          try {
            // ONE request for the whole chunk, replacing chunk.length requests.
            const balances = await this.fetchArc200BalancesForOwners(
              contractId,
              chunk
            );
            for (const owner of chunk) {
              // Absent from the response == zero / no row, matching what the
              // single getArc200Balance path returns for a missing account.
              balanceMap.set(
                `${contractId}_${owner}`,
                balances.get(owner) ?? '0'
              );
            }
          } catch (error) {
            // Batch failed: fall back to per-owner so one bad request cannot
            // make a whole contract's balances unknown, and per-owner failures
            // stay isolated in `failed` (TASK-188 semantics preserved).
            console.warn(
              `Batch balance fetch failed for contract ${contractId}; falling back to per-owner:`,
              error
            );
            for (const owner of chunk) {
              try {
                balanceMap.set(
                  `${contractId}_${owner}`,
                  await this.getArc200Balance(contractId, owner)
                );
              } catch (err) {
                console.error(
                  `Failed to fetch balance for ${owner} on contract ${contractId}:`,
                  err
                );
                // Record the failure instead of writing '0': the caller must be
                // able to distinguish "owner holds nothing" from "we don't know".
                failed.add(`${contractId}_${owner}`);
              }
            }
          }
        }
      })
    );

    return { balances: balanceMap, failed };
  }
}

export default MimirApiService.getInstance();
