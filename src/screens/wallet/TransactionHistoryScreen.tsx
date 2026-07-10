import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  RefreshControl,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  ListRenderItem,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import type { StackNavigationProp } from '@react-navigation/stack';
import { TransactionInfo } from '@/types/wallet';
import { useAuth } from '@/contexts/AuthContext';
import {
  useActiveAccount,
  useAccountState,
  useWalletStore,
} from '@/store/walletStore';
import TransactionListItem from '@/components/transaction/TransactionListItem';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import { serializeTransactionForNavigation } from '@/utils/navigationParams';
import { BlurredContainer } from '@/components/common/BlurredContainer';
import { NFTBackground } from '@/components/common/NFTBackground';
import { useTheme } from '@/contexts/ThemeContext';
import { useCurrentNetwork } from '@/store/networkStore';

export default function TransactionHistoryScreen() {
  const [refreshing, setRefreshing] = useState(false);
  const navigation = useNavigation<StackNavigationProp<any>>();
  const styles = useThemedStyles(createStyles);
  const { theme } = useTheme();
  const currentNetwork = useCurrentNetwork();

  const { updateActivity } = useAuth();
  const activeAccount = useActiveAccount();
  const accountState = useAccountState(activeAccount?.id || '');
  const loadAllTransactions = useWalletStore(
    (state) => state.loadAllTransactions
  );
  const loadMoreTransactions = useWalletStore(
    (state) => state.loadMoreTransactions
  );
  const loadTokenMetadata = useWalletStore((state) => state.loadTokenMetadata);
  const getTokenMetadata = useWalletStore((state) => state.getTokenMetadata);
  const loadAssetMetadata = useWalletStore((state) => state.loadAssetMetadata);
  const getAssetMetadata = useWalletStore((state) => state.getAssetMetadata);
  // Subscribe to the cache itself so rows re-render when ASA params resolve
  // (getAssetMetadata is a stable selector and wouldn't trigger a re-render).
  const assetMetadataCache = useWalletStore((state) => state.assetMetadataCache);

  useEffect(() => {
    if (activeAccount) {
      loadTransactions();
    }
    updateActivity();
  }, [activeAccount?.id]);

  // Load token metadata for ARC-200 transactions
  useEffect(() => {
    const transactions = accountState.recentTransactions || [];
    const arc200ContractIds = transactions
      .filter((tx) => tx.isArc200 && tx.contractId)
      .map((tx) => tx.contractId!)
      .filter((id, index, arr) => arr.indexOf(id) === index); // Remove duplicates

    if (arc200ContractIds.length > 0) {
      loadTokenMetadata(arc200ContractIds);
    }
  }, [accountState.recentTransactions, loadTokenMetadata]);

  // Resolve ASA params for transactions whose asset isn't in current holdings,
  // so amounts render with correct decimals instead of a 0-decimals fallback.
  useEffect(() => {
    const transactions = accountState.recentTransactions || [];
    const asaAssetIds = transactions
      .filter((tx) => !tx.isArc200 && tx.assetId && tx.assetId !== 0)
      .map((tx) => tx.assetId!)
      .filter((id, index, arr) => arr.indexOf(id) === index); // Remove duplicates

    if (asaAssetIds.length > 0) {
      loadAssetMetadata(asaAssetIds);
    }
    // currentNetwork: re-resolve for the new network after a switch even if the
    // transaction list reference hasn't changed (cache is network-scoped).
  }, [accountState.recentTransactions, loadAssetMetadata, currentNetwork]);

  const loadTransactions = async () => {
    if (!activeAccount) return;

    try {
      await loadAllTransactions(activeAccount.id);
    } catch (error) {
      console.error('Failed to load transaction history:', error);
    }
  };

  const onRefresh = async () => {
    setRefreshing(true);
    await loadTransactions();
    setRefreshing(false);
    updateActivity();
  };

  const handleLoadMore = useCallback(async () => {
    if (
      !activeAccount ||
      !accountState.transactionsPagination?.hasMore ||
      accountState.transactionsPagination?.isLoadingMore
    ) {
      return;
    }

    try {
      await loadMoreTransactions(activeAccount.id);
    } catch (error) {
      console.error('Failed to load more transactions:', error);
    }
  }, [
    activeAccount,
    accountState.transactionsPagination,
    loadMoreTransactions,
  ]);

  const handleTransactionPress = useCallback(
    (transaction: TransactionInfo) => {
      if (!activeAccount) return;

      try {
        // Get the asset symbol and ID for the transaction
        let assetName = 'VOI';
        let assetId = 0;
        // Undefined = decimals unresolved; the detail screen shows a placeholder
        // rather than scaling by 0 (which renders the wrong magnitude).
        let assetDecimals: number | undefined = 0;

        if (transaction.isArc200 && transaction.contractId) {
          // For ARC-200 tokens, use contractId and find the asset symbol
          assetId = transaction.contractId;

          // Prefer cached metadata, fallback to balance data
          const tokenMetadata = getTokenMetadata(transaction.contractId);
          if (tokenMetadata) {
            assetName = tokenMetadata.symbol || 'TOKEN';
            assetDecimals = tokenMetadata.decimals;
          } else {
            const asset = accountState.balance?.assets?.find(
              (a) =>
                a.assetType === 'arc200' &&
                a.contractId === transaction.contractId
            );
            assetName = asset?.symbol || 'TOKEN';
            assetDecimals = asset?.decimals;
          }
        } else if (transaction.assetId && transaction.assetId !== 0) {
          // For ASA tokens: prefer holdings, fall back to resolved asset params
          assetId = transaction.assetId;
          const asset = accountState.balance?.assets?.find(
            (a) => a.assetType === 'asa' && a.assetId === transaction.assetId
          );
          const resolved = getAssetMetadata(transaction.assetId);
          assetName = asset?.symbol || resolved?.unitName || 'TOKEN';
          assetDecimals = asset?.decimals ?? resolved?.decimals;
        }

        navigation.navigate('TransactionDetail', {
          transaction: serializeTransactionForNavigation(transaction),
          assetName,
          assetId,
          accountAddress: activeAccount.address,
          decimals: assetDecimals,
        });
      } catch (error) {
        console.error('Failed to navigate to transaction detail:', error);
      }
    },
    [
      activeAccount,
      accountState.balance?.assets,
      getTokenMetadata,
      getAssetMetadata,
      navigation,
    ]
  );

  const renderTransaction: ListRenderItem<TransactionInfo> = useCallback(
    ({ item }) => {
      // Get token metadata for ARC-200 transactions
      const tokenMetadata =
        item.isArc200 && item.contractId
          ? getTokenMetadata(item.contractId)
          : null;
      // Get resolved ASA params for non-ARC-200 asset transfers
      const assetMetadata =
        !item.isArc200 && item.assetId && item.assetId !== 0
          ? getAssetMetadata(item.assetId)
          : null;

      return (
        <TransactionListItem
          transaction={item}
          activeAccountAddress={activeAccount?.address || ''}
          assets={accountState.balance?.assets}
          tokenMetadata={tokenMetadata}
          assetMetadata={assetMetadata}
          onPress={handleTransactionPress}
        />
      );
    },
    [
      activeAccount?.address,
      accountState.balance?.assets,
      handleTransactionPress,
      getTokenMetadata,
      getAssetMetadata,
      // Recompute rows when resolved ASA params land in the cache
      assetMetadataCache,
    ]
  );

  const renderFooter = () => {
    if (!accountState.transactionsPagination?.isLoadingMore) {
      return null;
    }

    return (
      <View style={styles.loadingFooter}>
        <ActivityIndicator
          size="small"
          color={styles.activityIndicator.color}
        />
        <Text style={styles.loadingFooterText}>
          Loading more transactions...
        </Text>
      </View>
    );
  };

  const keyExtractor = useCallback(
    (item: TransactionInfo, index: number) => `${item.id}-${index}`,
    []
  );

  const allTransactions = accountState.recentTransactions || [];

  if (!activeAccount) {
    return (
      <NFTBackground>
        <SafeAreaView style={styles.container} edges={['top']}>
          <View style={styles.loadingContainer}>
            <Text style={styles.loadingText}>No active account</Text>
          </View>
        </SafeAreaView>
      </NFTBackground>
    );
  }

  return (
    <NFTBackground>
      <SafeAreaView style={styles.container} edges={['top']}>
        <BlurredContainer
          style={styles.header}
          borderRadius={0}
          opacity={0.8}
        >
          <TouchableOpacity
            style={styles.backButton}
            onPress={() => navigation.goBack()}
          >
            <Ionicons name="arrow-back" size={24} color={theme.mode === 'dark' ? '#FFFFFF' : '#000000'} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Transaction History</Text>
          <View style={styles.headerSpacer} />
        </BlurredContainer>

        {accountState.isTransactionsLoading && allTransactions.length === 0 ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator
              size="large"
              color={styles.activityIndicator.color}
            />
            <Text style={styles.loadingText}>Loading transactions...</Text>
          </View>
        ) : allTransactions.length === 0 ? (
          <View style={styles.emptyContainer}>
            <Ionicons
              name="receipt-outline"
              size={64}
              color={styles.emptyIcon.color}
            />
            <Text style={styles.emptyTitle}>No Transactions</Text>
            <Text style={styles.emptySubtitle}>
              Your transaction history will appear here when you start using your
              wallet.
            </Text>
          </View>
        ) : (
          <ScrollView
            contentContainerStyle={styles.listContainer}
            refreshControl={
              <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
            }
            onScrollBeginDrag={() => updateActivity()}
            showsVerticalScrollIndicator={false}
          >
            {allTransactions.map((item, index) => (
              <View key={`${item.id}-${index}`}>
                {renderTransaction({ item, index, separators: {} as any })}
              </View>
            ))}
            {renderFooter()}
          </ScrollView>
        )}
      </SafeAreaView>
    </NFTBackground>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    container: {
      flex: 1,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: theme.spacing.lg,
      paddingVertical: theme.spacing.md,
    },
    backButton: {
      padding: theme.spacing.xs,
    },
    headerTitle: {
      fontSize: 18,
      fontWeight: '600',
      color: theme.colors.text,
      flex: 1,
      textAlign: 'center',
      marginRight: 32, // Compensate for back button width
    },
    headerSpacer: {
      width: 32,
    },
    loadingContainer: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      paddingVertical: 60,
    },
    loadingText: {
      fontSize: 16,
      color: theme.colors.textSecondary,
      marginTop: theme.spacing.small,
    },
    emptyContainer: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      paddingVertical: 80,
      paddingHorizontal: theme.spacing.xl,
    },
    emptyTitle: {
      fontSize: 24,
      fontWeight: '600',
      color: theme.colors.text,
      marginTop: theme.spacing.md,
      marginBottom: theme.spacing.sm,
    },
    emptySubtitle: {
      fontSize: 16,
      color: theme.colors.textMuted,
      textAlign: 'center',
      lineHeight: 24,
      paddingHorizontal: theme.spacing.md,
    },
    listContainer: {
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.sm,
      paddingBottom: theme.spacing.xxl,
    },
    loadingFooter: {
      paddingVertical: theme.spacing.large,
      alignItems: 'center',
    },
    loadingFooterText: {
      fontSize: 14,
      color: theme.colors.textSecondary,
      marginTop: theme.spacing.xs,
    },
    backIcon: {
      color: theme.colors.primary,
    },
    activityIndicator: {
      color: theme.colors.primary,
    },
    emptyIcon: {
      color: theme.colors.textSecondary,
    },
  });
