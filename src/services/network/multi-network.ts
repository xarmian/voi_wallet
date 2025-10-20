import { NetworkId } from '@/types/network';
import { AccountBalance, AssetBalance } from '@/types/wallet';
import { NetworkService } from './index';
import {
  TokenMapping,
  MappedAsset,
  MultiNetworkBalance,
} from '../token-mapping/types';
import tokenMappingService from '../token-mapping';
import {
  normalizeAssetImageUrl,
  selectBestAssetImageUrl,
} from '@/utils/assetImages';

/**
 * Service for aggregating balances across multiple networks
 */
export class MultiNetworkBalanceService {
  /**
   * Get aggregated balance for an account across all supported networks
   */
  static async getAggregatedBalance(
    address: string,
    networks: NetworkId[] = [NetworkId.VOI_MAINNET, NetworkId.ALGORAND_MAINNET]
  ): Promise<MultiNetworkBalance> {
    try {
      // Fetch token mappings
      const tokenMappings = await tokenMappingService.getTokenMappings();

      // Fetch balances from all networks concurrently
      const balancePromises = networks.map(async (networkId) => {
        try {
          const networkService = NetworkService.getInstance(networkId);
          const balance = await networkService.getAccountBalance(address);
          return { networkId, balance, success: true };
        } catch (error) {
          console.warn(
            `[MultiNetworkBalanceService] Failed to fetch balance from ${networkId}:`,
            error
          );
          return { networkId, balance: null, success: false };
        }
      });

      const results = await Promise.allSettled(balancePromises);

      // Extract successful balances
      const networkBalances: Array<{
        networkId: NetworkId;
        balance: AccountBalance;
      }> = [];

      for (const result of results) {
        if (result.status === 'fulfilled' && result.value.success && result.value.balance) {
          networkBalances.push({
            networkId: result.value.networkId,
            balance: result.value.balance,
          });
        }
      }

      if (networkBalances.length === 0) {
        throw new Error('Failed to fetch balances from any network');
      }

      // Combine balances using token mappings
      const aggregated = this.combineBalances(
        networkBalances,
        tokenMappings,
        address
      );

      return aggregated;
    } catch (error) {
      console.error(
        '[MultiNetworkBalanceService] Failed to get aggregated balance:',
        error
      );
      throw error;
    }
  }

  /**
   * Combine balances from multiple networks into a single view
   */
  private static combineBalances(
    networkBalances: Array<{ networkId: NetworkId; balance: AccountBalance }>,
    tokenMappings: TokenMapping[],
    address: string
  ): MultiNetworkBalance {
    // Store per-network data for reference (but don't combine native tokens anymore)
    let minBalance = 0n;
    const perNetworkAmounts: Record<NetworkId, bigint> = {} as Record<
      NetworkId,
      bigint
    >;
    const perNetworkPrices: Record<NetworkId, number | undefined> = {} as Record<
      NetworkId,
      number | undefined
    >;

    const sourceNetworks: NetworkId[] = [];

    // Collect per-network data
    for (const { networkId, balance } of networkBalances) {
      sourceNetworks.push(networkId);

      const amount =
        typeof balance.amount === 'bigint'
          ? balance.amount
          : BigInt(balance.amount);
      const minBal =
        typeof balance.minBalance === 'bigint'
          ? balance.minBalance
          : BigInt(balance.minBalance);

      minBalance += minBal;
      perNetworkAmounts[networkId] = amount;

      // Store price data
      if (networkId === NetworkId.VOI_MAINNET) {
        perNetworkPrices[networkId] = balance.voiPrice;
      } else if (networkId === NetworkId.ALGORAND_MAINNET) {
        perNetworkPrices[networkId] = balance.algoPrice;
      }
    }

    // Combine assets using mappings (native tokens are now included)
    const combinedAssets = this.combineAssets(networkBalances, tokenMappings);

    return {
      address,
      combinedAmount: 0n, // Deprecated - use assets array instead
      minBalance,
      assets: combinedAssets,
      sourceNetworks,
      perNetworkAmounts,
      perNetworkPrices,
      timestamp: Date.now(),
    };
  }

