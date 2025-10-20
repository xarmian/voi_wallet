import algosdk from 'algosdk';
import { AccountBalance, AssetBalance, TransactionInfo } from '@/types/wallet';
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
  private algodClient: algosdk.Algodv2;
  private indexerClient: algosdk.Indexer;
  private config: NetworkConfiguration;
  private networkStatus: NetworkStatus;
  private mimirService?: MimirApiService;

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

  async checkNetworkHealth(): Promise<NetworkStatus> {
    try {
      const [algodStatus, indexerHealth] = await Promise.allSettled([
        this.algodClient.status().do(),
        this.indexerClient.makeHealthCheck().do(),
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
          this.algodClient.accountInformation(address).do(),
          this.getMimirAssets(address),
          this.getPricingData(address),
          this.getAccountRekeyInfo(address),
        ]);

      if (accountInfo.status === 'rejected') {
        throw new Error(`Failed to fetch account info: ${accountInfo.reason}`);
      }

      const algodAssets: AssetBalance[] = [];
      if (accountInfo.value.assets) {
        for (const asset of accountInfo.value.assets) {
          try {
            const assetInfo = await this.algodClient
              .getAssetByID(Number(asset.assetId))
              .do();
            algodAssets.push({
              assetId: Number(asset.assetId),
              amount: asset.amount,
              decimals: assetInfo.params.decimals || 0,
              name: assetInfo.params.name,
              unitName: assetInfo.params.unitName,
              assetType: 'asa',
            });
          } catch (assetError) {
            console.warn(
              `Failed to fetch asset info for ${asset.assetId}:`,
              assetError
            );
            algodAssets.push({
              assetId: Number(asset.assetId),
              amount: asset.amount,
              decimals: 0,
              assetType: 'asa',
            });
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
            applicationId = txn.applicationTransaction.applicationId;
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
  ): Promise<{ transactions: TransactionInfo[]; nextToken?: string; hasMore: boolean }> {
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
          .txType('axfer')  // Filter by asset transfer transactions first
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
            const recipient = txn.assetTransferTransaction?.receiver ?? txn.sender;

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
      return await this.algodClient.getTransactionParams().do();
    } catch (error) {
      console.error('Failed to get suggested params:', error);
      throw new Error(
        `Failed to get network parameters: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  async submitTransaction(
    signedTxn: Uint8Array | Uint8Array[]
  ): Promise<string> {
    try {
      const res = await this.algodClient.sendRawTransaction(signedTxn).do();
      const txId =
        (res as unknown as { txId?: string; txid?: string }).txId ??
        (res as any).txid;
      // Wait for confirmation with a sane round limit to avoid returning before the tx is accepted
      await this.waitForConfirmationInternal(txId);
      return txId;
    } catch (error) {
      console.error('Failed to submit transaction:', error);
      throw new Error(
        `Transaction failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  private async waitForConfirmationInternal(txId: string): Promise<void> {
    try {
      // Wait up to 10 rounds for confirmation
      await algosdk.waitForConfirmation(this.algodClient, txId, 10);
    } catch (err) {
      // If confirmation wait fails, surface a soft warning but do not mask original submission success
      console.warn('Transaction submitted but confirmation wait failed:', err);
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
          ? this.mimirService.getArc200Transfers(address, undefined, undefined, limit)
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
   */
  async getAccountRekeyInfo(address: string): Promise<RekeyInfo> {
    try {
      if (!algosdk.isValidAddress(address)) {
        throw new Error('Invalid Algorand address');
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
        return { isRekeyed: false };
      }

      // If rekeyed, try to find when it was rekeyed by looking at recent transactions
      let rekeyedAt: number | undefined;
      try {
        const txnResponse = await this.indexerClient
          .lookupAccountTransactions(address)
          .txType('pay') // Rekey transactions are payment type with rekey-to field
          .limit(50)
          .do();

        // Look for the most recent transaction with rekey-to field
        if (txnResponse.transactions) {
          for (const txn of txnResponse.transactions) {
            if (txn['rekey-to'] === authAddress) {
              rekeyedAt = txn.roundTime ? txn.roundTime * 1000 : undefined;
              break;
            }
          }
        }
      } catch (error) {
        console.warn('Failed to fetch rekey timestamp:', error);
      }

      return {
        isRekeyed: true,
        authAddress,
        rekeyedAt,
      };
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
   * Get detailed information about an asset
   */
  async getAssetInfo(assetId: number): Promise<any> {
    try {
      const assetInfo = await this.algodClient.getAssetByID(assetId).do();
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
        (response as Record<string, unknown>).txID;

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

        const confirmedRound =
          pendingInfo['confirmed-round'] ?? pendingInfo['confirmedRound'];
        if (confirmedRound && Number(confirmedRound) > 0) {
          return pendingInfo;
        }

        const poolError = pendingInfo['pool-error'] ?? pendingInfo['poolError'];
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
