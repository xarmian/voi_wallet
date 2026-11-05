// TASK-514: the wallet store after an onboarding commit, and after a failed read.
//
// 1. Trap 1 (dev lead): initialize() coalesces onto an in-flight pass. A pass
//    that started BEFORE accounts were committed reads an empty wallet, so a
//    refresh issued after the commit must not join it: it waits for it, then
//    runs a fresh pass that sees the accounts.
// 2. A failed read must not look like an empty wallet (product, TASK-514):
//    getCurrentWallet() swallows storage read errors and resolves null, so the
//    store tells "no wallet" from "could not read" with the strict probe, and
//    exposes `walletLoadFailed` so Home shows an error with Try again, never
//    Get Started, while accounts may exist. Only a load that succeeded and found
//    no wallet may show Get Started.
//
// Real walletStore; the wallet service and platform storage are faked.

const mockGetCurrentWallet = jest.fn();
const mockHasWalletWithAccountsStrict = jest.fn();

jest.mock('@/services/network', () => ({
  NetworkService: {
    getInstance: () => ({
      getAccountBalance: jest.fn(async () => ({})),
      getCurrentNetworkId: () => 'voi-mainnet',
    }),
  },
}));

jest.mock('@/services/wallet', () => ({
  MultiAccountWalletService: {
    getCurrentWallet: () => mockGetCurrentWallet(),
    hasWalletWithAccountsStrict: () => mockHasWalletWithAccountsStrict(),
    getAccount: jest.fn(async () => null),
    updateAccountMetadata: jest.fn(async () => {}),
  },
}));

jest.mock('@/services/wallet/rekeyManager', () => ({
  __esModule: true,
  default: {},
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

import { clearWalletUICache, useWalletStore } from '../walletStore';
import type { Wallet } from '@/types/wallet';

function walletWith(ids: string[]): Wallet {
  return {
    id: 'w',
    version: '1',
    createdAt: '2026-11-05T00:00:00.000Z',
    activeAccountId: ids[0],
    accounts: ids.map((id) => ({
      id,
      address: `ADDR-${id}`,
      publicKey: '00',
      type: 'standard',
      label: id,
      isHidden: false,
      createdAt: '2026-11-05T00:00:00.000Z',
    })),
    settings: {},
  } as unknown as Wallet;
}

const store = () => useWalletStore.getState();

beforeEach(() => {
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  mockGetCurrentWallet.mockReset();
  mockHasWalletWithAccountsStrict.mockReset();
  clearWalletUICache();
  useWalletStore.setState({
    wallet: null,
    isInitialized: false,
    isLoading: false,
    lastError: null,
    walletLoadFailed: false,
  } as never);
});

describe('TASK-514: a refresh after the commit never joins an init that started before it', () => {
  it('an init in flight when the commit lands reads empty; refresh() waits for it and then sees the accounts', async () => {
    let finishStaleRead: (w: Wallet | null) => void = () => {};
    // First pass: started before the commit, still reading when the commit lands.
    mockGetCurrentWallet.mockImplementationOnce(
      () => new Promise<Wallet | null>((resolve) => (finishStaleRead = resolve))
    );
    mockHasWalletWithAccountsStrict.mockResolvedValue(false);
    const stale = store().initialize();

    // The restore commits the accounts and the caller asks for a refresh.
    mockGetCurrentWallet.mockResolvedValue(walletWith(['a', 'b']));
    const refreshed = store().refresh();

    // The stale pass finishes with the empty wallet it read before the commit.
    finishStaleRead(null);
    await stale;
    await refreshed;

    expect(store().wallet?.accounts.map((a) => a.id)).toEqual(['a', 'b']);
    expect(store().isInitialized).toBe(true);
    expect(store().walletLoadFailed).toBe(false);
  });

  it('a second initialize() call while one is in flight still joins it (the cold-start coalescing stays)', async () => {
    let finish: (w: Wallet | null) => void = () => {};
    mockGetCurrentWallet.mockImplementationOnce(
      () => new Promise<Wallet | null>((resolve) => (finish = resolve))
    );
    mockHasWalletWithAccountsStrict.mockResolvedValue(false);
    const first = store().initialize();
    const second = store().initialize();
    finish(walletWith(['a']));
    await Promise.all([first, second]);
    expect(mockGetCurrentWallet).toHaveBeenCalledTimes(1);
  });
});

describe('TASK-514: a failed read is not an empty wallet', () => {
  it('a genuine empty wallet (the read succeeded and found nothing) is loaded, not failed: Get Started may show', async () => {
    mockGetCurrentWallet.mockResolvedValue(null);
    mockHasWalletWithAccountsStrict.mockResolvedValue(false);
    await store().initialize();
    expect(store().isInitialized).toBe(true);
    expect(store().wallet).toBeNull();
    expect(store().walletLoadFailed).toBe(false);
  });

  it('getCurrentWallet swallowed a read failure and returned null, but accounts exist: the load failed', async () => {
    mockGetCurrentWallet.mockResolvedValue(null);
    mockHasWalletWithAccountsStrict.mockResolvedValue(true);
    await store().initialize();
    expect(store().wallet).toBeNull();
    expect(store().walletLoadFailed).toBe(true);
  });

  it('the strict probe itself cannot read: the load failed, never "no wallet"', async () => {
    mockGetCurrentWallet.mockResolvedValue(null);
    mockHasWalletWithAccountsStrict.mockRejectedValue(new Error('keychain'));
    await store().initialize();
    expect(store().wallet).toBeNull();
    expect(store().walletLoadFailed).toBe(true);
  });

  it('getCurrentWallet rejects (the catch branch): the load failed and the error is kept', async () => {
    mockGetCurrentWallet.mockRejectedValue(new Error('read exploded'));
    await store().initialize();
    expect(store().walletLoadFailed).toBe(true);
    expect(store().lastError).toBe('read exploded');
    expect(store().isInitialized).toBe(true);
  });

  it('a wallet whose accounts is not an array throws inside initialize: the load failed', async () => {
    mockGetCurrentWallet.mockResolvedValue({ id: 'w', accounts: {} });
    await store().initialize();
    expect(store().wallet).toBeNull();
    expect(store().walletLoadFailed).toBe(true);
  });

  it('a successful load clears the failure, and Try again (refresh) recovers from it', async () => {
    mockGetCurrentWallet.mockResolvedValue(null);
    mockHasWalletWithAccountsStrict.mockResolvedValue(true);
    await store().initialize();
    expect(store().walletLoadFailed).toBe(true);

    mockGetCurrentWallet.mockResolvedValue(walletWith(['a']));
    await store().refresh();
    expect(store().walletLoadFailed).toBe(false);
    expect(store().wallet?.accounts).toHaveLength(1);
  });

  it('a load that finds a wallet never probes (no extra read on the normal cold start)', async () => {
    mockGetCurrentWallet.mockResolvedValue(walletWith(['a']));
    await store().initialize();
    expect(mockHasWalletWithAccountsStrict).not.toHaveBeenCalled();
    expect(store().walletLoadFailed).toBe(false);
  });
});