  /**
   * Combine assets from multiple networks, merging all tokens in the same mapping
   * into a single display item
   */
  private static combineAssets(
    networkBalances: Array<{ networkId: NetworkId; balance: AccountBalance }>,
    tokenMappings: TokenMapping[]
  ): MappedAsset[] {
    const mappedAssets = new Map<string, MappedAsset>();
    const unmappedAssets: MappedAsset[] = [];

    // Process each network's assets
    for (const { networkId, balance } of networkBalances) {
      // Create a list of all assets including the native token (assetId 0)
      const allAssets: AssetBalance[] = [];

      // Add native token as an asset
      if (balance.amount !== undefined) {
        const nativePrice = balance.voiPrice || balance.algoPrice;
        allAssets.push({
          assetId: 0,
          amount: balance.amount,
          decimals: 6,
          name: networkId === NetworkId.VOI_MAINNET ? 'VOI' : 'ALGO',
          symbol: networkId === NetworkId.VOI_MAINNET ? 'VOI' : 'ALGO',
          assetType: 'asa',
          usdValue: nativePrice ? nativePrice.toString() : undefined,
        });
      }

      // Add all other assets
      if (balance.assets && balance.assets.length > 0) {
        allAssets.push(...balance.assets);
      }

      for (const asset of allAssets) {
        // Find if this asset is part of a mapping
        const mapping = this.findMappingForAsset(
          asset.assetId,
          networkId,
          tokenMappings
        );

        if (mapping) {
          // This asset is mapped - merge ALL tokens in the same mapping
          const mappingId = mapping.mappingId;

          // Check if we already have an entry for this mapping
          if (mappedAssets.has(mappingId)) {
            // Add this asset's balance to the existing mapped asset
            const existing = mappedAssets.get(mappingId)!;
            existing.sourceBalances.push({
              networkId,
              balance: asset,
            });

            // Update combined amount (if they have same decimals)
            // Note: Different assets in mapping may have different decimals, so only combine if matching
            if (existing.decimals === asset.decimals) {
              const existingAmount =
                typeof existing.amount === 'bigint'
                  ? existing.amount
                  : BigInt(existing.amount);
              const assetAmount =
                typeof asset.amount === 'bigint'
                  ? asset.amount
                  : BigInt(asset.amount);
              existing.amount = existingAmount + assetAmount;
            }
          } else {
            // Create new mapped asset entry using mapping info
            // Use the mapping name and first token's details as the display values
            const mappedAsset: MappedAsset = {
              ...asset,
              name: mapping.name, // Use mapping name (e.g., "USDC") instead of asset name
              symbol: mapping.name, // Use mapping name as symbol too for consistency
              mappingId: mapping.mappingId,
              sourceBalances: [{ networkId, balance: asset }],
              isMapped: true,
              verified: mapping.verified,
              primaryNetwork: networkId, // First network encountered is primary
            };
            mappedAssets.set(mappingId, mappedAsset);
          }
        } else {
          // This asset is not mapped, add as standalone
          const unmappedAsset: MappedAsset = {
            ...asset,
            sourceBalances: [{ networkId, balance: asset }],
            isMapped: false,
            primaryNetwork: networkId,
          };
          unmappedAssets.push(unmappedAsset);
        }
      }
    }

    // Normalize image URLs for mapped assets, preferring the best available option
    const mappedAssetList = Array.from(mappedAssets.values());
    for (const asset of mappedAssetList) {
      const candidateUrls = [
        asset.imageUrl,
        ...asset.sourceBalances.map((source) => source.balance.imageUrl),
      ];
      asset.imageUrl = selectBestAssetImageUrl(candidateUrls);
    }

    // Normalize image URLs for unmapped assets as well
    for (const asset of unmappedAssets) {
      asset.imageUrl = normalizeAssetImageUrl(asset.imageUrl);
    }

    // Combine mapped and unmapped assets
    const allAssets = [...mappedAssetList, ...unmappedAssets];

    // Sort by USD value (descending) for better UX
    return allAssets.sort((a, b) => {
      const aValue = this.calculateTotalUsdValue(a);
      const bValue = this.calculateTotalUsdValue(b);
      return bValue - aValue;
    });
  }

  /**
   * Find the mapping that contains a specific asset
   */
  private static findMappingForAsset(
    assetId: number,
    networkId: NetworkId,
    tokenMappings: TokenMapping[]
  ): TokenMapping | null {
    return (
      tokenMappings.find((mapping) =>
        mapping.tokens.some(
          (token) => token.assetId === assetId && token.networkId === networkId
        )
      ) || null
    );
  }

  /**
   * Calculate total USD value for a mapped asset across all networks
   */
  private static calculateTotalUsdValue(asset: MappedAsset): number {
    let totalValue = 0;

    for (const source of asset.sourceBalances) {
      const sourceAsset = source.balance;
      if (sourceAsset.usdValue && sourceAsset.amount) {
        const unitPrice = parseFloat(sourceAsset.usdValue);
        const amount =
          typeof sourceAsset.amount === 'bigint'
            ? Number(sourceAsset.amount)
            : sourceAsset.amount;
        const normalizedBalance = amount / 10 ** sourceAsset.decimals;
        totalValue += normalizedBalance * unitPrice;
      }
    }

    return totalValue;
  }

  /**
   * Get balance for a specific mapped asset across networks
   */
  static async getMappedAssetBalance(
    address: string,
    mappingId: string
  ): Promise<MappedAsset | null> {
    try {
      const aggregatedBalance = await this.getAggregatedBalance(address);
      return (
        aggregatedBalance.assets.find(
          (asset) => asset.mappingId === mappingId
        ) || null
      );
    } catch (error) {
      console.error(
        '[MultiNetworkBalanceService] Failed to get mapped asset balance:',
        error
      );
      return null;
    }
  }

  /**
   * Get all mapped assets for an account (excluding non-mapped assets)
   */
  static async getMappedAssetsOnly(
    address: string
  ): Promise<MappedAsset[]> {
    try {
      const aggregatedBalance = await this.getAggregatedBalance(address);
      return aggregatedBalance.assets.filter((asset) => asset.isMapped);
    } catch (error) {
      console.error(
        '[MultiNetworkBalanceService] Failed to get mapped assets:',
        error
      );
      return [];
    }
  }

  /**
   * Check if an account has any assets on multiple networks
   */
  static async hasMultiNetworkAssets(address: string): Promise<boolean> {
    try {
      const aggregatedBalance = await this.getAggregatedBalance(address);
      return aggregatedBalance.sourceNetworks.length > 1;
    } catch (error) {
      console.error(
        '[MultiNetworkBalanceService] Failed to check multi-network assets:',
        error
      );
      return false;
    }
  }
}
