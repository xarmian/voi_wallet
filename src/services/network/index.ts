import algosdk from 'algosdk';
import {
  AccountBalance,
  AssetBalance,
  AssetParams,
  TransactionInfo,
} from '@/types/wallet';
import {
  NetworkId,
  NetworkConfiguration,
  NetworkStatus,
  NetworkError,
  NetworkUnavailableError,
} from '@/types/network';
import {
  getNetworkConfig,
  DEFAULT_NETWORK_ID,
  isFeatureAvailable,
} from './config';
import { MimirApiService, MimirAsset, Arc200Transfer } from '@/services/mimir';
import VoiPriceService from '@/services/price';
import AlgorandPriceService from '@/services/algorand-price';
import EnvoiService from '@/services/envoi';

export interface RekeyInfo {
  isRekeyed: boolean;
  authAddress?: string;
  rekeyedAt?: number;
}

// Re-export types for backwards compatibility
export type {
  NetworkConfiguration as NetworkConfig,
  NetworkStatus,
} from '@/types/network';

export class NetworkService {
  private static instances: Map<NetworkId, NetworkService> = new Map();
  private static activeNetworkId: NetworkId = DEFAULT_NETWORK_ID;
  private currentNetworkId: NetworkId;
  private algodClient!: algosdk.Algodv2;
  private indexerClient!: algosdk.Indexer;
  private config: NetworkConfiguration;
  private networkStatus: NetworkStatus;
  private mimirService?: MimirApiService;
  private rekeyInfoCache: Map<string, { info: RekeyInfo; timestamp: number }> =
    new Map();
  private rekeyInfoCacheTTL: number = 10000; // 10 second cache
  // Cache of immutable ASA params (decimals/name/unitName). Cleared on
  // switchNetwork (this instance is reused across networks). Keyed by the asset
  // ID as a string so uint64 IDs above Number.MAX_SAFE_INTEGER can't collide.
  private assetParamsCache: Map<
    string,
    { decimals: number; name?: string; unitName?: string }
  > = new Map();

  // Bumped on every network switch (when assetParamsCache is cleared). An
  // in-flight asset-params fetch captures the generation before awaiting and
  // discards its result if the generation changed — so a response that lands
  // after a switch (or a switch-and-back) can't poison the cleared cache with
  // another network's decimals.
  private assetCacheGeneration = 0;

  private constructor(networkId: NetworkId = DEFAULT_NETWORK_ID) {
    this.currentNetworkId = networkId;
    this.config = getNetworkConfig(networkId);
    this.initializeClients();
    this.initializeMimirService();
    this.configureEnvoiService();

    this.networkStatus = {
      isConnected: false,
      lastSync: 0,
      algodHeight: 0,
      indexerHealth: false,
      mimirHealth: undefined,
      envoiHealth: undefined,
    };
  }

  static getInstance(requestedNetworkId?: NetworkId): NetworkService {
    const targetNetworkId =
      requestedNetworkId !== undefined
        ? requestedNetworkId
        : NetworkService.activeNetworkId;

    const existingInstance = NetworkService.instances.get(targetNetworkId);

    if (existingInstance) {
      // When callers explicitly request a network, ensure the cached instance actually matches it.
      if (
        requestedNetworkId !== undefined &&
        existingInstance.getCurrentNetworkId() !== targetNetworkId
      ) {
        const refreshedInstance = new NetworkService(targetNetworkId);
        NetworkService.instances.set(targetNetworkId, refreshedInstance);
        return refreshedInstance;
      }

      return existingInstance;
    }

    const newInstance = new NetworkService(targetNetworkId);
    NetworkService.instances.set(targetNetworkId, newInstance);
    return newInstance;
  }

  private initializeClients(): void {
    this.algodClient = new algosdk.Algodv2(
      this.config.token,
      this.config.algodUrl,
      this.config.port
    );
    this.indexerClient = new algosdk.Indexer(
      this.config.token,
      this.config.indexerUrl,
      this.config.port
    );
  }

  private initializeMimirService(): void {
    if (this.config.features.mimir && this.config.mimirApiUrl) {
      this.mimirService = MimirApiService.getInstance();
      this.mimirService.updateConfig({ baseUrl: this.config.mimirApiUrl });
    } else {
      this.mimirService = undefined;
    }
  }

  private configureEnvoiService(): void {
    const envoiService = EnvoiService.getInstance();
    envoiService.configureForNetwork(this.currentNetworkId);
  }

  /**
   * Switch to a different network
   */
  async switchNetwork(networkId: NetworkId): Promise<void> {
    if (this.currentNetworkId === networkId) {
      return; // Already on this network
    }

    const previousNetworkId = this.currentNetworkId;

    try {
      const newConfig = getNetworkConfig(networkId);

      // Update internal state
      this.currentNetworkId = networkId;
      this.config = newConfig;

      // This instance is reused across networks (instances.set below), so drop
      // the per-network asset-params cache to avoid serving another network's
      // decimals for a colliding asset ID.
      this.assetParamsCache.clear();
      this.assetCacheGeneration++;

      // Reinitialize clients with new configuration
      this.initializeClients();
      this.initializeMimirService();
      this.configureEnvoiService();

      // Reset network status
      this.networkStatus = {
        isConnected: false,
        lastSync: 0,
        algodHeight: 0,
        indexerHealth: false,
        mimirHealth: undefined,
        envoiHealth: undefined,
      };

      // Perform initial health check
      await this.checkNetworkHealth();

      // Cache this instance under the new network ID and mark it active
      NetworkService.instances.set(networkId, this);
      NetworkService.activeNetworkId = networkId;

      console.log(`Switched to network: ${newConfig.name} (${networkId})`);
    } catch (error) {
      // Restore previous network configuration on failure
      this.currentNetworkId = previousNetworkId;
      this.config = getNetworkConfig(previousNetworkId);
      this.initializeClients();
      this.initializeMimirService();
      this.configureEnvoiService();
      NetworkService.activeNetworkId = previousNetworkId;
      throw new NetworkError(`Failed to switch to ${networkId}`, networkId);
    }
  }

  /**
   * Get current network configuration
   */
  getCurrentNetwork(): NetworkConfiguration {
    return { ...this.config };
  }

