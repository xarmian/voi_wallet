// TASK-59 / R-05: single-network balance writes are race-safe.
//
// - A fetch that straddles a network switch (A→B, or A→B→A where the network
//   id matches again) must not land its balance in state or the persisted
//   cache, and must not leave the loading spinner stuck.
// - refreshAllBalances merges per account into the LATEST state instead of
//   writing back a whole-map snapshot taken before its fetches.
// - An older fetch for an account can't overwrite a newer one's result.

const mockGetAccountBalance = jest.fn();
let mockNetworkId = 'voi-mainnet';
const mockGetAccount = jest.fn(async (id: string) => ({
  id,
  address: `ADDR-${id}`,
  type: 'standard',
}));
// A tiny in-memory AsyncStorage, so persisted-cache contents can be asserted.
let mockStorage: Record<string, string> = {};
// Reads resolve on a later macrotask, like real storage I/O, so overlapping
// read-modify-write persists genuinely interleave.
// The value is read when the call is made and delivered later.
const mockGetItem = jest.fn((key: string) => {
  const value = mockStorage[key] ?? null;
  return new Promise<string | null>((resolve) =>
    setTimeout(() => resolve(value), 0)
  );
});
// When `mockSlowWrites` is set, a write lands 20ms later (slower than a read,
// like real storage I/O), so a clear issued meanwhile can be overtaken by it.
let mockSlowWrites = false;
const mockSetItem = jest.fn((key: string, value: string) => {
  if (!mockSlowWrites) {
    mockStorage[key] = value;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) =>
    setTimeout(() => {
      mockStorage[key] = value;
      resolve();
    }, 20)
  );
});
const mockRemoveItem = jest.fn(async (key: string) => {
  delete mockStorage[key];
});
const mockDeleteAccount = jest.fn();
const mockUpdateAccountMetadata = jest.fn(async (_account: unknown) => {});
const mockGetCurrentWallet = jest.fn();

jest.mock('@/services/network', () => ({
  NetworkService: {
    getInstance: () => ({
      getAccountBalance: (address: string) => mockGetAccountBalance(address),
      getCurrentNetworkId: () => mockNetworkId,
    }),
  },
}));

jest.mock('@/services/wallet', () => ({
  MultiAccountWalletService: {
    getAccount: (id: string) => mockGetAccount(id),
    updateAccountMetadata: (account: unknown) =>
      mockUpdateAccountMetadata(account),
    deleteAccount: (id: string) => mockDeleteAccount(id),
    getCurrentWallet: () => mockGetCurrentWallet(),
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
  notificationService: { getDeviceId: () => null },
  DEFAULT_NOTIFICATION_PREFERENCES: {},
}));
jest.mock('@/services/realtime', () => ({ realtimeService: {} }));

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: (key: string) => mockGetItem(key),
    setItem: (key: string, value: string) => mockSetItem(key, value),
    removeItem: (key: string) => mockRemoveItem(key),
    multiRemove: async (keys: string[]) => {
      for (const key of keys) await mockRemoveItem(key);
    },
    multiGet: jest.fn(async () => []),
    multiSet: jest.fn(async () => {}),
  },
}));

import {
  invalidateBalanceRequests,
  removePersistedBalanceCaches,
  useWalletStore,
} from '../walletStore';
import type { AccountBalance, Wallet } from '@/types/wallet';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
/** Outlasts every slow write. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

const balanceOf = (amount: bigint): AccountBalance => ({
  address: 'ADDR',
  amount,
  minBalance: 0n,
  assets: [],
});

/** getAccountBalance calls stay pending until the test resolves them. */
const deferFetches = () => {
  const pending: { address: string; resolve: (b: AccountBalance) => void }[] =
    [];
  mockGetAccountBalance.mockImplementation(
    (address: string) =>
      new Promise<AccountBalance>((resolve) => {
        pending.push({ address, resolve });
      })
  );
  return pending;
};

const wallet = {
  id: 'w',
  activeAccountId: 'acc-1',
  accounts: [
    { id: 'acc-1', address: 'ADDR-acc-1', type: 'standard' },
    { id: 'acc-2', address: 'ADDR-acc-2', type: 'standard' },
  ],
} as unknown as Wallet;

const stateOf = (id: string) => useWalletStore.getState().accountStates[id];

/** The network store's switch: invalidate, then move the network. */
const switchNetwork = (to: string) => {
  invalidateBalanceRequests();
  mockNetworkId = to;
};

