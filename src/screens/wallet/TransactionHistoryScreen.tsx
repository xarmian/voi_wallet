import React, {
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
} from 'react';
import {
  View,
  Text,
  StyleSheet,
  RefreshControl,
  FlatList,
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
  ALL_TRANSACTIONS_SCOPE,
  useActiveAccount,
  useAccountState,
  useWalletStore,
} from '@/store/walletStore';
import TransactionListItem from '@/components/transaction/TransactionListItem';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import { serializeTransactionForNavigation } from '@/utils/navigationParams';
import { BlurredContainer } from '@/components/common/BlurredContainer';
import { ListEmptyState } from '@/components/common/ListEmptyState';
import { ListFooterSpinner } from '@/components/common/ListFooterSpinner';
import { ErrorStateView } from '@/components/common/ErrorStateView';
import { NFTBackground } from '@/components/common/NFTBackground';
import { useTheme } from '@/contexts/ThemeContext';
import { useCurrentNetwork } from '@/store/networkStore';

// Stable empty reference so a scope mismatch does not churn list identity.
const EMPTY_TRANSACTIONS: TransactionInfo[] = [];

export default function TransactionHistoryScreen() {
  const [refreshing, setRefreshing] = useState(false);
  // Distinguishes "this screen has not fetched yet" from "the account has no
  // transactions". Needed because the scope gate below starts the list empty
  // and the store only flips `isTransactionsLoading` after an await, leaving a
  // window in which the definitive empty state would otherwise be shown.
  //
  // Stored as the account that was attempted rather than a boolean, and
  // compared during render, so switching accounts cannot leave a frame in
  // which the new account looks "already loaded".
  const [attemptedAccountId, setAttemptedAccountId] = useState<string | null>(
    null
  );
  const loadMoreInFlightRef = useRef(false);
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
  const assetMetadataCache = useWalletStore(
    (state) => state.assetMetadataCache
  );

  // Read the shared `recentTransactions` array only while it holds the
  // ACCOUNT-WIDE history — AssetDetailScreen loads a single asset's history
  // into the same array, and rendering that here would be the wrong list.
  const allTransactions = useMemo(
    () =>
      accountState.recentTransactionsScope === ALL_TRANSACTIONS_SCOPE
        ? accountState.recentTransactions || []
        : EMPTY_TRANSACTIONS,
    [accountState.recentTransactionsScope, accountState.recentTransactions]
  );
  // Not the shared `lastError` (every other loader clears it) and not any
  // transaction error either — only an ACCOUNT-WIDE one. AssetDetailScreen
  // writes asset-scoped failures into the same field, and rendering those here
  // would blame the wrong list (TASK-40).
  const transactionsError =
    accountState.transactionsError?.scope === ALL_TRANSACTIONS_SCOPE
      ? accountState.transactionsError.message
      : null;

  useEffect(() => {
    if (activeAccount) {
      loadTransactions();
    }
    updateActivity();
  }, [activeAccount?.id]);

  // Load token metadata for ARC-200 transactions
  useEffect(() => {
    const transactions = allTransactions;
    const arc200ContractIds = transactions
      .filter((tx) => tx.isArc200 && tx.contractId)
      .map((tx) => tx.contractId!)
      .filter((id, index, arr) => arr.indexOf(id) === index); // Remove duplicates

    if (arc200ContractIds.length > 0) {
      loadTokenMetadata(arc200ContractIds);
    }
  }, [allTransactions, loadTokenMetadata]);

  // Resolve ASA params for transactions whose asset isn't in current holdings,
  // so amounts render with correct decimals instead of a 0-decimals fallback.
  useEffect(() => {
    const transactions = allTransactions;
    const asaAssetIds = transactions
      .filter((tx) => !tx.isArc200 && tx.assetId && tx.assetId !== 0)
      .map((tx) => tx.assetId!)
      .filter((id, index, arr) => arr.indexOf(id) === index); // Remove duplicates

    if (asaAssetIds.length > 0) {
      loadAssetMetadata(asaAssetIds);
    }
    // currentNetwork: re-resolve for the new network after a switch even if the
    // transaction list reference hasn't changed (cache is network-scoped).
  }, [allTransactions, loadAssetMetadata, currentNetwork]);

  // Stable identity: it is a dependency of the memoized empty/error component,
  // and an unstable one would remount that subtree on every render.
  const loadTransactions = useCallback(async () => {
    if (!activeAccount) return;

    const accountId = activeAccount.id;
    try {
      await loadAllTransactions(accountId);
    } catch (error) {
      console.error('Failed to load transaction history:', error);
    } finally {
      // Always set, even on failure/early-return, so a spinner can never wedge.
      setAttemptedAccountId(accountId);
    }
  }, [activeAccount, loadAllTransactions]);

  const onRefresh = async () => {
    setRefreshing(true);
    await loadTransactions();
    setRefreshing(false);
    updateActivity();
  };

  const handleLoadMore = useCallback(async () => {
    // The store only flips `isLoadingMore` after an await, so guard on an
    // in-flight ref as well — otherwise two `onEndReached` events fired in the
    // same tick would both pass the store-side check and double-fetch a page.
    if (
      loadMoreInFlightRef.current ||
      !activeAccount ||
      !accountState.transactionsPagination?.hasMore ||
      accountState.transactionsPagination?.isLoadingMore
    ) {
      return;
    }

    loadMoreInFlightRef.current = true;
    try {
      await loadMoreTransactions(activeAccount.id);
    } catch (error) {
      console.error('Failed to load more transactions:', error);
    } finally {
      loadMoreInFlightRef.current = false;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- assetMetadataCache is a DELIBERATE recompute trigger: getAssetMetadata reads it internally, so ESLint calls it "unnecessary" for not appearing in the body. Removing it would stop rows re-rendering when resolved ASA params land and freeze transaction amounts at the 0-decimals fallback.
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

  const renderFooter = useCallback(() => {
    // A page that failed to load used to just stop pagination silently.
    if (transactionsError && allTransactions.length > 0) {
      return (
        <ErrorStateView
          variant="inline"
          error={transactionsError}
          fallbackMessage="Couldn't load more transactions."
          onRetry={handleLoadMore}
          style={styles.footerError}
          testID="transactions-footer-error"
        />
      );
    }

    return (
      <ListFooterSpinner
        visible={!!accountState.transactionsPagination?.isLoadingMore}
        text="Loading more transactions..."
      />
    );
  }, [
    accountState.transactionsPagination?.isLoadingMore,
    transactionsError,
    allTransactions.length,
    handleLoadMore,
    styles.footerError,
  ]);

  // The core audit finding (U-03): a FAILED fetch used to fall through to the
  // "No Transactions" empty state, which is indistinguishable from a genuinely
  // empty account and reads as lost history. An error must look like an error
  // and must offer a retry.
  const renderEmptyState = useCallback(() => {
    if (transactionsError) {
      return (
        <ErrorStateView
          error={transactionsError}
          fallbackMessage="Couldn't load your transaction history."
          onRetry={loadTransactions}
          style={styles.emptyContainer}
          testID="transactions-error"
        />
      );
    }

    if (
      attemptedAccountId !== activeAccount?.id ||
      accountState.isTransactionsLoading
    ) {
      return (
        <ListFooterSpinner
          text="Loading transactions..."
          style={styles.emptyContainer}
        />
      );
    }

    return (
      <ListEmptyState
        icon="receipt-outline"
        iconColor={styles.emptyIcon.color}
        title="No Transactions"
        subtitle="Your transaction history will appear here when you start using your wallet."
        style={styles.emptyContainer}
      />
    );
  }, [
    transactionsError,
    attemptedAccountId,
    activeAccount?.id,
    accountState.isTransactionsLoading,
    loadTransactions,
    styles.emptyContainer,
    styles.emptyIcon.color,
  ]);

  const keyExtractor = useCallback(
    (item: TransactionInfo, index: number) => `${item.id}-${index}`,
    []
  );

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
        <BlurredContainer style={styles.header} borderRadius={0} opacity={0.8}>
          <TouchableOpacity
            style={styles.backButton}
            onPress={() => navigation.goBack()}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <Ionicons name="arrow-back" size={24} color={theme.colors.text} />
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
        ) : (
          <FlatList
            data={allTransactions}
            renderItem={renderTransaction}
            keyExtractor={keyExtractor}
            contentContainerStyle={
              allTransactions.length === 0
                ? styles.emptyListContainer
                : styles.listContainer
            }
            refreshControl={
              <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
            }
            onScrollBeginDrag={() => updateActivity()}
            showsVerticalScrollIndicator={false}
            onEndReached={handleLoadMore}
            onEndReachedThreshold={0.5}
            ListEmptyComponent={renderEmptyState}
            ListFooterComponent={renderFooter}
            // Rows are variable height (address/label wrapping), so no
            // getItemLayout here — a wrong fixed height breaks scrolling.
            initialNumToRender={12}
            maxToRenderPerBatch={12}
            windowSize={11}
            // Safe: rows pass `disableBlur`, so no BlurView is mounted inside
            // this VirtualizedList (see SafeBlurView's Android warning).
            removeClippedSubviews
          />
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
      marginTop: theme.spacing.sm,
    },
    emptyContainer: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      paddingVertical: 80,
      paddingHorizontal: theme.spacing.xl,
    },
    listContainer: {
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.sm,
      paddingBottom: theme.spacing.xxl,
    },
    emptyListContainer: {
      flexGrow: 1,
      justifyContent: 'center',
      paddingHorizontal: theme.spacing.md,
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
    footerError: {
      marginHorizontal: theme.spacing.md,
      marginVertical: theme.spacing.sm,
    },
  });
