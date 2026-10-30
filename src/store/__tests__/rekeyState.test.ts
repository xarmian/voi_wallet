const mockGetAccountBalance = jest.fn();
const mockGetRekeyInfo = jest.fn();
const mockGetInstance = jest.fn();
const mockConnected = jest.fn();
const mockDevices = jest.fn();
const mockDeviceListeners = new Set<() => void>();
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
const mockSetItem = jest.fn(async (key: string, value: string) => {
  mockStorage[key] = value;
});
const mockRemoveItem = jest.fn(async (key: string) => {
  delete mockStorage[key];
});
const mockDeleteAccount = jest.fn();
const mockUpdateAccountMetadata = jest.fn(async (_account: unknown) => {});
const mockGetCurrentWallet = jest.fn();
const mockPersistRestoredWallet = jest.fn();

jest.mock('@/services/network', () => ({
  NetworkService: {
    getInstance: (networkId?: string) => {
      mockGetInstance(networkId);
      return {
        getAccountRekeyInfo: (...args: unknown[]) => mockGetRekeyInfo(...args),
        getAccountBalance: (address: string) => mockGetAccountBalance(address),
        getCurrentNetworkId: () => mockNetworkId,
      };
    },
  },
}));

jest.mock('@/services/wallet', () => ({
  MultiAccountWalletService: {
    getAccount: (id: string) => mockGetAccount(id),
    updateAccountMetadata: (account: unknown) =>
      mockUpdateAccountMetadata(account),
    deleteAccount: (id: string) => mockDeleteAccount(id),
    getCurrentWallet: () => mockGetCurrentWallet(),
    persistRestoredWallet: (restored: unknown) =>
      mockPersistRestoredWallet(restored),
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
    multiGet: jest.fn(async () => []),
    multiSet: jest.fn(async () => {}),
  },
}));

jest.mock('@/services/ledger/transport', () => ({
  ledgerTransportService: {
    getConnectedDevice: () => mockConnected(),
    getDevices: () => mockDevices(),
    on: jest.fn((_event: string, listener: () => void) => {
      mockDeviceListeners.add(listener);
      return () => mockDeviceListeners.delete(listener);
    }),
  },
}));

import {
  getRekeyState,
  getRekeyStateStrict,
  useRekeyState,
  useWalletStore,
} from '../walletStore';
import { AccountBalance, AccountType, Wallet } from '@/types/wallet';
import { NetworkId } from '@/types/network';
import { renderHook, act } from '@testing-library/react-native';
import { AccountSecureStorage } from '@/services/secure/AccountSecureStorage';

const network = NetworkId.VOI_MAINNET;
const otherNetwork = NetworkId.ALGORAND_MAINNET;
const wallet = {
  id: 'w',
  accounts: [
    {
      id: 'source',
      address: 'SOURCE',
      type: AccountType.REKEYED,
      authAddress: 'STALE',
      canSign: false,
    },
    { id: 'signer', address: 'AUTH', type: AccountType.STANDARD },
  ],
} as unknown as Wallet;
const balance: AccountBalance = {
  address: 'SOURCE',
  amount: 1n,
  minBalance: 0n,
  assets: [],
  rekeyInfo: { isRekeyed: true, authAddress: 'AUTH' },
};
const seed = (patch = {}) => {
  useWalletStore.setState({
    wallet,
    accountStates: {
      source: {
        balance,
        balanceNetworkId: network,
        balanceError: null,
        ...patch,
      } as never,
    },
  });
};
const state = () => useWalletStore.getState().accountStates.source;

beforeEach(() => {
  jest.clearAllMocks();
  mockDeviceListeners.clear();
  mockStorage = {};
  mockNetworkId = network;
  mockConnected.mockReturnValue(null);
  mockDevices.mockReturnValue([]);
  mockGetRekeyInfo.mockResolvedValue(balance.rekeyInfo);
  mockGetCurrentWallet.mockResolvedValue(wallet);
  mockPersistRestoredWallet.mockImplementation(async (restored: Wallet) => {
    mockGetCurrentWallet.mockResolvedValue(restored);
    useWalletStore.setState({ wallet: restored });
  });
  seed();
});
afterEach(async () => {
  // Finish deferred cache writes before the next test changes networks.
  await new Promise((resolve) => setTimeout(resolve, 25));
});

