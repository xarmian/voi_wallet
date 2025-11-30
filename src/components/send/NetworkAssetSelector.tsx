import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView, Image } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { NetworkId } from '@/types/network';
import { getNetworkConfig } from '@/services/network/config';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import { formatAssetBalance } from '@/utils/bigint';
import { normalizeAssetImageUrl } from '@/utils/assetImages';
import { BlurredContainer } from '@/components/common/BlurredContainer';

interface AssetOption {
  networkId: NetworkId;
  assetId: number;
  balance: bigint;
  decimals: number;
  symbol: string;
  name: string;
  imageUrl?: string;
}

interface NetworkAssetSelectorProps {
  tokenName: string; // e.g., "USDC" - the general token name
  options: AssetOption[];
  selectedAssetId?: number;
  selectedNetworkId?: NetworkId;
  onSelect: (networkId: NetworkId, assetId: number) => void;
  disabled?: boolean;
}

export default function NetworkAssetSelector({
  tokenName,
  options,
  selectedAssetId,
  selectedNetworkId,
  onSelect,
  disabled = false,
}: NetworkAssetSelectorProps) {
  const styles = useThemedStyles(createStyles);
  const [imageError, setImageError] = useState(false);

  if (options.length === 0) {
    return null;
  }

  // Render asset image with fallback
  const renderAssetImage = (option: AssetOption) => {
    const config = getNetworkConfig(option.networkId);

    // For native tokens (assetId 0), use network's native token image
    if (option.assetId === 0) {
      return (
        <Image
          source={config.nativeTokenImage}
          style={styles.singleOptionImage}
        />
      );
    }

    const normalizedImageUrl = normalizeAssetImageUrl(option.imageUrl);

    if (!normalizedImageUrl || imageError) {
      return (
        <View style={styles.singleOptionPlaceholder}>
          <Ionicons
            name="disc"
            size={24}
            color={styles.singleOptionPlaceholder.color}
          />
        </View>
      );
    }

    return (
      <Image
        source={{ uri: normalizedImageUrl }}
        style={styles.singleOptionImage}
        onError={() => setImageError(true)}
      />
    );
  };

  // If only one option, show enhanced card
  if (options.length === 1) {
    const option = options[0];
    const config = getNetworkConfig(option.networkId);

    return (
      <BlurredContainer
        variant="light"
        borderRadius={styles.singleOptionCard.borderRadius}
        style={styles.singleOptionCard}
      >
        {renderAssetImage(option)}
        <View style={styles.singleOptionContent}>
          <View style={styles.singleOptionHeader}>
            <Text style={styles.singleOptionName}>{option.name}</Text>
            <View style={styles.singleOptionNetworkBadge}>
              <View style={[styles.networkDot, { backgroundColor: config.color }]} />
              <Text style={styles.singleOptionNetworkName}>
                {config.name.replace(' Network', '').replace(' Mainnet', '')}
              </Text>
            </View>
          </View>
          <View style={styles.singleOptionBalanceRow}>
            <Text style={styles.singleOptionSymbol}>{option.symbol}</Text>
            <Text style={styles.singleOptionBalance}>
              {formatAssetBalance(option.balance, option.decimals)} {option.symbol}
            </Text>
          </View>
          {option.assetId !== 0 && (
            <Text style={styles.singleOptionAssetId}>ID: {option.assetId}</Text>
          )}
        </View>
      </BlurredContainer>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.label}>Select Asset</Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
      >
        {options.map((option) => {
          const config = getNetworkConfig(option.networkId);
          const isSelected = option.assetId === selectedAssetId && option.networkId === selectedNetworkId;

          return (
            <TouchableOpacity
              key={`${option.networkId}-${option.assetId}`}
              onPress={() => !disabled && onSelect(option.networkId, option.assetId)}
              disabled={disabled}
              activeOpacity={0.7}
              style={disabled ? styles.cardDisabled : undefined}
            >
              <BlurredContainer
                variant={isSelected ? 'medium' : 'light'}
                borderRadius={styles.card.borderRadius}
                style={[
                  styles.card,
                  isSelected && styles.cardSelected,
                ]}
              >
                <View style={styles.cardHeader}>
                  <View style={[styles.networkDot, { backgroundColor: config.color }]} />
                  <Text style={[styles.networkName, !isSelected && styles.networkNameMuted]}>
                    {config.name.replace(' Network', '').replace(' Mainnet', '')}
                  </Text>
                </View>

                <Text style={[styles.assetName, !isSelected && styles.assetNameMuted]}>
                  {option.name}
                </Text>

                <Text style={[styles.balance, !isSelected && styles.balanceMuted]}>
                  {formatAssetBalance(option.balance, option.decimals)} {option.symbol}
                </Text>

                <Text style={[styles.assetId, !isSelected && styles.assetIdMuted]}>
                  ID: {option.assetId}
                </Text>
              </BlurredContainer>
            </TouchableOpacity>
          );
        })}
      </ScrollView>
    </View>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    container: {
      marginBottom: theme.spacing.lg,
    },
    label: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.text,
      marginBottom: theme.spacing.sm,
      // Text shadow for readability over NFT backgrounds
      textShadowColor: theme.mode === 'dark'
        ? 'rgba(0, 0, 0, 0.8)'
        : 'rgba(255, 255, 255, 0.9)',
      textShadowOffset: { width: 0, height: 0 },
      textShadowRadius: 10,
    },
    scrollContent: {
      gap: theme.spacing.sm,
      paddingRight: theme.spacing.md,
    },
    card: {
      borderWidth: 2,
      borderColor: 'transparent',
      borderRadius: theme.borderRadius.md,
      padding: theme.spacing.md,
      minWidth: 140,
    },
    cardSelected: {
      borderColor: theme.colors.primary,
    },
    cardDisabled: {
      opacity: 0.5,
    },
    cardHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: theme.spacing.sm,
      gap: theme.spacing.xs,
    },
    networkDot: {
      width: 8,
      height: 8,
      borderRadius: 4,
    },
    networkName: {
      fontSize: 10,
      fontWeight: '600',
      color: theme.colors.primary,
      textTransform: 'uppercase',
    },
    networkNameMuted: {
      color: theme.colors.textMuted,
    },
    assetName: {
      fontSize: 14,
      fontWeight: '600',
      color: theme.colors.text,
      marginBottom: 4,
    },
    assetNameMuted: {
      color: theme.colors.textSecondary,
    },
    balance: {
      fontSize: 16,
      fontWeight: 'bold',
      color: theme.colors.text,
      marginBottom: theme.spacing.xs,
    },
    balanceMuted: {
      color: theme.colors.textSecondary,
    },
    assetId: {
      fontSize: 10,
      color: theme.colors.textSecondary,
    },
    assetIdMuted: {
      color: theme.colors.textMuted,
    },
    // Single option card styles
    singleOptionCard: {
      flexDirection: 'row',
      alignItems: 'center',
      borderRadius: theme.borderRadius.md,
      padding: theme.spacing.md,
      marginBottom: theme.spacing.lg,
      gap: theme.spacing.md,
    },
    singleOptionImage: {
      width: 48,
      height: 48,
      borderRadius: 24,
    },
    singleOptionPlaceholder: {
      width: 48,
      height: 48,
      borderRadius: 24,
      backgroundColor: theme.mode === 'dark'
        ? 'rgba(255, 255, 255, 0.12)'
        : 'rgba(255, 255, 255, 0.6)',
      justifyContent: 'center',
      alignItems: 'center',
      color: theme.colors.primary,
    },
    singleOptionContent: {
      flex: 1,
    },
    singleOptionHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: theme.spacing.xs,
    },
    singleOptionName: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.text,
      flex: 1,
    },
    singleOptionNetworkBadge: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.xs,
      backgroundColor: theme.mode === 'dark'
        ? 'rgba(255, 255, 255, 0.12)'
        : 'rgba(255, 255, 255, 0.6)',
      paddingHorizontal: theme.spacing.sm,
      paddingVertical: 4,
      borderRadius: theme.borderRadius.sm,
    },
    singleOptionNetworkName: {
      fontSize: 10,
      fontWeight: '600',
      color: theme.colors.textSecondary,
      textTransform: 'uppercase',
    },
    singleOptionBalanceRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: 4,
    },
    singleOptionSymbol: {
      fontSize: 14,
      color: theme.colors.textSecondary,
    },
    singleOptionBalance: {
      fontSize: 16,
      fontWeight: 'bold',
      color: theme.colors.text,
    },
    singleOptionAssetId: {
      fontSize: 10,
      color: theme.colors.textMuted,
    },
  });
