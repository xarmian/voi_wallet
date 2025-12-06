import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  AccountMetadata,
  AccountType,
  StandardAccountMetadata,
  WatchAccountMetadata,
  RekeyedAccountMetadata,
  Wallet,
  WalletSettings,
  CreateAccountRequest,
  ImportAccountRequest,
  AddWatchAccountRequest,
  DetectRekeyedAccountRequest,
  AccountBalance,
  TransactionInfo,
  AccountNotFoundError,
  AccountExistsError,
} from '../types/wallet';
import { MultiAccountWalletService } from '../services/wallet';
import rekeyManager from '@/services/wallet/rekeyManager';
import { NetworkService, VoiNetworkService } from '../services/network';
import { NetworkId } from '../types/network';
import EnvoiService, { EnvoiNameInfo } from '../services/envoi';
import { MimirApiService, Arc200TokenMetadata } from '../services/mimir';
import tokenMappingService, { TokenMappingService } from '../services/token-mapping';
import { MultiNetworkBalanceService } from '../services/network/multi-network';
import {
  TokenMapping,
  MultiNetworkBalance,
} from '../services/token-mapping/types';
import { dedupeTransactions } from '@/utils/transactions';
import {
  AssetSortBy,
  AssetSortOrder,
  AssetFilterStorage,
  DEFAULT_ASSET_FILTER_SETTINGS,
} from '@/utils/assetFilterStorage';
import {
  notificationService,
  DEFAULT_NOTIFICATION_PREFERENCES,
} from '@/services/notifications';
import { realtimeService } from '@/services/realtime';

// Account-specific state for UI
interface AccountUIState {
  isLoading: boolean;
  lastError: string | null;
  balance?: AccountBalance;
  recentTransactions: TransactionInfo[];
  isBalanceLoading: boolean;
  isBackgroundRefreshing: boolean;
  balanceLastUpdated: number;
  isTransactionsLoading: boolean;
  envoiName?: EnvoiNameInfo | null;
  isEnvoiLoading: boolean;
  // Pagination state for transactions
  transactionsPagination?: {
    nextToken?: string;
    hasMore: boolean;
    isLoadingMore: boolean;
  };
  // Pagination state for asset-specific transactions
  assetTransactionsPagination?: Record<string, {
    nextToken?: string;
    hasMore: boolean;
    isLoadingMore: boolean;
  }>;
  // Multi-network balance state
  multiNetworkBalance?: MultiNetworkBalance;
  isMultiNetworkBalanceLoading: boolean;
  multiNetworkBalanceLastUpdated: number;
}

// Main wallet store state
interface WalletState {
  // Core wallet data
  wallet: Wallet | null;
  isInitialized: boolean;
  isLoading: boolean;
  lastError: string | null;

  // Account-specific UI states
  accountStates: Record<string, AccountUIState>;

  // Token metadata cache
  tokenMetadataCache: Record<number, Arc200TokenMetadata>;
  pendingTokenRequests: Set<number>;

  // Multi-network view mode
  viewMode: 'single-network' | 'multi-network';
  assetNetworkFilter: 'all' | 'voi' | 'algorand';
  tokenMappings: TokenMapping[];
  isTokenMappingsLoading: boolean;

  // Asset filter and sort settings
  assetSortBy: AssetSortBy;
  assetSortOrder: AssetSortOrder;
  assetFilterBalanceThreshold: number | null;
  assetFilterValueThreshold: number | null;
  assetNativeTokensFirst: boolean;

  // UI state
  isAccountSelectorVisible: boolean;
  isAddAccountModalVisible: boolean;
  selectedAccountType: AccountType | null;

  // Actions
  initialize: () => Promise<void>;
  refresh: () => Promise<void>;

  // Account management actions
  createAccount: (
    request: CreateAccountRequest
  ) => Promise<StandardAccountMetadata>;
  importAccount: (
    request: ImportAccountRequest
  ) => Promise<StandardAccountMetadata>;
  addWatchAccount: (
    request: AddWatchAccountRequest
  ) => Promise<WatchAccountMetadata>;
  detectRekeyedAccount: (
    request: DetectRekeyedAccountRequest
  ) => Promise<RekeyedAccountMetadata>;
  deleteAccount: (accountId: string) => Promise<void>;

  // Account operations
  setActiveAccount: (accountId: string) => Promise<void>;
  updateAccountLabel: (accountId: string, label: string) => Promise<void>;
  updateAccountColor: (accountId: string, color: string) => Promise<void>;
  toggleAccountVisibility: (accountId: string) => Promise<void>;

  // Balance and transaction management
  loadAccountBalance: (accountId: string, forceRefresh?: boolean) => Promise<void>;
  loadAccountTransactions: (accountId: string) => Promise<void>;
  loadAssetTransactions: (
    accountId: string,
    assetId: number,
    isArc200?: boolean
  ) => Promise<void>;
  loadMoreAssetTransactions: (
    accountId: string,
    assetId: number,
    isArc200?: boolean
  ) => Promise<void>;
  loadAllTransactions: (accountId: string) => Promise<void>;
  loadMoreTransactions: (accountId: string) => Promise<void>;
  refreshAllBalances: () => Promise<void>;

  // Envoi name management
  loadEnvoiName: (accountId: string) => Promise<void>;
  loadEnvoiNamesBatch: (accountIds: string[]) => Promise<void>;
  refreshAllEnvoiNames: () => Promise<void>;

  // Token metadata cache management
  loadTokenMetadata: (contractIds: number[]) => Promise<void>;
  getTokenMetadata: (contractId: number) => Arc200TokenMetadata | null;

  // Multi-network view mode management
  setViewMode: (mode: 'single-network' | 'multi-network') => Promise<void>;
  toggleViewMode: () => Promise<void>;
  setAssetNetworkFilter: (filter: 'all' | 'voi' | 'algorand') => Promise<void>;
  loadMultiNetworkBalance: (accountId: string, forceRefresh?: boolean) => Promise<void>;
  loadTokenMappings: (forceRefresh?: boolean) => Promise<void>;
  refreshTokenMappings: () => Promise<void>;

  // Asset filter and sort management
  setAssetSortBy: (sortBy: AssetSortBy) => Promise<void>;
  setAssetSortOrder: (sortOrder: AssetSortOrder) => Promise<void>;
  setAssetFilterBalanceThreshold: (threshold: number | null) => Promise<void>;
  setAssetFilterValueThreshold: (threshold: number | null) => Promise<void>;
  setAssetNativeTokensFirst: (nativeFirst: boolean) => Promise<void>;
  loadAssetFilterSettings: () => Promise<void>;
  resetAssetFilterSettings: () => Promise<void>;

  // Cache management
  clearSingleNetworkCache: (accountId?: string) => Promise<void>;
  clearMultiNetworkCache: (accountId?: string) => Promise<void>;
  clearAllBalanceCache: () => Promise<void>;

  // Wallet settings
  updateWalletSettings: (settings: Partial<WalletSettings>) => Promise<void>;

  // UI state actions
  showAccountSelector: () => void;
  hideAccountSelector: () => void;
  showAddAccountModal: (accountType?: AccountType) => void;
  hideAddAccountModal: () => void;

  // Error handling
  clearError: () => void;
  clearAccountError: (accountId: string) => void;
}

const createInitialAccountState = (): AccountUIState => ({
  isLoading: false,
  lastError: null,
  recentTransactions: [],
  isBalanceLoading: false,
  isBackgroundRefreshing: false,
  balanceLastUpdated: 0,
  isTransactionsLoading: false,
  envoiName: null,
  isEnvoiLoading: false,
  transactionsPagination: {
    hasMore: true,
    isLoadingMore: false,
  },
  multiNetworkBalance: undefined,
  isMultiNetworkBalanceLoading: false,
  multiNetworkBalanceLastUpdated: 0,
});

// Helper functions for persistent balance cache
const BALANCE_CACHE_KEY = '@voi_wallet_balance_cache_v2'; // v2: Network-aware caching
const MULTI_NETWORK_BALANCE_CACHE_KEY = '@voi_wallet_multi_network_balance_cache';

interface PersistedBalanceData {
  balance: AccountBalance;
  lastUpdated: number;
  networkId: NetworkId; // Track which network this balance is from
}

interface PersistedMultiNetworkBalanceData {
  balance: MultiNetworkBalance;
  lastUpdated: number;
}

// Generate cache key for single-network balance
const getSingleNetworkCacheKey = (accountId: string, networkId: NetworkId): string => {
  return `${accountId}_single_${networkId}`;
};

// Generate cache key for multi-network balance
const getMultiNetworkCacheKey = (accountId: string): string => {
  return `${accountId}_multi`;
};

const persistBalanceCache = async (balanceCache: Record<string, PersistedBalanceData>) => {
  try {
    // Custom JSON serialization that handles BigInt values
    const serializedData = JSON.stringify(balanceCache, (key, value) => {
      if (typeof value === 'bigint') {
        return { __bigint: value.toString() };
      }
      return value;
    });
    await AsyncStorage.setItem(BALANCE_CACHE_KEY, serializedData);
  } catch (error) {
    console.warn('Failed to persist balance cache:', error);
  }
};

const loadPersistedBalanceCache = async (): Promise<Record<string, PersistedBalanceData>> => {
  try {
    const cached = await AsyncStorage.getItem(BALANCE_CACHE_KEY);
    if (cached) {
      // Custom JSON deserialization that handles BigInt values
      return JSON.parse(cached, (key, value) => {
        if (value && typeof value === 'object' && value.__bigint) {
          return BigInt(value.__bigint);
        }
        return value;
      });
    }
  } catch (error) {
    console.warn('Failed to load persisted balance cache:', error);
  }
  return {};
};

