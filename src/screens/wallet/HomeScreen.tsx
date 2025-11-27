import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  RefreshControl,
  ScrollView,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
  BackHandler,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, CommonActions } from '@react-navigation/native';
import type { StackNavigationProp } from '@react-navigation/stack';
import { TransactionInfo } from '@/types/wallet';
import { useAuth } from '@/contexts/AuthContext';
import {
  useActiveAccount,
  useAccounts,
  useWalletStore,
  useActiveAccountBalance,
  useAccountEnvoiName,
  useViewMode,
  useIsMultiNetworkView,
  useMultiNetworkBalance,
  useAssetNetworkFilter,
  useAssetFilterSettings,
} from '@/store/walletStore';
import VoiNetworkService, { NetworkStatus } from '@/services/network';
import { formatNativeBalance, formatAssetBalance } from '@/utils/bigint';
import { formatCurrency } from '@/utils/formatting';
import { formatAddressSync } from '@/utils/address';
import { useCurrentNetworkConfig, useNetworkStore } from '@/store/networkStore';
import { getNetworkConfig } from '@/services/network/config';
import { NetworkId } from '@/types/network';
import AccountSelector from '@/components/account/AccountSelector';
import AccountListModal from '@/components/account/AccountListModal';
import UniversalHeader from '@/components/common/UniversalHeader';
import AddAccountModal from '@/components/account/AddAccountModal';
import AssetItem from '@/components/assets/AssetItem';
import MultiNetworkAssetItem from '@/components/assets/MultiNetworkAssetItem';
import AccountAvatar from '@/components/account/AccountAvatar';
import ViewModeToggle from '@/components/network/ViewModeToggle';
import NetworkFilterToggle from '@/components/assets/NetworkFilterToggle';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import AssetOptInModal from '@/components/assets/AssetOptInModal';
import AssetFilterModal from '@/components/assets/AssetFilterModal';
import type { AssetFilterSettings } from '@/components/assets/AssetFilterModal';
import { AssetBalance } from '@/types/wallet';
import { MappedAsset } from '@/services/token-mapping/types';
import { BlurredContainer } from '@/components/common/BlurredContainer';
import { useTheme } from '@/contexts/ThemeContext';

