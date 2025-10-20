import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Image } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { AssetBalance } from '@/types/wallet';
import { formatAssetBalance, formatNativeBalance } from '@/utils/bigint';
import { formatCurrency } from '@/utils/formatting';
import { useCurrentNetworkConfig } from '@/store/networkStore';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import { normalizeAssetImageUrl } from '@/utils/assetImages';

interface AssetItemProps {
  asset: AssetBalance;
  isNative?: boolean;
  nativePrice?: number;
  onPress: () => void;
}

export default function AssetItem({
  asset,
  isNative = false,
  nativePrice,
  onPress,
}: AssetItemProps) {
  const [imageError, setImageError] = useState(false);
  const currentNetworkConfig = useCurrentNetworkConfig();
  const styles = useThemedStyles(createStyles);

  const formatBalance = () => {
    if (isNative) {
      return formatNativeBalance(
        asset.amount,
        currentNetworkConfig.nativeToken
      );
    }
    return formatAssetBalance(asset.amount, asset.decimals);
  };

  const getAssetName = () => {
    if (isNative) return currentNetworkConfig.nativeToken;
    return (
      asset.name || asset.unitName || asset.symbol || `Asset ${asset.assetId}`
    );
  };

  const getAssetSymbol = () => {
    if (isNative) return currentNetworkConfig.nativeToken;
    return asset.symbol || asset.unitName || `${asset.assetId}`;
  };

  const calculateAssetUsdValue = () => {
    if (!asset.usdValue || !asset.amount) return '--';

    const unitPrice = parseFloat(asset.usdValue);
    const amount =
      typeof asset.amount === 'bigint' ? Number(asset.amount) : asset.amount;
    const normalizedBalance = amount / 10 ** asset.decimals;
    const totalUsdValue = normalizedBalance * unitPrice;

    return formatCurrency(totalUsdValue);
  };

  const calculateNativeUsdValue = () => {
    if (!nativePrice || !asset.amount) return formatCurrency(0);

    const amount =
      typeof asset.amount === 'bigint' ? Number(asset.amount) : asset.amount;
    const nativeValue = amount / 1_000_000; // Convert microVOI/microALGO to VOI/ALGO
    const usdValue = nativeValue * nativePrice;

    return formatCurrency(usdValue);
  };

  const renderAssetImage = () => {
    // Use network-specific native token image
    if (isNative) {
      return (
        <Image
          source={currentNetworkConfig.nativeTokenImage}
          style={styles.assetImage}
        />
      );
    }

    const normalizedImageUrl = normalizeAssetImageUrl(asset.imageUrl);

    if (!normalizedImageUrl || imageError) {
      return (
        <View style={styles.placeholderIcon}>
          <Ionicons
            name="disc"
            size={24}
            color={styles.placeholderIcon.color}
          />
        </View>
      );
    }

    return (
      <Image
        source={{ uri: normalizedImageUrl }}
        style={styles.assetImage}
        onError={() => setImageError(true)}
      />
    );
  };

  return (
    <TouchableOpacity style={styles.container} onPress={onPress}>
      <View style={styles.leftSection}>
        {renderAssetImage()}
        <View style={styles.assetInfo}>
          <View style={styles.assetNameRow}>
            <Text style={styles.assetName} numberOfLines={1}>
              {getAssetName()}
            </Text>
          </View>
          <View style={styles.assetDetailsRow}>
            <Text style={styles.assetSymbol} numberOfLines={1}>
              {getAssetSymbol()}
            </Text>
            <View style={styles.balanceColumn}>
              <Text style={styles.assetBalance} numberOfLines={1}>
                {formatBalance()}
              </Text>
              <Text style={styles.assetUsdValue} numberOfLines={1}>
                {isNative
                  ? calculateNativeUsdValue()
                  : calculateAssetUsdValue()}
              </Text>
            </View>
          </View>
        </View>
      </View>

      <View style={styles.rightSection}>
        <Ionicons
          name="chevron-forward"
          size={16}
          color={styles.chevron.color}
        />
      </View>
    </TouchableOpacity>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    container: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingVertical: 12,
      paddingHorizontal: 4,
      borderRadius: theme.borderRadius.sm,
    },
    leftSection: {
      flexDirection: 'row',
      alignItems: 'center',
      flex: 1,
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
      marginRight: 8,
    },
    assetNameRow: {
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: 2,
    },
    assetName: {
      fontSize: 16,
      fontWeight: '500',
      color: theme.colors.text,
      flex: 1,
    },
    assetDetailsRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'flex-start',
    },
    assetSymbol: {
      fontSize: 14,
      color: theme.colors.textSecondary,
      flex: 1,
    },
    balanceColumn: {
      alignItems: 'flex-end',
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
      marginTop: 1,
    },
    rightSection: {
      justifyContent: 'center',
      alignItems: 'center',
      paddingLeft: 8,
    },
    chevron: {
      color: theme.colors.textMuted,
    },
  });