describe('network-scoped rekey accessors', () => {
  it('network mismatch returns loading', () => {
    expect(getRekeyState('SOURCE', otherNetwork)).toEqual({
      status: 'loading',
    });
  });
  it.each([undefined, {}])('empty rekeyInfo returns loading: %p', (info) => {
    seed({ balance: { ...balance, rekeyInfo: info } });
    expect(getRekeyState('SOURCE', network)).toEqual({ status: 'loading' });
  });
  it('requires a stamp and a known account', () => {
    seed({ balanceNetworkId: undefined });
    expect(getRekeyState('SOURCE', network)).toEqual({ status: 'loading' });
    expect(getRekeyState('UNKNOWN', network)).toEqual({ status: 'loading' });
  });
  it('ignores persisted stale authAddress and canSign', async () => {
    const expected = {
      status: 'loaded',
      isRekeyed: true,
      authAddress: 'AUTH',
      canSign: true,
    };
    expect(getRekeyState('SOURCE', network)).toEqual(expected);
    expect(await getRekeyStateStrict('SOURCE', network)).toEqual(expected);
  });
  it('loads not-rekeyed state from rekeyInfo', () => {
    seed({ balance: { ...balance, rekeyInfo: { isRekeyed: false } } });
    expect(getRekeyState('SOURCE', network)).toEqual({
      status: 'loaded',
      isRekeyed: false,
      authAddress: undefined,
      canSign: false,
    });
  });
  it('reports scoped balance failures only for the stamped network', () => {
    seed({ balanceError: 'offline' });
    expect(getRekeyState('SOURCE', network)).toEqual({ status: 'error' });
    expect(getRekeyState('SOURCE', otherNetwork)).toEqual({
      status: 'loading',
    });
  });
  it('strict queries the explicit network instance with skipTimestamp', async () => {
    await getRekeyStateStrict('SOURCE', otherNetwork);
    expect(mockGetInstance).toHaveBeenCalledWith(otherNetwork);
    expect(mockGetRekeyInfo).toHaveBeenCalledWith('SOURCE', true);
  });
  it('unavailable is an error and strict signing lookup rejects it', async () => {
    const info = { isRekeyed: false, unavailable: true };
    const { deriveRekeyState } = jest.requireActual(
      '@/services/wallet/rekeyState'
    );
    expect(deriveRekeyState('SOURCE', info, wallet.accounts)).toEqual({
      status: 'error',
    });
    seed({ balance: { ...balance, rekeyInfo: info } });
    expect(getRekeyState('SOURCE', network)).toEqual({ status: 'error' });
    mockGetRekeyInfo.mockResolvedValueOnce(info);
    await expect(getRekeyStateStrict('SOURCE', network)).rejects.toThrow(
      'unavailable'
    );
  });
  it('strict throws on fetch failure', async () => {
    const error = new Error('offline');
    mockGetRekeyInfo.mockRejectedValueOnce(error);
    await expect(getRekeyStateStrict('SOURCE', network)).rejects.toBe(error);
  });
  it('selector reacts to Ledger device availability without a balance update', async () => {
    useWalletStore.setState({
      wallet: {
        ...wallet,
        accounts: [
          wallet.accounts[0],
          {
            ...wallet.accounts[1],
            type: AccountType.LEDGER,
            deviceId: 'device',
          },
        ],
      } as Wallet,
    });
    const { result, unmount } = await renderHook(() =>
      useRekeyState('SOURCE', network)
    );
    expect(result.current).toMatchObject({ canSign: false });
    await act(() => {
      mockDevices.mockReturnValue([{ id: 'device' }]);
      mockDeviceListeners.forEach((listener) => listener());
    });
    expect(result.current).toMatchObject({ canSign: true });
    await unmount();
    expect(mockDeviceListeners.size).toBe(0);
  });
  it('selector stays stable and reacts to network stamp changes', async () => {
    const { result, rerender } = await renderHook(() =>
      useRekeyState('SOURCE', network)
    );
    const first = result.current;
    await act(() => useWalletStore.setState({ lastError: 'unrelated' }));
    await rerender({});
    expect(result.current).toBe(first);
    await act(() => seed({ balanceNetworkId: otherNetwork }));
    expect(result.current).toEqual({ status: 'loading' });
  });
});