beforeEach(() => {
  mockGetAccountBalance.mockReset();
  mockGetAccount.mockClear();
  mockSetItem.mockClear();
  mockStorage = {};
  mockSlowWrites = false;
  mockRemoveItem.mockClear();
  mockNetworkId = 'voi-mainnet';
  useWalletStore.setState({ accountStates: {}, wallet });
});

// Let each test's deferred cache persists (setTimeout → async read → write)
// finish inside that test, so they can't leak into the next one's assertions.
afterEach(async () => {
  for (let i = 0; i < 10; i += 1) await flush();
});

describe('loadAccountBalance commit guard (TASK-59)', () => {
  it('commits a fetch when nothing changed (control)', async () => {
    const pending = deferFetches();
    const load = useWalletStore.getState().loadAccountBalance('acc-1', true);
    await flush();
    expect(stateOf('acc-1')?.isBalanceLoading).toBe(true);

    pending[0].resolve(balanceOf(7n));
    await load;
    for (let i = 0; i < 10; i += 1) await flush();

    expect(stateOf('acc-1')?.balance?.amount).toBe(7n);
    expect(stateOf('acc-1')?.balanceNetworkId).toBe('voi-mainnet');
    expect(stateOf('acc-1')?.isBalanceLoading).toBe(false);
    expect(mockSetItem).toHaveBeenCalled();
  });

  it('drops a fetch that straddles a network switch, and clears its spinner', async () => {
    const pending = deferFetches();
    const load = useWalletStore.getState().loadAccountBalance('acc-1', true);
    await flush();

    switchNetwork('algorand-mainnet');
    pending[0].resolve(balanceOf(7n));
    await load;
    await flush();

    expect(stateOf('acc-1')?.balance).toBeUndefined();
    expect(stateOf('acc-1')?.isBalanceLoading).toBe(false);
    expect(stateOf('acc-1')?.isBackgroundRefreshing).toBe(false);
    // Nothing persisted under either network.
    expect(mockSetItem).not.toHaveBeenCalled();
  });

  it('drops a fetch when the service network moved without a store switch', async () => {
    // e.g. a service-level switch that bypasses the network store, so the
    // epoch is not bumped: the network id check alone must catch it.
    const pending = deferFetches();
    const load = useWalletStore.getState().loadAccountBalance('acc-1', true);
    await flush();

    mockNetworkId = 'algorand-mainnet';
    pending[0].resolve(balanceOf(7n));
    await load;
    await flush();

    expect(stateOf('acc-1')?.balance).toBeUndefined();
    expect(stateOf('acc-1')?.isBalanceLoading).toBe(false);
    expect(mockSetItem).not.toHaveBeenCalled();
  });

  it('drops a fetch across A→B→A, where the network id matches again', async () => {
    const pending = deferFetches();
    const load = useWalletStore.getState().loadAccountBalance('acc-1', true);
    await flush();

    switchNetwork('algorand-mainnet');
    switchNetwork('voi-mainnet');
    pending[0].resolve(balanceOf(7n));
    await load;
    await flush();

    expect(stateOf('acc-1')?.balance).toBeUndefined();
    expect(mockSetItem).not.toHaveBeenCalled();
  });

  it('a caller after A→B→A starts its own load instead of joining the stale one', async () => {
    const pending = deferFetches();
    const stale = useWalletStore.getState().loadAccountBalance('acc-1', true);
    await flush();

    switchNetwork('algorand-mainnet');
    switchNetwork('voi-mainnet');
    const fresh = useWalletStore.getState().loadAccountBalance('acc-1', true);
    await flush();
    expect(pending).toHaveLength(2);

    pending[0].resolve(balanceOf(1n));
    pending[1].resolve(balanceOf(2n));
    await Promise.all([stale, fresh]);

    expect(stateOf('acc-1')?.balance?.amount).toBe(2n);
  });
});

describe('persisted balance cache (TASK-59)', () => {
  it('a switch after commit but before the deferred persist writes nothing', async () => {
    const pending = deferFetches();
    const load = useWalletStore.getState().loadAccountBalance('acc-1', true);
    await flush();
    pending[0].resolve(balanceOf(7n));
    await load;
    expect(stateOf('acc-1')?.balance?.amount).toBe(7n);
    expect(stateOf('acc-1')?.balanceNetworkId).toBe('voi-mainnet');

    // The persist is still queued behind a 0ms timer.
    switchNetwork('algorand-mainnet');
    for (let i = 0; i < 10; i += 1) await flush();

    expect(mockSetItem).not.toHaveBeenCalled();
  });

  it('concurrent persists from a batch refresh keep every account', async () => {
    const pending = deferFetches();
    const refresh = useWalletStore.getState().refreshAllBalances();
    await flush();
    pending.forEach(({ resolve }, i) => resolve(balanceOf(BigInt(i + 1))));
    await refresh;
    for (let i = 0; i < 10; i += 1) await flush();

    const blobs = Object.values(mockStorage);
    expect(blobs).toHaveLength(1);
    const keys = Object.keys(JSON.parse(blobs[0]));
    expect(keys.some((k) => k.startsWith('acc-1'))).toBe(true);
    expect(keys.some((k) => k.startsWith('acc-2'))).toBe(true);
  });
});

