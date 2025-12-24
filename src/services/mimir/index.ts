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
  globalState: Array<{
    key: string;
    value: any;
  }>;
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
  balances: Array<{
    accountId: string;
    contractId: number;
    balance: string;
  }>;
  'current-round': number;
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
    public code?: string
  ) {
    super(message);
    this.name = 'MimirApiError';
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
        `Network error: ${error instanceof Error ? error.message : 'Unknown error'}`
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
        `Network error: ${error instanceof Error ? error.message : 'Unknown error'}`
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
            `Mimir API attempt ${attempt} failed, retrying in ${this.config.retryDelay}ms:`,
            lastError.message
          );
          await this.sleep(this.config.retryDelay * attempt); // Exponential backoff
        }
      }
    }

    throw new MimirApiError(
      `All ${this.config.retryAttempts} attempts failed. Last error: ${lastError!.message}`
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
        `Network error: ${error instanceof Error ? error.message : 'Unknown error'}`
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
        `Network error: ${error instanceof Error ? error.message : 'Unknown error'}`
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
        `Network error: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Batch fetch ARC-200 balances for multiple owner/contract pairs
   * More efficient than individual calls when validating multiple approvals
   */
  async batchGetArc200Balances(
    pairs: Array<{ owner: string; contractId: number }>
  ): Promise<Map<string, string>> {
    const balanceMap = new Map<string, string>();

    // Group by contractId to minimize API calls
    const byContract = new Map<number, string[]>();
    for (const pair of pairs) {
      const owners = byContract.get(pair.contractId) || [];
      if (!owners.includes(pair.owner)) {
        owners.push(pair.owner);
      }
      byContract.set(pair.contractId, owners);
    }

    // Fetch balances for each contract
    await Promise.all(
      Array.from(byContract.entries()).map(async ([contractId, owners]) => {
        for (const owner of owners) {
          try {
            const balance = await this.getArc200Balance(contractId, owner);
            balanceMap.set(`${contractId}_${owner}`, balance);
          } catch (error) {
            console.error(
              `Failed to fetch balance for ${owner} on contract ${contractId}:`,
              error
            );
            // Set to '0' on error to mark as not claimable
            balanceMap.set(`${contractId}_${owner}`, '0');
          }
        }
      })
    );

    return balanceMap;
  }
}

export default MimirApiService.getInstance();
