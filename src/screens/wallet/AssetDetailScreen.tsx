import React, { useState, useEffect, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  RefreshControl,
  ScrollView,
  TouchableOpacity,
  Alert,
  Image,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRoute, useNavigation } from '@react-navigation/native';
import type { StackNavigationProp } from '@react-navigation/stack';
import { useThemedStyles, useThemeColors } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import { TransactionInfo, AccountBalance } from '@/types/wallet';
import { useAuth } from '@/contexts/AuthContext';
import {
  useWalletStore,
  useAccountState,
  useAccountBalance,
  useAccounts,
  useIsMultiNetworkView,
  useMultiNetworkBalance,
} from '@/store/walletStore';
import { formatNativeBalance, formatAssetBalance } from '@/utils/bigint';
import { formatCurrency } from '@/utils/formatting';
import { dedupeTransactions } from '@/utils/transactions';
import TransactionAddressDisplay from '@/components/transaction/TransactionAddressDisplay';
import { useCurrentNetworkConfig } from '@/store/networkStore';
import { getNetworkConfig } from '@/services/network/config';
import { NetworkId } from '@/types/network';
import { serializeTransactionForNavigation } from '@/utils/navigationParams';
import {
  submitAsaOptOut,
  validateAsaOptOut,
} from '@/services/transactions/asa';
import { MultiAccountWalletService } from '@/services/wallet';
import NetworkServiceInstance, { NetworkService } from '@/services/network';
import UnifiedAuthModal from '@/components/UnifiedAuthModal';
import { BlurredContainer } from '@/components/common/BlurredContainer';
import { GlassCard } from '@/components/common/GlassCard';
import { NFTBackground } from '@/components/common/NFTBackground';
import { useTheme } from '@/contexts/ThemeContext';
import { SwapService } from '@/services/swap';
import { GlassButton } from '@/components/common/GlassButton';
import UniversalHeader from '@/components/common/UniversalHeader';
import { useIsSwapEnabled } from '@/store/experimentalStore';

interface AssetDetailRouteParams {
  assetName: string;
  assetId: number;
  accountId: string;
  mappingId?: string;
  networkId?: string; // Optional network filter for multi-network context
}