describe('retained REKEYED auth key (TASK-425 U3)', () => {
  // AUTH's record stays REKEYED after an undone rekey (U4); its own key may or
  // may not still be on the device.
  const retained = {
    ...wallet,
    accounts: [
      wallet.accounts[0],
      { id: 'signer', address: 'AUTH', type: AccountType.REKEYED },
    ],
  } as unknown as Wallet;
  let probe: jest.SpyInstance;
  beforeEach(() => {
    useWalletStore.setState({ wallet: retained });
    probe = jest.spyOn(AccountSecureStorage, 'probeSecretPresenceStrict');
  });
  afterEach(() => probe.mockRestore());

  it('strict counts it as the signer once its key is probed present', async () => {
    probe.mockResolvedValue(true);
    await expect(getRekeyStateStrict('SOURCE', network)).resolves.toMatchObject(
      { isRekeyed: true, authAddress: 'AUTH', canSign: true }
    );
    expect(probe).toHaveBeenCalledWith('signer');
  });

  it('strict reads it as not signing when the key is gone', async () => {
    probe.mockResolvedValue(false);
    await expect(getRekeyStateStrict('SOURCE', network)).resolves.toMatchObject(
      { canSign: false }
    );
  });

  it('strict propagates a probe error instead of guessing', async () => {
    probe.mockRejectedValue(new Error('keychain busy'));
    await expect(getRekeyStateStrict('SOURCE', network)).rejects.toThrow(
      'Signer custody unavailable'
    );
  });

  it('the sync display path does not probe and reads it as not signing', () => {
    useWalletStore.setState({
      wallet: retained,
      accountStates: {
        source: {
          balance,
          balanceNetworkId: network,
          balanceError: null,
        } as never,
      },
    });
    expect(getRekeyState('SOURCE', network)).toMatchObject({ canSign: false });
    expect(probe).not.toHaveBeenCalled();
  });
});

describe('balance stamp commit paths', () => {
  it.each([true, false])(
    'single fetch with rekeyInfo=%s commits atomically',
    async (withRekey) => {
      useWalletStore.setState({ accountStates: {} });
      mockGetAccountBalance.mockResolvedValue({
        ...balance,
        rekeyInfo: withRekey ? balance.rekeyInfo : undefined,
      });
      const commits: unknown[] = [];
      const off = useWalletStore.subscribe((s) => {
        if (s.accountStates.source?.balance)
          commits.push(s.accountStates.source.balanceNetworkId);
      });
      await useWalletStore.getState().loadAccountBalance('source', true);
      off();
      expect(commits.length).toBeGreaterThan(0);
      expect(commits.every((stamp) => stamp === network)).toBe(true);
    }
  );
  it('batch refresh commits a stamp for each account', async () => {
    useWalletStore.setState({ accountStates: {} });
    mockGetAccountBalance.mockResolvedValue(balance);
    await useWalletStore.getState().refreshAllBalances();
    wallet.accounts.forEach((a) => {
      expect(
        useWalletStore.getState().accountStates[a.id].balanceNetworkId
      ).toBe(network);
    });
  });
  it.each(['initialize', 'setViewMode'])(
    '%s hydrates the cache network stamp',
    async (action) => {
      mockStorage['@voi_wallet_balance_cache_v2'] = JSON.stringify({
        ['source_single_voi-mainnet']: {
          balance: {
            ...balance,
            amount: { __bigint: '1' },
            minBalance: { __bigint: '0' },
          },
          lastUpdated: 1,
          networkId: network,
        },
      });
      useWalletStore.setState({
        accountStates: {},
        viewMode: action === 'initialize' ? 'single-network' : 'multi-network',
      });
      if (action === 'initialize') await useWalletStore.getState().initialize();
      else await useWalletStore.getState().setViewMode('single-network');
      expect(state().balanceNetworkId).toBe(network);
      expect(state().balance?.amount).toBe(1n);
    }
  );
  it.each(['account', 'network-switch', 'all'])(
    '%s clear clears the stamp',
    async (action) => {
      if (action === 'all')
        await useWalletStore.getState().clearAllBalanceCache();
      else
        await useWalletStore
          .getState()
          .clearSingleNetworkCache(action === 'account' ? 'source' : undefined);
      expect(state().balance).toBeUndefined();
      expect(state().balanceNetworkId).toBeUndefined();
    }
  );
});

