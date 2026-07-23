// TASK-40 / U-03: per-account errors must be OPERATION-SCOPED.
//
// `lastError` was written in ~20 places and read by nothing. Simply reading it
// would not have worked either: every loader clears it on start, so a balance
// refresh landing after a failed transaction fetch would erase the transaction
// error and the history screen would silently fall back to its "No
// Transactions" empty state — the exact defect this task fixes. These tests pin
// the scoping: a balance failure must not look like a transaction failure, and
// neither must be erased by the other's success.
//
// The heavy service graph is mocked; only the two dependencies these loaders
// drive (NetworkService + MultiAccountWalletService) carry behavior.

const mockGetAccountBalance = jest.fn();
const mockGetTransactionHistory = jest.fn();
const mockGetAllTransactionHistory = jest.fn();
const mockGetAssetTransactionHistory = jest.fn();
const mockGetCurrentNetworkId = jest.fn(() => 'voi-mainnet');
const mockGetAccount = jest.fn(async (id: string) => ({
  id,
  address: `ADDR-${id}`,
  type: 'standard',
}));

jest.mock('@/services/network', () => ({
  NetworkService: {
    getInstance: () => ({
      getAccountBalance: (...args: unknown[]) => mockGetAccountBalance(...args),
      getTransactionHistory: (...args: unknown[]) =>
        mockGetTransactionHistory(...args),
      getAllTransactionHistory: (...args: unknown[]) =>
        mockGetAllTransactionHistory(...args),
      getAssetTransactionHistory: (...args: unknown[]) =>
        mockGetAssetTransactionHistory(...args),
      getCurrentNetworkId: () => mockGetCurrentNetworkId(),
    }),
  },
  VoiNetworkService: {},
}));

jest.mock('@/services/wallet', () => ({
  MultiAccountWalletService: {
    getAccount: (id: string) => mockGetAccount(id),
    updateAccountMetadata: jest.fn(async () => {}),
  },
}));

jest.mock('@/services/wallet/rekeyManager', () => ({
  __esModule: true,
  default: { updateAccountWithRekeyInfo: jest.fn() },
}));

jest.mock('@/services/envoi', () => ({ __esModule: true, default: {} }));
jest.mock('@/services/mimir', () => ({ MimirApiService: {} }));
jest.mock('@/services/token-mapping', () => ({
  __esModule: true,
  default: {},
  TokenMappingService: {},
}));
jest.mock('@/services/network/multi-network', () => ({
  MultiNetworkBalanceService: {},
}));
jest.mock('@/services/notifications', () => ({
  notificationService: {},
  DEFAULT_NOTIFICATION_PREFERENCES: {},
}));
jest.mock('@/services/realtime', () => ({ realtimeService: {} }));

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async () => null),
    setItem: jest.fn(async () => {}),
    removeItem: jest.fn(async () => {}),
    multiGet: jest.fn(async () => []),
    multiSet: jest.fn(async () => {}),
  },
}));

import {
  ALL_TRANSACTIONS_SCOPE,
  assetTransactionsScope,
  useWalletStore,
} from '../walletStore';

const accountState = (id: string) =>
  useWalletStore.getState().accountStates[id];

