import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  RefreshControl,
  ScrollView,
  TouchableOpacity,
  Image,
  Alert,
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
  useActiveAccount,
} from '@/store/walletStore';
import { formatNativeBalance, formatAssetBalance } from '@/utils/bigint';
import { formatCurrency } from '@/utils/formatting';
import { getNetworkConfig } from '@/services/network/config';
import { NetworkId } from '@/types/network';
import { SwapService } from '@/services/swap';
import { submitAsaOptIn, validateAsaOptIn } from '@/services/transactions/asa';
import tokenMappingService from '@/services/token-mapping';
import { TokenReference, NetworkBalanceSource } from '@/services/token-mapping/types';
import { NetworkService } from '@/services/network';
import UnifiedAuthModal from '@/components/UnifiedAuthModal';
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

type NetworkRowItem =
  | { type: 'balance'; source: NetworkBalanceSource }
  | { type: 'opt-in'; token: TokenReference };

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
  const activeAccount = useActiveAccount();

  // Opt-in flow state
  const [optInPending, setOptInPending] = useState<{
    assetId: number;
    networkId: NetworkId;
    symbol: string;
  } | null>(null);
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [isOptingIn, setIsOptingIn] = useState(false);

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

  // Check if swap is available on any network this asset exists on
  // NOTE: Must be defined AFTER mappedAsset
  const isSwappable = useMemo(() => {
    if (!mappedAsset) return false;
    return mappedAsset.sourceBalances.some(
      (source) => SwapService.isSwapAvailable(source.networkId)
    );
  }, [mappedAsset]);

  // Compute Algorand tokens that user could opt into (but hasn't yet)
  const missingAlgorandOptIns = useMemo(() => {
    if (!mappedAsset || !mappedAsset.mappingId) return [];

    // Get the full token mapping for this asset
    const mapping = tokenMappingService.getMappingForToken(
      mappedAsset.assetId,
      mappedAsset.primaryNetwork
    );

    if (!mapping) return [];

    // Find Algorand tokens in the mapping
    const algorandTokens = mapping.tokens.filter(
      (t) => t.networkId === NetworkId.ALGORAND_MAINNET
    );

    // Check which ones are NOT in sourceBalances (i.e., not opted in)
    const existingAlgorandAssetIds = mappedAsset.sourceBalances
      .filter((s) => s.networkId === NetworkId.ALGORAND_MAINNET)
      .map((s) => s.balance.assetId);

    // Return Algorand tokens that user hasn't opted into
    return algorandTokens.filter(
      (t) => !existingAlgorandAssetIds.includes(t.assetId)
    );
  }, [mappedAsset]);

  // Compute Voi tokens that user could opt into (but hasn't yet)
  // Limited to specific whitelisted tokens: aALGO (302189) and aUSDC (302190)
  const ALLOWED_VOI_OPT_IN_ASSET_IDS = [302189, 302190];

  const missingVoiOptIns = useMemo(() => {
    if (!mappedAsset || !mappedAsset.mappingId) return [];

    // Get the full token mapping for this asset
    const mapping = tokenMappingService.getMappingForToken(
      mappedAsset.assetId,
      mappedAsset.primaryNetwork
    );

    if (!mapping) return [];

    // Find Voi tokens in the mapping that are in our whitelist
    const voiTokens = mapping.tokens.filter(
      (t) =>
        t.networkId === NetworkId.VOI_MAINNET &&
        ALLOWED_VOI_OPT_IN_ASSET_IDS.includes(t.assetId)
    );

    // Check which ones are NOT in sourceBalances (i.e., not opted in)
    const existingVoiAssetIds = mappedAsset.sourceBalances
      .filter((s) => s.networkId === NetworkId.VOI_MAINNET)
      .map((s) => s.balance.assetId);

    // Return Voi tokens that user hasn't opted into
    return voiTokens.filter((t) => !existingVoiAssetIds.includes(t.assetId));
  }, [mappedAsset]);

  // Combine balance rows with opt-in opportunity rows
  const allNetworkRows = useMemo((): NetworkRowItem[] => {
    if (!mappedAsset) return [];

    const balanceRows: NetworkRowItem[] = mappedAsset.sourceBalances.map(
      (source) => ({ type: 'balance' as const, source })
    );

    const algorandOptInRows: NetworkRowItem[] = missingAlgorandOptIns.map(
      (token) => ({
        type: 'opt-in' as const,
        token,
      })
    );

    const voiOptInRows: NetworkRowItem[] = missingVoiOptIns.map((token) => ({
      type: 'opt-in' as const,
      token,
    }));

    // Balance rows first, then opt-in opportunities (Algorand, then Voi)
    return [...balanceRows, ...algorandOptInRows, ...voiOptInRows];
  }, [mappedAsset, missingAlgorandOptIns, missingVoiOptIns]);

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

  const handleSwap = useCallback(() => {
    if (!mappedAsset) return;

    // Check if primary network supports swap, otherwise find first swappable network
    const primaryNetworkSwappable = SwapService.isSwapAvailable(mappedAsset.primaryNetwork);

    // Find the source balance for the target network
    const targetSource = primaryNetworkSwappable
      ? mappedAsset.sourceBalances.find((s) => s.networkId === mappedAsset.primaryNetwork)
      : mappedAsset.sourceBalances.find((source) => SwapService.isSwapAvailable(source.networkId));

    if (!targetSource) return;

    navigation.navigate('Swap', {
      assetName,
      assetId: targetSource.balance.assetId, // Use network-specific asset ID
      accountId,
      networkId: targetSource.networkId,
    });
  }, [navigation, assetName, accountId, mappedAsset]);

  const handleReceive = useCallback(() => {
    // Navigate to Receive screen
    navigation.navigate('Receive', {
      assetName,
      assetId,
      accountId,
    });
  }, [navigation, assetName, assetId, accountId]);

  // Opt-in handlers
  const handleOptInPress = useCallback(
    async (token: TokenReference) => {
      if (!activeAccount) return;

      // Validate opt-in is possible before showing auth modal
      const validation = await validateAsaOptIn(
        activeAccount.address,
        token.assetId,
        token.networkId
      );

      if (!validation.valid) {
        Alert.alert(
          'Cannot Opt In',
          validation.error || 'Unable to opt in to this asset'
        );
        return;
      }

      setOptInPending({
        assetId: token.assetId,
        networkId: token.networkId,
        symbol: token.symbol,
      });
      setShowAuthModal(true);
    },
    [activeAccount]
  );

  const handleAuthSuccess = useCallback(
    async (pin?: string) => {
      if (!optInPending || !activeAccount) return;

      setIsOptingIn(true);

      try {
        const txId = await submitAsaOptIn(
          optInPending.assetId,
          activeAccount.address,
          optInPending.networkId,
          pin
        );

        // Wait for confirmation
        const networkService = NetworkService.getInstance(optInPending.networkId);
        await networkService.waitForConfirmation(txId, 4);

        // Reload balances to update the UI
        await loadMultiNetworkBalance(accountId);

        setShowAuthModal(false);
        setOptInPending(null);

        Alert.alert(
          'Success',
          `Successfully opted into ${optInPending.symbol} on ${getNetworkConfig(optInPending.networkId).name}`
        );
      } catch (error: any) {
        Alert.alert('Error', `Failed to opt in: ${error.message}`);
        setShowAuthModal(false);
      } finally {
        setIsOptingIn(false);
      }
    },
    [optInPending, activeAccount, accountId, loadMultiNetworkBalance]
  );

  const handleAuthCancel = useCallback(() => {
    if (!isOptingIn) {
      setShowAuthModal(false);
      setOptInPending(null);
    }
  }, [isOptingIn]);

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

          {allNetworkRows.map((row, index) => {
            if (row.type === 'balance') {
              const source = row.source;
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
                  key={`balance-${source.networkId}-${sourceAsset.assetId}-${index}`}
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
            } else {
              // Opt-in row
              const token = row.token;
              const networkConfig = getNetworkConfig(token.networkId);

              return (
                <View
                  key={`optin-${token.networkId}-${token.assetId}-${index}`}
                  style={styles.networkBreakdownRow}
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
                        {token.symbol} • ID: {token.assetId}
                      </Text>
                    </View>
                  </View>
                  <View style={styles.networkBreakdownRight}>
                    <View style={styles.optInBadgeContainer}>
                      <View style={styles.notOptedInBadge}>
                        <Text style={styles.notOptedInText}>Not opted in</Text>
                      </View>
                      <TouchableOpacity
                        style={styles.optInButton}
                        onPress={() => handleOptInPress(token)}
                      >
                        <Text style={styles.optInButtonText}>Opt In</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                </View>
              );
            }
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

          {isSwappable && (
            <GlassButton
              variant="secondary"
              size="md"
              icon="swap-horizontal"
              label="Swap"
              tint="#AF52DE"
              onPress={handleSwap}
              style={styles.actionButton}
            />
          )}

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

      <UnifiedAuthModal
        visible={showAuthModal}
        onSuccess={handleAuthSuccess}
        onCancel={handleAuthCancel}
        title="Authorize Asset Opt-In"
        message={
          optInPending
            ? `Authenticate to opt into ${optInPending.symbol} on ${getNetworkConfig(optInPending.networkId).name}`
            : 'Authenticate to complete the opt-in'
        }
        purpose="sign_transaction"
        isProcessing={isOptingIn}
      />
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
    // Opt-in styles
    optInBadgeContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.sm,
    },
    notOptedInBadge: {
      backgroundColor: theme.colors.warning + '20',
      paddingHorizontal: theme.spacing.sm,
      paddingVertical: theme.spacing.xs,
      borderRadius: theme.borderRadius.sm,
    },
    notOptedInText: {
      fontSize: 12,
      color: theme.colors.warning,
      fontWeight: '500',
    },
    optInButton: {
      backgroundColor: theme.colors.primary,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.xs,
      borderRadius: theme.borderRadius.md,
    },
    optInButtonText: {
      fontSize: 13,
      color: theme.colors.buttonText,
      fontWeight: '600',
    },
  });