export default function AssetDetailScreen() {
  const styles = useThemedStyles(createStyles);
  const themeColors = useThemeColors();
  const { theme } = useTheme();
  const [refreshing, setRefreshing] = useState(false);
  const [imageError, setImageError] = useState(false);
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [optingOut, setOptingOut] = useState(false);
  const [isSwappable, setIsSwappable] = useState(false);
  const [checkingSwappable, setCheckingSwappable] = useState(true);
  const loadMoreCalledRef = React.useRef(false);
  const route = useRoute();
  const navigation = useNavigation<StackNavigationProp<any>>();
  const isSwapEnabled = useIsSwapEnabled();
  const { assetName, assetId, accountId, mappingId, networkId } =
    route.params as AssetDetailRouteParams;
  const currentNetworkConfig = useCurrentNetworkConfig();

  // If networkId is provided, get that network's config; otherwise use current
  const specificNetworkConfig = networkId
    ? getNetworkConfig(networkId as NetworkId)
    : currentNetworkConfig;

  const { updateActivity } = useAuth();
  const loadAllTransactions = useWalletStore(
    (state) => state.loadAllTransactions
  );
  const loadAssetTransactions = useWalletStore(
    (state) => state.loadAssetTransactions
  );
  const loadMoreAssetTransactions = useWalletStore(
    (state) => state.loadMoreAssetTransactions
  );
  const loadMoreTransactions = useWalletStore(
    (state) => state.loadMoreTransactions
  );
  const loadMultiNetworkBalance = useWalletStore(
    (state) => state.loadMultiNetworkBalance
  );
  const accountBalance = useAccountBalance(accountId);
  const accountState = useAccountState(accountId);
  const allAccounts = useAccounts();
  const currentAccount = allAccounts.find((acc) => acc.id === accountId);

  // Multi-network support
  const isMultiNetworkView = useIsMultiNetworkView();
  const { balance: multiNetworkBalance } = useMultiNetworkBalance(accountId);

  const derivedNetworkBalance = useMemo(() => {
    if (!networkId || !multiNetworkBalance) {
      return null;
    }

    const targetNetworkId = networkId as NetworkId;
    const accountAddress =
      currentAccount?.address || multiNetworkBalance.address;

    if (!accountAddress) {
      return null;
    }

    const findMatchingAsset = () =>
      multiNetworkBalance.assets.find((asset) => {
        if (mappingId && asset.mappingId) {
          return asset.mappingId === mappingId;
        }

        return asset.sourceBalances.some((source) => {
          if (source.networkId !== targetNetworkId) {
            return false;
          }

          const sourceAsset = source.balance;
          const matchesAssetId =
            sourceAsset.assetId === assetId ||
            (sourceAsset.assetType === 'arc200' &&
              sourceAsset.contractId === assetId);

          return matchesAssetId;
        });
      }) || null;

    const mappedAsset = findMatchingAsset();
    if (!mappedAsset) {
      return null;
    }

    const sourceBalance = mappedAsset.sourceBalances.find((source) => {
      if (source.networkId !== targetNetworkId) {
        return false;
      }

      const sourceAsset = source.balance;
      const isMatchingAsset =
        sourceAsset.assetId === assetId ||
        (sourceAsset.assetType === 'arc200' &&
          sourceAsset.contractId === assetId);

      return isMatchingAsset;
    });

    if (!sourceBalance) {
      return null;
    }

    const perNetworkAmount =
      multiNetworkBalance.perNetworkAmounts?.[targetNetworkId];
    const perNetworkPrice =
      multiNetworkBalance.perNetworkPrices?.[targetNetworkId];

    const balance: AccountBalance = {
      address: accountAddress,
      amount:
        perNetworkAmount !== undefined
          ? perNetworkAmount
          : sourceBalance.balance.amount,
      minBalance: 0,
      assets: [sourceBalance.balance],
    };

    if (typeof perNetworkPrice === 'number') {
      if (targetNetworkId === NetworkId.VOI_MAINNET) {
        balance.voiPrice = perNetworkPrice;
      } else if (targetNetworkId === NetworkId.ALGORAND_MAINNET) {
        balance.algoPrice = perNetworkPrice;
      }
    }

    return balance;
  }, [
    networkId,
    multiNetworkBalance,
    currentAccount?.address,
    mappingId,
    assetId,
    specificNetworkConfig.nativeToken,
  ]);

  // If networkId is provided, we need to get the balance from that specific network
  const [networkSpecificBalance, setNetworkSpecificBalance] =
    useState<AccountBalance | null>(null);
  const [networkSpecificTransactions, setNetworkSpecificTransactions] = useState<TransactionInfo[]>([]);
  const [isLoadingNetworkTransactions, setIsLoadingNetworkTransactions] = useState(false);

  useEffect(() => {
    if (!networkId) {
      setNetworkSpecificBalance(null);
      return;
    }

    if (derivedNetworkBalance) {
      setNetworkSpecificBalance(derivedNetworkBalance);
      return;
    }

    if (!currentAccount) {
      return;
    }

    let isMounted = true;

    const fetchNetworkBalance = async () => {
      try {
        const networkService = NetworkService.getInstance(networkId as NetworkId);
        const balance = await networkService.getAccountBalance(currentAccount.address);
        if (isMounted) {
          setNetworkSpecificBalance(balance);
        }
      } catch (error) {
        console.error(`Failed to fetch balance from ${networkId}:`, error);
      }
    };

    fetchNetworkBalance();

    return () => {
      isMounted = false;
    };
  }, [networkId, currentAccount, derivedNetworkBalance]);

  // Check if token is swappable (VOI via SnowballSwap, Algorand via Deflex)
  useEffect(() => {
    const checkSwappable = async () => {
      setCheckingSwappable(true);
      try {
        const effectiveNetworkId = networkId as NetworkId || NetworkId.VOI_MAINNET;

        // Check if swap is available on this network
        if (!SwapService.isSwapAvailable(effectiveNetworkId)) {
          setIsSwappable(false);
          return;
        }

        // For Algorand, enable swap for all ASA tokens without lookup
        // Deflex handles routing for most tokens
        if (effectiveNetworkId === NetworkId.ALGORAND_MAINNET) {
          setIsSwappable(true);
          return;
        }

        // For VOI, check with SnowballSwap API
        const provider = SwapService.getProvider(effectiveNetworkId);
        const swappable = await provider.isTokenSwappable(assetId);
        setIsSwappable(swappable);
      } catch (error) {
        console.error('Error checking token swappability:', error);
        setIsSwappable(false);
      } finally {
        setCheckingSwappable(false);
      }
    };

    checkSwappable();
  }, [assetId, networkId]);

  // Build effective balance based on context
  const effectiveBalance = useMemo(() => {
    // If viewing a specific network, use network-specific balance
    if (networkId) {
      return networkSpecificBalance || derivedNetworkBalance;
    }

    // If viewing a mapped asset in multi-network mode, construct balance from mapped asset
    if (mappingId && isMultiNetworkView && multiNetworkBalance) {
      const mappedAsset = multiNetworkBalance.assets.find(
        (a) => a.mappingId === mappingId && a.isMapped
      );

      if (mappedAsset && currentAccount) {
        // Construct an AccountBalance from the mapped asset
        const syntheticBalance: AccountBalance = {
          address: currentAccount.address,
          amount: mappedAsset.amount,
          minBalance: 0n,
          assets: [mappedAsset],
        };

        // Add price data from perNetworkPrices if available
        // Use the primary network's price
        const primaryPrice = multiNetworkBalance.perNetworkPrices?.[mappedAsset.primaryNetwork];
        if (primaryPrice) {
          if (mappedAsset.primaryNetwork === NetworkId.VOI_MAINNET) {
            syntheticBalance.voiPrice = primaryPrice;
          } else if (mappedAsset.primaryNetwork === NetworkId.ALGORAND_MAINNET) {
            syntheticBalance.algoPrice = primaryPrice;
          }
        }

        return syntheticBalance;
      }
    }

    // Default: use single-network balance
    return accountBalance.balance;
  }, [
    networkId,
    networkSpecificBalance,
    derivedNetworkBalance,
    mappingId,
    isMultiNetworkView,
    multiNetworkBalance,
    currentAccount,
    accountBalance.balance,
  ]);

  // Compute network subtitle for header
  const networkSubtitle = useMemo(() => {
    // If viewing a specific network, show that network name
    if (networkId) {
      const specificConfig = getNetworkConfig(networkId as NetworkId);
      return specificConfig.name
        .replace(' Network', '')
        .replace(' Mainnet', '')
        .replace(' Testnet', '')
        .trim();
    }

    // If multi-network view, show all networks this asset exists on
    if (isMultiNetworkView && multiNetworkBalance) {
      const mappedAsset = multiNetworkBalance.assets.find(
        (a) => mappingId ? (a.mappingId === mappingId && a.isMapped) : (a.assetId === assetId && a.isMapped)
      );
      if (mappedAsset && mappedAsset.sourceBalances.length > 0) {
        const uniqueNetworks = Array.from(new Set(mappedAsset.sourceBalances.map(s => s.networkId)));
        return uniqueNetworks
          .map((nid) => getNetworkConfig(nid).name
            .replace(' Network', '')
            .replace(' Mainnet', '')
            .replace(' Testnet', '')
            .trim())
          .join(' + ');
      }
    }

    return undefined;
  }, [networkId, isMultiNetworkView, multiNetworkBalance, mappingId, assetId]);

  useEffect(() => {
    const loadTransactions = async () => {
      try {
        // Determine if this is an ARC-200 token
        const asset = effectiveBalance?.assets?.find(
          (a) =>
            a.assetId === assetId ||
            (a.assetType === 'arc200' && a.contractId === assetId)
        );
        const isArc200 = asset?.assetType === 'arc200';

        // If networkId is provided, fetch transactions from that specific network
        if (networkId && currentAccount) {
          setIsLoadingNetworkTransactions(true);
          try {
            const networkService = NetworkService.getInstance(networkId as NetworkId);
            const result = await networkService.getAssetTransactionHistory(
              currentAccount.address,
              assetId,
              isArc200
            );
            setNetworkSpecificTransactions(dedupeTransactions(result.transactions));
          } catch (error) {
            console.error(`Failed to load transactions from ${networkId}:`, error);
            setNetworkSpecificTransactions([]);
          } finally {
            setIsLoadingNetworkTransactions(false);
          }
        } else {
          // Use wallet store for current network
          await loadAssetTransactions(accountId, assetId, isArc200);
        }
      } catch (error) {
        console.error('Failed to load transactions:', error);
      }
    };

    loadTransactions();
    updateActivity();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, assetId, effectiveBalance, networkId, currentAccount]);

  const onRefresh = async () => {
    setRefreshing(true);
    const refreshPromises: Promise<any>[] = [];

    // Reload balance based on context
    if (networkId) {
      refreshPromises.push(loadMultiNetworkBalance(accountId, true));
    } else {
      refreshPromises.push(accountBalance.reload());
    }

    // Determine if this is an ARC-200 token
    const asset = effectiveBalance?.assets?.find(
      (a) =>
        a.assetId === assetId ||
        (a.assetType === 'arc200' && a.contractId === assetId)
    );
    const isArc200 = asset?.assetType === 'arc200';

    // Load transactions based on context
    if (networkId && currentAccount) {
      // Reload network-specific transactions
      refreshPromises.push((async () => {
        try {
          const networkService = NetworkService.getInstance(networkId as NetworkId);
          const result = await networkService.getAssetTransactionHistory(
            currentAccount.address,
            assetId,
            isArc200
          );
          setNetworkSpecificTransactions(dedupeTransactions(result.transactions));
        } catch (error) {
          console.error(`Failed to refresh transactions from ${networkId}:`, error);
        }
      })());
    } else {
      // Use loadAssetTransactions for all assets (including native VOI)
      refreshPromises.push(loadAssetTransactions(accountId, assetId, isArc200));
    }

    await Promise.allSettled(refreshPromises);
    setRefreshing(false);
    updateActivity();
  };

  const handleTransactionPress = async (transaction: TransactionInfo) => {
    try {
      // Get the account address from the wallet service
      const account = await MultiAccountWalletService.getAccount(accountId);

      // Get the asset to find decimals
      const asset = effectiveBalance?.assets?.find(
        (a) =>
          a.assetId === assetId ||
          (transaction.isArc200 && a.contractId === assetId)
      );

      navigation.navigate('TransactionDetail', {
        transaction: serializeTransactionForNavigation(transaction),
        assetName,
        assetId,
        accountAddress: account.address,
        decimals: asset?.decimals,
      });
    } catch (error) {
      console.error('Failed to get account address:', error);
      // Fallback to empty string if we can't get the address
      navigation.navigate('TransactionDetail', {
        transaction: serializeTransactionForNavigation(transaction),
        assetName,
        assetId,
        accountAddress: '',
        decimals: 0,
      });
    }
  };

  const formatTransactionType = (type: TransactionInfo['type']) => {
    switch (type) {
      case 'payment':
        return 'Payment';
      case 'asset-transfer':
        return 'Asset Transfer';
      case 'asset-config':
        return 'Asset Config';
      case 'application-call':
        return 'App Call';
      case 'arc200-transfer':
        return 'ARC-200 Transfer';
      default:
        return 'Unknown';
    }
  };

  const getTransactionTypeIcon = (type: TransactionInfo['type']) => {
    switch (type) {
      case 'payment':
        return 'arrow-forward';
      case 'asset-transfer':
        return 'arrow-forward';
      case 'asset-config':
        return 'settings';
      case 'application-call':
        return 'cube';
      case 'arc200-transfer':
        return 'arrow-forward';
      default:
        return 'help-circle';
    }
  };

  const getTransactionTypeColor = (
    type: TransactionInfo['type'],
    isOutgoing: boolean
  ) => {
    switch (type) {
      case 'payment':
      case 'asset-transfer':
      case 'arc200-transfer':
        return isOutgoing ? themeColors.error : themeColors.success;
      case 'application-call':
        return '#8B5CF6'; // Purple for application calls
      case 'asset-config':
        return themeColors.warning;
      default:
        return themeColors.textSecondary;
    }
  };

  const formatTimestamp = (timestamp: number) => {
    return new Date(timestamp).toLocaleDateString();
  };

  const formatAddress = (address: string) => {
    return `${address.slice(0, 6)}...${address.slice(-6)}`;
  };

  const formatBalance = (amount: number | bigint) => {
    return formatNativeBalance(amount, specificNetworkConfig.nativeToken);
  };

  const getAsset = () => {
    if (assetId === 0) {
      return null; // VOI doesn't have enhanced asset data
    }

    const assets = effectiveBalance?.assets;
    if (!assets) {
      return null;
    }

    return (
      assets.find((asset) => {
        const resolvedId = Number(asset.assetId);
        if (Number.isFinite(resolvedId) && resolvedId === assetId) {
          return true;
        }

        if (
          asset.assetType === 'arc200' &&
          typeof asset.contractId === 'number'
        ) {
          return asset.contractId === assetId;
        }

        return false;
      }) ?? null
    );
  };

  const getAssetBalance = () => {
    if (assetId === 0) {
      return effectiveBalance
        ? formatBalance(effectiveBalance.amount)
        : '0.000000';
    }

    const asset = getAsset();
    if (asset) {
      return formatAssetBalance(asset.amount, asset.decimals);
    }
    return '0';
  };

  const calculateAssetUsdValue = () => {
    const asset = getAsset();
    if (!asset?.amount) return formatCurrency(0);

    // For mapped assets, calculate USD value across all source networks
    if (asset.isMapped && asset.sourceBalances && multiNetworkBalance) {
      let totalValue = 0;

      for (const source of asset.sourceBalances) {
        const sourceAsset = source.balance;

        // Check if this is a native asset on this network
        if (sourceAsset.assetId === 0) {
          const price = multiNetworkBalance.perNetworkPrices[source.networkId];
          if (price && sourceAsset.amount) {
            const amount =
              typeof sourceAsset.amount === 'bigint'
                ? Number(sourceAsset.amount)
                : sourceAsset.amount;
            const nativeValue = amount / 1_000_000;
            totalValue += nativeValue * price;
          }
        } else {
          // Non-native asset - use usdValue if available
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
    }

    // For non-mapped assets, use the simple calculation
    if (!asset.usdValue) return formatCurrency(0);

    const unitPrice = parseFloat(asset.usdValue);
    const amount =
      typeof asset.amount === 'bigint' ? Number(asset.amount) : asset.amount;
    const normalizedBalance = amount / 10 ** asset.decimals;
    const totalUsdValue = normalizedBalance * unitPrice;

    return formatCurrency(totalUsdValue);
  };

  const calculateNativeUsdValue = () => {
    const nativePrice =
      effectiveBalance?.voiPrice || effectiveBalance?.algoPrice;
    if (!nativePrice || !effectiveBalance?.amount) return formatCurrency(0);

    const amount =
      typeof effectiveBalance.amount === 'bigint'
        ? Number(effectiveBalance.amount)
        : effectiveBalance.amount;
    const nativeValue = amount / 1_000_000; // Convert micro-units to whole units
    const usdValue = nativeValue * nativePrice;

    return formatCurrency(usdValue);
  };

  const getFilteredTransactions = () => {
    // If viewing a specific network, use network-specific transactions
    if (networkId) {
      return networkSpecificTransactions;
    }

    // Otherwise use transactions from wallet store
    // Transactions are already filtered by the NetworkService at the API level
    // No client-side filtering needed anymore
    return accountState.recentTransactions || [];
  };

  const handleOptOut = async () => {
    if (!currentAccount) return;

    // Check if balance is zero or if user wants to opt out with remaining balance
    const asset = getAsset();
    if (!asset || asset.assetType !== 'asa') {
      return;
    }

    const validation = await validateAsaOptOut(currentAccount.address, assetId);
    if (!validation.valid) {
      Alert.alert(
        'Cannot Opt Out',
        validation.error || 'Unable to opt out of this asset'
      );
      return;
    }

    if (validation.warning) {
      Alert.alert('Opt Out Warning', validation.warning, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Continue', onPress: () => setShowAuthModal(true) },
      ]);
    } else {
      // Confirm opt-out even if balance is zero
      Alert.alert(
        'Remove Asset',
        `Are you sure you want to remove ${assetName} from your wallet?`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Remove',
            style: 'destructive',
            onPress: () => setShowAuthModal(true),
          },
        ]
      );
    }
  };

  const handleAuthSuccess = async (pin?: string) => {
    setShowAuthModal(false);
    setOptingOut(true);

    try {
      if (!currentAccount) {
        throw new Error('No active account');
      }

      const txId = await submitAsaOptOut(assetId, currentAccount.address, pin);

      // Wait for confirmation
      await NetworkServiceInstance.waitForConfirmation(txId, 4);

      // Refresh balances
      const { refreshAllBalances } = useWalletStore.getState();
      await refreshAllBalances();

      Alert.alert(
        'Success',
        `Successfully removed ${assetName} from your wallet`,
        [{ text: 'OK', onPress: () => navigation.goBack() }]
      );
    } catch (error: any) {
      Alert.alert('Error', `Failed to opt out: ${error.message}`);
    } finally {
      setOptingOut(false);
    }
  };

  const handleAuthCancel = () => {
    if (!optingOut) {
      setShowAuthModal(false);
    }
  };

  const canOptOut = () => {
    const asset = getAsset();
    if (!asset || asset.assetType !== 'asa' || assetId === 0) {
      return false;
    }

    const amount = asset.amount as unknown;
    if (typeof amount === 'bigint') {
      return amount === 0n;
    }

    if (typeof amount === 'number') {
      return amount === 0;
    }

    if (typeof amount === 'string') {
      const parsed = Number(amount);
      return Number.isFinite(parsed) && parsed === 0;
    }

    return false;
  };

  const filteredTransactions = getFilteredTransactions();

  const asset = effectiveBalance?.assets?.find(
    (a) =>
      a.assetId === assetId ||
      (a.assetType === 'arc200' && a.contractId === assetId)
  );
  const isArc200 = asset?.assetType === 'arc200';
  const assetKey = `${assetId}_${isArc200 ? 'arc200' : 'asa'}`;
  const pagination = accountState.assetTransactionsPagination?.[assetKey];

  const handleLoadMore = React.useCallback(() => {
    // Prevent duplicate calls
    if (loadMoreCalledRef.current) {
      return;
    }

    console.log('[handleLoadMore] Called - assetId:', assetId);
    console.log('[handleLoadMore] Asset pagination state:', JSON.stringify(pagination));

    if (!pagination || !pagination.hasMore || pagination.isLoadingMore) {
      console.log('[handleLoadMore] Skipping - no more data or already loading');
      return;
    }

    console.log('[handleLoadMore] Triggering loadMoreAssetTransactions');
    loadMoreCalledRef.current = true;
    loadMoreAssetTransactions(accountId, assetId, isArc200);

    setTimeout(() => {
      loadMoreCalledRef.current = false;
    }, 1000);
  }, [assetId, accountId, pagination, isArc200, loadMoreAssetTransactions]);

  const renderTransactionItem = ({ item: tx }: { item: TransactionInfo }) => {
    const isOutgoing = tx.from === currentAccount?.address;

    return (
      <BlurredContainer
        style={[
          styles.transactionItem,
          isOutgoing
            ? styles.outgoingTransaction
            : styles.incomingTransaction,
        ]}
        borderRadius={theme.borderRadius.lg}
        opacity={0.7}
      >
        <TouchableOpacity
          style={{ flex: 1 }}
          onPress={() => handleTransactionPress(tx)}
        >
        <View style={styles.transactionContent}>
          <View style={styles.transactionHeader}>
            <View style={styles.transactionInfo}>
              <View style={styles.transactionTypeRow}>
                <Ionicons
                  name={getTransactionTypeIcon(tx.type) as any}
                  size={16}
                  color={getTransactionTypeColor(tx.type, isOutgoing)}
                  style={{ marginRight: 4 }}
                />
                <Text style={styles.transactionType}>
                  {formatTransactionType(tx.type)}
                </Text>
                {tx.type !== 'application-call' && (
                  <View
                    style={[
                      styles.statusBadge,
                      isOutgoing
                        ? styles.outgoingStatus
                        : styles.incomingStatus,
                    ]}
                  >
                    <Text style={styles.statusText}>
                      {isOutgoing ? 'Sent' : 'Received'}
                    </Text>
                  </View>
                )}
              </View>
              <TransactionAddressDisplay
                address={
                  tx.from === currentAccount?.address
                    ? tx.to
                    : tx.from
                }
                isOutgoing={tx.from === currentAccount?.address}
                style={styles.transactionAddress}
                nameStyle={styles.transactionName}
                addressStyle={styles.transactionAddressText}
              />
            </View>
            <View style={styles.transactionRightInfo}>
              <Ionicons
                name="chevron-forward"
                size={16}
                color={themeColors.textMuted}
              />
            </View>
          </View>
          <View style={styles.transactionAmountContainer}>
            <View style={styles.amountRow}>
              <Text
                style={[
                  styles.transactionAmountText,
                  {
                    color: isOutgoing
                      ? themeColors.error
                      : themeColors.success,
                  },
                ]}
                numberOfLines={1}
                ellipsizeMode="tail"
              >
                {isOutgoing ? '-' : '+'}
                {(() => {
                  if (assetId === 0) {
                    return `${formatBalance(tx.amount)} ${assetName}`;
                  } else {
                    const txAsset =
                      effectiveBalance?.assets?.find(
                        (a) =>
                          a.assetId === assetId ||
                          (tx.isArc200 && a.contractId === assetId)
                      );
                    return `${formatAssetBalance(tx.amount, txAsset?.decimals || 0)} ${txAsset?.symbol || assetName}`;
                  }
                })()}
              </Text>
            </View>
            <Text style={styles.transactionDate}>
              {formatTimestamp(tx.timestamp)}
            </Text>
          </View>
        </View>
        </TouchableOpacity>
      </BlurredContainer>
    );
  };

  const renderListHeader = () => (
    <>
        <GlassCard
          style={styles.balanceContainer}
          variant="medium"
        >
          {(() => {
            const asset = getAsset();
            const showImage = asset?.imageUrl && !imageError;

            return (
              <>
                <View style={styles.assetHeader}>
                  {assetId === 0 ? (
                    <Image
                      source={specificNetworkConfig.nativeTokenImage}
                      style={styles.assetImage}
                    />
                  ) : showImage ? (
                    <Image
                      source={{ uri: asset!.imageUrl }}
                      style={styles.assetImage}
                      onError={() => setImageError(true)}
                    />
                  ) : (
                    <View style={styles.placeholderIcon}>
                      <Ionicons
                        name="disc"
                        size={32}
                        color={themeColors.primary}
                      />
                    </View>
                  )}
                  <View style={styles.assetTitleSection}>
                    <View style={styles.assetNameRow}>
                      <Text style={styles.assetTitle}>
                        {asset?.name || assetName}
                      </Text>
                      {asset?.verified === 1 && (
                        <View style={styles.verifiedBadge}>
                          <Ionicons
                            name="checkmark-circle"
                            size={18}
                            color={themeColors.success}
                          />
                        </View>
                      )}
                    </View>
                    {asset?.symbol && (
                      <Text style={styles.assetSymbol}>{asset.symbol}</Text>
                    )}
                    {asset?.assetType === 'arc200' && (
                      <View style={styles.arc200Badge}>
                        <Text style={styles.arc200Text}>ARC-200 Token</Text>
                      </View>
                    )}
                  </View>
                </View>

                <Text style={styles.balanceLabel}>Balance</Text>
                <Text style={styles.balance}>
                  {getAssetBalance()} {asset?.symbol || assetName}
                </Text>
                <Text style={styles.balanceUsd}>
                  {assetId === 0
                    ? `${calculateNativeUsdValue()} USD`
                    : `${calculateAssetUsdValue()} USD`}
                </Text>

                {asset?.contractId && asset.assetType === 'arc200' && (
                  <View style={styles.contractInfo}>
                    <Text style={styles.contractLabel}>Contract ID:</Text>
                    <Text style={styles.contractId}>{asset.contractId}</Text>
                  </View>
                )}
                {asset?.assetType === 'asa' && (
                  <View style={styles.contractInfo}>
                    <Text style={styles.contractLabel}>Asset ID:</Text>
                    <Text style={styles.contractId}>{asset.assetId}</Text>
                  </View>
                )}
                {asset?.decimals && (
                  <View style={styles.decimalsInfo}>
                    <Text style={styles.decimalsLabel}>Decimals:</Text>
                    <Text style={styles.decimalsId}>{asset.decimals}</Text>
                  </View>
                )}
              </>
            );
          })()}
        </GlassCard>

        {/* Per-Network Breakdown for Mapped Assets */}
        {/* Only show breakdown if we're NOT viewing a specific network */}
        {!networkId && isMultiNetworkView && multiNetworkBalance && (() => {
          // Find mapped asset by mappingId if provided, otherwise by assetId
          const mappedAsset = multiNetworkBalance.assets.find(
            (a) => mappingId ? (a.mappingId === mappingId && a.isMapped) : (a.assetId === assetId && a.isMapped)
          );

          if (mappedAsset && mappedAsset.sourceBalances.length >= 1) {
            return (
              <BlurredContainer
                style={styles.networkBreakdownContainer}
                borderRadius={theme.borderRadius.lg}
                opacity={0.7}
              >
                <Text style={styles.networkBreakdownTitle}>Per-Network Breakdown</Text>
                {mappedAsset.sourceBalances.map((source, index) => {
                  const networkConfig = getNetworkConfig(source.networkId);
                  const sourceAsset = source.balance;
                  const isNative = sourceAsset.assetId === 0;

                  const balanceStr = isNative
                    ? formatNativeBalance(sourceAsset.amount, networkConfig.nativeToken)
                    : formatAssetBalance(sourceAsset.amount, sourceAsset.decimals);

                  return (
                    <View key={`${source.networkId}-${sourceAsset.assetId}-${index}`} style={styles.networkBreakdownRow}>
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
                            {sourceAsset.symbol || sourceAsset.name || `Asset ${sourceAsset.assetId}`} • ID: {sourceAsset.assetId}
                          </Text>
                        </View>
                      </View>
                      <Text style={styles.networkBreakdownBalance}>
                        {balanceStr}
                      </Text>
                    </View>
                  );
                })}
              </BlurredContainer>
            );
          }
          return null;
        })()}

        <View style={styles.actionButtonsContainer}>
          <GlassButton
            variant="secondary"
            size="md"
            icon="send"
            label="Send"
            tint="#007AFF"
            onPress={() =>
              navigation.navigate('Send', {
                assetName,
                assetId,
                accountId,
                networkId,
                mappingId,
              })
            }
            style={styles.actionButton}
          />

          {isSwappable && isSwapEnabled && (
            <GlassButton
              variant="secondary"
              size="md"
              icon="swap-horizontal"
              label="Swap"
              tint="#AF52DE"
              onPress={() =>
                navigation.navigate('Swap', {
                  assetName,
                  assetId,
                  accountId,
                  networkId,
                })
              }
              style={styles.actionButton}
            />
          )}

          <GlassButton
            variant="secondary"
            size="md"
            icon="download"
            label="Receive"
            tint="#30D158"
            onPress={() =>
              navigation.navigate('Receive', {
                assetName,
                assetId,
                accountId,
              })
            }
            style={styles.actionButton}
          />
        </View>

        {canOptOut() && (
          <TouchableOpacity
            style={styles.optOutButton}
            onPress={handleOptOut}
            disabled={optingOut}
          >
            <Ionicons name="remove-circle-outline" size={20} color="#EF4444" />
            <Text style={styles.optOutButtonText}>
              {optingOut ? 'Removing...' : 'Remove Asset'}
            </Text>
          </TouchableOpacity>
        )}

        <Text style={styles.transactionsTitle}>Transactions</Text>
      </>
  );

  const renderListFooter = () => {
    // All assets now use assetTransactionsPagination (including native VOI)
    if (!pagination?.hasMore) return null;

    return (
      <View style={{ paddingVertical: 20, alignItems: 'center' }}>
        {pagination?.isLoadingMore && (
          <ActivityIndicator size="small" color={themeColors.primary} />
        )}
      </View>
    );
  };

  const renderListEmpty = () => (
    <View style={styles.emptyTransactions}>
      <Ionicons
        name="receipt-outline"
        size={64}
        color={themeColors.textMuted}
      />
      <Text style={styles.emptyTitle}>No transactions yet</Text>
      <Text style={styles.emptySubtitle}>
        Transactions for this asset will appear here when they occur.
      </Text>
    </View>
  );

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
          contentContainerStyle={styles.content}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
          }
        >
          {renderListHeader()}
          {filteredTransactions.length === 0 ? (
            renderListEmpty()
          ) : (
            filteredTransactions.map((tx) => (
              <View key={tx.id}>
                {renderTransactionItem({ item: tx })}
              </View>
            ))
          )}
          {renderListFooter()}
        </ScrollView>

        {/* PIN Entry Modal */}
        <UnifiedAuthModal
          visible={showAuthModal}
          onSuccess={handleAuthSuccess}
          onCancel={handleAuthCancel}
          title="Confirm Asset Removal"
          message={`Authenticate to remove ${assetName} from your wallet`}
          purpose="sign_transaction"
          isProcessing={optingOut}
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
    content: {
      flexGrow: 1,
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
      marginBottom: 4,
    },
    arc200Badge: {
      backgroundColor: theme.colors.surface,
      paddingHorizontal: theme.spacing.xs,
      paddingVertical: theme.spacing.xs,
      borderRadius: theme.borderRadius.sm,
      alignSelf: 'flex-start',
    },
    arc200Text: {
      fontSize: 12,
      fontWeight: '600',
      color: theme.colors.primary,
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
    contractInfo: {
      flexDirection: 'row',
      alignItems: 'center',
      marginTop: theme.spacing.md,
      paddingTop: theme.spacing.md,
      borderTopWidth: 1,
      borderTopColor: theme.colors.borderLight,
    },
    contractLabel: {
      fontSize: 14,
      color: theme.colors.textSecondary,
      marginRight: theme.spacing.xs,
    },
    contractId: {
      fontSize: 14,
      fontWeight: '500',
      color: theme.colors.text,
      fontFamily: 'monospace',
    },
    decimalsInfo: {
      flexDirection: 'row',
      alignItems: 'center',
      borderTopWidth: 1,
      borderTopColor: theme.colors.borderLight,
    },
    decimalsLabel: {
      fontSize: 14,
      color: theme.colors.textSecondary,
      marginRight: theme.spacing.xs,
    },
    decimalsId: {
      fontSize: 14,
      fontWeight: '500',
      color: theme.colors.text,
      fontFamily: 'monospace',
    },
    actionButtonsContainer: {
      flexDirection: 'row',
      marginBottom: theme.spacing.lg,
      gap: theme.spacing.sm,
    },
    actionButton: {
      flex: 1,
    },
    optOutButton: {
      backgroundColor: theme.colors.card,
      borderColor: '#EF4444',
      borderWidth: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: theme.spacing.sm,
      paddingHorizontal: theme.spacing.md,
      borderRadius: theme.borderRadius.md,
      marginTop: theme.spacing.sm,
      marginHorizontal: theme.spacing.md,
      gap: theme.spacing.xs,
    },
    optOutButtonText: {
      color: '#EF4444',
      fontSize: 16,
      fontWeight: '600',
    },
    transactionsContainer: {
      marginTop: 16,
    },
    transactionsTitle: {
      fontSize: 18,
      fontWeight: '600',
      color: theme.colors.text,
      marginBottom: theme.spacing.md,
      textShadowColor: theme.mode === 'dark'
        ? 'rgba(0, 0, 0, 1.0)'
        : 'rgba(255, 255, 255, 1.0)',
      textShadowOffset: { width: 0, height: 0 },
      textShadowRadius: 16,
    },
    emptyTransactions: {
      paddingVertical: theme.spacing.xl,
      alignItems: 'center',
    },
    emptyTitle: {
      fontSize: 20,
      fontWeight: '600',
      color: theme.colors.text,
      marginTop: theme.spacing.md,
      marginBottom: theme.spacing.xs,
    },
    emptySubtitle: {
      fontSize: 16,
      color: theme.colors.textMuted,
      textAlign: 'center',
      lineHeight: 22,
      paddingHorizontal: theme.spacing.md,
    },
    transactionItem: {
      padding: theme.spacing.lg,
      marginBottom: theme.spacing.md,
      borderLeftWidth: 4,
      borderLeftColor: 'transparent',
    },
    outgoingTransaction: {
      borderLeftColor: theme.colors.error,
    },
    incomingTransaction: {
      borderLeftColor: theme.colors.success,
    },
    transactionContent: {
      flex: 1,
    },
    transactionHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'flex-start',
      marginBottom: theme.spacing.sm,
    },
    transactionInfo: {
      flex: 1,
      minWidth: 0,
      paddingRight: theme.spacing.sm,
    },
    transactionTypeRow: {
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: 2,
    },
    transactionType: {
      fontSize: 16,
      fontWeight: '700',
      color: theme.colors.text,
      flex: 1,
    },
    statusBadge: {
      paddingHorizontal: theme.spacing.xs,
      paddingVertical: 2,
      borderRadius: theme.borderRadius.sm,
      marginLeft: theme.spacing.xs,
    },
    outgoingStatus: {
      backgroundColor: theme.colors.error + '20',
    },
    incomingStatus: {
      backgroundColor: theme.colors.success + '20',
    },
    statusText: {
      fontSize: 10,
      fontWeight: '600',
      textTransform: 'uppercase',
      color: theme.colors.text,
    },
    transactionAddress: {
      fontSize: 12,
      color: theme.colors.textSecondary,
      marginBottom: 2,
    },
    transactionRightInfo: {
      alignItems: 'center',
      justifyContent: 'flex-start',
      minHeight: 40,
    },
    transactionDate: {
      fontSize: 12,
      color: theme.colors.textMuted,
      fontWeight: '500',
      marginTop: theme.spacing.xs,
    },
    transactionAmountContainer: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'flex-end',
    },
    amountRow: {
      flex: 1,
    },
    transactionAmountText: {
      fontSize: 18,
      fontWeight: '700',
      textAlign: 'left',
    },
    transactionName: {
      fontSize: 14,
      color: theme.colors.primary,
      fontWeight: '600',
    },
    transactionAddressText: {
      fontSize: 12,
      color: theme.colors.textMuted,
      fontFamily: 'monospace',
    },
    networkBreakdownContainer: {
      padding: theme.spacing.lg,
      marginHorizontal: theme.spacing.md,
      marginBottom: theme.spacing.lg,
    },
    networkBreakdownTitle: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.text,
      marginBottom: theme.spacing.md,
    },
    networkBreakdownRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingVertical: theme.spacing.sm,
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
      width: 10,
      height: 10,
      borderRadius: 5,
    },
    networkBreakdownInfo: {
      flex: 1,
    },
    networkBreakdownNetwork: {
      fontSize: 14,
      fontWeight: '500',
      color: theme.colors.text,
    },
    networkBreakdownAssetInfo: {
      fontSize: 12,
      color: theme.colors.textSecondary,
      marginTop: 2,
    },
    networkBreakdownBalance: {
      fontSize: 14,
      fontWeight: '600',
      color: theme.colors.text,
      textAlign: 'right',
    },
  });