// Restore through the production restorer, then exercise production accessors
// and signing preflight against contradictory network responses.
describe('restored legacy rekey fields are non-authoritative', () => {
  it.each([false, true])(
    'chain isRekeyed=%s wins after restore',
    async (isRekeyed) => {
      const { AccountSecureStorage } =
        await import('@/services/secure/AccountSecureStorage');
      const { restoreAccounts } = await import('@/services/backup/restorers');
      const { SecureKeyManager } = await import('@/services/secure/keyManager');
      const store = jest
        .spyOn(AccountSecureStorage, 'storeAccountMetadataForCreation')
        .mockResolvedValue(undefined);
      const probe = jest
        .spyOn(AccountSecureStorage, 'probeSecretPresenceStrict')
        .mockResolvedValue(false);
      try {
        await restoreAccounts([
          {
            id: 'source',
            address: 'SOURCE',
            publicKey: '',
            type: AccountType.REKEYED,
            createdAt: '',
            isHidden: false,
            authAddress: 'STALE',
            canSign: !isRekeyed,
          },
          {
            id: 'signer',
            address: 'AUTH',
            publicKey: '',
            type: AccountType.REMOTE_SIGNER,
            createdAt: '',
            isHidden: false,
            signerDeviceId: 'device',
            pairedAt: '2026-01-01',
          },
        ]);
        expect(useWalletStore.getState().wallet?.accounts[0]).toMatchObject({
          authAddress: 'STALE',
          canSign: !isRekeyed,
        });
        const info = { isRekeyed, authAddress: isRekeyed ? 'AUTH' : undefined };
        useWalletStore.setState({
          accountStates: {
            source: {
              balance: { ...balance, rekeyInfo: info },
              balanceNetworkId: otherNetwork,
            } as never,
          },
        });
        mockGetRekeyInfo.mockResolvedValue(info);
        const derived = getRekeyState('SOURCE', otherNetwork);
        const signing = await SecureKeyManager.getSigningInfo(
          'SOURCE',
          otherNetwork
        );
        expect({ derived, signing }).toMatchObject({
          derived: { status: 'loaded', ...info, canSign: isRekeyed },
          signing: {
            ...info,
            canSign: isRekeyed,
            signingAddress: isRekeyed ? 'AUTH' : 'SOURCE',
          },
        });
        expect(mockGetInstance).toHaveBeenCalledWith(otherNetwork);
        expect(mockGetRekeyInfo).toHaveBeenCalledWith('SOURCE', true);
      } finally {
        store.mockRestore();
        probe.mockRestore();
      }
    }
  );
});

describe('balance loads never persist rekey metadata', () => {
  it.each([
    ['single', AccountType.STANDARD],
    ['single', AccountType.WATCH],
    ['single', AccountType.REKEYED],
    ['batch', AccountType.STANDARD],
    ['batch', AccountType.WATCH],
    ['batch', AccountType.REKEYED],
  ])(
    '%s leaves %s metadata intact on every network and after switches',
    async (mode, type) => {
      const currentWallet = {
        ...wallet,
        accounts: [{ ...wallet.accounts[0], type }, wallet.accounts[1]],
      } as Wallet;
      useWalletStore.setState({ wallet: currentWallet });
      mockGetAccount.mockImplementation(
        async (id: string) =>
          currentWallet.accounts.find((account) => account.id === id) as never
      );
      const original = useWalletStore.getState().wallet;
      for (const networkId of [...Object.values(NetworkId), network]) {
        mockNetworkId = networkId;
        for (const rekeyInfo of [balance.rekeyInfo, { isRekeyed: false }]) {
          await useWalletStore.getState().clearSingleNetworkCache();
          mockGetAccountBalance.mockResolvedValue({ ...balance, rekeyInfo });
          if (mode === 'single') {
            await useWalletStore.getState().loadAccountBalance('source', true);
          } else {
            await useWalletStore.getState().refreshAllBalances();
          }
          expect(state().balanceNetworkId).toBe(networkId);
          expect(state().balance?.rekeyInfo).toEqual(rekeyInfo);
          expect(mockUpdateAccountMetadata).not.toHaveBeenCalled();
          expect(useWalletStore.getState().wallet).toBe(original);
        }
      }
    }
  );
});