  /**
   * Get current network ID
   */
  getCurrentNetworkId(): NetworkId {
    return this.currentNetworkId;
  }

  /**
   * Check if a feature is available on current network
   */
  isFeatureAvailable(feature: keyof NetworkConfiguration['features']): boolean {
    return this.config.features[feature];
  }

  // algod/indexer clients have no built-in timeout/abort (unlike the Mimir
  // service), so a hung/unresponsive node would leave balance spinners stuck
  // and sends hanging. Bound each call so the caller can surface an error and
  // clear loading state. (Promise.race unblocks the awaiter; the socket may
  // linger, but the UI no longer hangs.)
  private static readonly REQUEST_TIMEOUT_MS = 15000;

  private withTimeout<T>(
    promise: Promise<T>,
    label: string,
    timeoutMs: number = NetworkService.REQUEST_TIMEOUT_MS
  ): Promise<T> {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(
        () =>
          reject(
            new NetworkError(
              `${label} timed out after ${timeoutMs}ms`,
              this.currentNetworkId
            )
          ),
        timeoutMs
      );
    });
    return Promise.race([promise, timeout]).finally(() =>
      clearTimeout(timeoutId)
    ) as Promise<T>;
  }

  async checkNetworkHealth(): Promise<NetworkStatus> {
    try {
      const [algodStatus, indexerHealth] = await Promise.allSettled([
        this.withTimeout(this.algodClient.status().do(), 'algod status'),
        this.withTimeout(
          this.indexerClient.makeHealthCheck().do(),
          'indexer health'
        ),
      ]);

      const isAlgodHealthy = algodStatus.status === 'fulfilled';
      const isIndexerHealthy = indexerHealth.status === 'fulfilled';

      this.networkStatus = {
        isConnected: isAlgodHealthy && isIndexerHealthy,
        lastSync: Date.now(),
        algodHeight: isAlgodHealthy ? Number(algodStatus.value.lastRound) : 0,
        indexerHealth: isIndexerHealthy,
      };

      return this.networkStatus;
    } catch (error) {
      console.error('Network health check failed:', error);
      this.networkStatus = {
        isConnected: false,
        lastSync: Date.now(),
        algodHeight: 0,
        indexerHealth: false,
      };
      return this.networkStatus;
    }
  }

  async getAccountBalance(address: string): Promise<AccountBalance> {
    try {
      if (!algosdk.isValidAddress(address)) {
        throw new Error('Invalid Algorand address');
      }

      // Fetch basic account info, Mimir assets, pricing, and rekey info in parallel
      const [accountInfo, mimirAssets, priceData, rekeyInfo] =
        await Promise.allSettled([
          this.withTimeout(
            this.algodClient.accountInformation(address).do(),
            'account info'
          ),
          this.getMimirAssets(address),
          this.getPricingData(address),
          this.getAccountRekeyInfo(address),
        ]);

      if (accountInfo.status === 'rejected') {
        throw new Error(`Failed to fetch account info: ${accountInfo.reason}`);
      }

      const algodAssets: AssetBalance[] = [];
      // Guard the cache writes below against a network switch during this
      // refresh: switchNetwork clears assetParamsCache and bumps the
      // generation, so a stale response can't repopulate the cleared cache
      // (holds even across a switch-and-back within the loop).
      const requestGeneration = this.assetCacheGeneration;
      if (accountInfo.value.assets) {
        for (const asset of accountInfo.value.assets) {
          const assetId = Number(asset.assetId);
          const assetKey = String(asset.assetId);

          // Asset params are immutable: reuse the cached entry and skip the
          // network call entirely once we've seen this asset before.
          const cachedParams = this.assetParamsCache.get(assetKey);
          if (cachedParams) {
            algodAssets.push({
              assetId,
              amount: asset.amount,
              decimals: cachedParams.decimals,
              name: cachedParams.name,
              unitName: cachedParams.unitName,
              assetType: 'asa',
            });
            continue;
          }

          try {
            const assetInfo = await this.withTimeout(
              this.algodClient.getAssetByID(assetId).do(),
              `asset ${assetId}`
            );
            const params = {
              decimals: Number(assetInfo.params.decimals ?? 0),
              name: assetInfo.params.name,
              unitName: assetInfo.params.unitName,
            };
            if (this.assetCacheGeneration === requestGeneration) {
              this.assetParamsCache.set(assetKey, params);
            }
            algodAssets.push({
              assetId,
              amount: asset.amount,
              decimals: params.decimals,
              name: params.name,
              unitName: params.unitName,
              assetType: 'asa',
            });
          } catch (assetError) {
            console.warn(
              `Failed to fetch asset info for ${asset.assetId}:`,
              assetError
            );
            // Never fall back to decimals: 0 for an unknown asset — that would
            // display a 10^N x inflated balance. Omit the asset until a later
            // refresh can resolve its real params.
            continue;
          }
        }
      }

      // Merge with Mimir data if available
      let assets = algodAssets;
      if (mimirAssets.status === 'fulfilled') {
        assets = this.mergeAssetsWithMimirData(algodAssets, mimirAssets.value);
      } else {
        console.warn('Failed to fetch Mimir assets:', mimirAssets.reason);
      }

      // Enhance assets with pricing data for Algorand network
      const pricing = priceData.status === 'fulfilled' ? priceData.value : {};
      assets = this.enhanceAssetsWithPricing(assets, pricing.assetPrices);

      return {
        address,
        amount: accountInfo.value.amount,
        minBalance: accountInfo.value.minBalance,
        assets,
        voiPrice:
          this.currentNetworkId === NetworkId.VOI_MAINNET
            ? pricing.nativePrice
            : undefined,
        algoPrice:
          this.currentNetworkId === NetworkId.ALGORAND_MAINNET
            ? pricing.nativePrice
            : undefined,
        rekeyInfo:
          rekeyInfo.status === 'fulfilled'
            ? rekeyInfo.value
            : { isRekeyed: false },
      };
    } catch (error) {
      console.error('Failed to fetch account balance:', error);
      throw new Error(
        `Failed to fetch balance: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Coerce a decimals value read from an external source (algod/Mimir) into a
   * trustworthy integer. Returns null for anything that isn't a genuine,
   * finite, non-negative integer so callers can omit the asset instead of
   * guessing — a fabricated 0 would inflate a displayed balance by 10^N. A
   * real `decimals: 0` is preserved.
   *
   * Decimals legitimately only ever arrives as a `number` (Mimir) or
   * `number | bigint` (algosdk), so only those types are accepted. Strings,
   * booleans, and empty/whitespace values are rejected — `Number('')`,
   * `Number('  ')`, `Number(false)`, `Number([])` all coerce to a deceptive 0.
   */
  private normalizeDecimals(value: unknown): number | null {
    let n: number;
    if (typeof value === 'number') {
      n = value;
    } else if (typeof value === 'bigint') {
      n = Number(value);
    } else {
      return null;
    }
    if (!Number.isInteger(n) || n < 0) {
      return null;
    }
    return n;
  }

  /**
   * Targeted balance lookup for a single asset (used by the send flow's asset
   * picker). Unlike getAccountBalance, this resolves only the requested asset
   * and skips the heavy parts of that pipeline — pricing, rekey info, and the
   * sequential per-holding metadata loop.
   *
   * ARC-200 discovery is retained via Mimir (checked first), so unmapped
   * ARC-200 assets still resolve; an ASA fallback uses algod holdings as the
   * source of truth. `assetId` is an ASA asset ID or an ARC-200 contract ID.
   * The native token (assetId 0) is intentionally not handled here — callers
   * resolve it separately. Returns null when the account doesn't hold it (or
   * when its decimals can't be resolved, to avoid displaying an inflated
   * balance).
   */
  async getSingleAssetBalance(
    address: string,
    assetId: number
  ): Promise<AssetBalance | null> {
    if (!algosdk.isValidAddress(address)) {
      throw new Error('Invalid Algorand address');
    }
    if (!assetId) {
      return null;
    }

    // ARC-200 tokens live only in Mimir, so check there first — this is what
    // keeps unmapped ARC-200 assets discoverable (parity with
    // getAccountBalance -> mergeAssetsWithMimirData). getMimirAssets returns []
    // when Mimir is unavailable on this network, so ASAs still resolve below.
    const mimirAssets = await this.getMimirAssets(address);
    const arc200Match = mimirAssets.find(
      (m) => m.assetType === 'arc200' && m.contractId === assetId
    );
    if (arc200Match) {
      const decimals = this.normalizeDecimals(arc200Match.decimals);
      if (decimals === null) {
        // Can't trust the magnitude without real decimals — omit rather than
        // risk showing an inflated balance.
        return null;
      }
      return {
        assetId: arc200Match.contractId,
        amount: arc200Match.balance ? BigInt(arc200Match.balance) : 0n,
        decimals,
        name: arc200Match.name,
        symbol: arc200Match.symbol,
        imageUrl: arc200Match.imageUrl,
        usdValue: arc200Match.usdValue,
        verified: arc200Match.verified,
        assetType: 'arc200',
        contractId: arc200Match.contractId,
      };
    }

    // Otherwise treat it as an ASA: algod holdings are the source of truth for
    // whether the account actually holds it (mirrors mergeAssetsWithMimirData,
    // which only surfaces ASAs present in the algod holdings).
    const accountInfo = await this.withTimeout(
      this.algodClient.accountInformation(address).do(),
      'account info'
    );
    // algosdk v3 exposes `assetId` (a uint64 bigint); compare as strings so
    // large IDs aren't collapsed by a lossy Number() cast.
    const holding = accountInfo.assets?.find(
      (a: any) => String(a.assetId) === String(assetId)
    );
    if (!holding) {
      return null;
    }

    // getAssetInfo returns null on a 404 (asset genuinely doesn't exist) but
    // THROWS on timeout/other transient errors. Distinguish them: a transient
    // failure should tolerate a Mimir fallback, but a genuine not-found must
    // NOT be papered over with stale Mimir ASA metadata.
    let assetInfo: any = null;
    let assetInfoThrew = false;
    try {
      assetInfo = await this.getAssetInfo(assetId);
    } catch (error) {
      console.warn(`Failed to fetch asset info for ${assetId}:`, error);
      assetInfoThrew = true;
    }

    // Genuine null (not a thrown error) = algod says this ASA doesn't exist.
    // Report not-found rather than substituting Mimir data for a nonexistent
    // asset. (ARC-200 discovery above is Mimir-first and unaffected.)
    if (!assetInfoThrew && assetInfo === null) {
      return null;
    }

    const mimirMeta = mimirAssets.find(
      (m) => m.assetType === 'asa' && m.contractId === assetId
    );

    // `decimals` is a REQUIRED ASA param, so treat "genuinely present" and
    // "absent" differently: 0 is a legitimate value, but getCachedAssetParams'
    // `?? 0` would fabricate a 0 for a missing/failed response and silently
    // inflate the displayed balance by 10^N. algod is authoritative when it's
    // reachable — trust its decimals (0 included). Only when the algod lookup
    // THREW (transient/unreachable) do we fall back to Mimir; a reachable algod
    // that returned unusable params must NOT be papered over with (possibly
    // stale) Mimir decimals. If neither resolves it, return null.
    const algodDecimals = this.normalizeDecimals(assetInfo?.params?.decimals);
    const decimals =
      algodDecimals ??
      (assetInfoThrew ? this.normalizeDecimals(mimirMeta?.decimals) : null);
    if (decimals === null) {
      // Never guess decimals: 0 — that would show a 10^N-inflated balance.
      // Omit the asset until a later refresh can resolve its real params.
      return null;
    }

    return {
      assetId,
      amount: holding.amount,
      decimals,
      name: assetInfo?.params?.name ?? mimirMeta?.name,
      unitName: assetInfo?.params?.unitName,
      symbol: mimirMeta?.symbol,
      imageUrl: mimirMeta?.imageUrl,
      usdValue: mimirMeta?.usdValue,
      verified: mimirMeta?.verified,
      assetType: 'asa',
      contractId: mimirMeta?.contractId,
    };
  }

  private async getMimirAssets(address: string): Promise<MimirAsset[]> {
    // Return empty array if Mimir is not available on this network
    if (!this.mimirService) {
      return [];
    }

    try {
      return await this.mimirService.getAllAccountAssets(address);
    } catch (error) {
      console.warn('Failed to fetch Mimir assets:', error);
      return [];
    }
  }

  private async getPricingData(
    address: string
  ): Promise<{ nativePrice?: number; assetPrices?: Map<number, number> }> {
    if (!this.isFeatureAvailable('pricing')) {
      return {};
    }

    try {
      if (this.currentNetworkId === NetworkId.VOI_MAINNET) {
        // For Voi, just get the native VOI price
        const voiPrice = await VoiPriceService.getVoiPrice();
        return { nativePrice: voiPrice };
      } else if (this.currentNetworkId === NetworkId.ALGORAND_MAINNET) {
        // For Algorand, get prices for ALGO and all user's assets
        const accountInfo = await this.algodClient
          .accountInformation(address)
          .do();
        const assetIds: number[] = [0]; // Always include ALGO (asset ID 0)

        // Collect all asset IDs from user's assets
        if (accountInfo.assets) {
          accountInfo.assets.forEach((asset: any) => {
            assetIds.push(Number(asset.assetId));
          });
        }

        // Fetch prices for ALGO and all user assets
        const assetPrices = await AlgorandPriceService.getAssetPrices(assetIds);
        const algoPrice = assetPrices.get(0) || 0;

        return { nativePrice: algoPrice, assetPrices };
      }

      return {};
    } catch (error) {
      console.warn('Failed to fetch pricing data:', error);
      return {};
    }
  }

  private mergeAssetsWithMimirData(
    algodAssets: AssetBalance[],
    mimirAssets: MimirAsset[]
  ): AssetBalance[] {
    // Create a map of Mimir assets by contract ID for ARC-200 and asset ID for ASAs
    const mimirAssetMap = new Map<number, MimirAsset>();
    const mimirArc200Assets: MimirAsset[] = [];

    mimirAssets.forEach((mimirAsset) => {
      if (mimirAsset.assetType === 'arc200') {
        mimirArc200Assets.push(mimirAsset);
      } else {
        // For ASAs, use contractId as the asset ID
        mimirAssetMap.set(mimirAsset.contractId, mimirAsset);
      }
    });

    // Enhance algod assets with Mimir data
    const enhancedAssets = algodAssets.map((algodAsset) => {
      const mimirData = mimirAssetMap.get(algodAsset.assetId);
      if (mimirData) {
        return {
          ...algodAsset,
          symbol: mimirData.symbol,
          imageUrl: mimirData.imageUrl,
          usdValue: mimirData.usdValue,
          verified: mimirData.verified,
          assetType: 'asa' as const,
          contractId: mimirData.contractId,
        };
      }
      return algodAsset;
    });

    // Add ARC-200 assets that don't exist in algod
    const arc200Assets: AssetBalance[] = mimirArc200Assets.map(
      (mimirAsset) => ({
        assetId: mimirAsset.contractId, // Use contractId as assetId for ARC-200
        amount: mimirAsset.balance ? BigInt(mimirAsset.balance) : 0n,
        decimals: mimirAsset.decimals,
        name: mimirAsset.name,
        symbol: mimirAsset.symbol,
        imageUrl: mimirAsset.imageUrl,
        usdValue: mimirAsset.usdValue,
        verified: mimirAsset.verified,
        assetType: 'arc200',
        contractId: mimirAsset.contractId,
      })
    );

    return [...enhancedAssets, ...arc200Assets];
  }

  private enhanceAssetsWithPricing(
    assets: AssetBalance[],
    assetPrices?: Map<number, number>
  ): AssetBalance[] {
    if (!assetPrices || this.currentNetworkId !== NetworkId.ALGORAND_MAINNET) {
      return assets;
    }

    return assets.map((asset) => {
      const price = assetPrices.get(asset.assetId);
      if (price && price > 0) {
        // Store the unit price (same format as Mimir)
        // The UI component will multiply by the normalized amount
        return {
          ...asset,
          usdValue: price.toFixed(6), // Store unit price, not total value
        };
      }
      return asset;
    });
  }

  async getTransactionHistory(
    address: string,
    limit: number = 50
  ): Promise<TransactionInfo[]> {
    try {
      if (!algosdk.isValidAddress(address)) {
        throw new Error('Invalid Algorand address');
      }

      const algodResponse = await this.indexerClient
        .lookupAccountTransactions(address)
        .limit(limit)
        .do();

      const transactions: TransactionInfo[] = [];

      if (algodResponse.transactions) {
        for (const txn of algodResponse.transactions) {
          const timestamp = txn.roundTime ? txn.roundTime * 1000 : Date.now();

          let type: TransactionInfo['type'] = 'payment';
          let assetId: number | undefined;

          if (txn.txType === 'pay') {
            type = 'payment';
          } else if (txn.txType === 'axfer') {
            type = 'asset-transfer';
            assetId = txn.assetTransferTransaction?.assetId
              ? Number(txn.assetTransferTransaction.assetId)
              : undefined;
          } else if (txn.txType === 'acfg') {
            type = 'asset-config';
            assetId = txn.assetConfigTransaction?.assetId
              ? Number(txn.assetConfigTransaction.assetId)
              : undefined;
          } else if (txn.txType === 'appl') {
            type = 'application-call';
          }

          // Extract amount based on transaction type
          let amount: number | bigint = 0;
          const sender: string = txn.sender ?? '';
          let recipient: string = sender; // Default recipient for non-payment transactions
          let applicationId: number | undefined;

          if (txn.txType === 'pay' && txn.paymentTransaction) {
            amount = txn.paymentTransaction.amount ?? 0;
            recipient = txn.paymentTransaction.receiver ?? sender;
          } else if (txn.txType === 'axfer' && txn.assetTransferTransaction) {
            amount = txn.assetTransferTransaction.amount ?? 0;
            recipient = txn.assetTransferTransaction.receiver ?? sender;
          } else if (txn.txType === 'appl' && txn.applicationTransaction) {
            applicationId = Number(txn.applicationTransaction.applicationId);
            recipient = applicationId ? `App ${applicationId}` : 'App Call';
          }

          transactions.push({
            id: txn.id ?? '',
            from: txn.sender,
            to: recipient,
            amount: amount,
            fee: txn.fee ?? 0,
            timestamp,
            type,
            assetId,
            applicationId,
            note:
              txn.note instanceof Uint8Array
                ? new TextDecoder().decode(txn.note)
                : undefined,
            confirmedRound: txn.confirmedRound,
          });
        }
      }

      return transactions.sort((a, b) => b.timestamp - a.timestamp);
    } catch (error) {
      console.error('Failed to fetch transaction history:', error);
      throw new Error(
        `Failed to fetch transactions: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  async getAssetTransactionHistory(
    address: string,
    assetId: number,
    isArc200: boolean = false,
    limit: number = 50,
    nextToken?: string
  ): Promise<{
    transactions: TransactionInfo[];
    nextToken?: string;
    hasMore: boolean;
  }> {
    try {
      if (!algosdk.isValidAddress(address)) {
        throw new Error('Invalid Algorand address');
      }

      if (isArc200) {
        // Return empty array if Mimir is not available on this network
        if (!this.mimirService) {
          console.warn('ARC-200 transfers not available on this network');
          return { transactions: [], hasMore: false };
        }

        // For ARC-200 tokens, use offset-based pagination from Mimir
        // Note: nextToken here is actually the offset as a string
        const offset = nextToken ? parseInt(nextToken, 10) : 0;
        const arc200Response = await this.mimirService.getArc200Transfers(
          address,
          assetId,
          offset,
          limit
        );

        const transactions = arc200Response.transfers
          .map((transfer) => ({
            id: transfer.transactionId,
            from: transfer.sender,
            to: transfer.receiver,
            amount: transfer.amount ? BigInt(transfer.amount) : 0n,
            fee: 0, // ARC-200 transfers don't have separate fees
            timestamp: transfer.timestamp * 1000, // Convert to milliseconds
            type: 'arc200-transfer' as const,
            assetId: transfer.contractId, // Use contractId as assetId for compatibility
            contractId: transfer.contractId,
            isArc200: true,
            confirmedRound: transfer.round,
          }))
          .sort((a, b) => b.timestamp - a.timestamp);

        // For ARC-200, nextToken is the next offset
        const newNextToken = arc200Response.hasMore
          ? (offset + transactions.length).toString()
          : undefined;

        return {
          transactions,
          nextToken: newNextToken,
          hasMore: arc200Response.hasMore ?? false,
        };
      } else if (assetId === 0) {
        // For native token (VOI/ALGO), use txType filter with next-token pagination
        let indexerQuery = this.indexerClient
          .lookupAccountTransactions(address)
          .txType('pay')
          .limit(limit);

        if (nextToken) {
          indexerQuery = indexerQuery.nextToken(nextToken);
        }

        const algodResponse = await indexerQuery.do();
        const transactions: TransactionInfo[] = [];

        if (algodResponse.transactions) {
          for (const txn of algodResponse.transactions) {
            const timestamp = txn.roundTime ? txn.roundTime * 1000 : Date.now();
            const amount = txn.paymentTransaction?.amount ?? 0;
            const recipient = txn.paymentTransaction?.receiver ?? txn.sender;

            transactions.push({
              id: txn.id ?? '',
              from: txn.sender,
              to: recipient,
              amount: amount,
              fee: txn.fee ?? 0,
              timestamp,
              type: 'payment',
              note:
                txn.note instanceof Uint8Array
                  ? new TextDecoder().decode(txn.note)
                  : undefined,
              confirmedRound: txn.confirmedRound,
            });
          }
        }

        return {
          transactions,
          nextToken: algodResponse.nextToken,
          hasMore: !!algodResponse.nextToken,
        };
      } else {
        // For ASA assets, use txType and assetID filters with next-token pagination
        // Add txType filter first to narrow search space and prevent indexer timeouts
        let indexerQuery = this.indexerClient
          .lookupAccountTransactions(address)
          .txType('axfer') // Filter by asset transfer transactions first
          .assetID(assetId)
          .limit(limit);

        if (nextToken) {
          indexerQuery = indexerQuery.nextToken(nextToken);
        }

        const algodResponse = await indexerQuery.do();
        const transactions: TransactionInfo[] = [];

        if (algodResponse.transactions) {
          for (const txn of algodResponse.transactions) {
            // Only process asset transfer transactions
            if (txn.txType !== 'axfer') {
              continue;
            }

            const timestamp = txn.roundTime ? txn.roundTime * 1000 : Date.now();
            const txnAssetId = txn.assetTransferTransaction?.assetId
              ? Number(txn.assetTransferTransaction.assetId)
              : undefined;

            // Double-check the asset ID matches (indexer filter should handle this)
            if (txnAssetId !== assetId) {
              continue;
            }

            const amount = txn.assetTransferTransaction?.amount ?? 0;
            const recipient =
              txn.assetTransferTransaction?.receiver ?? txn.sender;

            transactions.push({
              id: txn.id ?? '',
              from: txn.sender,
              to: recipient,
              amount: amount,
              fee: txn.fee ?? 0,
              timestamp,
              type: 'asset-transfer',
              assetId: txnAssetId,
              note:
                txn.note instanceof Uint8Array
                  ? new TextDecoder().decode(txn.note)
                  : undefined,
              confirmedRound: txn.confirmedRound,
            });
          }
        }

        return {
          transactions,
          nextToken: algodResponse.nextToken,
          hasMore: !!algodResponse.nextToken,
        };
      }
    } catch (error) {
      console.error('Failed to fetch asset transaction history:', error);
      throw new Error(
        `Failed to fetch asset transactions: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  async estimateTransactionFee(): Promise<number> {
    // Both VOI and Algorand use similar fee structures
    // VOI: 0.001 VOI (1000 microVOI)
    // Algorand: 0.001 ALGO (1000 microALGO)
    return 1000;
  }

  async getSuggestedParams(): Promise<algosdk.SuggestedParams> {
    try {
      return await this.withTimeout(
        this.algodClient.getTransactionParams().do(),
        'suggested params'
      );
    } catch (error) {
      console.error('Failed to get suggested params:', error);
      throw new Error(
        `Failed to get network parameters: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  async submitTransaction(
    signedTxn: Uint8Array | Uint8Array[]
  ): Promise<{ txId: string; confirmed: boolean }> {
    try {
      // NOTE: sendRawTransaction is now wrapped with a client-side timeout.
      // A timeout after the node accepted the tx is safe because
      // TransactionService.submitWithRetries detects "already in ledger" /
      // "already in the pool" responses on retry and treats them as success
      // instead of resubmitting, so a lost-response commit can no longer cause
      // either a false failure or a double-send.
      const res = await this.withTimeout(
        this.algodClient.sendRawTransaction(signedTxn).do(),
        'submit transaction',
        30000
      );
      const txId =
        (res as unknown as { txId?: string; txid?: string }).txId ??
        (res as any).txid;
      // Wait for confirmation. A false result means the tx is still pending
      // (not confirmed within the round window), NOT a failure.
      const confirmed = await this.waitForConfirmationInternal(txId);
      return { txId, confirmed };
    } catch (error) {
      console.error('Failed to submit transaction:', error);
      throw new Error(
        `Transaction failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  private async waitForConfirmationInternal(txId: string): Promise<boolean> {
    try {
      // Wait up to 10 rounds for confirmation
      await algosdk.waitForConfirmation(this.algodClient, txId, 10);
      return true;
    } catch (err) {
      // Not confirmed within the round window. This is a PENDING state, not a
      // failure: the tx may still confirm later. Surface a soft warning and let
      // the caller report a pending (not failed) status to the user.
      console.warn('Transaction submitted but not yet confirmed:', err);
      return false;
    }
  }

  /**
   * Short, best-effort confirmation check used to reconcile a submit whose
   * HTTP response was lost (algod returned "already in ledger"/"already in the
   * pool" on retry). Returns true only if the tx is confirmed within a few
   * rounds; false on any error or timeout.
   */
  async isTransactionConfirmed(txId: string): Promise<boolean> {
    try {
      await this.withTimeout(
        algosdk.waitForConfirmation(this.algodClient, txId, 4),
        'confirm transaction',
        30000
      );
      return true;
    } catch {
      return false;
    }
  }

  getNetworkStatus(): NetworkStatus {
    return { ...this.networkStatus };
  }

  getConfig(): NetworkConfiguration {
    return { ...this.config };
  }

  async getAllTransactionHistory(
    address: string,
    limit: number = 50,
    nextToken?: string
  ): Promise<{ transactions: TransactionInfo[]; nextToken?: string }> {
    try {
      if (!algosdk.isValidAddress(address)) {
        throw new Error('Invalid Algorand address');
      }

      const textDecoder = new TextDecoder();
      const decodeNote = (noteField: unknown): string | undefined => {
        if (!noteField) {
          return undefined;
        }

        try {
          if (noteField instanceof Uint8Array) {
            return textDecoder.decode(noteField);
          }

          if (typeof noteField === 'string') {
            const decodedBytes = Buffer.from(noteField, 'base64');
            const normalizedOriginal = noteField.replace(/=+$/, '');
            const normalizedEncoded = Buffer.from(decodedBytes)
              .toString('base64')
              .replace(/=+$/, '');

            if (normalizedOriginal === normalizedEncoded) {
              return decodedBytes.length
                ? textDecoder.decode(decodedBytes)
                : '';
            }

            return noteField;
          }
        } catch (error) {
          console.warn('Failed to decode transaction note:', error);
        }

        return undefined;
      };

      // Build indexer query with pagination
      let indexerQuery = this.indexerClient
        .lookupAccountTransactions(address)
        .limit(limit);

      if (nextToken) {
        indexerQuery = indexerQuery.nextToken(nextToken);
      }

      // Fetch indexer transactions and ARC-200 transfers in parallel
      const promises: [Promise<any>, Promise<any>] = [
        indexerQuery.do(),
        // Only fetch ARC-200 transfers if Mimir service is available
        this.mimirService
          ? this.mimirService.getArc200Transfers(
              address,
              undefined,
              undefined,
              limit
            )
          : Promise.resolve({ transfers: [], hasMore: false }),
      ];

      const [algodResponse, arc200Response] = await Promise.all(promises);

      const allTransactions: TransactionInfo[] = [];

      // Process Algorand transactions (native payments, ASA transfers, app calls, etc.)
      if (algodResponse.transactions) {
        for (const txn of algodResponse.transactions) {
          const timestamp = txn.roundTime ? txn.roundTime * 1000 : Date.now();
          let type: TransactionInfo['type'] = 'payment';
          let txnAssetId: number | undefined;

          if (txn.txType === 'pay') {
            type = 'payment';
            txnAssetId = undefined;
          } else if (txn.txType === 'axfer') {
            type = 'asset-transfer';
            txnAssetId = txn.assetTransferTransaction?.assetId
              ? Number(txn.assetTransferTransaction.assetId)
              : undefined;
          } else if (txn.txType === 'acfg') {
            type = 'asset-config';
            txnAssetId = txn.assetConfigTransaction?.assetId
              ? Number(txn.assetConfigTransaction.assetId)
              : undefined;
          } else if (txn.txType === 'appl') {
            type = 'application-call';
          } else {
            continue; // Skip unsupported transaction types
          }

          const sender = txn.sender || '';
          let receiver =
            txn.paymentTransaction?.receiver ||
            txn.assetTransferTransaction?.receiver ||
            '';

          // For application calls, use application ID instead of receiver address
          let applicationId: number | undefined;
          if (txn.txType === 'appl' && txn.applicationTransaction) {
            applicationId = txn.applicationTransaction.applicationId;
            receiver = applicationId ? `App ${applicationId}` : 'App Call';
          }

          const amount = BigInt(
            txn.paymentTransaction?.amount ||
              txn.assetTransferTransaction?.amount ||
              0
          );

          allTransactions.push({
            id: txn.id || '',
            from: sender,
            to: receiver,
            amount,
            fee: txn.fee || 0,
            timestamp,
            type,
            assetId: txnAssetId,
            applicationId,
            isArc200: false,
            note: decodeNote(txn.note),
            confirmedRound: txn.confirmedRound || 0,
          });
        }
      }

      // Process ARC-200 transfers
      for (const transfer of arc200Response.transfers) {
        allTransactions.push({
          id: transfer.transactionId,
          from: transfer.sender,
          to: transfer.receiver,
          amount: transfer.amount ? BigInt(transfer.amount) : 0n,
          fee: 0, // ARC-200 transfers don't have separate fees
          timestamp: transfer.timestamp * 1000, // Convert to milliseconds
          type: 'arc200-transfer' as const,
          assetId: transfer.contractId,
          contractId: transfer.contractId,
          isArc200: true,
          note: decodeNote(transfer.note),
          confirmedRound: transfer.round,
        });
      }

      // Sort all transactions by timestamp (newest first)
      const sortedTransactions = allTransactions.sort(
        (a, b) => b.timestamp - a.timestamp
      );

      // Return transactions with pagination info
      return {
        transactions: sortedTransactions,
        nextToken: algodResponse.nextToken || undefined,
      };
    } catch (error) {
      console.error('Failed to fetch complete transaction history:', error);
      throw new Error(
        `Failed to fetch transactions: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  getAlgodClient(): algosdk.Algodv2 {
    return this.algodClient;
  }

  getIndexerClient(): algosdk.Indexer {
    return this.indexerClient;
  }

  /**
   * Check if an account has been rekeyed and return rekey information
   * @param skipTimestamp - Skip fetching the rekey timestamp (faster, for signing operations)
   */
  async getAccountRekeyInfo(
    address: string,
    skipTimestamp: boolean = false
  ): Promise<RekeyInfo> {
    try {
      if (!algosdk.isValidAddress(address)) {
        throw new Error('Invalid Algorand address');
      }

      // Check cache first
      const cached = this.rekeyInfoCache.get(address);
      const now = Date.now();
      if (cached && now - cached.timestamp < this.rekeyInfoCacheTTL) {
        return cached.info;
      }

      const accountInfo = await this.algodClient
        .accountInformation(address)
        .do();

      // Check if account has auth-addr field (indicating it's been rekeyed)
      let authAddress: string | undefined;

      // algosdk v3+ returns authAddr as an object with publicKey bytes
      if (accountInfo.authAddr && accountInfo.authAddr.publicKey) {
        // Convert public key bytes to address string
        authAddress = algosdk.encodeAddress(
          new Uint8Array(accountInfo.authAddr.publicKey)
        );
      }

      const isRekeyed = Boolean(authAddress);

      if (!isRekeyed) {
        const result = { isRekeyed: false };
        // Cache the result
        this.rekeyInfoCache.set(address, {
          info: result,
          timestamp: Date.now(),
        });
        return result;
      }

      // If rekeyed, try to find when it was rekeyed by looking at recent transactions
      // Skip this for signing operations to improve performance (timestamp not needed for signing)
      let rekeyedAt: number | undefined;
      if (!skipTimestamp) {
        try {
          const txnResponse = await this.indexerClient
            .lookupAccountTransactions(address)
            .txType('pay') // Rekey transactions are payment type with rekey-to field
            .limit(50)
            .do();

          // Look for the most recent transaction with a rekey-to field.
          // algosdk v3 exposes it as `rekeyTo` (string or Address), not the
          // legacy kebab-case 'rekey-to'.
          if (txnResponse.transactions) {
            for (const txn of txnResponse.transactions) {
              const rekeyTo = (txn as any).rekeyTo;
              const rekeyToAddress =
                typeof rekeyTo === 'string'
                  ? rekeyTo
                  : rekeyTo?.publicKey
                    ? algosdk.encodeAddress(new Uint8Array(rekeyTo.publicKey))
                    : undefined;
              if (rekeyToAddress && rekeyToAddress === authAddress) {
                rekeyedAt = txn.roundTime ? txn.roundTime * 1000 : undefined;
                break;
              }
            }
          }
        } catch (error) {
          console.warn('Failed to fetch rekey timestamp:', error);
        }
      }

      const result = {
        isRekeyed: true,
        authAddress,
        rekeyedAt,
      };

      // Cache the result
      this.rekeyInfoCache.set(address, { info: result, timestamp: Date.now() });

      return result;
    } catch (error) {
      console.error('Failed to check rekey status:', error);
      throw new Error(
        `Failed to check rekey status: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Check multiple accounts for rekey status in parallel
   */
  async getMultipleAccountRekeyInfo(
    addresses: string[]
  ): Promise<Record<string, RekeyInfo>> {
    try {
      const results = await Promise.allSettled(
        addresses.map((address) => this.getAccountRekeyInfo(address))
      );

      const rekeyInfo: Record<string, RekeyInfo> = {};

      addresses.forEach((address, index) => {
        const result = results[index];
        if (result.status === 'fulfilled') {
          rekeyInfo[address] = result.value;
        } else {
          console.warn(
            `Failed to check rekey status for ${address}:`,
            result.reason
          );
          rekeyInfo[address] = { isRekeyed: false };
        }
      });

      return rekeyInfo;
    } catch (error) {
      console.error('Failed to check multiple rekey statuses:', error);
      throw new Error(
        `Failed to check rekey statuses: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Resolve an ASA's immutable params (decimals/name/unitName), preferring the
   * process-wide assetParamsCache populated during balance refreshes. Falls back
   * to a single getAssetByID fetch and caches the result. Returns null when the
   * asset can't be resolved (not found / network error) so callers can render a
   * safe placeholder instead of assuming 0 decimals (which inflates displayed
   * amounts by up to 10^decimals).
   */
  async getCachedAssetParams(assetId: number): Promise<AssetParams | null> {
    const assetKey = String(assetId);

    const cached = this.assetParamsCache.get(assetKey);
    if (cached) {
      return cached;
    }

    // Capture the switch generation before the fetch. switchNetwork() clears
    // this cache and bumps the generation, so if it changed while we awaited,
    // this response belongs to a network we've since left — discard it (don't
    // cache OR return it) so callers never see another network's params.
    const requestGeneration = this.assetCacheGeneration;

    try {
      const assetInfo = await this.getAssetInfo(assetId);
      if (!assetInfo?.params) {
        return null;
      }
      if (this.assetCacheGeneration !== requestGeneration) {
        return null;
      }
      const params: AssetParams = {
        decimals: Number(assetInfo.params.decimals ?? 0),
        name: assetInfo.params.name,
        unitName: assetInfo.params.unitName,
      };
      this.assetParamsCache.set(assetKey, params);
      return params;
    } catch (error) {
      console.error(`Failed to resolve asset params for ${assetId}:`, error);
      return null;
    }
  }

  /**
   * Get detailed information about an asset
   */
  async getAssetInfo(assetId: number): Promise<any> {
    try {
      const assetInfo = await this.withTimeout(
        this.algodClient.getAssetByID(assetId).do(),
        `asset ${assetId}`
      );
      return assetInfo;
    } catch (error) {
      console.error(`Failed to fetch asset info for ${assetId}:`, error);

      if (error instanceof NetworkError) {
        throw error;
      }

      if (error instanceof Error) {
        if (
          error.message.includes('404') ||
          error.message.includes('not found')
        ) {
          return null; // Asset not found
        }
      }

      throw new Error(
        `Failed to fetch asset info: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Search for assets by name or unit name using the indexer
   */
  async searchAssets(
    query: string,
    limit = 20,
    nextToken?: string
  ): Promise<{ assets: any[]; nextToken?: string }> {
    try {
      // Try to parse as asset ID first
      const assetId = parseInt(query.trim());
      if (!isNaN(assetId)) {
        const assetInfo = await this.getAssetInfo(assetId);
        return { assets: assetInfo ? [assetInfo] : [] };
      }

      // Build URL parameters manually since algosdk isn't working properly
      const params = new URLSearchParams({
        'include-all': 'false',
        limit: limit.toString(),
        name: query,
      });

      if (nextToken) {
        params.set('next', nextToken);
      }

      const url = `${this.config.indexerUrl}/v2/assets?${params.toString()}`;

      // Make direct HTTP request
      const response = await fetch(url, {
        headers: {
          'X-API-Key': this.config.token || '',
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();

      // If name search didn't find anything, try unit name search
      if ((!data.assets || data.assets.length === 0) && !nextToken) {
        const unitParams = new URLSearchParams({
          'include-all': 'false',
          limit: limit.toString(),
          'unit-name': query,
        });

        const unitUrl = `${this.config.indexerUrl}/v2/assets?${unitParams.toString()}`;

        const unitResponse = await fetch(unitUrl, {
          headers: {
            'X-API-Key': this.config.token || '',
          },
        });

        if (unitResponse.ok) {
          const unitData = await unitResponse.json();

          return {
            assets: unitData.assets || [],
            nextToken: unitData.nextToken,
          };
        }
      }

      return {
        assets: data.assets || [],
        nextToken: data.nextToken,
      };
    } catch (error) {
      console.error(`Failed to search assets for "${query}":`, error);
      throw new Error(
        `Failed to search assets: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Get the very first transaction for an account
   */
  async getFirstTransaction(address: string): Promise<any> {
    try {
      if (!algosdk.isValidAddress(address)) {
        throw new Error('Invalid Algorand address');
      }

      // Query with minRound=1 and limit=1 to get the earliest transaction
      const algodResponse = await this.indexerClient
        .lookupAccountTransactions(address)
        .minRound(1)
        .limit(1)
        .do();

      if (algodResponse.transactions && algodResponse.transactions.length > 0) {
        const txn = algodResponse.transactions[0];
        return {
          timestamp: txn.roundTime ? txn.roundTime * 1000 : Date.now(),
          round: txn.confirmedRound,
          id: txn.id,
        };
      }

      return null;
    } catch (error) {
      console.error(`Failed to fetch first transaction for ${address}:`, error);
      return null;
    }
  }

  /**
   * Get account information including opted-in assets
   */
  async getAccountInfo(address: string): Promise<any> {
    try {
      if (!algosdk.isValidAddress(address)) {
        throw new Error('Invalid Algorand address');
      }

      const accountInfo = await this.algodClient
        .accountInformation(address)
        .do();
      return accountInfo;
    } catch (error) {
      console.error(`Failed to fetch account info for ${address}:`, error);

      if (error instanceof NetworkError) {
        throw error;
      }

      throw new Error(
        `Failed to fetch account info: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Get current transaction parameters
   */
  async getTransactionParams(): Promise<algosdk.SuggestedParams> {
    try {
      const params = await this.algodClient.getTransactionParams().do();
      return params;
    } catch (error) {
      console.error('Failed to fetch transaction params:', error);

      if (error instanceof NetworkError) {
        throw error;
      }

      throw new Error(
        `Failed to fetch transaction params: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Send a raw transaction
   */
  async sendRawTransaction(signedTxn: Uint8Array): Promise<string> {
    try {
      const response = await this.algodClient
        .sendRawTransaction(signedTxn)
        .do();
      const txId =
        (response as { txId?: string }).txId ??
        (response as { txid?: string }).txid ??
        (response as unknown as Record<string, unknown>).txID;

      if (!txId || typeof txId !== 'string') {
        throw new Error(
          'Transaction submission succeeded but no transaction ID was returned'
        );
      }

      return txId;
    } catch (error) {
      console.error('Failed to send transaction:', error);

      if (error instanceof NetworkError) {
        throw error;
      }

      throw new Error(
        `Failed to send transaction: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Wait for transaction confirmation
   */
  public async waitForConfirmation(txId: string, rounds = 4): Promise<any> {
    const roundsToWait = Math.max(rounds, 1);

    try {
      return await algosdk.waitForConfirmation(
        this.algodClient,
        txId,
        roundsToWait
      );
    } catch (error) {
      // Before surfacing the error, check whether the transaction actually confirmed
      try {
        const pendingInfo = await this.algodClient
          .pendingTransactionInformation(txId)
          .do();

        const confirmedRound = pendingInfo.confirmedRound;
        if (confirmedRound && Number(confirmedRound) > 0) {
          return pendingInfo;
        }

        const poolError = pendingInfo.poolError;
        if (typeof poolError === 'string' && poolError.length > 0) {
          throw new Error(`Transaction rejected: ${poolError}`);
        }
      } catch (pendingError) {
        console.warn(
          'Failed to inspect pending transaction after waitForConfirmation error:',
          pendingError
        );
      }

      if (error instanceof NetworkError) {
        throw error;
      }

      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to confirm transaction ${txId}: ${message}`);
    }
  }
}

export default NetworkService.getInstance();

// Backwards compatibility exports
export const VoiNetworkService = NetworkService;