describe('operation-scoped account errors (TASK-40)', () => {
  beforeEach(() => {
    mockGetAccountBalance.mockReset();
    mockGetTransactionHistory.mockReset();
    mockGetAllTransactionHistory.mockReset();
    mockGetAssetTransactionHistory.mockReset();
    mockGetAccount.mockClear();
    mockGetCurrentNetworkId.mockReset();
    mockGetCurrentNetworkId.mockReturnValue('voi-mainnet');
    useWalletStore.setState({ accountStates: {}, wallet: null });
  });

  it('records a balance failure under balanceError, not transactionsError', async () => {
    mockGetAccountBalance.mockRejectedValue(new Error('algod is down'));

    await useWalletStore.getState().loadAccountBalance('acc-1', true);

    expect(accountState('acc-1').balanceError).toBe('algod is down');
    expect(accountState('acc-1').transactionsError).toBeNull();
  });

  it('records a transaction failure under transactionsError, not balanceError', async () => {
    mockGetTransactionHistory.mockRejectedValue(new Error('indexer is down'));

    await useWalletStore.getState().loadAccountTransactions('acc-1');

    expect(accountState('acc-1').transactionsError).toEqual({
      scope: ALL_TRANSACTIONS_SCOPE,
      message: 'indexer is down',
    });
    expect(accountState('acc-1').balanceError).toBeNull();
  });

  it('does not let a successful balance refresh erase a transaction failure', async () => {
    // The regression that makes `lastError` unusable for this: the history
    // screen would drop back to "No Transactions" as soon as a balance poll
    // landed, even though the history fetch had genuinely failed.
    mockGetAllTransactionHistory.mockRejectedValue(new Error('indexer 503'));
    await useWalletStore.getState().loadAllTransactions('acc-1');
    expect(accountState('acc-1').transactionsError?.message).toBe(
      'indexer 503'
    );

    mockGetAccountBalance.mockResolvedValue({});
    await useWalletStore.getState().loadAccountBalance('acc-1', true);

    expect(accountState('acc-1').transactionsError?.message).toBe(
      'indexer 503'
    );
    expect(accountState('acc-1').balanceError).toBeNull();
  });

  it('clears the transaction error on a successful reload', async () => {
    mockGetAllTransactionHistory.mockRejectedValueOnce(
      new Error('indexer 503')
    );
    await useWalletStore.getState().loadAllTransactions('acc-1');
    expect(accountState('acc-1').transactionsError?.message).toBe(
      'indexer 503'
    );

    mockGetAllTransactionHistory.mockResolvedValueOnce({
      transactions: [],
      nextToken: undefined,
    });
    await useWalletStore.getState().loadAllTransactions('acc-1');

    expect(accountState('acc-1').transactionsError).toBeNull();
  });

  it('tags an asset-history failure with the asset scope, not the account-wide one', async () => {
    // Both loaders write into the SAME `recentTransactions` array and the same
    // error field, so without a scope tag an asset failure would render as the
    // full-history screen's failure (and vice versa).
    mockGetAssetTransactionHistory.mockRejectedValue(new Error('asset 500'));

    await useWalletStore.getState().loadAssetTransactions('acc-1', 42, false);

    expect(accountState('acc-1').transactionsError).toEqual({
      scope: assetTransactionsScope(42, false),
      message: 'asset 500',
    });
    expect(accountState('acc-1').transactionsError?.scope).not.toBe(
      ALL_TRANSACTIONS_SCOPE
    );
  });

  it('tags the shared transaction array with the resource it holds', async () => {
    // AssetDetailScreen and TransactionHistoryScreen read the SAME array; the
    // tag is what lets each tell whether the rows are actually theirs.
    mockGetAllTransactionHistory.mockResolvedValue({
      transactions: [{ id: 'a' }],
      nextToken: undefined,
    });
    await useWalletStore.getState().loadAllTransactions('acc-1');
    expect(accountState('acc-1').recentTransactionsScope).toBe(
      ALL_TRANSACTIONS_SCOPE
    );

    mockGetAssetTransactionHistory.mockResolvedValue({
      transactions: [{ id: 'b' }],
      nextToken: undefined,
      hasMore: false,
    });
    await useWalletStore.getState().loadAssetTransactions('acc-1', 42, false);
    expect(accountState('acc-1').recentTransactionsScope).toBe(
      assetTransactionsScope(42, false)
    );
  });

  it('does not skip a load for a DIFFERENT resource that is already in flight', async () => {
    // The skip guard dedupes identical requests. Skipping a different scope
    // would mean that screen never fetches at all, and — since the shared array
    // is scope-gated on read — it would sit on a permanent false empty state.
    let resolveAsset!: (value: unknown) => void;
    mockGetAssetTransactionHistory.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveAsset = resolve as (value: unknown) => void;
        })
    );
    mockGetAllTransactionHistory.mockResolvedValue({
      transactions: [],
      nextToken: undefined,
    });

    const assetLoad = useWalletStore
      .getState()
      .loadAssetTransactions('acc-1', 42, false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(accountState('acc-1').isTransactionsLoading).toBe(true);

    await useWalletStore.getState().loadAllTransactions('acc-1');

    // The account-wide request actually ran instead of being swallowed.
    expect(mockGetAllTransactionHistory).toHaveBeenCalledTimes(1);
    expect(accountState('acc-1').recentTransactionsScope).toBe(
      ALL_TRANSACTIONS_SCOPE
    );

    resolveAsset({ transactions: [], nextToken: undefined, hasMore: false });
    await assetLoad;
  });

  it('clearAccountError clears every scoped field', async () => {
    mockGetAccountBalance.mockRejectedValue(new Error('algod is down'));
    mockGetTransactionHistory.mockRejectedValue(new Error('indexer is down'));

    await useWalletStore.getState().loadAccountBalance('acc-1', true);
    await useWalletStore.getState().loadAccountTransactions('acc-1');

    useWalletStore.getState().clearAccountError('acc-1');

    expect(accountState('acc-1').lastError).toBeNull();
    expect(accountState('acc-1').balanceError).toBeNull();
    expect(accountState('acc-1').transactionsError).toBeNull();
    expect(accountState('acc-1').multiNetworkBalanceError).toBeNull();
  });
});