export default function HomeScreen() {
  const [networkStatus, setNetworkStatus] = useState<NetworkStatus | null>(
    null
  );
  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [isAccountModalVisible, setIsAccountModalVisible] = useState(false);
  const [isAddAccountModalVisible, setIsAddAccountModalVisible] =
    useState(false);
  const [isAssetOptInModalVisible, setIsAssetOptInModalVisible] =
    useState(false);
  const [isAssetFilterModalVisible, setIsAssetFilterModalVisible] =
    useState(false);

  const navigation = useNavigation<StackNavigationProp<any>>();
  const { updateActivity } = useAuth();
  const activeAccount = useActiveAccount();
  const currentNetworkConfig = useCurrentNetworkConfig();
  const styles = useThemedStyles(createStyles);
  const { theme } = useTheme();

  const initialize = useWalletStore((state) => state.initialize);
  const wallet = useWalletStore((state) => state.wallet);
  const loadAccountTransactions = useWalletStore(
    (state) => state.loadAccountTransactions
  );
  const allAccounts = useAccounts();
  const {
    balance: accountBalance,
    isLoading: isBalanceLoading,
    isBackgroundRefreshing,
    reload: reloadBalance,
  } = useActiveAccountBalance();
  const {
    nameInfo: envoiNameInfo,
    isLoading: isEnvoiLoading,
    reload: reloadEnvoiName,
  } = useAccountEnvoiName(activeAccount?.id || '');
  const loadEnvoiName = useWalletStore((state) => state.loadEnvoiName);

  // Multi-network view mode
  const viewMode = useViewMode();
  const isMultiNetworkView = useIsMultiNetworkView();
  const assetNetworkFilter = useAssetNetworkFilter();
  const {
    balance: multiNetworkBalance,
    isLoading: isMultiNetworkBalanceLoading,
  } = useMultiNetworkBalance(activeAccount?.id || '');
  const loadMultiNetworkBalance = useWalletStore(
    (state) => state.loadMultiNetworkBalance
  );
  const loadTokenMappings = useWalletStore((state) => state.loadTokenMappings);

  // Asset filter settings - use individual hooks to avoid unnecessary re-renders
  const assetSortBy = useWalletStore((state) => state.assetSortBy);
  const assetSortOrder = useWalletStore((state) => state.assetSortOrder);
  const assetFilterBalanceThreshold = useWalletStore(
    (state) => state.assetFilterBalanceThreshold
  );
  const assetFilterValueThreshold = useWalletStore(
    (state) => state.assetFilterValueThreshold
  );
  const assetNativeTokensFirst = useWalletStore(
    (state) => state.assetNativeTokensFirst
  );
  const setAssetSortBy = useWalletStore((state) => state.setAssetSortBy);
  const setAssetSortOrder = useWalletStore((state) => state.setAssetSortOrder);
  const setAssetFilterBalanceThreshold = useWalletStore(
    (state) => state.setAssetFilterBalanceThreshold
  );
  const setAssetFilterValueThreshold = useWalletStore(
    (state) => state.setAssetFilterValueThreshold
  );
  const setAssetNativeTokensFirst = useWalletStore(
    (state) => state.setAssetNativeTokensFirst
  );
  const resetAssetFilterSettings = useWalletStore(
    (state) => state.resetAssetFilterSettings
  );

  // Combined settings object for modal (memoized to prevent re-renders)
  const assetFilterSettings = React.useMemo(
    () => ({
      sortBy: assetSortBy,
      sortOrder: assetSortOrder,
      balanceThreshold: assetFilterBalanceThreshold,
      valueThreshold: assetFilterValueThreshold,
      nativeTokensFirst: assetNativeTokensFirst,
    }),
    [assetSortBy, assetSortOrder, assetFilterBalanceThreshold, assetFilterValueThreshold, assetNativeTokensFirst]
  );

  useEffect(() => {
    initializeWallet();
    updateActivity();
  }, []);

  // Handle Android back button for local modals
  useEffect(() => {
    const backHandler = BackHandler.addEventListener('hardwareBackPress', () => {
      // Close modals in order of priority (most recently likely opened first)
      if (isAssetFilterModalVisible) {
        setIsAssetFilterModalVisible(false);
        return true;
      }
      if (isAssetOptInModalVisible) {
        setIsAssetOptInModalVisible(false);
        return true;
      }
      if (isAddAccountModalVisible) {
        setIsAddAccountModalVisible(false);
        return true;
      }
      if (isAccountModalVisible) {
        setIsAccountModalVisible(false);
        return true;
      }
      return false; // Let default back behavior happen
    });

    return () => backHandler.remove();
  }, [isAccountModalVisible, isAddAccountModalVisible, isAssetOptInModalVisible, isAssetFilterModalVisible]);

  // Track the current view mode to prevent race conditions
  const viewModeRef = React.useRef(isMultiNetworkView);
  const activeAccountIdRef = React.useRef(activeAccount?.id);

  // Update refs when dependencies change
  React.useEffect(() => {
    viewModeRef.current = isMultiNetworkView;
    activeAccountIdRef.current = activeAccount?.id;
  }, [isMultiNetworkView, activeAccount?.id]);

  // Load data when active account changes - inline to avoid stale closure
  useEffect(() => {
    if (!activeAccount?.id) return;

    const loadData = async () => {
      const accountId = activeAccount.id;
      const currentViewMode = isMultiNetworkView;

      try {
        const [networkHealth] = await Promise.allSettled([
          VoiNetworkService.checkNetworkHealth(),
        ]);

        if (networkHealth.status === 'fulfilled') {
          setNetworkStatus(networkHealth.value);
        }

        // Check if view mode or account changed while loading
        if (viewModeRef.current !== currentViewMode || activeAccountIdRef.current !== accountId) {
          console.log('[HomeScreen] View mode or account changed during load, aborting');
          return;
        }

        // Load token mappings if needed for multi-network view
        if (currentViewMode) {
          await loadTokenMappings();
        }

        // Check again before loading balance
        if (viewModeRef.current !== currentViewMode || activeAccountIdRef.current !== accountId) {
          console.log('[HomeScreen] View mode or account changed after mappings, aborting');
          return;
        }

        // Trigger cache-first balance loading (will use cached data if available)
        // This will show cached data immediately and refresh in background if needed
        // ALWAYS load multi-network balance regardless of view mode since user can toggle
        await loadMultiNetworkBalance(accountId);

        // Final check before loading additional data
        if (viewModeRef.current !== currentViewMode || activeAccountIdRef.current !== accountId) {
          console.log('[HomeScreen] View mode or account changed after balance, aborting');
          return;
        }

        await Promise.all([
          loadAccountTransactions(accountId),
          loadEnvoiName(accountId),
        ]);
      } catch (error) {
        console.error('Failed to load account data:', error);
      }
    };

    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeAccount?.id,
    isMultiNetworkView,
    // Don't include function refs as they cause infinite loops
  ]);

  const handleUserInteraction = () => {
    updateActivity();
  };

  // Filter and sort utility functions
  const filterAndSortMultiNetworkAssets = React.useCallback(
    (assets: MappedAsset[]) => {
      let filtered = [...assets];

      // Apply balance threshold filter
      if (assetFilterBalanceThreshold !== null && assetFilterBalanceThreshold > 0) {
        filtered = filtered.filter((asset) => {
          let totalAmount = 0;
          asset.sourceBalances.forEach((source) => {
            const amount =
              typeof source.balance.amount === 'bigint'
                ? Number(source.balance.amount)
                : source.balance.amount;
            totalAmount += amount;
          });
          const normalizedBalance = totalAmount / 10 ** asset.decimals;
          return normalizedBalance >= assetFilterBalanceThreshold!;
        });
      }

      // Apply value threshold filter
      if (assetFilterValueThreshold !== null && assetFilterValueThreshold > 0) {
        filtered = filtered.filter((asset) => {
          let totalValue = 0;
          asset.sourceBalances.forEach((source) => {
            const sourceAsset = source.balance;
            if (sourceAsset.assetId === 0) {
              // Native token
              const price = multiNetworkBalance?.perNetworkPrices[source.networkId];
              if (price && sourceAsset.amount) {
                const amount =
                  typeof sourceAsset.amount === 'bigint'
                    ? Number(sourceAsset.amount)
                    : sourceAsset.amount;
                const nativeValue = amount / 1_000_000;
                totalValue += nativeValue * price;
              }
            } else if (sourceAsset.usdValue && sourceAsset.amount) {
              const unitPrice = parseFloat(sourceAsset.usdValue);
              const amount =
                typeof sourceAsset.amount === 'bigint'
                  ? Number(sourceAsset.amount)
                  : sourceAsset.amount;
              const normalizedBalance = amount / 10 ** sourceAsset.decimals;
              totalValue += normalizedBalance * unitPrice;
            }
          });
          return totalValue >= assetFilterValueThreshold!;
        });
      }

      // Sort assets
      filtered.sort((a, b) => {
        // If nativeTokensFirst is enabled, always put native tokens (assetId 0) first
        if (assetNativeTokensFirst) {
          const aIsNative = a.assetId === 0;
          const bIsNative = b.assetId === 0;

          if (aIsNative && !bIsNative) return -1;
          if (!aIsNative && bIsNative) return 1;
          // If both are native or both are non-native, continue with normal sorting
        }

        let compareValue = 0;

        if (assetSortBy === 'name') {
          const nameA = (a.name || a.symbol || `Asset ${a.assetId}`).toLowerCase();
          const nameB = (b.name || b.symbol || `Asset ${b.assetId}`).toLowerCase();
          compareValue = nameA.localeCompare(nameB);
        } else if (assetSortBy === 'balance') {
          let totalAmountA = 0;
          a.sourceBalances.forEach((source) => {
            const amount =
              typeof source.balance.amount === 'bigint'
                ? Number(source.balance.amount)
                : source.balance.amount;
            totalAmountA += amount;
          });
          const normalizedBalanceA = totalAmountA / 10 ** a.decimals;

          let totalAmountB = 0;
          b.sourceBalances.forEach((source) => {
            const amount =
              typeof source.balance.amount === 'bigint'
                ? Number(source.balance.amount)
                : source.balance.amount;
            totalAmountB += amount;
          });
          const normalizedBalanceB = totalAmountB / 10 ** b.decimals;

          compareValue = normalizedBalanceA - normalizedBalanceB;
        } else if (assetSortBy === 'value') {
          let totalValueA = 0;
          a.sourceBalances.forEach((source) => {
            const sourceAsset = source.balance;
            if (sourceAsset.assetId === 0) {
              const price = multiNetworkBalance?.perNetworkPrices[source.networkId];
              if (price && sourceAsset.amount) {
                const amount =
                  typeof sourceAsset.amount === 'bigint'
                    ? Number(sourceAsset.amount)
                    : sourceAsset.amount;
                const nativeValue = amount / 1_000_000;
                totalValueA += nativeValue * price;
              }
            } else if (sourceAsset.usdValue && sourceAsset.amount) {
              const unitPrice = parseFloat(sourceAsset.usdValue);
              const amount =
                typeof sourceAsset.amount === 'bigint'
                  ? Number(sourceAsset.amount)
                  : sourceAsset.amount;
              const normalizedBalance = amount / 10 ** sourceAsset.decimals;
              totalValueA += normalizedBalance * unitPrice;
            }
          });

          let totalValueB = 0;
          b.sourceBalances.forEach((source) => {
            const sourceAsset = source.balance;
            if (sourceAsset.assetId === 0) {
              const price = multiNetworkBalance?.perNetworkPrices[source.networkId];
              if (price && sourceAsset.amount) {
                const amount =
                  typeof sourceAsset.amount === 'bigint'
                    ? Number(sourceAsset.amount)
                    : sourceAsset.amount;
                const nativeValue = amount / 1_000_000;
                totalValueB += nativeValue * price;
              }
            } else if (sourceAsset.usdValue && sourceAsset.amount) {
              const unitPrice = parseFloat(sourceAsset.usdValue);
              const amount =
                typeof sourceAsset.amount === 'bigint'
                  ? Number(sourceAsset.amount)
                  : sourceAsset.amount;
              const normalizedBalance = amount / 10 ** sourceAsset.decimals;
              totalValueB += normalizedBalance * unitPrice;
            }
          });

          compareValue = totalValueA - totalValueB;
        }

        return assetSortOrder === 'asc' ? compareValue : -compareValue;
      });

      return filtered;
    },
    [assetSortBy, assetSortOrder, assetFilterBalanceThreshold, assetFilterValueThreshold, assetNativeTokensFirst, multiNetworkBalance]
  );

  const filterAndSortSingleNetworkAssets = React.useCallback(
    (assets: AssetBalance[]) => {
      let filtered = [...assets];

      // Apply balance threshold filter
      if (assetFilterBalanceThreshold !== null && assetFilterBalanceThreshold > 0) {
        filtered = filtered.filter((asset) => {
          const amount =
            typeof asset.amount === 'bigint' ? Number(asset.amount) : asset.amount;
          const normalizedBalance = amount / 10 ** asset.decimals;
          return normalizedBalance >= assetFilterBalanceThreshold!;
        });
      }

      // Apply value threshold filter (USD)
      if (assetFilterValueThreshold !== null && assetFilterValueThreshold > 0) {
        filtered = filtered.filter((asset) => {
          if (!asset.usdValue || !asset.amount) return false;

          const unitPrice = parseFloat(asset.usdValue);
          const amount =
            typeof asset.amount === 'bigint' ? Number(asset.amount) : asset.amount;
          const normalizedBalance = amount / 10 ** asset.decimals;
          const totalUsdValue = normalizedBalance * unitPrice;

          return totalUsdValue >= assetFilterValueThreshold!;
        });
      }

      // Sort assets
      filtered.sort((a, b) => {
        // If nativeTokensFirst is enabled, always put native tokens (assetId 0) first
        if (assetNativeTokensFirst) {
          const aIsNative = a.assetId === 0;
          const bIsNative = b.assetId === 0;

          if (aIsNative && !bIsNative) return -1;
          if (!aIsNative && bIsNative) return 1;
          // If both are native or both are non-native, continue with normal sorting
        }

        let compareValue = 0;

        if (assetSortBy === 'name') {
          const nameA = (
            a.name ||
            a.unitName ||
            a.symbol ||
            `Asset ${a.assetId}`
          ).toLowerCase();
          const nameB = (
            b.name ||
            b.unitName ||
            b.symbol ||
            `Asset ${b.assetId}`
          ).toLowerCase();
          compareValue = nameA.localeCompare(nameB);
        } else if (assetSortBy === 'balance') {
          const amountA =
            typeof a.amount === 'bigint' ? Number(a.amount) : a.amount;
          const normalizedBalanceA = amountA / 10 ** a.decimals;

          const amountB =
            typeof b.amount === 'bigint' ? Number(b.amount) : b.amount;
          const normalizedBalanceB = amountB / 10 ** b.decimals;

          compareValue = normalizedBalanceA - normalizedBalanceB;
        } else if (assetSortBy === 'value') {
          let valueA = 0;
          if (a.usdValue && a.amount) {
            const unitPrice = parseFloat(a.usdValue);
            const amount =
              typeof a.amount === 'bigint' ? Number(a.amount) : a.amount;
            const normalizedBalance = amount / 10 ** a.decimals;
            valueA = normalizedBalance * unitPrice;
          }

          let valueB = 0;
          if (b.usdValue && b.amount) {
            const unitPrice = parseFloat(b.usdValue);
            const amount =
              typeof b.amount === 'bigint' ? Number(b.amount) : b.amount;
            const normalizedBalance = amount / 10 ** b.decimals;
            valueB = normalizedBalance * unitPrice;
          }

          compareValue = valueA - valueB;
        }

        return assetSortOrder === 'asc' ? compareValue : -compareValue;
      });

      return filtered;
    },
    [assetSortBy, assetSortOrder, assetFilterBalanceThreshold, assetFilterValueThreshold, assetNativeTokensFirst]
  );

  const handleAssetPress = useCallback((assetName: string, assetId: number, mappingId?: string) => {
    if (!activeAccount) return;

    // In multi-network view, always navigate to MultiNetworkAssetScreen
    // It handles both single and multi-network assets gracefully
    if (isMultiNetworkView) {
      navigation.navigate('MultiNetworkAsset', {
        assetName,
        assetId,
        accountId: activeAccount.id,
        mappingId,
      });
      return;
    }

    // Single-network view: navigate directly to AssetDetail
    navigation.navigate('AssetDetail', {
      assetName,
      assetId,
      accountId: activeAccount.id,
      mappingId,
    });
  }, [activeAccount, isMultiNetworkView, navigation]);

  // Memoize multi-network asset list to prevent excessive re-renders
  const multiNetworkAssetList = React.useMemo(() => {
    if (!multiNetworkBalance?.assets || multiNetworkBalance.assets.length === 0) {
      return null;
    }

    // Filter assets based on network filter
    let filteredAssets = multiNetworkBalance.assets.filter((asset) => {
      if (assetNetworkFilter === 'all') {
        return true;
      }

      // Check if any source balance is from the filtered network
      const hasMatchingNetwork = asset.sourceBalances.some((source) => {
        if (assetNetworkFilter === 'voi') {
          return source.networkId === NetworkId.VOI_MAINNET;
        } else if (assetNetworkFilter === 'algorand') {
          return source.networkId === NetworkId.ALGORAND_MAINNET;
        }
        return false;
      });

      return hasMatchingNetwork;
    });

    // Apply filter and sort
    filteredAssets = filterAndSortMultiNetworkAssets(filteredAssets);

    if (filteredAssets.length === 0) {
      return null;
    }

    return filteredAssets.map((asset) => {
      const key = asset.mappingId || `${asset.primaryNetwork}-${asset.assetId}`;
      return (
        <MultiNetworkAssetItem
          key={key}
          asset={asset}
          nativePrices={multiNetworkBalance.perNetworkPrices}
          networkFilter={assetNetworkFilter}
          onPress={() =>
            handleAssetPress(
              asset.name || asset.symbol || `Asset ${asset.assetId}`,
              asset.assetId,
              asset.mappingId
            )
          }
        />
      );
    });
  }, [
    multiNetworkBalance?.assets,
    multiNetworkBalance?.perNetworkPrices,
    assetNetworkFilter,
    handleAssetPress,
    filterAndSortMultiNetworkAssets,
  ]);

  // Memoize single-network asset list to prevent excessive re-renders
  const singleNetworkAssetList = React.useMemo(() => {
    if (!accountBalance) {
      return null;
    }

    // Build asset list: native token + all other assets
    const nativeAsset: AssetBalance = {
      assetId: 0,
      amount: accountBalance.amount || 0,
      decimals: 6,
      name: currentNetworkConfig.nativeToken,
      symbol: currentNetworkConfig.nativeToken,
      assetType: 'asa',
      usdValue: accountBalance.voiPrice?.toString() || accountBalance.algoPrice?.toString(),
    };

    const allAssets = [nativeAsset, ...(accountBalance.assets || [])];

    // Apply filter and sort
    const filteredAndSortedAssets = filterAndSortSingleNetworkAssets(allAssets);

    if (filteredAndSortedAssets.length === 0) {
      return null;
    }

    return (
      <>
        {filteredAndSortedAssets.map((asset) => (
          <AssetItem
            key={`${asset.assetType || 'asa'}-${asset.assetId}`}
            asset={asset}
            isNative={asset.assetId === 0}
            nativePrice={accountBalance.voiPrice || accountBalance.algoPrice}
            onPress={() =>
              handleAssetPress(
                asset.name ||
                  asset.symbol ||
                  asset.unitName ||
                  `Asset ${asset.assetId}`,
                asset.assetId
              )
            }
          />
        ))}
      </>
    );
  }, [
    accountBalance,
    currentNetworkConfig,
    handleAssetPress,
    filterAndSortSingleNetworkAssets,
  ]);

  const initializeWallet = async () => {
    try {
      setLoading(true);
      await initialize();
    } catch (error) {
      console.error('Failed to initialize wallet:', error);
      Alert.alert('Error', 'Failed to load wallet data');
    } finally {
      setLoading(false);
    }
  };

  const loadAccountData = async () => {
    if (!activeAccount) return;

    try {
      const [networkHealth] = await Promise.allSettled([
        VoiNetworkService.checkNetworkHealth(),
      ]);

      if (networkHealth.status === 'fulfilled') {
        setNetworkStatus(networkHealth.value);
      }

      // Load balance and transactions through the store
      await reloadBalance();
      await Promise.all([
        loadAccountTransactions(activeAccount.id),
        loadEnvoiName(activeAccount.id),
      ]);
    } catch (error) {
      console.error('Failed to load account data:', error);
    }
  };

  const onRefresh = async () => {
    setRefreshing(true);
    handleUserInteraction();

    if (activeAccount) {
      // Only refresh the current account, not all accounts
      await loadAccountData();
    }

    setRefreshing(false);
  };

  useEffect(() => {
    if (!activeAccount?.id) return;
    void reloadEnvoiName();
  }, [activeAccount?.id, reloadEnvoiName]);

  const handleAccountSelectorPress = () => {
    setIsAccountModalVisible(true);
  };

  const handleAccountModalClose = () => {
    setIsAccountModalVisible(false);
  };

  const handleAddAccount = () => {
    setIsAccountModalVisible(false);
    setIsAddAccountModalVisible(true);
  };


  const handleQRScan = () => {
    navigation.navigate('QRScanner' as never);
  };

  const handleSend = () => {
    navigation.navigate('Send' as never);
  };

  const handleReceive = () => {
    navigation.navigate('Receive' as never);
  };

  const handleHistory = () => {
    navigation.navigate('TransactionHistory' as never);
  };

  const handleAddAsset = () => {
    setIsAssetOptInModalVisible(true);
  };

  const handleAssetOptInSuccess = () => {
    // Refresh balances after successful opt-in
    onRefresh();
  };

  const handleAccountInfo = () => {
    navigation.navigate('AccountInfo' as never);
  };

  const handleOpenAssetFilter = () => {
    setIsAssetFilterModalVisible(true);
  };

  const handleCloseAssetFilter = () => {
    setIsAssetFilterModalVisible(false);
  };

  const handleApplyAssetFilter = async (settings: AssetFilterSettings) => {
    await Promise.all([
      setAssetSortBy(settings.sortBy),
      setAssetSortOrder(settings.sortOrder),
      setAssetFilterBalanceThreshold(settings.balanceThreshold),
      setAssetFilterValueThreshold(settings.valueThreshold),
      setAssetNativeTokensFirst(settings.nativeTokensFirst),
    ]);
  };

  const handleResetAssetFilter = async () => {
    await resetAssetFilterSettings();
  };

  const formatAddress = (address: string) => {
    return `${address.slice(0, 6)}...${address.slice(-6)}`;
  };

  const formatBalance = (amount: number | bigint) => {
    return formatNativeBalance(amount, currentNetworkConfig.nativeToken);
  };

  const calculateTotalUsdValue = React.useMemo(() => {
    if (isMultiNetworkView && multiNetworkBalance) {
      // Multi-network calculation - ALWAYS show combined total regardless of filter
      let totalUsdValue = 0;

      // Calculate values from ALL mapped assets and networks (ignore filter for total)
      if (multiNetworkBalance.assets) {
        multiNetworkBalance.assets.forEach((mappedAsset) => {
          // Sum USD value from ALL source networks
          mappedAsset.sourceBalances.forEach((source) => {
            const sourceAsset = source.balance;

            // Check if native asset
            if (sourceAsset.assetId === 0) {
              const price = multiNetworkBalance.perNetworkPrices[source.networkId];
              if (price && sourceAsset.amount) {
                const amount =
                  typeof sourceAsset.amount === 'bigint'
                    ? Number(sourceAsset.amount)
                    : sourceAsset.amount;
                const nativeValue = amount / 1_000_000;
                totalUsdValue += nativeValue * price;
              }
            } else if (sourceAsset.usdValue && sourceAsset.amount) {
              const unitPrice = parseFloat(sourceAsset.usdValue);
              const amount =
                typeof sourceAsset.amount === 'bigint'
                  ? Number(sourceAsset.amount)
                  : sourceAsset.amount;
              const normalizedBalance = amount / 10 ** sourceAsset.decimals;
              totalUsdValue += normalizedBalance * unitPrice;
            }
          });
        });
      }

      return formatCurrency(totalUsdValue);
    }

    // Single-network calculation (existing logic)
    if (!accountBalance) return formatCurrency(0);

    let totalUsdValue = 0;

    // Add native token value
    const nativePrice = accountBalance.voiPrice || accountBalance.algoPrice;
    if (nativePrice && accountBalance.amount) {
      const amount =
        typeof accountBalance.amount === 'bigint'
          ? Number(accountBalance.amount)
          : accountBalance.amount;
      const nativeValue = amount / 1_000_000; // Convert micro-units to whole units
      totalUsdValue += nativeValue * nativePrice;
    }

    // Add asset values
    if (accountBalance.assets) {
      accountBalance.assets.forEach((asset) => {
        if (asset.usdValue && asset.amount) {
          const unitPrice = parseFloat(asset.usdValue);
          const amount =
            typeof asset.amount === 'bigint'
              ? Number(asset.amount)
              : asset.amount;
          const normalizedBalance = amount / 10 ** asset.decimals;
          totalUsdValue += normalizedBalance * unitPrice;
        }
      });
    }

    return formatCurrency(totalUsdValue);
  }, [isMultiNetworkView, multiNetworkBalance, accountBalance]);

  const calculateNetworkUsdValue = React.useCallback((targetNetworkId: NetworkId) => {
    if (!isMultiNetworkView || !multiNetworkBalance) {
      return 0;
    }

    let totalUsdValue = 0;

    if (multiNetworkBalance.assets) {
      multiNetworkBalance.assets.forEach((mappedAsset) => {
        mappedAsset.sourceBalances.forEach((source) => {
          // Only include the target network
          if (source.networkId !== targetNetworkId) {
            return;
          }

          const sourceAsset = source.balance;

          // Check if native asset
          if (sourceAsset.assetId === 0) {
            const price = multiNetworkBalance.perNetworkPrices[source.networkId];
            if (price && sourceAsset.amount) {
              const amount =
                typeof sourceAsset.amount === 'bigint'
                  ? Number(sourceAsset.amount)
                  : sourceAsset.amount;
              const nativeValue = amount / 1_000_000;
              totalUsdValue += nativeValue * price;
            }
          } else if (sourceAsset.usdValue && sourceAsset.amount) {
            const unitPrice = parseFloat(sourceAsset.usdValue);
            const amount =
              typeof sourceAsset.amount === 'bigint'
                ? Number(sourceAsset.amount)
                : sourceAsset.amount;
            const normalizedBalance = amount / 10 ** sourceAsset.decimals;
            totalUsdValue += normalizedBalance * unitPrice;
          }
        });
      });
    }

    return totalUsdValue;
  }, [isMultiNetworkView, multiNetworkBalance]);

  const voiNetworkUsdValue = React.useMemo(() => {
    return calculateNetworkUsdValue(NetworkId.VOI_MAINNET);
  }, [calculateNetworkUsdValue]);

  const algorandNetworkUsdValue = React.useMemo(() => {
    return calculateNetworkUsdValue(NetworkId.ALGORAND_MAINNET);
  }, [calculateNetworkUsdValue]);

  const calculateNativeTokenEquivalent = React.useMemo(() => {
    if (isMultiNetworkView && multiNetworkBalance) {
      // Multi-network: Show breakdown by network, filtered by assetNetworkFilter
      const parts: string[] = [];

      // Determine which networks to include based on filter
      const shouldIncludeNetwork = (networkId: NetworkId) => {
        if (assetNetworkFilter === 'all') return true;
        if (assetNetworkFilter === 'voi') return networkId === NetworkId.VOI_MAINNET;
        if (assetNetworkFilter === 'algorand') return networkId === NetworkId.ALGORAND_MAINNET;
        return true;
      };

      Object.entries(multiNetworkBalance.perNetworkAmounts).forEach(
        ([networkId, amount]) => {
          // Skip if this network is filtered out
          if (!shouldIncludeNetwork(networkId as NetworkId)) {
            return;
          }

          const config = getNetworkConfig(networkId as NetworkId);
          const amountNum = typeof amount === 'bigint' ? Number(amount) : amount;
          const formatted = formatNativeBalance(amountNum, config.nativeToken);
          parts.push(`${formatted} ${config.nativeToken}`);
        }
      );

      return parts.length > 0 ? parts.join(' + ') : formatNativeBalance(0, 'VOI');
    }

    // Single-network calculation (existing logic)
    const nativePrice = accountBalance?.voiPrice || accountBalance?.algoPrice;
    if (!nativePrice) return formatNativeBalance(0, currentNetworkConfig.nativeToken);

    // Get total USD value without formatting
    let totalUsdValue = 0;

    // Add native token value
    if (nativePrice && accountBalance.amount) {
      const amount =
        typeof accountBalance.amount === 'bigint'
          ? Number(accountBalance.amount)
          : accountBalance.amount;
      const nativeValue = amount / 1_000_000; // Convert micro-units to whole units
      totalUsdValue += nativeValue * nativePrice;
    }

    // Add asset values
    if (accountBalance.assets) {
      accountBalance.assets.forEach((asset) => {
        if (asset.usdValue && asset.amount) {
          const unitPrice = parseFloat(asset.usdValue);
          const amount =
            typeof asset.amount === 'bigint'
              ? Number(asset.amount)
              : asset.amount;
          const normalizedBalance = amount / 10 ** asset.decimals;
          totalUsdValue += normalizedBalance * unitPrice;
        }
      });
    }

    const nativeTokenEquivalent = totalUsdValue / nativePrice;
    // Convert to micro-units for formatting
    return formatNativeBalance(nativeTokenEquivalent * 1_000_000, currentNetworkConfig.nativeToken);
  }, [isMultiNetworkView, multiNetworkBalance, assetNetworkFilter, accountBalance, currentNetworkConfig]);

  if (loading) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <View style={styles.loadingContainer}>
          <Text style={styles.loadingText}>Loading wallet...</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
        <UniversalHeader
          title="Voi Wallet"
          subtitle={isMultiNetworkView ? "All Networks" : `Network: ${currentNetworkConfig.name}`}
          onAccountSelectorPress={handleAccountSelectorPress}
        />

        <ScrollView
          style={styles.scrollView}
          contentContainerStyle={styles.content}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
          }
          onScrollBeginDrag={handleUserInteraction}
        >
          {activeAccount && (
            <>
              <View style={styles.balanceContainerWrapper}>
                <BlurredContainer
                  style={styles.balanceContainer}
                  borderRadius={theme.borderRadius.lg}
                  opacity={0.6}
                >
                  <View style={styles.balanceHeader}>
                  <View style={styles.balanceHeaderLeft}>
                    <Text style={styles.balanceLabel}>Account Value</Text>
                    {isBackgroundRefreshing && (
                      <ActivityIndicator size="small" color="#007AFF" />
                    )}
                  </View>
                  <TouchableOpacity onPress={handleAccountInfo} style={styles.infoButton}>
                    <Ionicons name="information-circle-outline" size={20} color="#007AFF" />
                  </TouchableOpacity>
                </View>
                {isBalanceLoading && !accountBalance ? (
                  <View style={styles.loadingBalance}>
                    <ActivityIndicator size="small" color="#007AFF" />
                    <Text style={styles.loadingText}>Loading balance...</Text>
                  </View>
                ) : (
                  <>
                    <Text style={styles.balance}>{calculateTotalUsdValue}</Text>
                    {isMultiNetworkView && multiNetworkBalance && (
                      <View style={styles.networkBalanceBreakdown}>
                        <View style={styles.networkBalanceItem}>
                          <Text style={styles.networkBalanceLabel}>Voi</Text>
                          <Text style={styles.networkBalanceValue}>
                            {formatCurrency(voiNetworkUsdValue)}
                          </Text>
                        </View>
                        <View style={styles.networkBalanceItem}>
                          <Text style={styles.networkBalanceLabel}>Algorand</Text>
                          <Text style={styles.networkBalanceValue}>
                            {formatCurrency(algorandNetworkUsdValue)}
                          </Text>
                        </View>
                      </View>
                    )}
                  </>
                )}
                </BlurredContainer>
                <TouchableOpacity
                  onPress={handleQRScan}
                  style={styles.qrButtonTopRight}
                  accessibilityRole="button"
                  accessibilityLabel="Scan QR code"
                  accessibilityHint="Opens the QR scanner to connect or import"
                >
                  <Ionicons
                    name="qr-code-outline"
                    size={22}
                    style={styles.qrButtonIcon}
                  />
                </TouchableOpacity>
              </View>

            {false && (
              <View style={styles.addressContainer}>
                <Text style={styles.addressLabel}>Your Address</Text>
                <View style={styles.addressHeader}>
                  <AccountAvatar address={activeAccount?.address || ''} size={56} />
                  <View style={styles.addressDetails}>
                    {isEnvoiLoading ? (
                      <View style={styles.envoiLoading}>
                        <ActivityIndicator size="small" color="#3B82F6" />
                        <Text style={styles.loadingText}>
                          Looking up name...
                        </Text>
                      </View>
                    ) : envoiNameInfo?.name ? (
                      <Text style={styles.envoiName}>{envoiNameInfo?.name}</Text>
                    ) : (
                      <Text style={styles.address}>
                        {formatAddress(activeAccount?.address || '')}
                      </Text>
                    )}
                    <Text style={styles.fullAddress}>
                      {activeAccount?.address}
                    </Text>
                  </View>
                </View>
              </View>
            )}

            {/* View Mode Toggle - Hidden by default (multi-network is primary UX)
                 Users can switch networks via settings if needed */}
            {false && (
              <View style={styles.viewModeContainer}>
                <ViewModeToggle size="small" showLabel={false} />
              </View>
            )}

            <BlurredContainer
              style={styles.actionButtonsContainer}
              borderRadius={theme.borderRadius.lg}
              opacity={0.6}
            >
              <TouchableOpacity
                style={styles.actionButton}
                onPress={handleSend}
              >
                <Ionicons name="send" size={24} color="#007AFF" />
                <Text style={[styles.actionButtonText, { color: theme.colors.text }]}>Send</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.actionButton}
                onPress={handleReceive}
              >
                <Ionicons name="download" size={24} color="#007AFF" />
                <Text style={[styles.actionButtonText, { color: theme.colors.text }]}>Receive</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.actionButton}
                onPress={handleHistory}
              >
                <Ionicons name="time" size={24} color="#007AFF" />
                <Text style={[styles.actionButtonText, { color: theme.colors.text }]}>History</Text>
              </TouchableOpacity>
            </BlurredContainer>

            <BlurredContainer
              style={styles.assetsContainer}
              borderRadius={theme.borderRadius.lg}
              opacity={0.6}
            >
              <View style={styles.assetsHeader}>
                <View style={styles.assetsHeaderLeft}>
                  <Text style={styles.assetsTitle}>Assets</Text>
                </View>
                <View style={styles.assetsHeaderCenter}>
                  {isMultiNetworkView && <NetworkFilterToggle />}
                </View>
                <View style={styles.assetsHeaderRight}>
                  <TouchableOpacity
                    onPress={handleOpenAssetFilter}
                    style={styles.addAssetButton}
                  >
                    <Ionicons
                      name="filter-outline"
                      size={24}
                      color="#007AFF"
                    />
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={handleAddAsset}
                    style={styles.addAssetButton}
                  >
                    <Ionicons
                      name="add-circle-outline"
                      size={24}
                      color="#007AFF"
                    />
                  </TouchableOpacity>
                </View>
              </View>

              {isMultiNetworkView ? (
                // Multi-network view
                isMultiNetworkBalanceLoading && !multiNetworkBalance ? (
                  <View style={styles.loadingAssets}>
                    <ActivityIndicator size="small" color="#007AFF" />
                    <Text style={styles.loadingText}>Loading assets...</Text>
                  </View>
                ) : multiNetworkAssetList ? (
                  multiNetworkAssetList
                ) : (
                  <View style={styles.loadingAssets}>
                    <Text style={styles.loadingText}>No assets found</Text>
                  </View>
                )
              ) : (
                // Single-network view (existing behavior)
                isBalanceLoading && !accountBalance ? (
                  <View style={styles.loadingAssets}>
                    <ActivityIndicator size="small" color="#007AFF" />
                    <Text style={styles.loadingText}>Loading assets...</Text>
                  </View>
                ) : (
                  singleNetworkAssetList
                )
              )}
            </BlurredContainer>
          </>
        )}
      </ScrollView>

      {/* Account List Modal */}
      <AccountListModal
        isVisible={isAccountModalVisible}
        onClose={handleAccountModalClose}
        onAddAccount={handleAddAccount}
      />

      {/* Add Account Modal */}
      <AddAccountModal
        isVisible={isAddAccountModalVisible}
        onClose={() => setIsAddAccountModalVisible(false)}
        onCreateAccount={() => {
          console.log('HomeScreen: onCreateAccount called');
          setIsAddAccountModalVisible(false);
          console.log('HomeScreen: navigating to Settings then CreateAccount');
          // Navigate to Settings stack, then to CreateAccount
          navigation.dispatch(
            CommonActions.navigate({
              name: 'Settings',
              params: {
                screen: 'CreateAccount',
              },
            })
          );
          console.log(
            'HomeScreen: navigation dispatched to Settings->CreateAccount'
          );
        }}
        onImportAccount={() => {
          setIsAddAccountModalVisible(false);
          navigation.dispatch(
            CommonActions.navigate({
              name: 'Settings',
              params: {
                screen: 'MnemonicImport',
              },
            })
          );
        }}
        onImportQRAccount={() => {
          setIsAddAccountModalVisible(false);
          navigation.navigate('QRAccountImport' as never);
        }}
        onImportLedgerAccount={() => {
          setIsAddAccountModalVisible(false);
          navigation.navigate('LedgerAccountImport' as never);
        }}
        onAddWatchAccount={() => {
          setIsAddAccountModalVisible(false);
          navigation.dispatch(
            CommonActions.navigate({
              name: 'Settings',
              params: {
                screen: 'AddWatchAccount',
              },
            })
          );
        }}
      />


      {/* Asset Opt-In Modal */}
      <AssetOptInModal
        visible={isAssetOptInModalVisible}
        onClose={() => setIsAssetOptInModalVisible(false)}
        onSuccess={handleAssetOptInSuccess}
      />

      {/* Asset Filter Modal */}
      <AssetFilterModal
        visible={isAssetFilterModalVisible}
        currentSettings={assetFilterSettings}
        onClose={handleCloseAssetFilter}
        onApply={handleApplyAssetFilter}
        onReset={handleResetAssetFilter}
      />
    </SafeAreaView>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: theme.backgroundImageUrl ? 'transparent' : theme.colors.background,
    },
    scrollView: {
      flex: 1,
    },
    content: {
      flexGrow: 1,
      paddingHorizontal: theme.spacing.sm,
      paddingTop: theme.spacing.sm,
      paddingBottom: theme.spacing.xxl,
    },
    loadingContainer: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
    },
    loadingText: {
      fontSize: 14,
      color: theme.colors.textMuted,
      marginLeft: theme.spacing.sm,
    },
    loadingBalance: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: theme.spacing.md,
    },
    loadingAssets: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: theme.spacing.xl,
    },
    balanceContainerWrapper: {
      position: 'relative',
      marginBottom: theme.spacing.sm,
    },
    balanceContainer: {
      backgroundColor: theme.colors.card,
      borderRadius: theme.borderRadius.lg,
      padding: theme.spacing.lg,
      alignItems: 'center',
      borderWidth: 1,
      borderColor: theme.colors.border,
      ...theme.shadows.md,
    },
    balanceHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: 5,
    },
    balanceHeaderLeft: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.sm,
    },
    qrButtonTopRight: {
      position: 'absolute',
      top: theme.spacing.md,
      right: theme.spacing.md,
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: theme.colors.primary,
      paddingVertical: theme.spacing.xs,
      paddingHorizontal: theme.spacing.sm,
      borderRadius: theme.borderRadius.md,
      zIndex: 10,
      ...theme.shadows.md,
    },
    qrButtonIcon: {
      color: theme.colors.buttonText,
    },
    qrButtonText: {
      color: theme.colors.buttonText,
      fontSize: 14,
      fontWeight: '600',
    },
    infoButton: {
      padding: theme.spacing.xs,
    },
    balanceLabel: {
      fontSize: 16,
      color: theme.colors.textSecondary,
    },
    balance: {
      fontSize: 32,
      fontWeight: 'bold',
      color: theme.colors.text,
      marginBottom: 5,
    },
    networkBalanceBreakdown: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      width: '100%',
      marginTop: theme.spacing.xs,
      paddingTop: theme.spacing.xs,
      borderTopWidth: 1,
      borderTopColor: theme.colors.border,
    },
    networkBalanceItem: {
      flex: 1,
      alignItems: 'center',
    },
    networkBalanceLabel: {
      fontSize: 12,
      color: theme.colors.textSecondary,
      marginBottom: 2,
    },
    networkBalanceValue: {
      fontSize: 14,
      fontWeight: '600',
      color: theme.colors.text,
    },
    balanceUsd: {
      fontSize: 16,
      color: theme.colors.textMuted,
    },
    minBalance: {
      fontSize: 12,
      color: theme.colors.textMuted,
      marginTop: 5,
    },
    viewModeContainer: {
      marginBottom: theme.spacing.sm,
      alignItems: 'center',
    },
    addressContainer: {
      backgroundColor: theme.colors.card,
      borderRadius: theme.borderRadius.lg,
      padding: theme.spacing.md,
      marginBottom: theme.spacing.md,
    },
    addressHeader: {
      flexDirection: 'row',
      alignItems: 'center',
    },
    addressDetails: {
      marginLeft: theme.spacing.md,
      flex: 1,
    },
    addressLabel: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.text,
      marginBottom: 10,
    },
    envoiName: {
      fontSize: 20,
      fontWeight: '600',
      color: theme.colors.primary,
      marginBottom: 5,
    },
    envoiLoading: {
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: 5,
    },
    address: {
      fontSize: 18,
      fontWeight: '500',
      color: theme.colors.primary,
      marginBottom: 5,
    },
    fullAddress: {
      fontSize: 12,
      color: theme.colors.textMuted,
      fontFamily: 'monospace',
    },
    actionButtonsContainer: {
      backgroundColor: theme.colors.card,
      borderRadius: theme.borderRadius.lg,
      padding: theme.spacing.md,
      marginBottom: theme.spacing.sm,
      flexDirection: 'row',
      justifyContent: 'space-around',
      alignItems: 'center',
      borderWidth: 1,
      borderColor: theme.colors.border,
      ...theme.shadows.sm,
    },
    actionButton: {
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: 12,
      paddingHorizontal: theme.spacing.md,
      minWidth: 80,
    },
    actionButtonText: {
      fontSize: 14,
      fontWeight: '600',
      color: theme.colors.primary,
      marginTop: 4,
    },
    assetsContainer: {
      backgroundColor: theme.colors.card,
      borderRadius: theme.borderRadius.lg,
      padding: theme.spacing.md,
      marginBottom: theme.spacing.sm,
      borderWidth: 1,
      borderColor: theme.colors.border,
      ...theme.shadows.sm,
    },
    assetsHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: 15,
    },
    assetsTitle: {
      fontSize: 18,
      fontWeight: '600',
      color: theme.colors.text,
    },
    assetsHeaderLeft: {
      flexShrink: 0,
    },
    assetsHeaderCenter: {
      flex: 1,
      alignItems: 'center',
    },
    assetsHeaderRight: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.sm,
      marginLeft: 'auto',
    },
    addAssetButton: {
      padding: theme.spacing.xs,
    },
  });