const persistBalanceToStorage = async (
  accountId: string,
  balance: AccountBalance,
  lastUpdated: number,
  networkId: NetworkId
) => {
  try {
    const cacheKey = getSingleNetworkCacheKey(accountId, networkId);

    // Load existing cache
    const existingCache = await loadPersistedBalanceCache();

    // Update with new balance data (using network-specific key)
    const updatedCache = {
      ...existingCache,
      [cacheKey]: {
        balance,
        lastUpdated,
        networkId,
      },
    };

    // Persist the updated cache
    await persistBalanceCache(updatedCache);
  } catch (error) {
    console.warn('Failed to persist balance for account:', accountId, error);
  }
};

// Multi-network balance cache functions
const persistMultiNetworkBalanceCache = async (
  balanceCache: Record<string, PersistedMultiNetworkBalanceData>
) => {
  try {
    const serializedData = JSON.stringify(balanceCache, (key, value) => {
      if (typeof value === 'bigint') {
        return { __bigint: value.toString() };
      }
      return value;
    });
    await AsyncStorage.setItem(MULTI_NETWORK_BALANCE_CACHE_KEY, serializedData);
  } catch (error) {
    console.warn('Failed to persist multi-network balance cache:', error);
  }
};

const loadPersistedMultiNetworkBalanceCache = async (): Promise<Record<string, PersistedMultiNetworkBalanceData>> => {
  try {
    const cached = await AsyncStorage.getItem(MULTI_NETWORK_BALANCE_CACHE_KEY);
    if (cached) {
      return JSON.parse(cached, (key, value) => {
        if (value && typeof value === 'object' && value.__bigint) {
          return BigInt(value.__bigint);
        }
        return value;
      });
    }
  } catch (error) {
    console.warn('Failed to load persisted multi-network balance cache:', error);
  }
  return {};
};

const persistMultiNetworkBalanceToStorage = async (
  accountId: string,
  balance: MultiNetworkBalance,
  lastUpdated: number
) => {
  try {
    const cacheKey = getMultiNetworkCacheKey(accountId);

    // Load existing cache
    const existingCache = await loadPersistedMultiNetworkBalanceCache();

    // Update with new balance data
    const updatedCache = {
      ...existingCache,
      [cacheKey]: {
        balance,
        lastUpdated,
      },
    };

    // Persist the updated cache
    await persistMultiNetworkBalanceCache(updatedCache);
  } catch (error) {
    console.warn('Failed to persist multi-network balance for account:', accountId, error);
  }
};

