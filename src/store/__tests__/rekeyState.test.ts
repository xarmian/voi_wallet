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
const mockUpdateWithRekeyInfo = jest.fn();
const mockGetCurrentWallet = jest.fn();

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
  },
}));

jest.mock('@/services/wallet/rekeyManager', () => ({
  __esModule: true,
  default: {
    updateAccountWithRekeyInfo: (...args: unknown[]) =>
      mockUpdateWithRekeyInfo(...args),
  },
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
  mockUpdateWithRekeyInfo.mockImplementation(async (account) => account);
  mockGetCurrentWallet.mockResolvedValue(wallet);
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

describe('canSign parity with updateAccountWithRekeyInfo', () => {
  const realManager = jest.requireActual(
    '@/services/wallet/rekeyManager'
  ).default;
  it.each([
    [AccountType.STANDARD, false, false, true],
    [AccountType.LEDGER, false, false, false],
    [AccountType.LEDGER, true, false, true],
    [AccountType.LEDGER, false, true, true],
    [AccountType.REMOTE_SIGNER, false, false, true],
    [AccountType.WATCH, false, false, false],
    [AccountType.REKEYED, false, false, false],
  ])(
    '%s connected=%s available=%s',
    async (type, connected, available, expected) => {
      const accounts = [
        wallet.accounts[0],
        { ...wallet.accounts[1], type, deviceId: 'device' },
      ];
      const currentWallet = { ...wallet, accounts } as Wallet;
      useWalletStore.setState({ wallet: currentWallet });
      mockConnected.mockReturnValue(
        connected ? { id: 'device' } : { id: 'OTHER' }
      );
      mockDevices.mockReturnValue(available ? [{ id: 'device' }] : []);
      const updated = await realManager.updateAccountWithRekeyInfo(
        accounts[0],
        balance.rekeyInfo,
        currentWallet
      );
      expect(updated.canSign).toBe(expected);
      expect(getRekeyState('SOURCE', network)).toMatchObject({
        canSign: updated.canSign,
      });
      expect(await getRekeyStateStrict('SOURCE', network)).toMatchObject({
        canSign: updated.canSign,
      });
    }
  );
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