// TASK-458: both current-network balance commits feed the display-only rekey
// status, so an external rekey shows after the next refresh. Neither writes
// wallet metadata or the persisted account type.
describe('balance refreshes feed the display-only rekey status (TASK-458)', () => {
  const external = {
    ...balance,
    rekeyInfo: { isRekeyed: true, authAddress: 'OUTSIDE' },
  };
  const display = async (address: string) => {
    const { useRekeyDisplayStatus, clearRekeyDisplayStatus } =
      await import('../rekeyDisplayStatus');
    return { useRekeyDisplayStatus, clearRekeyDisplayStatus, address };
  };

  it.each(['loadAccountBalance', 'refreshAllBalances'] as const)(
    '%s records an external rekey without a persisted write',
    async (path) => {
      const { useRekeyDisplayStatus, clearRekeyDisplayStatus } =
        await display('');
      clearRekeyDisplayStatus();
      // Pinned here: earlier tests in this file replace these implementations.
      mockGetAccount.mockImplementation(async (id: string) => ({
        id,
        address: id === 'source' ? 'SOURCE' : 'AUTH',
        type: 'standard',
      }));
      mockGetCurrentWallet.mockResolvedValue(wallet);
      useWalletStore.setState({ wallet, accountStates: {} });
      const { issueRekeyObservation, stampRekeyInfo } =
        await import('@/services/network/rekeyObservation');
      // Stamped at issue, as NetworkService.getAccountRekeyInfo does.
      mockGetAccountBalance.mockImplementation(async () => ({
        ...external,
        rekeyInfo: stampRekeyInfo(
          { ...external.rekeyInfo },
          issueRekeyObservation()
        ),
      }));
      const address = 'SOURCE';
      if (path === 'loadAccountBalance')
        await useWalletStore.getState().loadAccountBalance('source', true);
      else await useWalletStore.getState().refreshAllBalances();
      const { result } = await renderHook(() =>
        useRekeyDisplayStatus(address, network)
      );
      expect(result.current).toMatchObject({
        status: 'delegated',
        authAddress: 'OUTSIDE',
      });
      expect(mockUpdateAccountMetadata).not.toHaveBeenCalled();
      expect(mockPersistRestoredWallet).not.toHaveBeenCalled();
      // Storage writes, if any, are the network-scoped balance cache only.
      for (const [key] of mockSetItem.mock.calls) {
        expect(key).toMatch(/balance_cache/);
      }
    }
  );

  // Codex passes C #2 / D #1: an explicit refresh never just joins a load
  // whose read was issued before the press, forced or not.
  it.each([false, true])(
    'a forced load after another load in flight (forced=%s) issues its own read',
    async (firstForced) => {
      const { useRekeyDisplayStatus, clearRekeyDisplayStatus } =
        await import('../rekeyDisplayStatus');
      const { issueRekeyObservation, stampRekeyInfo } =
        await import('@/services/network/rekeyObservation');
      clearRekeyDisplayStatus();
      mockGetAccount.mockImplementation(async (id: string) => ({
        id,
        address: id === 'source' ? 'SOURCE' : 'AUTH',
        type: 'standard',
      }));
      useWalletStore.setState({ wallet, accountStates: {} });
      let releaseOld!: () => void;
      const reads: string[] = [];
      mockGetAccountBalance.mockImplementation(async () => {
        const first = reads.length === 0;
        reads.push(first ? 'old' : 'new');
        // The old read was issued before the external rekey landed.
        const observation = issueRekeyObservation();
        if (first) await new Promise<void>((resolve) => (releaseOld = resolve));
        return {
          ...balance,
          rekeyInfo: stampRekeyInfo(
            first
              ? { isRekeyed: false }
              : { isRekeyed: true, authAddress: 'OUTSIDE' },
            observation
          ),
        };
      });
      const earlier = useWalletStore
        .getState()
        .loadAccountBalance('source', firstForced);
      await new Promise((resolve) => setTimeout(resolve, 0));
      // Two presses while the earlier load is in flight share one follow-up.
      const press1 = useWalletStore
        .getState()
        .loadAccountBalance('source', true);
      const press2 = useWalletStore
        .getState()
        .loadAccountBalance('source', true);
      releaseOld();
      await Promise.all([earlier, press1, press2]);
      expect(reads).toEqual(['old', 'new']);
      const { result } = await renderHook(() =>
        useRekeyDisplayStatus('SOURCE', network)
      );
      expect(result.current).toMatchObject({
        status: 'delegated',
        authAddress: 'OUTSIDE',
      });
    }
  );
});
