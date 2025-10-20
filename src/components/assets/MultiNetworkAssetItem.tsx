import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Image } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { MappedAsset } from '@/services/token-mapping/types';
import { formatAssetBalance, formatNativeBalance } from '@/utils/bigint';
import { formatCurrency } from '@/utils/formatting';
import { getNetworkConfig } from '@/services/network/config';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import { NetworkId } from '@/types/network';
import {
  normalizeAssetImageUrl,
  selectBestAssetImageUrl,
} from '@/utils/assetImages';

interface MultiNetworkAssetItemProps {
  asset: MappedAsset;
  nativePrices: Record<NetworkId, number | undefined>;
  networkFilter?: 'all' | 'voi' | 'algorand';
  onPress: () => void;
}

export default function MultiNetworkAssetItem({
  asset,
  nativePrices,
  networkFilter = 'all',
  onPress,
}: MultiNetworkAssetItemProps) {
  const [imageError, setImageError] = useState(false);
  const styles = useThemedStyles(createStyles);

  useEffect(() => {
    setImageError(false);
  }, [asset.mappingId, asset.assetId, asset.imageUrl]);

  // Filter source balances based on network filter
  const getFilteredSourceBalances = () => {
    if (networkFilter === 'all') {
      return asset.sourceBalances;
    }

    const targetNetworkId = networkFilter === 'voi'
      ? NetworkId.VOI_MAINNET
      : NetworkId.ALGORAND_MAINNET;

    return asset.sourceBalances.filter(source => source.networkId === targetNetworkId);
  };

  const formatBalance = () => {
    const filteredBalances = getFilteredSourceBalances();

    // Calculate total amount across filtered networks
    let totalAmount = 0;
    filteredBalances.forEach(source => {
      const amount = typeof source.balance.amount === 'bigint'
        ? Number(source.balance.amount)
        : source.balance.amount;
      totalAmount += amount;
    });

    // Format based on decimals (works for both native and non-native assets)
    return formatAssetBalance(totalAmount, asset.decimals);
  };

  const getAssetName = () => {
    // Use the asset name from the mapping if available (including for native tokens)
    return asset.name || asset.unitName || asset.symbol || `Asset ${asset.assetId}`;
  };

  const getAssetSymbol = () => {
    // Use the asset symbol from the mapping if available (including for native tokens)
    return asset.symbol || asset.unitName || `${asset.assetId}`;
  };

  const calculateTotalUsdValue = () => {
    const filteredBalances = getFilteredSourceBalances();
    let totalValue = 0;

    for (const source of filteredBalances) {
      const sourceAsset = source.balance;

      // Check if this is a native asset
      if (sourceAsset.assetId === 0) {
        const price = nativePrices[source.networkId];
        if (price && sourceAsset.amount) {
          const amount =
            typeof sourceAsset.amount === 'bigint'
              ? Number(sourceAsset.amount)
              : sourceAsset.amount;
          const nativeValue = amount / 1_000_000; // Convert micro-units
          totalValue += nativeValue * price;
        }
      } else {
        // Non-native asset with usdValue
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
    }

    return totalValue > 0 ? formatCurrency(totalValue) : '--';
  };

  const renderAssetImage = () => {
    const normalizedPrimaryImageUrl = normalizeAssetImageUrl(asset.imageUrl);

    // Check if we have a primary image URL first
    if (normalizedPrimaryImageUrl && !imageError) {
      return (
        <Image
          source={{ uri: normalizedPrimaryImageUrl }}
          style={styles.assetImage}
          onError={() => setImageError(true)}
        />
      );
    }

    // For mapped assets, check if any source balance has an imageUrl
    if (asset.isMapped && asset.sourceBalances.length > 0) {
      const fallbackImageUrl = selectBestAssetImageUrl(
        asset.sourceBalances
          .map((source) => source.balance.imageUrl)
          .filter((url) => url && url !== asset.imageUrl)
      );

      if (fallbackImageUrl && fallbackImageUrl !== normalizedPrimaryImageUrl) {
        return (
          <Image
            source={{ uri: fallbackImageUrl }}
            style={styles.assetImage}
            onError={() => setImageError(true)}
          />
        );
      }
    }

    // For assets with assetId 0 (native tokens), try to show the network's token image
    // This handles cases where native tokens don't have a custom imageUrl
    if (asset.assetId === 0 || (asset.isMapped && asset.sourceBalances.some(s => s.balance.assetId === 0))) {
      // For mapped native tokens, use the primary network's icon as fallback
      const primaryNetworkConfig = getNetworkConfig(asset.primaryNetwork);
      return (
        <Image
          source={primaryNetworkConfig.nativeTokenImage}
          style={styles.assetImage}
        />
      );
    }

    // Default placeholder for other assets without images
    return (
      <View style={styles.placeholderIcon}>
        <Ionicons
          name="disc"
          size={24}
          color={styles.placeholderIcon.color}
        />
      </View>
    );
  };

  const renderNetworkBadges = () => {
    // Use filtered source balances
    const filteredBalances = getFilteredSourceBalances();
    const networks = filteredBalances.length > 0
      ? filteredBalances
      : [{ networkId: asset.primaryNetwork, balance: asset }];

    // Deduplicate networks - only show each network once
    const uniqueNetworks = Array.from(new Set(networks.map(n => n.networkId)));

    return (
      <View style={styles.networkBadgesContainer}>
        {uniqueNetworks.map((networkId) => {
          const networkConfig = getNetworkConfig(networkId);
          // Shorten network name - remove "Network" and other long suffixes
          const shortName = networkConfig.name
            .replace(' Network', '')
            .replace(' Mainnet', '')
            .replace(' Testnet', '')
            .trim();
          return (
            <View
              key={networkId}
              style={[
                styles.networkBadgePill,
                { backgroundColor: networkConfig.color },
              ]}
            >
              <Text style={styles.networkBadgeText}>{shortName}</Text>
            </View>
          );
        })}
      </View>
    );
  };

  // Always navigate to detail screen on press
  const handlePress = () => {
    onPress();
  };

  return (
    <View style={styles.wrapper}>
      <TouchableOpacity style={styles.container} onPress={handlePress}>
        {renderAssetImage()}
        <View style={styles.assetInfo}>
          {/* Line 1: Asset Name + Chevron */}
          <View style={styles.row}>
            <Text style={styles.assetName} numberOfLines={1}>
              {getAssetName()}
            </Text>
            <Ionicons
              name="chevron-forward"
              size={16}
              color={styles.chevron.color}
            />
          </View>

          {/* Line 2: Symbol (left) + Amount (right) */}
          <View style={styles.row}>
            <Text style={styles.assetSymbol} numberOfLines={1}>
              {getAssetSymbol()}
            </Text>
            <Text style={styles.assetBalance} numberOfLines={1}>
              {formatBalance()}
            </Text>
          </View>

          {/* Line 3: Network Pills (left) + USD Value (right) */}
          <View style={styles.row}>
            {renderNetworkBadges()}
            <Text style={styles.assetUsdValue} numberOfLines={1}>
              {calculateTotalUsdValue()}
            </Text>
          </View>
        </View>
      </TouchableOpacity>
    </View>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    wrapper: {
      marginBottom: 4,
    },
    container: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 12,
      paddingHorizontal: 4,
      borderRadius: theme.borderRadius.sm,
    },
    assetImage: {
      width: 40,
      height: 40,
      borderRadius: 20,
      marginRight: 12,
    },
    placeholderIcon: {
      width: 40,
      height: 40,
      borderRadius: 20,
      backgroundColor: theme.colors.surface,
      justifyContent: 'center',
      alignItems: 'center',
      marginRight: 12,
      color: theme.colors.primary,
    },
    assetInfo: {
      flex: 1,
      minWidth: 0, // Allow text truncation
      gap: 4,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      minHeight: 20,
    },
    assetName: {
      fontSize: 16,
      fontWeight: '500',
      color: theme.colors.text,
      flex: 1,
    },
    assetSymbol: {
      fontSize: 14,
      color: theme.colors.textSecondary,
      flex: 1,
    },
    assetBalance: {
      fontSize: 16,
      fontWeight: '500',
      color: theme.colors.text,
      textAlign: 'right',
    },
    assetUsdValue: {
      fontSize: 12,
      color: theme.colors.textMuted,
      textAlign: 'right',
    },
    networkBadgesContainer: {
      flexDirection: 'row',
      gap: 4,
      flexWrap: 'wrap',
      flex: 1,
    },
    networkBadgePill: {
      paddingHorizontal: 6,
      paddingVertical: 2,
      borderRadius: 10,
    },
    networkBadgeText: {
      fontSize: 10,
      fontWeight: '600',
      color: '#FFFFFF',
      textTransform: 'uppercase',
    },
    chevron: {
      color: theme.colors.textMuted,
    },
  });