describe('balance-cache clears vs deferred writes (TASK-59)', () => {
  /** Commit a balance for acc-1; its persist is still queued behind a timer. */
  const commitBalance = async () => {
    mockSlowWrites = true;
    const pending = deferFetches();
    const load = useWalletStore.getState().loadAccountBalance('acc-1', true);
    await flush();
    pending[0].resolve(balanceOf(7n));
    await load;
    expect(mockSetItem).not.toHaveBeenCalled();
  };

  /** Commit a balance for acc-1 and stop once its persist has called setItem. */
  const startDeferredWrite = async () => {
    await commitBalance();
    for (let i = 0; i < 10 && mockSetItem.mock.calls.length === 0; i += 1) {
      await flush();
    }
    // The write passed its last token check and its setItem is in flight.
    expect(mockSetItem).toHaveBeenCalledTimes(1);
  };

  const cachedKeys = () => {
    const blob = Object.values(mockStorage)[0];
    return blob ? Object.keys(JSON.parse(blob)) : [];
  };

  it('a network-switch clear sticks over a write already in setItem', async () => {
    await startDeferredWrite();

    // The network store's switch: invalidate, move, then clear the cache.
    switchNetwork('algorand-mainnet');
    await useWalletStore.getState().clearSingleNetworkCache();
    await settle();

    expect(cachedKeys()).toEqual([]);
    expect(stateOf('acc-1')?.balanceNetworkId).toBeUndefined();
  });

  it('the switch clear keeps a load already issued for the NEW network', async () => {
    // networkStore.switchNetwork: invalidate, switch the service, then clear.
    // A load issued between the switch and the clear is for the new network
    // and must still land.
    switchNetwork('algorand-mainnet');
    const pending = deferFetches();
    const load = useWalletStore.getState().loadAccountBalance('acc-1', true);
    await flush();
    await useWalletStore.getState().clearSingleNetworkCache();

    pending[0].resolve(balanceOf(9n));
    await load;
    await settle();

    expect(stateOf('acc-1')?.balance?.amount).toBe(9n);
    expect(stateOf('acc-1')?.balanceNetworkId).toBe('algorand-mainnet');
    expect(stateOf('acc-1')?.isBalanceLoading).toBe(false);
    expect(cachedKeys()).toEqual(['acc-1_single_algorand-mainnet']);
  });

  it('a per-account clear sticks over a write already in setItem', async () => {
    await startDeferredWrite();

    await useWalletStore.getState().clearSingleNetworkCache('acc-1');
    await settle();

    expect(cachedKeys().some((k) => k.startsWith('acc-1'))).toBe(false);
  });

  it('a per-account clear sticks over a write that starts after it', async () => {
    // The clear reads the blob first; the deferred write then reads, and its
    // read-modify-write lands after the clear's.
    await commitBalance();

    await useWalletStore.getState().clearSingleNetworkCache('acc-1');
    await settle();

    expect(cachedKeys().some((k) => k.startsWith('acc-1'))).toBe(false);
  });

  // TASK-398: the backup restore removes balance-cache keys from outside the
  // store; a deferred persist must not re-add an entry afterwards.
  it('a restore removal sticks over a write already in setItem', async () => {
    await startDeferredWrite();

    await removePersistedBalanceCaches();
    await settle();

    expect(cachedKeys()).toEqual([]);
  });

  it('a restore removal sticks over a deferred write that has not started', async () => {
    await commitBalance();

    await removePersistedBalanceCaches();
    await settle();

    expect(cachedKeys()).toEqual([]);
  });

  it('clearAllBalanceCache sticks over a write already in setItem', async () => {
    await startDeferredWrite();

    await useWalletStore.getState().clearAllBalanceCache();
    await settle();

    expect(cachedKeys()).toEqual([]);
    expect(stateOf('acc-1')?.balanceNetworkId).toBeUndefined();
  });
});