export const useWalletStore = create<WalletState>()(
  subscribeWithSelector((set, get) => ({
    // Initial state
    wallet: null,
    isInitialized: false,
    isLoading: false,
    lastError: null,
    accountStates: {},
    tokenMetadataCache: {},
    pendingTokenRequests: new Set(),
    viewMode: 'multi-network', // Default to multi-network view
    assetNetworkFilter: 'all', // Default to showing all networks
    tokenMappings: [],
    isTokenMappingsLoading: false,
    assetSortBy: DEFAULT_ASSET_FILTER_SETTINGS.sortBy,
    assetSortOrder: DEFAULT_ASSET_FILTER_SETTINGS.sortOrder,
    assetFilterBalanceThreshold: DEFAULT_ASSET_FILTER_SETTINGS.balanceThreshold,
    assetFilterValueThreshold: DEFAULT_ASSET_FILTER_SETTINGS.valueThreshold,
    assetNativeTokensFirst: DEFAULT_ASSET_FILTER_SETTINGS.nativeTokensFirst,
    isAccountSelectorVisible: false,
    isAddAccountModalVisible: false,
    selectedAccountType: null,

    // All getters removed to prevent infinite loops

    // Initialization
    initialize: async () => {
      try {
        set({ isLoading: true, lastError: null });

        // Load persisted asset network filter
        try {
          const persistedFilter = await AsyncStorage.getItem('@wallet-asset-network-filter');
          if (persistedFilter && ['all', 'voi', 'algorand'].includes(persistedFilter)) {
            set({ assetNetworkFilter: persistedFilter as 'all' | 'voi' | 'algorand' });
          }
        } catch (error) {
          console.warn('Failed to load persisted asset network filter:', error);
        }

        // Load persisted asset filter settings
        try {
          const filterSettings = await AssetFilterStorage.loadAssetFilterSettings();
          set({
            assetSortBy: filterSettings.sortBy,
            assetSortOrder: filterSettings.sortOrder,
            assetFilterBalanceThreshold: filterSettings.balanceThreshold,
            assetFilterValueThreshold: filterSettings.valueThreshold,
            assetNativeTokensFirst: filterSettings.nativeTokensFirst,
          });
        } catch (error) {
          console.warn('Failed to load persisted asset filter settings:', error);
        }

        const wallet = await MultiAccountWalletService.getCurrentWallet();

        if (wallet) {
          // Initialize account states
          const accountStates: Record<string, AccountUIState> = {};
          wallet.accounts.forEach((account) => {
            accountStates[account.id] = createInitialAccountState();
          });

          const currentViewMode = get().viewMode;
          const networkService = NetworkService.getInstance();
          const currentNetwork = networkService.getCurrentNetworkId();

          if (currentViewMode === 'multi-network') {
            // Load multi-network cached balances
            const persistedMultiCache = await loadPersistedMultiNetworkBalanceCache();

            wallet.accounts.forEach((account) => {
              const cacheKey = getMultiNetworkCacheKey(account.id);
              const persistedData = persistedMultiCache[cacheKey];

              if (persistedData && persistedData.balance) {
                accountStates[account.id] = {
                  ...accountStates[account.id],
                  multiNetworkBalance: persistedData.balance,
                  multiNetworkBalanceLastUpdated: persistedData.lastUpdated,
                };
              }
            });
          } else {
            // Load single-network cached balances
            const persistedCache = await loadPersistedBalanceCache();

            wallet.accounts.forEach((account) => {
              const cacheKey = getSingleNetworkCacheKey(account.id, currentNetwork);
              const persistedData = persistedCache[cacheKey];

              // Verify the cached data is for the current network
              if (persistedData && persistedData.balance && persistedData.networkId === currentNetwork) {
                accountStates[account.id] = {
                  ...accountStates[account.id],
                  balance: persistedData.balance,
                  balanceLastUpdated: persistedData.lastUpdated,
                };
              }
            });
          }

          set({
            wallet,
            accountStates,
            isInitialized: true,
          });
        } else {
          set({ isInitialized: true });
        }
      } catch (error) {
        set({
          lastError:
            error instanceof Error
              ? error.message
              : 'Failed to initialize wallet',
          isInitialized: true,
        });
      } finally {
        set({ isLoading: false });
      }
    },

    refresh: async () => {
      const { initialize } = get();
      await initialize();
    },


    // Account management
    createAccount: async (request: CreateAccountRequest) => {
      try {
        set({ isLoading: true, lastError: null });

        const newAccount =
          await MultiAccountWalletService.createStandardAccount(request);

        // If this is the first account, create the wallet
        let { wallet } = get();
        if (!wallet) {
          wallet = await MultiAccountWalletService.createWallet(newAccount);
        } else {
          wallet = await MultiAccountWalletService.getCurrentWallet();
        }

        // Initialize account state
        const { accountStates } = get();
        accountStates[newAccount.id] = createInitialAccountState();

        set({
          wallet,
          accountStates: { ...accountStates },
        });

        // Auto-subscribe new account to notifications if service is initialized
        if (notificationService.getDeviceId()) {
          notificationService
            .subscribeAccount(newAccount.address, DEFAULT_NOTIFICATION_PREFERENCES)
            .catch(err => console.warn('Failed to subscribe new account to notifications:', err));
          realtimeService.addAddress(newAccount.address);
        }

        return newAccount;
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : 'Failed to create account';
        set({ lastError: errorMessage });
        throw error;
      } finally {
        set({ isLoading: false });
      }
    },

    importAccount: async (request: ImportAccountRequest) => {
      try {
        set({ isLoading: true, lastError: null });

        const importedAccount =
          await MultiAccountWalletService.importStandardAccount(request);
        const wallet = await MultiAccountWalletService.getCurrentWallet();

        // Initialize account state
        const { accountStates } = get();
        accountStates[importedAccount.id] = createInitialAccountState();

        set({
          wallet,
          accountStates: { ...accountStates },
        });

        // Auto-subscribe imported account to notifications if service is initialized
        if (notificationService.getDeviceId()) {
          notificationService
            .subscribeAccount(importedAccount.address, DEFAULT_NOTIFICATION_PREFERENCES)
            .catch(err => console.warn('Failed to subscribe imported account to notifications:', err));
          realtimeService.addAddress(importedAccount.address);
        }

        return importedAccount;
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : 'Failed to import account';
        set({ lastError: errorMessage });
        throw error;
      } finally {
        set({ isLoading: false });
      }
    },

    addWatchAccount: async (request: AddWatchAccountRequest) => {
      try {
        set({ isLoading: true, lastError: null });

        const watchAccount =
          await MultiAccountWalletService.addWatchAccount(request);
        const wallet = await MultiAccountWalletService.getCurrentWallet();

        // Initialize account state
        const { accountStates } = get();
        accountStates[watchAccount.id] = createInitialAccountState();

        set({
          wallet,
          accountStates: { ...accountStates },
        });

        // Auto-subscribe watch account to notifications (with messages disabled)
        if (notificationService.getDeviceId()) {
          notificationService
            .subscribeAccount(watchAccount.address, {
              ...DEFAULT_NOTIFICATION_PREFERENCES,
              messages: false, // Watch accounts can't decrypt messages
            })
            .catch(err => console.warn('Failed to subscribe watch account to notifications:', err));
          realtimeService.addAddress(watchAccount.address);
        }

        return watchAccount;
      } catch (error) {
        const errorMessage =
          error instanceof Error
            ? error.message
            : 'Failed to add watch account';
        set({ lastError: errorMessage });
        throw error;
      } finally {
        set({ isLoading: false });
      }
    },

    detectRekeyedAccount: async (request: DetectRekeyedAccountRequest) => {
      try {
        set({ isLoading: true, lastError: null });

        const rekeyedAccount =
          await MultiAccountWalletService.detectRekeyedAccount(request);
        const wallet = await MultiAccountWalletService.getCurrentWallet();

        // Initialize account state
        const { accountStates } = get();
        accountStates[rekeyedAccount.id] = createInitialAccountState();

        set({
          wallet,
          accountStates: { ...accountStates },
        });

        // Auto-subscribe rekeyed account to notifications if service is initialized
        if (notificationService.getDeviceId()) {
          notificationService
            .subscribeAccount(rekeyedAccount.address, DEFAULT_NOTIFICATION_PREFERENCES)
            .catch(err => console.warn('Failed to subscribe rekeyed account to notifications:', err));
          realtimeService.addAddress(rekeyedAccount.address);
        }

        return rekeyedAccount;
      } catch (error) {
        const errorMessage =
          error instanceof Error
            ? error.message
            : 'Failed to detect rekeyed account';
        set({ lastError: errorMessage });
        throw error;
      } finally {
        set({ isLoading: false });
      }
    },

    deleteAccount: async (accountId: string) => {
      try {
        set({ isLoading: true, lastError: null });

        // Get the account address before deletion for unsubscribing
        const { wallet: currentWallet } = get();
        const accountToDelete = currentWallet?.accounts.find(a => a.id === accountId);
        const addressToUnsubscribe = accountToDelete?.address;

        await MultiAccountWalletService.deleteAccount(accountId);
        const wallet = await MultiAccountWalletService.getCurrentWallet();

        // Remove account state
        const { accountStates } = get();
        delete accountStates[accountId];

        set({
          wallet,
          accountStates: { ...accountStates },
        });

        // Unsubscribe deleted account from notifications
        if (addressToUnsubscribe && notificationService.getDeviceId()) {
          notificationService
            .unsubscribeAccount(addressToUnsubscribe)
            .catch(err => console.warn('Failed to unsubscribe deleted account from notifications:', err));
          realtimeService.removeAddress(addressToUnsubscribe);
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : 'Failed to delete account';
        set({ lastError: errorMessage });
        throw error;
      } finally {
        set({ isLoading: false });
      }
    },

    // Account operations
    setActiveAccount: async (accountId: string) => {
      try {
        await MultiAccountWalletService.setActiveAccount(accountId);
        const wallet = await MultiAccountWalletService.getCurrentWallet();
        set({ wallet });
      } catch (error) {
        const errorMessage =
          error instanceof Error
            ? error.message
            : 'Failed to set active account';
        set({ lastError: errorMessage });
        throw error;
      }
    },

    updateAccountLabel: async (accountId: string, label: string) => {
      const { wallet } = get();
      if (!wallet) {
        return;
      }

      const normalizedLabel = label.trim();
      const sanitizedLabel =
        normalizedLabel.length > 0 ? normalizedLabel : undefined;

      const previousWalletSnapshot = {
        ...wallet,
        accounts: wallet.accounts.map((account) => ({ ...account })),
      };

      // Optimistically update local state for immediate feedback
      const optimisticallyUpdatedAccounts = wallet.accounts.map((account) =>
        account.id === accountId
          ? { ...account, label: sanitizedLabel }
          : account
      );

      set({
        wallet: { ...wallet, accounts: optimisticallyUpdatedAccounts },
      });

      try {
        const persistedAccount =
          await MultiAccountWalletService.updateAccountLabel(accountId, label);

        set((state) => {
          if (!state.wallet) {
            return {};
          }

          const accounts = state.wallet.accounts.map((account) =>
            account.id === persistedAccount.id ? persistedAccount : account
          );

          return {
            wallet: {
              ...state.wallet,
              accounts,
            },
          };
        });
      } catch (error) {
        set({ wallet: previousWalletSnapshot });
        throw error;
      }
    },

    updateAccountColor: async (accountId: string, color: string) => {
      try {
        const { wallet } = get();
        if (!wallet) return;

        // Update local state immediately for better UX
        const updatedAccounts = wallet.accounts.map((acc) =>
          acc.id === accountId ? { ...acc, color } : acc
        );

        set({
          wallet: { ...wallet, accounts: updatedAccounts },
        });

        // TODO: Implement server-side color update
        // await MultiAccountWalletService.updateAccountColor(accountId, color);
      } catch (error) {
        // Revert on error
        await get().refresh();
        throw error;
      }
    },

    toggleAccountVisibility: async (accountId: string) => {
      try {
        const { wallet } = get();
        if (!wallet) return;

        // Update local state immediately for better UX
        const updatedAccounts = wallet.accounts.map((acc) =>
          acc.id === accountId ? { ...acc, isHidden: !acc.isHidden } : acc
        );

        set({
          wallet: { ...wallet, accounts: updatedAccounts },
        });

        // TODO: Implement server-side visibility update
        // await MultiAccountWalletService.updateAccountVisibility(accountId, !account.isHidden);
      } catch (error) {
        // Revert on error
        await get().refresh();
        throw error;
      }
    },

    // Balance and transaction management
    loadAccountBalance: async (accountId: string, forceRefresh = false) => {
      try {
        const { accountStates } = get();
        const accountState =
          accountStates[accountId] || createInitialAccountState();

        // Define cache expiry time (30 seconds for background refresh logic)
        const CACHE_EXPIRY_MS = 30 * 1000;
        const now = Date.now();
        const isCacheExpired = now - accountState.balanceLastUpdated > CACHE_EXPIRY_MS;
        const hasExistingBalance = !!accountState.balance;

        // If we have cached data and not forcing refresh, check if we need background update
        if (!forceRefresh && hasExistingBalance) {
          // If cache is fresh, don't refresh at all
          if (!isCacheExpired) {
            return;
          }
          // If cache is stale, do background refresh (don't show loading state)
          // This allows cached data to stay visible while refreshing
        }

        // Resolve account fresh from service (repairs missing addresses if needed)
        const account = await MultiAccountWalletService.getAccount(accountId);

        // Determine loading state based on cache availability
        const shouldShowLoading = !hasExistingBalance || forceRefresh;
        const shouldShowBackgroundRefresh = hasExistingBalance && !forceRefresh;

        set({
          accountStates: {
            ...accountStates,
            [accountId]: {
              ...accountState,
              isBalanceLoading: shouldShowLoading,
              isBackgroundRefreshing: shouldShowBackgroundRefresh,
              lastError: null,
            },
          },
        });

        const networkService = NetworkService.getInstance();
        const currentNetworkId = networkService.getCurrentNetworkId();
        const balance = await networkService.getAccountBalance(account.address);

        // Process rekey information if available (both rekeyed and non-rekeyed states)
        let updatedWallet = get().wallet;
        if (balance.rekeyInfo && updatedWallet) {

          // Update the account with rekey information
          const updatedAccount = await rekeyManager.updateAccountWithRekeyInfo(
            account,
            balance.rekeyInfo,
            updatedWallet
          );

          let shouldPersistMetadata = account.type !== updatedAccount.type;

          if (
            !shouldPersistMetadata &&
            updatedAccount.type === AccountType.REKEYED &&
            account.type === AccountType.REKEYED
          ) {
            const existingRekeyed = account as RekeyedAccountMetadata;
            const newRekeyed = updatedAccount as RekeyedAccountMetadata;

            shouldPersistMetadata =
              existingRekeyed.authAddress !== newRekeyed.authAddress ||
              existingRekeyed.canSign !== newRekeyed.canSign ||
              existingRekeyed.rekeyedAt !== newRekeyed.rekeyedAt;
          }

          if (shouldPersistMetadata) {
            try {
              await MultiAccountWalletService.updateAccountMetadata(
                updatedAccount
              );
            } catch (persistError) {
              console.warn(
                'Failed to persist rekey metadata update:',
                persistError
              );
            }
          }

          // Update the wallet with the new account metadata
          const updatedAccounts = updatedWallet.accounts.map((acc) =>
            acc.id === accountId ? updatedAccount : acc
          );

          updatedWallet = { ...updatedWallet, accounts: updatedAccounts };

          set({
            wallet: updatedWallet,
            accountStates: {
              ...get().accountStates,
              [accountId]: {
                ...get().accountStates[accountId],
                balance,
                isBalanceLoading: false,
                isBackgroundRefreshing: false,
                balanceLastUpdated: now,
              },
            },
          });

          // Persist the updated balance cache with network ID
          setTimeout(() => {
            persistBalanceToStorage(accountId, balance, now, currentNetworkId);
          }, 0);
        } else {
          set({
            accountStates: {
              ...get().accountStates,
              [accountId]: {
                ...get().accountStates[accountId],
                balance,
                isBalanceLoading: false,
                isBackgroundRefreshing: false,
                balanceLastUpdated: now,
              },
            },
          });

          // Persist the updated balance cache with network ID
          setTimeout(() => {
            persistBalanceToStorage(accountId, balance, now, currentNetworkId);
          }, 0);
        }
      } catch (error) {
        const { accountStates } = get();
        set({
          accountStates: {
            ...accountStates,
            [accountId]: {
              ...accountStates[accountId],
              lastError:
                error instanceof Error
                  ? error.message
                  : 'Failed to load balance',
              isBalanceLoading: false,
              isBackgroundRefreshing: false,
            },
          },
        });
      }
    },

    loadAccountTransactions: async (accountId: string) => {
      try {
        const { accountStates } = get();
        const accountState =
          accountStates[accountId] || createInitialAccountState();

        console.log(`Loading transactions for account: ${accountId}`);

        // Skip if already loading transactions for this account
        if (accountState.isTransactionsLoading) {
          console.log(
            `Transactions already loading for account: ${accountId}, skipping`
          );
          return;
        }

        // Resolve account fresh from service (repairs missing addresses if needed)
        const account = await MultiAccountWalletService.getAccount(accountId);

        set({
          accountStates: {
            ...accountStates,
            [accountId]: {
              ...accountState,
              isTransactionsLoading: true,
              lastError: null,
            },
          },
        });

        const networkService = NetworkService.getInstance();
        const transactions = await networkService.getTransactionHistory(
          account.address
        );
        const dedupedTransactions = dedupeTransactions(transactions);

        set({
          accountStates: {
            ...get().accountStates,
            [accountId]: {
              ...get().accountStates[accountId],
              recentTransactions: dedupedTransactions,
              isTransactionsLoading: false,
            },
          },
        });
      } catch (error) {
        const { accountStates } = get();
        set({
          accountStates: {
            ...accountStates,
            [accountId]: {
              ...accountStates[accountId],
              lastError:
                error instanceof Error
                  ? error.message
                  : 'Failed to load transactions',
              isTransactionsLoading: false,
            },
          },
        });
      }
    },

    loadAssetTransactions: async (
      accountId: string,
      assetId: number,
      isArc200: boolean = false
    ) => {
      try {
        const { accountStates } = get();
        const accountState =
          accountStates[accountId] || createInitialAccountState();

        console.log(
          `Loading asset transactions for account: ${accountId}, assetId: ${assetId}, isArc200: ${isArc200}`
        );

        // Skip if already loading transactions for this account
        if (accountState.isTransactionsLoading) {
          console.log(
            `Transactions already loading for account: ${accountId}, skipping`
          );
          return;
        }

        // Resolve account fresh from service
        const account = await MultiAccountWalletService.getAccount(accountId);

        set({
          accountStates: {
            ...accountStates,
            [accountId]: {
              ...accountState,
              isTransactionsLoading: true,
              lastError: null,
            },
          },
        });

        const networkService = NetworkService.getInstance();
        const limit = 30; // Initial page size
        const result = await networkService.getAssetTransactionHistory(
          account.address,
          assetId,
          isArc200,
          limit
        );

        // Create asset key for pagination tracking
        const assetKey = `${assetId}_${isArc200 ? 'arc200' : 'asa'}`;

        // Deduplicate transactions by ID (in case API returns duplicates)
        const uniqueTransactions = dedupeTransactions(result.transactions);

        set({
          accountStates: {
            ...get().accountStates,
            [accountId]: {
              ...get().accountStates[accountId],
              recentTransactions: uniqueTransactions,
              isTransactionsLoading: false,
              assetTransactionsPagination: {
                ...get().accountStates[accountId]?.assetTransactionsPagination,
                [assetKey]: {
                  nextToken: result.nextToken,
                  hasMore: result.hasMore,
                  isLoadingMore: false,
                },
              },
            },
          },
        });
      } catch (error) {
        const { accountStates } = get();
        set({
          accountStates: {
            ...accountStates,
            [accountId]: {
              ...accountStates[accountId],
              lastError:
                error instanceof Error
                  ? error.message
                  : 'Failed to load asset transactions',
              isTransactionsLoading: false,
            },
          },
        });
      }
    },

    loadMoreAssetTransactions: async (
      accountId: string,
      assetId: number,
      isArc200: boolean = false
    ) => {
      try {
        const { accountStates } = get();
        const accountState =
          accountStates[accountId] || createInitialAccountState();

        const assetKey = `${assetId}_${isArc200 ? 'arc200' : 'asa'}`;
        const pagination = accountState.assetTransactionsPagination?.[assetKey];

        // Don't load more if already loading or no more data
        if (!pagination?.hasMore || pagination?.isLoadingMore) {
          return;
        }

        // Resolve account fresh from service
        const account = await MultiAccountWalletService.getAccount(accountId);

        // Set loading more state
        set({
          accountStates: {
            ...accountStates,
            [accountId]: {
              ...accountState,
              assetTransactionsPagination: {
                ...accountState.assetTransactionsPagination,
                [assetKey]: {
                  ...pagination,
                  isLoadingMore: true,
                },
              },
            },
          },
        });

        const networkService = NetworkService.getInstance();
        const limit = 30;
        const result = await networkService.getAssetTransactionHistory(
          account.address,
          assetId,
          isArc200,
          limit,
          pagination.nextToken
        );

        // Deduplicate transactions by ID
        const existingIds = new Set(
          accountState.recentTransactions.map((tx) => tx.id)
        );
        const newTransactions = result.transactions.filter(
          (tx) => !existingIds.has(tx.id)
        );

        // Append new transactions to existing ones and deduplicate
        const updatedTransactions = dedupeTransactions([
          ...accountState.recentTransactions,
          ...newTransactions,
        ]);

        set({
          accountStates: {
            ...get().accountStates,
            [accountId]: {
              ...get().accountStates[accountId],
              recentTransactions: updatedTransactions,
              assetTransactionsPagination: {
                ...get().accountStates[accountId]?.assetTransactionsPagination,
                [assetKey]: {
                  nextToken: result.nextToken,
                  hasMore: result.hasMore,
                  isLoadingMore: false,
                },
              },
            },
          },
        });
      } catch (error) {
        const { accountStates } = get();
        const assetKey = `${assetId}_${isArc200 ? 'arc200' : 'asa'}`;
        set({
          accountStates: {
            ...accountStates,
            [accountId]: {
              ...accountStates[accountId],
              assetTransactionsPagination: {
                ...accountStates[accountId]?.assetTransactionsPagination,
                [assetKey]: {
                  ...accountStates[accountId]?.assetTransactionsPagination?.[
                    assetKey
                  ],
                  isLoadingMore: false,
                },
              },
            },
          },
        });
        console.error('Failed to load more asset transactions:', error);
      }
    },

    loadAllTransactions: async (accountId: string) => {
      try {
        const { accountStates } = get();
        const accountState =
          accountStates[accountId] || createInitialAccountState();

        console.log(`Loading all transactions for account: ${accountId}`);

        // Skip if already loading transactions for this account
        if (accountState.isTransactionsLoading) {
          console.log(
            `Transactions already loading for account: ${accountId}, skipping`
          );
          return;
        }

        // Resolve account fresh from service
        const account = await MultiAccountWalletService.getAccount(accountId);

        set({
          accountStates: {
            ...accountStates,
            [accountId]: {
              ...accountState,
              isTransactionsLoading: true,
              lastError: null,
            },
          },
        });

        const networkService = NetworkService.getInstance();
        const result = await networkService.getAllTransactionHistory(
          account.address,
          50
        );

        const uniqueTransactions = dedupeTransactions(result.transactions);

        set({
          accountStates: {
            ...get().accountStates,
            [accountId]: {
              ...get().accountStates[accountId],
              recentTransactions: uniqueTransactions,
              isTransactionsLoading: false,
              transactionsPagination: {
                nextToken: result.nextToken,
                hasMore: !!result.nextToken,
                isLoadingMore: false,
              },
            },
          },
        });
      } catch (error) {
        const { accountStates } = get();
        set({
          accountStates: {
            ...accountStates,
            [accountId]: {
              ...accountStates[accountId],
              lastError:
                error instanceof Error
                  ? error.message
                  : 'Failed to load all transactions',
              isTransactionsLoading: false,
            },
          },
        });
      }
    },

    loadMoreTransactions: async (accountId: string) => {
      try {
        const { accountStates } = get();
        const accountState =
          accountStates[accountId] || createInitialAccountState();

        // Don't load more if already loading or no more data
        if (
          !accountState.transactionsPagination?.hasMore ||
          accountState.transactionsPagination?.isLoadingMore
        ) {
          return;
        }

        // Resolve account fresh from service
        const account = await MultiAccountWalletService.getAccount(accountId);

        // Set loading more state
        set({
          accountStates: {
            ...accountStates,
            [accountId]: {
              ...accountState,
              transactionsPagination: {
                ...accountState.transactionsPagination,
                isLoadingMore: true,
              },
            },
          },
        });

        const networkService = NetworkService.getInstance();
        const result = await networkService.getAllTransactionHistory(
          account.address,
          50,
          accountState.transactionsPagination?.nextToken
        );

        // Deduplicate transactions by ID
        const existingIds = new Set(
          accountState.recentTransactions.map((tx) => tx.id)
        );
        const newTransactions = result.transactions.filter(
          (tx) => !existingIds.has(tx.id)
        );

        // Append new transactions to existing ones and ensure uniqueness
        const updatedTransactions = dedupeTransactions([
          ...accountState.recentTransactions,
          ...newTransactions,
        ]);

        set({
          accountStates: {
            ...get().accountStates,
            [accountId]: {
              ...get().accountStates[accountId],
              recentTransactions: updatedTransactions,
              transactionsPagination: {
                nextToken: result.nextToken,
                hasMore: !!result.nextToken,
                isLoadingMore: false,
              },
            },
          },
        });
      } catch (error) {
        const { accountStates } = get();
        set({
          accountStates: {
            ...accountStates,
            [accountId]: {
              ...accountStates[accountId],
              transactionsPagination: {
                hasMore: true,
                ...accountStates[accountId]?.transactionsPagination,
                isLoadingMore: false,
              },
            },
          },
        });
        console.error('Failed to load more transactions:', error);
      }
    },

    refreshAllBalances: async () => {
      const { wallet, accountStates } = get();
      if (!wallet) return;

      const networkService = NetworkService.getInstance();
      const currentNetworkId = networkService.getCurrentNetworkId();
      const now = Date.now();

      // Fetch all balances in parallel without individual state updates
      const balancePromises = wallet.accounts.map(async (account) => {
        try {
          // Resolve account fresh from service
          const freshAccount = await MultiAccountWalletService.getAccount(account.id);
          const balance = await networkService.getAccountBalance(freshAccount.address);

          return {
            accountId: account.id,
            account: freshAccount,
            balance,
            error: null,
          };
        } catch (error) {
          return {
            accountId: account.id,
            account,
            balance: null,
            error: error instanceof Error ? error.message : 'Failed to load balance',
          };
        }
      });

      const results = await Promise.allSettled(balancePromises);

      // Prepare batch state update
      const updatedAccountStates: Record<string, AccountUIState> = { ...accountStates };
      const rekeyUpdates: Array<{ account: AccountMetadata; balance: any }> = [];
      let updatedWallet = get().wallet;

      // Process all results
      for (const result of results) {
        if (result.status === 'fulfilled') {
          const { accountId, account, balance, error } = result.value;
          const currentState = updatedAccountStates[accountId] || createInitialAccountState();

          if (error) {
            // Update with error
            updatedAccountStates[accountId] = {
              ...currentState,
              lastError: error,
              isBalanceLoading: false,
              isBackgroundRefreshing: false,
            };
          } else if (balance) {
            // Update with successful balance
            updatedAccountStates[accountId] = {
              ...currentState,
              balance,
              isBalanceLoading: false,
              isBackgroundRefreshing: false,
              balanceLastUpdated: now,
              lastError: null,
            };

            // Collect rekey updates for later processing
            if (balance.rekeyInfo && updatedWallet) {
              rekeyUpdates.push({ account, balance });
            }

            // Persist balance to storage asynchronously
            setTimeout(() => {
              persistBalanceToStorage(accountId, balance, now, currentNetworkId);
            }, 0);
          }
        }
      }

      // Process rekey updates if any
      if (rekeyUpdates.length > 0 && updatedWallet) {
        for (const { account, balance } of rekeyUpdates) {
          const updatedAccount = await rekeyManager.updateAccountWithRekeyInfo(
            account,
            balance.rekeyInfo,
            updatedWallet
          );

          let shouldPersistMetadata = account.type !== updatedAccount.type;

          if (
            !shouldPersistMetadata &&
            updatedAccount.type === AccountType.REKEYED &&
            account.type === AccountType.REKEYED
          ) {
            const existingRekeyed = account as RekeyedAccountMetadata;
            const newRekeyed = updatedAccount as RekeyedAccountMetadata;

            shouldPersistMetadata =
              existingRekeyed.authAddress !== newRekeyed.authAddress ||
              existingRekeyed.canSign !== newRekeyed.canSign ||
              existingRekeyed.rekeyedAt !== newRekeyed.rekeyedAt;
          }

          if (shouldPersistMetadata) {
            try {
              await MultiAccountWalletService.updateAccountMetadata(updatedAccount);
            } catch (persistError) {
              console.warn('Failed to persist rekey metadata update:', persistError);
            }
          }

          // Update wallet with rekey metadata
          const updatedAccounts = updatedWallet.accounts.map((acc) =>
            acc.id === account.id ? updatedAccount : acc
          );
          updatedWallet = { ...updatedWallet, accounts: updatedAccounts };
        }
      }

      // Single batch state update with all balance changes
      set({
        accountStates: updatedAccountStates,
        ...(updatedWallet !== get().wallet && { wallet: updatedWallet }),
      });
    },

    // Envoi name management
    loadEnvoiName: async (accountId: string) => {
      try {
        const { accountStates } = get();
        const accountState =
          accountStates[accountId] || createInitialAccountState();

        // Resolve account fresh from service
        const account = await MultiAccountWalletService.getAccount(accountId);

        // Skip if already loading or already has data
        if (accountState.isEnvoiLoading) {
          return;
        }

        // Skip if we already have envoi data (unless it's been more than 5 minutes)
        // Allow reloading if the current value is null (failed previous load)
        if (accountState.envoiName !== undefined && accountState.envoiName !== null) {
          return;
        }

        set({
          accountStates: {
            ...accountStates,
            [accountId]: { ...accountState, isEnvoiLoading: true },
          },
        });

        const envoiService = EnvoiService.getInstance();
        const envoiName = await envoiService.getName(account.address);

        const nextAvatarUrl = envoiName?.avatar ?? undefined;
        const shouldUpdateAvatar = (account.avatarUrl ?? undefined) !== nextAvatarUrl;
        const avatarUpdatedAt = nextAvatarUrl ? new Date().toISOString() : undefined;

        set((state) => {
          const currentAccountState =
            state.accountStates[accountId] || createInitialAccountState();
          const nextAccountStates = {
            ...state.accountStates,
            [accountId]: {
              ...currentAccountState,
              envoiName,
              isEnvoiLoading: false,
            },
          };

          if (!shouldUpdateAvatar || !state.wallet) {
            return { accountStates: nextAccountStates };
          }

          const accountIndex = state.wallet.accounts.findIndex(
            (candidate) => candidate.id === accountId
          );

          if (accountIndex === -1) {
            return { accountStates: nextAccountStates };
          }

          const updatedAccounts = [...state.wallet.accounts];
          updatedAccounts[accountIndex] = {
            ...updatedAccounts[accountIndex],
            avatarUrl: nextAvatarUrl,
            avatarUpdatedAt,
          } as typeof updatedAccounts[number];

          return {
            accountStates: nextAccountStates,
            wallet: { ...state.wallet, accounts: updatedAccounts },
          };
        });

        if (shouldUpdateAvatar) {
          const updatedAccount = {
            ...account,
            avatarUrl: nextAvatarUrl,
            avatarUpdatedAt,
          } as typeof account;
          await MultiAccountWalletService.updateAccountMetadata(updatedAccount);
        }
      } catch (error) {
        const { accountStates } = get();
        set({
          accountStates: {
            ...accountStates,
            [accountId]: {
              ...accountStates[accountId],
              isEnvoiLoading: false,
            },
          },
        });
        console.error('Failed to load Envoi name:', error);
      }
    },

    loadEnvoiNamesBatch: async (accountIds: string[]) => {
      try {
        if (!accountIds.length) return;

        const { accountStates } = get();

        // Filter accounts that need loading
        const accountsToLoad: { id: string; address: string }[] = [];

        for (const accountId of accountIds) {
          const accountState =
            accountStates[accountId] || createInitialAccountState();

          // Skip if already loading or already has data
          if (
            accountState.isEnvoiLoading ||
            accountState.envoiName !== undefined
          ) {
            continue;
          }

          try {
            const account =
              await MultiAccountWalletService.getAccount(accountId);
            accountsToLoad.push({ id: accountId, address: account.address });
          } catch (error) {
            console.warn(
              '[WalletStore] Failed to get account for batch load',
              { accountId },
              error
            );
          }
        }

        if (accountsToLoad.length === 0) {
          console.log('[WalletStore] loadEnvoiNamesBatch no accounts to load');
          return;
        }

        console.log('[WalletStore] loadEnvoiNamesBatch start', {
          count: accountsToLoad.length,
        });

        // Mark all as loading
        const updatedStates = { ...get().accountStates };
        for (const { id } of accountsToLoad) {
          const currentState = updatedStates[id] || createInitialAccountState();
          updatedStates[id] = { ...currentState, isEnvoiLoading: true };
        }
        set({ accountStates: updatedStates });

        // Batch resolve names
        const envoiService = EnvoiService.getInstance();
        const addresses = accountsToLoad.map((acc) => acc.address);
        const results = await envoiService.getNames(addresses);

        console.log('[WalletStore] loadEnvoiNamesBatch results', {
          count: results.size,
        });

        const finalStates = { ...get().accountStates };
        const metadataUpdates: Array<{
          accountId: string;
          nextAvatarUrl: string | undefined;
          avatarUpdatedAt?: string;
        }> = [];
        const accountMetadataMap: Record<string, AccountMetadata> = {};

        for (const { id, address } of accountsToLoad) {
          const envoiName = results.get(address) || null;
          const currentState = finalStates[id] || createInitialAccountState();
          finalStates[id] = {
            ...currentState,
            envoiName,
            isEnvoiLoading: false,
          };

          try {
            const accountMetadata = await MultiAccountWalletService.getAccount(id);
            accountMetadataMap[id] = accountMetadata;
            const nextAvatarUrl = envoiName?.avatar ?? undefined;
            if ((accountMetadata.avatarUrl ?? undefined) !== nextAvatarUrl) {
              metadataUpdates.push({
                accountId: id,
                nextAvatarUrl,
                avatarUpdatedAt: nextAvatarUrl ? new Date().toISOString() : undefined,
              });
            }
          } catch (error) {
            console.warn(
              '[WalletStore] Failed to load account metadata for avatar update',
              { accountId: id },
              error
            );
          }
        }

        const metadataUpdateMap = new Map(
          metadataUpdates.map((update) => [update.accountId, update])
        );

        set((state) => {
          const nextAccountStates = { ...state.accountStates, ...finalStates };

          if (!state.wallet || metadataUpdates.length === 0) {
            return { accountStates: nextAccountStates };
          }

          let accountsChanged = false;
          const updatedAccounts = state.wallet.accounts.map((acc) => {
            const update = metadataUpdateMap.get(acc.id);

            if (!update) {
              return acc;
            }

            accountsChanged = true;
            return {
              ...acc,
              avatarUrl: update.nextAvatarUrl,
              avatarUpdatedAt: update.avatarUpdatedAt,
            } as typeof acc;
          });

          if (!accountsChanged) {
            return { accountStates: nextAccountStates };
          }

          return {
            accountStates: nextAccountStates,
            wallet: { ...state.wallet, accounts: updatedAccounts },
          };
        });

        if (metadataUpdates.length > 0) {
          await Promise.all(
            metadataUpdates.map(async (update) => {
              const baseMetadata = accountMetadataMap[update.accountId];
              if (!baseMetadata) {
                return;
              }

              const updatedAccount = {
                ...baseMetadata,
                avatarUrl: update.nextAvatarUrl,
                avatarUpdatedAt: update.avatarUpdatedAt,
              } as AccountMetadata;

              await MultiAccountWalletService.updateAccountMetadata(updatedAccount);
            })
          );
        }
      } catch (error) {
        console.error('[WalletStore] loadEnvoiNamesBatch error', error);

        // Clear loading states on error
        const errorStates = { ...get().accountStates };
        for (const accountId of accountIds) {
          const currentState = errorStates[accountId];
          if (currentState) {
            errorStates[accountId] = { ...currentState, isEnvoiLoading: false };
          }
        }
        set({ accountStates: errorStates });
      }
    },

    refreshAllEnvoiNames: async () => {
      const { wallet, loadEnvoiNamesBatch } = get();
      if (!wallet) return;

      const accountIds = wallet.accounts.map((account) => account.id);
      console.log('[WalletStore] refreshAllEnvoiNames batch', {
        accounts: accountIds.length,
      });
      await loadEnvoiNamesBatch(accountIds);
    },

    // Wallet settings
    updateWalletSettings: async (settingsUpdate: Partial<WalletSettings>) => {
      try {
        const { wallet } = get();
        if (!wallet) return;

        const updatedWallet = {
          ...wallet,
          settings: { ...wallet.settings, ...settingsUpdate },
        };

        set({ wallet: updatedWallet });

        // TODO: Implement server-side settings update
        // await MultiAccountWalletService.updateWalletSettings(settingsUpdate);
      } catch (error) {
        // Revert on error
        await get().refresh();
        throw error;
      }
    },

    // Token metadata cache management
    loadTokenMetadata: async (contractIds: number[]) => {
      try {
        const { tokenMetadataCache, pendingTokenRequests } = get();

        // Filter out already cached or pending tokens
        const uncachedContractIds = contractIds.filter(
          (id) => !tokenMetadataCache[id] && !pendingTokenRequests.has(id)
        );

        if (uncachedContractIds.length === 0) {
          return;
        }

        // Mark tokens as pending
        const newPendingRequests = new Set(pendingTokenRequests);
        uncachedContractIds.forEach((id) => newPendingRequests.add(id));

        set({
          pendingTokenRequests: newPendingRequests,
        });

        // Fetch token metadata
        const mimirService = MimirApiService.getInstance();
        const response =
          await mimirService.getArc200TokensMetadata(uncachedContractIds);

        // Update cache with new tokens
        const updatedCache = { ...tokenMetadataCache };
        const updatedPendingRequests = new Set(newPendingRequests);

        response.tokens.forEach((token) => {
          updatedCache[token.contractId] = token;
          updatedPendingRequests.delete(token.contractId);
        });

        // Mark remaining tokens as failed (remove from pending)
        uncachedContractIds.forEach((id) => {
          updatedPendingRequests.delete(id);
        });

        set({
          tokenMetadataCache: updatedCache,
          pendingTokenRequests: updatedPendingRequests,
        });
      } catch (error) {
        console.error('Failed to load token metadata:', error);

        // Clear pending requests on error
        const { pendingTokenRequests } = get();
        const updatedPendingRequests = new Set(pendingTokenRequests);
        contractIds.forEach((id) => updatedPendingRequests.delete(id));

        set({
          pendingTokenRequests: updatedPendingRequests,
        });
      }
    },

    getTokenMetadata: (contractId: number) => {
      const { tokenMetadataCache } = get();
      return tokenMetadataCache[contractId] || null;
    },

    // Multi-network view mode management
    setViewMode: async (mode: 'single-network' | 'multi-network') => {
      const { viewMode: currentMode, wallet } = get();

      if (currentMode === mode) {
        return; // Already in this mode
      }

      set({ viewMode: mode });

      // Load appropriate cached data for the new mode
      if (wallet) {
        const networkService = NetworkService.getInstance();
        const currentNetwork = networkService.getCurrentNetworkId();

        if (mode === 'multi-network') {
          // Load multi-network cached data
          const multiCache = await loadPersistedMultiNetworkBalanceCache();
          const updatedStates = { ...get().accountStates };

          wallet.accounts.forEach((account) => {
            const cacheKey = getMultiNetworkCacheKey(account.id);
            const cachedData = multiCache[cacheKey];

            if (cachedData) {
              updatedStates[account.id] = {
                ...updatedStates[account.id],
                multiNetworkBalance: cachedData.balance,
                multiNetworkBalanceLastUpdated: cachedData.lastUpdated,
              };
            }
          });

          set({ accountStates: updatedStates });
        } else {
          // Load single-network cached data
          const singleCache = await loadPersistedBalanceCache();
          const updatedStates = { ...get().accountStates };

          wallet.accounts.forEach((account) => {
            const cacheKey = getSingleNetworkCacheKey(account.id, currentNetwork);
            const cachedData = singleCache[cacheKey];

            if (cachedData && cachedData.networkId === currentNetwork) {
              updatedStates[account.id] = {
                ...updatedStates[account.id],
                balance: cachedData.balance,
                balanceLastUpdated: cachedData.lastUpdated,
              };
            }
          });

          set({ accountStates: updatedStates });
        }
      }
    },

    toggleViewMode: async () => {
      const { viewMode, setViewMode } = get();
      const newMode = viewMode === 'single-network' ? 'multi-network' : 'single-network';
      await setViewMode(newMode);
    },

    setAssetNetworkFilter: async (filter: 'all' | 'voi' | 'algorand') => {
      set({ assetNetworkFilter: filter });

      // Persist to AsyncStorage
      try {
        await AsyncStorage.setItem('@wallet-asset-network-filter', filter);
      } catch (error) {
        console.error('Failed to persist asset network filter:', error);
      }
    },

    loadMultiNetworkBalance: async (accountId: string, forceRefresh = false) => {
      try {
        const { accountStates, tokenMappings } = get();
        const accountState = accountStates[accountId] || createInitialAccountState();

        // Define cache expiry time
        const CACHE_EXPIRY_MS = 30 * 1000; // 30 seconds
        const now = Date.now();
        const isCacheExpired = now - accountState.multiNetworkBalanceLastUpdated > CACHE_EXPIRY_MS;
        const hasExistingBalance = !!accountState.multiNetworkBalance;

        // Use cache if available and not expired
        if (!forceRefresh && hasExistingBalance && !isCacheExpired) {
          return;
        }

        // Get account address
        const account = await MultiAccountWalletService.getAccount(accountId);

        // Determine loading state based on cache availability
        const shouldShowLoading = !hasExistingBalance || forceRefresh;

        // Set loading state
        set({
          accountStates: {
            ...accountStates,
            [accountId]: {
              ...accountState,
              isMultiNetworkBalanceLoading: shouldShowLoading,
              lastError: null,
            },
          },
        });

        // Ensure token mappings are loaded
        if (tokenMappings.length === 0) {
          await get().loadTokenMappings();
        }

        // Fetch multi-network balance
        const multiNetworkBalance = await MultiNetworkBalanceService.getAggregatedBalance(
          account.address
        );

        set({
          accountStates: {
            ...get().accountStates,
            [accountId]: {
              ...get().accountStates[accountId],
              multiNetworkBalance,
              isMultiNetworkBalanceLoading: false,
              multiNetworkBalanceLastUpdated: now,
            },
          },
        });

        // Persist the multi-network balance cache
        setTimeout(() => {
          persistMultiNetworkBalanceToStorage(accountId, multiNetworkBalance, now);
        }, 0);
      } catch (error) {
        const { accountStates } = get();
        const accountState = accountStates[accountId] || createInitialAccountState();
        set({
          accountStates: {
            ...accountStates,
            [accountId]: {
              ...accountState,
              lastError:
                error instanceof Error
                  ? error.message
                  : 'Failed to load multi-network balance',
              isMultiNetworkBalanceLoading: false,
            },
          },
        });
        console.error('[WalletStore] Failed to load multi-network balance:', error);
      }
    },

    loadTokenMappings: async (forceRefresh = false) => {
      try {
        const { isTokenMappingsLoading } = get();

        // Prevent concurrent loading
        if (isTokenMappingsLoading) {
          return;
        }

        set({ isTokenMappingsLoading: true });

        const mappings = await tokenMappingService.getTokenMappings(forceRefresh);

        set({
          tokenMappings: mappings,
          isTokenMappingsLoading: false,
        });

        console.log(`[WalletStore] Loaded ${mappings.length} token mappings`);
      } catch (error) {
        set({ isTokenMappingsLoading: false });
        console.error('[WalletStore] Failed to load token mappings:', error);
        throw error;
      }
    },

    refreshTokenMappings: async () => {
      await get().loadTokenMappings(true);
    },

    // Asset filter and sort management
    setAssetSortBy: async (sortBy: AssetSortBy) => {
      set({ assetSortBy: sortBy });
      try {
        await AssetFilterStorage.saveAssetSortBy(sortBy);
      } catch (error) {
        console.error('Failed to persist asset sort by:', error);
      }
    },

    setAssetSortOrder: async (sortOrder: AssetSortOrder) => {
      set({ assetSortOrder: sortOrder });
      try {
        await AssetFilterStorage.saveAssetSortOrder(sortOrder);
      } catch (error) {
        console.error('Failed to persist asset sort order:', error);
      }
    },

    setAssetFilterBalanceThreshold: async (threshold: number | null) => {
      set({ assetFilterBalanceThreshold: threshold });
      try {
        await AssetFilterStorage.saveBalanceThreshold(threshold);
      } catch (error) {
        console.error('Failed to persist balance threshold:', error);
      }
    },

    setAssetFilterValueThreshold: async (threshold: number | null) => {
      set({ assetFilterValueThreshold: threshold });
      try {
        await AssetFilterStorage.saveValueThreshold(threshold);
      } catch (error) {
        console.error('Failed to persist value threshold:', error);
      }
    },

    setAssetNativeTokensFirst: async (nativeFirst: boolean) => {
      set({ assetNativeTokensFirst: nativeFirst });
      try {
        await AssetFilterStorage.saveNativeTokensFirst(nativeFirst);
      } catch (error) {
        console.error('Failed to persist native tokens first:', error);
      }
    },

    loadAssetFilterSettings: async () => {
      try {
        const settings = await AssetFilterStorage.loadAssetFilterSettings();
        set({
          assetSortBy: settings.sortBy,
          assetSortOrder: settings.sortOrder,
          assetFilterBalanceThreshold: settings.balanceThreshold,
          assetFilterValueThreshold: settings.valueThreshold,
          assetNativeTokensFirst: settings.nativeTokensFirst,
        });
      } catch (error) {
        console.error('Failed to load asset filter settings:', error);
      }
    },

    resetAssetFilterSettings: async () => {
      try {
        await AssetFilterStorage.resetAssetFilterSettings();
        set({
          assetSortBy: DEFAULT_ASSET_FILTER_SETTINGS.sortBy,
          assetSortOrder: DEFAULT_ASSET_FILTER_SETTINGS.sortOrder,
          assetFilterBalanceThreshold: DEFAULT_ASSET_FILTER_SETTINGS.balanceThreshold,
          assetFilterValueThreshold: DEFAULT_ASSET_FILTER_SETTINGS.valueThreshold,
          assetNativeTokensFirst: DEFAULT_ASSET_FILTER_SETTINGS.nativeTokensFirst,
        });
      } catch (error) {
        console.error('Failed to reset asset filter settings:', error);
        throw error;
      }
    },

    // UI state actions
    showAccountSelector: () => set({ isAccountSelectorVisible: true }),
    hideAccountSelector: () => set({ isAccountSelectorVisible: false }),

    showAddAccountModal: (accountType?: AccountType) => {
      set({
        isAddAccountModalVisible: true,
        selectedAccountType: accountType || null,
      });
    },

    hideAddAccountModal: () => {
      set({
        isAddAccountModalVisible: false,
        selectedAccountType: null,
      });
    },

    // Error handling
    clearError: () => set({ lastError: null }),

    clearAccountError: (accountId: string) => {
      const { accountStates } = get();
      if (accountStates[accountId]) {
        set({
          accountStates: {
            ...accountStates,
            [accountId]: { ...accountStates[accountId], lastError: null },
          },
        });
      }
    },

    // Cache management
    clearSingleNetworkCache: async (accountId?: string) => {
      try {
        const cache = await loadPersistedBalanceCache();

        if (accountId) {
          // Clear cache for specific account across all networks
          const filteredCache: Record<string, PersistedBalanceData> = {};
          Object.entries(cache).forEach(([key, value]) => {
            if (!key.startsWith(`${accountId}_single_`)) {
              filteredCache[key] = value;
            }
          });
          await persistBalanceCache(filteredCache);

          // Also clear from state
          const { accountStates } = get();
          if (accountStates[accountId]) {
            set({
              accountStates: {
                ...accountStates,
                [accountId]: {
                  ...accountStates[accountId],
                  balance: undefined,
                  balanceLastUpdated: 0,
                },
              },
            });
          }
        } else {
          // Clear all single-network cache
          await AsyncStorage.removeItem(BALANCE_CACHE_KEY);

          // Also clear ALL single-network account balances from state immediately
          // BUT preserve multi-network balance since that's network-independent
          const { accountStates } = get();
          const updatedStates: Record<string, AccountUIState> = {};
          Object.keys(accountStates).forEach((id) => {
            updatedStates[id] = {
              ...accountStates[id],
              balance: undefined, // Clear single-network balance
              balanceLastUpdated: 0,
              isBalanceLoading: false,
              // Keep multiNetworkBalance and multiNetworkBalanceLastUpdated intact
            };
          });
          set({ accountStates: updatedStates });
        }

        console.log('[WalletStore] Cleared single-network cache', accountId ? `for ${accountId}` : '(all)');
      } catch (error) {
        console.error('[WalletStore] Failed to clear single-network cache:', error);
      }
    },

    clearMultiNetworkCache: async (accountId?: string) => {
      try {
        const cache = await loadPersistedMultiNetworkBalanceCache();

        if (accountId) {
          // Clear cache for specific account
          const cacheKey = getMultiNetworkCacheKey(accountId);
          const filteredCache = { ...cache };
          delete filteredCache[cacheKey];
          await persistMultiNetworkBalanceCache(filteredCache);

          // Also clear from state
          const { accountStates } = get();
          if (accountStates[accountId]) {
            set({
              accountStates: {
                ...accountStates,
                [accountId]: {
                  ...accountStates[accountId],
                  multiNetworkBalance: undefined,
                  multiNetworkBalanceLastUpdated: 0,
                },
              },
            });
          }
        } else {
          // Clear all multi-network cache
          await AsyncStorage.removeItem(MULTI_NETWORK_BALANCE_CACHE_KEY);
        }

        console.log('[WalletStore] Cleared multi-network cache', accountId ? `for ${accountId}` : '(all)');
      } catch (error) {
        console.error('[WalletStore] Failed to clear multi-network cache:', error);
      }
    },

    clearAllBalanceCache: async () => {
      try {
        await Promise.all([
          AsyncStorage.removeItem(BALANCE_CACHE_KEY),
          AsyncStorage.removeItem(MULTI_NETWORK_BALANCE_CACHE_KEY),
        ]);

        // Clear all balance state
        const { accountStates } = get();
        const clearedStates: Record<string, AccountUIState> = {};
        Object.keys(accountStates).forEach((accountId) => {
          clearedStates[accountId] = {
            ...accountStates[accountId],
            balance: undefined,
            balanceLastUpdated: 0,
            multiNetworkBalance: undefined,
            multiNetworkBalanceLastUpdated: 0,
          };
        });

        set({ accountStates: clearedStates });
        console.log('[WalletStore] Cleared all balance cache');
      } catch (error) {
        console.error('[WalletStore] Failed to clear all balance cache:', error);
      }
    },
  }))
);

//
// Selector hooks for specific data
// IMPORTANT: Avoid creating new arrays/objects on each selector call.
// React 18 verifies that getSnapshot returns a cached value between calls.
// Returning newly-allocated objects will trigger
// "The result of getSnapshot should be cached" and can cause render loops.

// Stable empty references used when store data is not available yet
const EMPTY_ACCOUNTS: AccountMetadata[] = [];
const EMPTY_STANDARD_ACCOUNTS: StandardAccountMetadata[] = [];
const EMPTY_WATCH_ACCOUNTS: WatchAccountMetadata[] = [];
const EMPTY_REKEYED_ACCOUNTS: RekeyedAccountMetadata[] = [];
const EMPTY_ACCOUNT_UI_STATE: Readonly<AccountUIState> = Object.freeze({
  isLoading: false,
  lastError: null,
  recentTransactions: [],
  isBalanceLoading: false,
  isBackgroundRefreshing: false,
  balanceLastUpdated: 0,
  isTransactionsLoading: false,
  envoiName: null,
  isEnvoiLoading: false,
  multiNetworkBalance: undefined,
  isMultiNetworkBalanceLoading: false,
  multiNetworkBalanceLastUpdated: 0,
});

// Cache filtered account lists by wallet object identity to keep references stable
let lastWalletForDerived: Wallet | null | undefined = undefined;
let cachedStandardAccounts: StandardAccountMetadata[] = EMPTY_STANDARD_ACCOUNTS;
let cachedWatchAccounts: WatchAccountMetadata[] = EMPTY_WATCH_ACCOUNTS;
let cachedRekeyedAccounts: RekeyedAccountMetadata[] = EMPTY_REKEYED_ACCOUNTS;

function ensureDerivedAccountCaches(wallet: Wallet | null | undefined) {
  if (wallet === lastWalletForDerived) return;
  lastWalletForDerived = wallet;

  if (!wallet) {
    cachedStandardAccounts = EMPTY_STANDARD_ACCOUNTS;
    cachedWatchAccounts = EMPTY_WATCH_ACCOUNTS;
    cachedRekeyedAccounts = EMPTY_REKEYED_ACCOUNTS;
    return;
  }

  const accounts = wallet.accounts;
  cachedStandardAccounts = accounts.filter(
    (acc) => acc.type === AccountType.STANDARD
  ) as StandardAccountMetadata[];
  cachedWatchAccounts = accounts.filter(
    (acc) => acc.type === AccountType.WATCH
  ) as WatchAccountMetadata[];
  cachedRekeyedAccounts = accounts.filter(
    (acc) => acc.type === AccountType.REKEYED
  ) as RekeyedAccountMetadata[];
}

export const useActiveAccount = () =>
  useWalletStore((state) => {
    if (!state.wallet) return null;
    return (
      state.wallet.accounts.find(
        (acc) => acc.id === state.wallet?.activeAccountId
      ) || null
    );
  });

export const useAccounts = () =>
  useWalletStore((state) => state.wallet?.accounts ?? EMPTY_ACCOUNTS);

export const useStandardAccounts = () =>
  useWalletStore((state) => {
    ensureDerivedAccountCaches(state.wallet);
    return cachedStandardAccounts;
  });

export const useWatchAccounts = () =>
  useWalletStore((state) => {
    ensureDerivedAccountCaches(state.wallet);
    return cachedWatchAccounts;
  });

export const useRekeyedAccounts = () =>
  useWalletStore((state) => {
    ensureDerivedAccountCaches(state.wallet);
    return cachedRekeyedAccounts;
  });

export const useAccountState = (accountId: string) =>
  useWalletStore(
    (state) => state.accountStates[accountId] ?? EMPTY_ACCOUNT_UI_STATE
  );

export const useWalletSettings = () =>
  useWalletStore((state) => state.wallet?.settings);

export const useIsWalletInitialized = () =>
  useWalletStore((state) => state.isInitialized);

export const useWalletError = () => useWalletStore((state) => state.lastError);

// Set up event listener for transaction success notifications
if (typeof document !== 'undefined') {
  document.addEventListener('transactionSuccess', (event) => {
    const { fromAddress, toAddress } = (event as CustomEvent).detail;
    const store = useWalletStore.getState();

    if (store.wallet) {
      // Find accounts that match the transaction addresses and refresh their balances
      const accountsToRefresh = store.wallet.accounts.filter(
        (account) =>
          account.address === fromAddress || account.address === toAddress
      );

      accountsToRefresh.forEach((account) => {
        store.loadAccountBalance(account.id, true); // Force refresh after transaction
      });
    }
  });
}

// Cache for account balance results to keep references stable
const accountBalanceCache = new Map<
  string,
  {
    accountState: AccountUIState;
    result: {
      balance: AccountBalance | undefined;
      isLoading: boolean;
      isBackgroundRefreshing: boolean;
      error: string | null;
      reload: () => Promise<void>;
    };
  }
>();

// Stable reload functions cache for balance
const balanceReloadFunctions = new Map<string, () => Promise<void>>();

// Balance-specific hooks
export const useAccountBalance = (accountId: string) =>
  useWalletStore((state) => {
    const accountState =
      state.accountStates[accountId] ?? EMPTY_ACCOUNT_UI_STATE;

    // Check if we have a cached result for this account and state
    const cached = accountBalanceCache.get(accountId);
    if (cached && cached.accountState === accountState) {
      return cached.result;
    }

    // Get or create stable reload function
    let reloadFunction = balanceReloadFunctions.get(accountId);
    if (!reloadFunction) {
      reloadFunction = () => state.loadAccountBalance(accountId);
      balanceReloadFunctions.set(accountId, reloadFunction);
    }

    // Create new result and cache it
    const result = Object.freeze({
      balance: accountState.balance,
      isLoading: accountState.isBalanceLoading,
      isBackgroundRefreshing: accountState.isBackgroundRefreshing,
      error: accountState.lastError,
      reload: reloadFunction,
    });

    accountBalanceCache.set(accountId, { accountState, result });
    return result;
  });

// Cached empty balance object to prevent re-renders
const EMPTY_BALANCE_STATE = Object.freeze({
  balance: undefined,
  isLoading: false,
  isBackgroundRefreshing: false,
  error: null,
  reload: () => Promise.resolve(),
});

// Cache for active account balance result to keep references stable
let lastActiveAccountId: string | undefined = undefined;
let lastAccountState: AccountUIState | undefined = undefined;
let cachedActiveAccountBalance: {
  balance: AccountBalance | undefined;
  isLoading: boolean;
  isBackgroundRefreshing: boolean;
  error: string | null;
  reload: () => Promise<void>;
} = EMPTY_BALANCE_STATE;

// Stable reload function for active account
let activeAccountReloadFunction: (() => Promise<void>) | null = null;

export const useActiveAccountBalance = () =>
  useWalletStore((state) => {
    const activeAccount = state.wallet?.accounts.find(
      (acc) => acc.id === state.wallet?.activeAccountId
    );

    if (!activeAccount) {
      // Reset cache if no active account
      lastActiveAccountId = undefined;
      lastAccountState = undefined;
      cachedActiveAccountBalance = EMPTY_BALANCE_STATE;
      return EMPTY_BALANCE_STATE;
    }

    const accountState =
      state.accountStates[activeAccount.id] ?? EMPTY_ACCOUNT_UI_STATE;

    // Only create new object if the account ID or account state has changed
    if (
      lastActiveAccountId !== activeAccount.id ||
      lastAccountState !== accountState
    ) {
      lastActiveAccountId = activeAccount.id;
      lastAccountState = accountState;

      // Create or reuse stable reload function
      if (
        !activeAccountReloadFunction ||
        lastActiveAccountId !== activeAccount.id
      ) {
        activeAccountReloadFunction = () =>
          state.loadAccountBalance(activeAccount.id);
      }

      cachedActiveAccountBalance = Object.freeze({
        balance: accountState.balance,
        isLoading: accountState.isBalanceLoading,
        isBackgroundRefreshing: accountState.isBackgroundRefreshing,
        error: accountState.lastError,
        reload: activeAccountReloadFunction,
      });
    }

    return cachedActiveAccountBalance;
  });

// Hook for refreshing all balances - useful for pull-to-refresh
export const useRefreshAllBalances = () =>
  useWalletStore((state) => state.refreshAllBalances);

// Function to clear all UI caches - useful after importing new accounts
export const clearWalletUICache = () => {
  console.log('[WalletStore] Clearing UI caches');
  accountBalanceCache.clear();
  balanceReloadFunctions.clear();
  envoiNameCache.clear();
  multiNetworkBalanceCache.clear();

  // Reset active account cache
  lastActiveAccountId = undefined;
  lastAccountState = undefined;
  cachedActiveAccountBalance = EMPTY_BALANCE_STATE;
  activeAccountReloadFunction = null;
};

// Cache for Envoi name results to keep references stable
const envoiNameCache = new Map<
  string,
  {
    accountState: AccountUIState;
    result: {
      nameInfo: EnvoiNameInfo | null;
      isLoading: boolean;
      reload: () => Promise<void>;
    };
  }
>();

// Stable reload functions cache
const envoiReloadFunctions = new Map<string, () => Promise<void>>();

// Envoi name-specific hooks
export const useAccountEnvoiName = (accountId: string) =>
  useWalletStore((state) => {
    const accountState =
      state.accountStates[accountId] ?? EMPTY_ACCOUNT_UI_STATE;

    // Check if we have a cached result for this account and state
    const cached = envoiNameCache.get(accountId);
    if (cached && cached.accountState === accountState) {
      return cached.result;
    }

    // Get or create stable reload function
    let reloadFunction = envoiReloadFunctions.get(accountId);
    if (!reloadFunction) {
      reloadFunction = () => state.loadEnvoiName(accountId);
      envoiReloadFunctions.set(accountId, reloadFunction);
    }

    // Create new result and cache it
    const result = Object.freeze({
      nameInfo: accountState.envoiName ?? null,
      isLoading: accountState.isEnvoiLoading,
      reload: reloadFunction,
    });

    envoiNameCache.set(accountId, { accountState, result });
    return result;
  });

// Hook for refreshing all Envoi names
export const useRefreshAllEnvoiNames = () =>
  useWalletStore((state) => state.refreshAllEnvoiNames);

// Multi-network view mode hooks
export const useViewMode = () => useWalletStore((state) => state.viewMode);

export const useIsMultiNetworkView = () =>
  useWalletStore((state) => state.viewMode === 'multi-network');

export const useAssetNetworkFilter = () =>
  useWalletStore((state) => state.assetNetworkFilter);

export const useTokenMappings = () => useWalletStore((state) => state.tokenMappings);

// Asset filter and sort hooks
export const useAssetSortBy = () => useWalletStore((state) => state.assetSortBy);

export const useAssetSortOrder = () => useWalletStore((state) => state.assetSortOrder);

export const useAssetFilterBalanceThreshold = () =>
  useWalletStore((state) => state.assetFilterBalanceThreshold);

export const useAssetFilterValueThreshold = () =>
  useWalletStore((state) => state.assetFilterValueThreshold);

export const useAssetNativeTokensFirst = () =>
  useWalletStore((state) => state.assetNativeTokensFirst);

// Cache for asset filter settings to keep references stable
let lastAssetFilterSettings: {
  sortBy: AssetSortBy;
  sortOrder: AssetSortOrder;
  balanceThreshold: number | null;
  valueThreshold: number | null;
  nativeTokensFirst: boolean;
} | null = null;

export const useAssetFilterSettings = () =>
  useWalletStore((state) => {
    const currentSettings = {
      sortBy: state.assetSortBy,
      sortOrder: state.assetSortOrder,
      balanceThreshold: state.assetFilterBalanceThreshold,
      valueThreshold: state.assetFilterValueThreshold,
      nativeTokensFirst: state.assetNativeTokensFirst,
    };

    // Only create new object if values actually changed
    if (
      !lastAssetFilterSettings ||
      lastAssetFilterSettings.sortBy !== currentSettings.sortBy ||
      lastAssetFilterSettings.sortOrder !== currentSettings.sortOrder ||
      lastAssetFilterSettings.balanceThreshold !== currentSettings.balanceThreshold ||
      lastAssetFilterSettings.valueThreshold !== currentSettings.valueThreshold ||
      lastAssetFilterSettings.nativeTokensFirst !== currentSettings.nativeTokensFirst
    ) {
      lastAssetFilterSettings = currentSettings;
    }

    return lastAssetFilterSettings;
  });

// Cache for multi-network balance results to keep references stable
const multiNetworkBalanceCache = new Map<
  string,
  {
    accountState: AccountUIState | undefined;
    result: {
      balance: MultiNetworkBalance | undefined;
      isLoading: boolean;
      lastUpdated: number;
    };
  }
>();

export const useMultiNetworkBalance = (accountId: string) =>
  useWalletStore((state) => {
    const accountState = state.accountStates[accountId];

    // Check if we have a cached result for this account and state
    const cached = multiNetworkBalanceCache.get(accountId);
    if (cached && cached.accountState === accountState) {
      return cached.result;
    }

    // Create new result and cache it
    const result = {
      balance: accountState?.multiNetworkBalance,
      isLoading: accountState?.isMultiNetworkBalanceLoading ?? false,
      lastUpdated: accountState?.multiNetworkBalanceLastUpdated ?? 0,
    } as const;

    multiNetworkBalanceCache.set(accountId, { accountState, result });
    return result;
  });
