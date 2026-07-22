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

import { useWalletStore } from '../walletStore';

const accountState = (id: string) =>
  useWalletStore.getState().accountStates[id];

describe('operation-scoped account errors (TASK-40)', () => {
  beforeEach(() => {
    mockGetAccountBalance.mockReset();
    mockGetTransactionHistory.mockReset();
    mockGetAllTransactionHistory.mockReset();
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

    expect(accountState('acc-1').transactionsError).toBe('indexer is down');
    expect(accountState('acc-1').balanceError).toBeNull();
  });

  it('does not let a successful balance refresh erase a transaction failure', async () => {
    // The regression that makes `lastError` unusable for this: the history
    // screen would drop back to "No Transactions" as soon as a balance poll
    // landed, even though the history fetch had genuinely failed.
    mockGetAllTransactionHistory.mockRejectedValue(new Error('indexer 503'));
    await useWalletStore.getState().loadAllTransactions('acc-1');
    expect(accountState('acc-1').transactionsError).toBe('indexer 503');

    mockGetAccountBalance.mockResolvedValue({});
    await useWalletStore.getState().loadAccountBalance('acc-1', true);

    expect(accountState('acc-1').transactionsError).toBe('indexer 503');
    expect(accountState('acc-1').balanceError).toBeNull();
  });

  it('clears the transaction error on a successful reload', async () => {
    mockGetAllTransactionHistory.mockRejectedValueOnce(
      new Error('indexer 503')
    );
    await useWalletStore.getState().loadAllTransactions('acc-1');
    expect(accountState('acc-1').transactionsError).toBe('indexer 503');

    mockGetAllTransactionHistory.mockResolvedValueOnce({
      transactions: [],
      nextToken: undefined,
    });
    await useWalletStore.getState().loadAllTransactions('acc-1');

    expect(accountState('acc-1').transactionsError).toBeNull();
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