describe('deleteAccount vs in-flight balance fetches (TASK-59)', () => {
  it('a fetch that lands after deletion does not recreate the account state', async () => {
    const pending = deferFetches();
    const load = useWalletStore.getState().loadAccountBalance('acc-2', true);
    await flush();
    expect(stateOf('acc-2')).toBeDefined();

    const remaining = {
      ...wallet,
      accounts: wallet.accounts.filter((a) => a.id !== 'acc-2'),
    };
    mockDeleteAccount.mockResolvedValueOnce(undefined);
    mockGetCurrentWallet.mockResolvedValueOnce(remaining);
    const target = wallet.accounts.find((a) => a.id === 'acc-2')!;
    await useWalletStore.getState().deleteAccount('acc-2', {
      address: target.address,
      type: target.type,
      keyless: true,
    });
    expect(stateOf('acc-2')).toBeUndefined();

    pending[0].resolve(balanceOf(7n));
    await load;
    await flush();

    expect(stateOf('acc-2')).toBeUndefined();
    expect(mockSetItem).not.toHaveBeenCalled();
  });
});

describe('refreshAllBalances (TASK-59)', () => {
  it('keeps updates made to accountStates while its fetches were in flight', async () => {
    const pending = deferFetches();
    const refresh = useWalletStore.getState().refreshAllBalances();
    await flush();
    expect(pending).toHaveLength(2);

    // Interleaved writes: another field on a refreshed account, and an
    // account added mid-refresh.
    useWalletStore.setState((state) => ({
      accountStates: {
        ...state.accountStates,
        'acc-1': {
          ...(state.accountStates['acc-1'] ?? {}),
          envoiName: { name: 'alice.voi' },
        } as never,
        'acc-3': { isBalanceLoading: true } as never,
      },
    }));

    pending.forEach(({ resolve }, i) => resolve(balanceOf(BigInt(i + 10))));
    await refresh;

    expect(stateOf('acc-1')?.balance?.amount).toBe(10n);
    expect(stateOf('acc-2')?.balance?.amount).toBe(11n);
    expect(stateOf('acc-1')?.envoiName).toEqual({ name: 'alice.voi' });
    expect(stateOf('acc-3')).toEqual({ isBalanceLoading: true });
  });

  it('does not re-write old-network balances after a switch cleared them', async () => {
    const pending = deferFetches();
    const refresh = useWalletStore.getState().refreshAllBalances();
    await flush();

    switchNetwork('algorand-mainnet');
    pending.forEach(({ resolve }) => resolve(balanceOf(99n)));
    await refresh;
    await flush();

    expect(stateOf('acc-1')?.balance).toBeUndefined();
    expect(stateOf('acc-2')?.balance).toBeUndefined();
    expect(mockSetItem).not.toHaveBeenCalled();
  });

  it('a restore removal releases the spinner of a load a batch superseded (TASK-398)', async () => {
    // The per-account load is no longer "latest" once the batch starts, and
    // after the restore's invalidation neither can settle the loading flag.
    const pending = deferFetches();
    const load = useWalletStore.getState().loadAccountBalance('acc-1', true);
    await flush();
    const refresh = useWalletStore.getState().refreshAllBalances();
    await flush();
    expect(stateOf('acc-1')?.isBalanceLoading).toBe(true);

    await removePersistedBalanceCaches();
    pending.forEach(({ resolve }) => resolve(balanceOf(5n)));
    await Promise.all([load, refresh]);
    await settle();

    expect(stateOf('acc-1')?.isBalanceLoading).toBe(false);
    expect(stateOf('acc-1')?.balance).toBeUndefined();
  });

  it('an older batch result cannot overwrite a newer per-account load', async () => {
    const pending = deferFetches();
    const refresh = useWalletStore.getState().refreshAllBalances();
    await flush();

    // A forced single-account load is issued after the batch and lands first.
    const load = useWalletStore.getState().loadAccountBalance('acc-1', true);
    await flush();
    const newer = pending.find((p, i) => i >= 2 && p.address === 'ADDR-acc-1');
    newer!.resolve(balanceOf(2n));
    await load;
    expect(stateOf('acc-1')?.balance?.amount).toBe(2n);

    // Then the batch's older acc-1 response arrives.
    pending
      .slice(0, 2)
      .forEach(({ address, resolve }) =>
        resolve(balanceOf(address === 'ADDR-acc-1' ? 1n : 5n))
      );
    await refresh;

    expect(stateOf('acc-1')?.balance?.amount).toBe(2n);
    expect(stateOf('acc-2')?.balance?.amount).toBe(5n);
  });
});
