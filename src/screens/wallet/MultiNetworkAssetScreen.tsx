import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  RefreshControl,
  ScrollView,
  TouchableOpacity,
  Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRoute, useNavigation } from '@react-navigation/native';
import type { StackNavigationProp } from '@react-navigation/stack';
import { useThemedStyles, useThemeColors } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import { useAuth } from '@/contexts/AuthContext';
import {
  useWalletStore,
  useMultiNetworkBalance,
} from '@/store/walletStore';
import { formatNativeBalance, formatAssetBalance } from '@/utils/bigint';
import { formatCurrency } from '@/utils/formatting';
import { getNetworkConfig } from '@/services/network/config';
import { NetworkId } from '@/types/network';
import { BlurredContainer } from '@/components/common/BlurredContainer';
import { GlassCard } from '@/components/common/GlassCard';
import { NFTBackground } from '@/components/common/NFTBackground';
import { useTheme } from '@/contexts/ThemeContext';
import { GlassButton } from '@/components/common/GlassButton';
import UniversalHeader from '@/components/common/UniversalHeader';

interface MultiNetworkAssetRouteParams {
  assetName: string;
  assetId: number;
  accountId: string;
  mappingId?: string;
}

export default function MultiNetworkAssetScreen() {
  const styles = useThemedStyles(createStyles);
  const themeColors = useThemeColors();
  const { theme } = useTheme();
  const [refreshing, setRefreshing] = useState(false);
  const [imageError, setImageError] = useState(false);
  const route = useRoute();
  const navigation = useNavigation<StackNavigationProp<any>>();
  const { assetName, assetId, accountId, mappingId } =
    route.params as MultiNetworkAssetRouteParams;

  const { updateActivity } = useAuth();
  const { balance: multiNetworkBalance, reload: reloadMultiNetworkBalance } =
    useMultiNetworkBalance(accountId);
  const loadMultiNetworkBalance = useWalletStore(
    (state) => state.loadMultiNetworkBalance
  );

  useEffect(() => {
    updateActivity();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadMultiNetworkBalance(accountId);
    setRefreshing(false);
    updateActivity();
  }, [accountId, loadMultiNetworkBalance, updateActivity]);

  // Find the mapped asset - memoized to prevent re-computation on every render
  // Also handles single-network assets (isMapped can be false)
  const mappedAsset = useMemo(() => {
    return multiNetworkBalance?.assets.find(
      (a) =>
        mappingId
          ? a.mappingId === mappingId
          : a.assetId === assetId
    );
  }, [multiNetworkBalance?.assets, mappingId, assetId]);

  if (!mappedAsset) {
    return (
      <NFTBackground>
        <SafeAreaView style={styles.container} edges={['top']}>
          <UniversalHeader
            title="Asset Not Found"
            showBackButton
            onBackPress={() => navigation.goBack()}
            showAccountSelector={false}
            onAccountSelectorPress={() => {}}
          />
          <View style={styles.emptyContainer}>
            <Text style={styles.emptyText}>
              This asset could not be found in your balance.
            </Text>
          </View>
        </SafeAreaView>
      </NFTBackground>
    );
  }

  const calculateTotalUsdValue = useMemo(() => {
    if (!mappedAsset) return formatCurrency(0);

    let totalValue = 0;

    for (const source of mappedAsset.sourceBalances) {
      const sourceAsset = source.balance;

      // Check if this is a native asset
      if (sourceAsset.assetId === 0) {
        const price = multiNetworkBalance?.perNetworkPrices[source.networkId];
        if (price && sourceAsset.amount) {
          const amount =
            typeof sourceAsset.amount === 'bigint'
              ? Number(sourceAsset.amount)
              : sourceAsset.amount;
          const nativeValue = amount / 1_000_000;
          totalValue += nativeValue * price;
        }
      } else {
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

    return formatCurrency(totalValue);
  }, [mappedAsset, multiNetworkBalance?.perNetworkPrices]);

  const handleNetworkPress = useCallback((networkId: NetworkId, networkAssetId: number) => {
    // Navigate to AssetDetailScreen with specific network context
    navigation.navigate('AssetDetail', {
      assetName,
      assetId: networkAssetId,
      accountId,
      networkId,
      mappingId,
    });
  }, [navigation, assetName, accountId, mappingId]);

  const handleSend = useCallback(() => {
    // Pass mappingId so SendScreen can show all network options for this asset
    navigation.navigate('Send', {
      assetName,
      assetId,
      accountId,
      mappingId, // CRITICAL: Pass mappingId so SendScreen knows this is a multi-network asset
      networkId: mappedAsset?.primaryNetwork, // Default to primary network
    });
  }, [navigation, assetName, assetId, accountId, mappingId, mappedAsset?.primaryNetwork]);

  const handleReceive = useCallback(() => {
    // Navigate to Receive screen
    navigation.navigate('Receive', {
      assetName,
      assetId,
      accountId,
    });
  }, [navigation, assetName, assetId, accountId]);

  const assetImageSource = useMemo(() => {
    if (!mappedAsset) return null;

    // Check if we have a custom image URL first
    if (mappedAsset.imageUrl && !imageError) {
      return { type: 'uri' as const, uri: mappedAsset.imageUrl };
    }

    // For native tokens or if image failed, use primary network's token image
    if (mappedAsset.assetId === 0 || imageError) {
      const primaryNetworkConfig = getNetworkConfig(mappedAsset.primaryNetwork);
      return { type: 'source' as const, source: primaryNetworkConfig.nativeTokenImage };
    }

    return { type: 'placeholder' as const };
  }, [mappedAsset, imageError]);

  const renderAssetImage = useCallback(() => {
    if (!assetImageSource) return null;

    if (assetImageSource.type === 'uri') {
      return (
        <Image
          source={{ uri: assetImageSource.uri }}
          style={styles.assetImage}
          onError={() => setImageError(true)}
        />
      );
    }

    if (assetImageSource.type === 'source') {
      return (
        <Image
          source={assetImageSource.source}
          style={styles.assetImage}
        />
      );
    }

    // Default placeholder
    return (
      <View style={styles.placeholderIcon}>
        <Ionicons name="disc" size={32} color={themeColors.primary} />
      </View>
    );
  }, [assetImageSource, styles.assetImage, styles.placeholderIcon, themeColors.primary]);

  const formattedBalance = useMemo(() => {
    if (!mappedAsset) return '0';
    return formatAssetBalance(mappedAsset.amount, mappedAsset.decimals);
  }, [mappedAsset]);

  // Compute network subtitle for header
  const networkSubtitle = useMemo(() => {
    if (!mappedAsset || !mappedAsset.sourceBalances.length) return undefined;
    const uniqueNetworks = Array.from(new Set(mappedAsset.sourceBalances.map(s => s.networkId)));
    return uniqueNetworks
      .map((nid) => getNetworkConfig(nid).name
        .replace(' Network', '')
        .replace(' Mainnet', '')
        .replace(' Testnet', '')
        .trim())
      .join(' + ');
  }, [mappedAsset]);

  return (
    <NFTBackground>
      <SafeAreaView style={styles.container} edges={['top']}>
        <UniversalHeader
          title={assetName}
          subtitle={networkSubtitle}
          showBackButton
          onBackPress={() => navigation.goBack()}
          showAccountSelector={false}
          onAccountSelectorPress={() => {}}
        />

      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
        }
      >
        {/* Combined Balance Card */}
        <GlassCard
          style={styles.balanceContainer}
          variant="medium"
        >
          <View style={styles.assetHeader}>
            {renderAssetImage()}
            <View style={styles.assetTitleSection}>
              <View style={styles.assetNameRow}>
                <Text style={styles.assetTitle}>
                  {mappedAsset.name || assetName}
                </Text>
                {mappedAsset.verified === 1 && (
                  <View style={styles.verifiedBadge}>
                    <Ionicons
                      name="checkmark-circle"
                      size={18}
                      color={themeColors.success}
                    />
                  </View>
                )}
              </View>
              {mappedAsset.symbol && (
                <Text style={styles.assetSymbol}>{mappedAsset.symbol}</Text>
              )}
            </View>
          </View>

          <Text style={styles.balanceLabel}>Combined Balance</Text>
          <Text style={styles.balance}>
            {formattedBalance} {mappedAsset.symbol || assetName}
          </Text>
          <Text style={styles.balanceUsd}>{calculateTotalUsdValue} USD</Text>
        </GlassCard>

        {/* Per-Network Breakdown */}
        <BlurredContainer
          style={styles.networkBreakdownContainer}
          borderRadius={theme.borderRadius.lg}
          opacity={0.7}
        >
          <Text style={styles.networkBreakdownTitle}>
            Balances by Network
          </Text>
          <Text style={styles.networkBreakdownSubtitle}>
            Tap a network to view transactions
          </Text>

          {mappedAsset.sourceBalances.map((source, index) => {
            const networkConfig = getNetworkConfig(source.networkId);
            const sourceAsset = source.balance;
            const isNative = sourceAsset.assetId === 0;

            const balanceStr = isNative
              ? formatNativeBalance(
                  sourceAsset.amount,
                  networkConfig.nativeToken
                )
              : formatAssetBalance(sourceAsset.amount, sourceAsset.decimals);

            // Calculate USD value for this network
            let usdValue = 0;
            if (isNative) {
              const price =
                multiNetworkBalance?.perNetworkPrices[source.networkId];
              if (price && sourceAsset.amount) {
                const amount =
                  typeof sourceAsset.amount === 'bigint'
                    ? Number(sourceAsset.amount)
                    : sourceAsset.amount;
                usdValue = (amount / 1_000_000) * price;
              }
            } else {
              if (sourceAsset.usdValue && sourceAsset.amount) {
                const unitPrice = parseFloat(sourceAsset.usdValue);
                const amount =
                  typeof sourceAsset.amount === 'bigint'
                    ? Number(sourceAsset.amount)
                    : sourceAsset.amount;
                usdValue = (amount / 10 ** sourceAsset.decimals) * unitPrice;
              }
            }

            return (
              <TouchableOpacity
                key={`${source.networkId}-${sourceAsset.assetId}-${index}`}
                style={styles.networkBreakdownRow}
                onPress={() =>
                  handleNetworkPress(source.networkId, sourceAsset.assetId)
                }
              >
                <View style={styles.networkBreakdownLeft}>
                  <View
                    style={[
                      styles.networkBreakdownDot,
                      { backgroundColor: networkConfig.color },
                    ]}
                  />
                  <View style={styles.networkBreakdownInfo}>
                    <Text style={styles.networkBreakdownNetwork}>
                      {networkConfig.name}
                    </Text>
                    <Text style={styles.networkBreakdownAssetInfo}>
                      {sourceAsset.symbol ||
                        sourceAsset.name ||
                        `Asset ${sourceAsset.assetId}`}{' '}
                      • ID: {sourceAsset.assetId}
                    </Text>
                  </View>
                </View>
                <View style={styles.networkBreakdownRight}>
                  <View style={styles.networkBreakdownAmounts}>
                    <Text style={styles.networkBreakdownBalance}>
                      {balanceStr}
                    </Text>
                    <Text style={styles.networkBreakdownUsd}>
                      {formatCurrency(usdValue)}
                    </Text>
                  </View>
                  <Ionicons
                    name="chevron-forward"
                    size={16}
                    color={themeColors.textMuted}
                    style={styles.chevron}
                  />
                </View>
              </TouchableOpacity>
            );
          })}
        </BlurredContainer>

        {/* Action Buttons */}
        <View style={styles.actionButtonsContainer}>
          <GlassButton
            variant="secondary"
            size="md"
            icon="send"
            label="Send"
            tint="#007AFF"
            onPress={handleSend}
            style={styles.actionButton}
          />

          <GlassButton
            variant="secondary"
            size="md"
            icon="download"
            label="Receive"
            tint="#30D158"
            onPress={handleReceive}
            style={styles.actionButton}
          />
        </View>

        {/* Info Section - only show if asset is on multiple networks */}
        {mappedAsset.sourceBalances.length > 1 && (
          <BlurredContainer
            style={styles.infoContainer}
            borderRadius={theme.borderRadius.md}
            opacity={0.7}
          >
            <Ionicons
              name="information-circle-outline"
              size={20}
              color={themeColors.textSecondary}
            />
            <Text style={styles.infoText}>
              This asset is available on multiple networks. Tap a network above to
              view its transaction history and network-specific details.
            </Text>
          </BlurredContainer>
        )}
      </ScrollView>
      </SafeAreaView>
    </NFTBackground>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    container: {
      flex: 1,
    },
    scrollView: {
      flex: 1,
    },
    content: {
      paddingHorizontal: theme.spacing.sm,
      paddingVertical: theme.spacing.lg,
    },
    balanceContainer: {
      padding: theme.spacing.xl,
      marginBottom: theme.spacing.sm,
      alignItems: 'center',
    },
    assetHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: theme.spacing.lg,
      alignSelf: 'stretch',
    },
    assetImage: {
      width: 50,
      height: 50,
      borderRadius: 25,
      marginRight: theme.spacing.md,
    },
    placeholderIcon: {
      width: 50,
      height: 50,
      borderRadius: 25,
      backgroundColor: theme.colors.surface,
      justifyContent: 'center',
      alignItems: 'center',
      marginRight: theme.spacing.md,
    },
    assetTitleSection: {
      flex: 1,
    },
    assetNameRow: {
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: 4,
    },
    assetTitle: {
      fontSize: 20,
      fontWeight: '600',
      color: theme.colors.text,
      flex: 1,
    },
    verifiedBadge: {
      marginLeft: theme.spacing.xs,
    },
    assetSymbol: {
      fontSize: 14,
      color: theme.colors.textSecondary,
    },
    balanceLabel: {
      fontSize: 16,
      color: theme.colors.textSecondary,
      marginBottom: theme.spacing.xs,
    },
    balance: {
      fontSize: 32,
      fontWeight: 'bold',
      color: theme.colors.text,
      marginBottom: theme.spacing.xs,
      textAlign: 'center',
    },
    balanceUsd: {
      fontSize: 16,
      color: theme.colors.textMuted,
    },
    networkBreakdownContainer: {
      padding: theme.spacing.lg,
      marginBottom: theme.spacing.lg,
    },
    networkBreakdownTitle: {
      fontSize: 18,
      fontWeight: '600',
      color: theme.colors.text,
      marginBottom: theme.spacing.xs,
    },
    networkBreakdownSubtitle: {
      fontSize: 13,
      color: theme.colors.textSecondary,
      marginBottom: theme.spacing.md,
    },
    networkBreakdownRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingVertical: theme.spacing.md,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.borderLight,
    },
    networkBreakdownLeft: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.sm,
      flex: 1,
    },
    networkBreakdownDot: {
      width: 12,
      height: 12,
      borderRadius: 6,
    },
    networkBreakdownInfo: {
      flex: 1,
    },
    networkBreakdownNetwork: {
      fontSize: 15,
      fontWeight: '600',
      color: theme.colors.text,
      marginBottom: 2,
    },
    networkBreakdownAssetInfo: {
      fontSize: 12,
      color: theme.colors.textSecondary,
    },
    networkBreakdownRight: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: theme.spacing.sm,
    },
    networkBreakdownAmounts: {
      alignItems: 'flex-end',
      gap: 2,
    },
    networkBreakdownBalance: {
      fontSize: 15,
      fontWeight: '600',
      color: theme.colors.text,
    },
    networkBreakdownUsd: {
      fontSize: 12,
      color: theme.colors.textMuted,
    },
    chevron: {
      marginLeft: theme.spacing.xs,
    },
    actionButtonsContainer: {
      flexDirection: 'row',
      gap: theme.spacing.sm,
      marginBottom: theme.spacing.lg,
    },
    actionButton: {
      flex: 1,
    },
    infoContainer: {
      flexDirection: 'row',
      padding: theme.spacing.md,
      gap: theme.spacing.sm,
    },
    infoText: {
      flex: 1,
      fontSize: 13,
      color: theme.colors.textSecondary,
      lineHeight: 18,
    },
    emptyContainer: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      padding: theme.spacing.xl,
    },
    emptyText: {
      fontSize: 16,
      color: theme.colors.textSecondary,
      textAlign: 'center',
    },
  });
