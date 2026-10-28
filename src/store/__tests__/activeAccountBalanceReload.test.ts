// GH #12 / TASK-390: useActiveAccountBalance's `reload` must follow the active
// account. It used to compare against an id it had just assigned, so the check
// was always false and `reload` stayed bound to the FIRST active account until
// the app restarted: after an account switch, reload (and the pull-to-refresh
// that called it) refreshed the wrong account.

import { act, renderHook } from '@testing-library/react-native';

const mockGetAccountBalance = jest.fn(async () => ({}));
const mockGetAccount = jest.fn(async (id: string) => ({
  id,
  address: `ADDR-${id}`,
  type: 'standard',
}));

jest.mock('@/services/network', () => ({
  NetworkService: {
    getInstance: () => ({
      getAccountBalance: () => mockGetAccountBalance(),
      getCurrentNetworkId: () => 'voi-mainnet',
    }),
  },
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
  clearWalletUICache,
  useActiveAccountBalance,
  useWalletStore,
} from '../walletStore';
import type { Wallet } from '@/types/wallet';

const makeWallet = (activeAccountId: string): Wallet =>
  ({
    id: 'w',
    activeAccountId,
    accounts: [
      { id: 'acc-a', address: 'ADDR-acc-a', type: 'standard' },
      { id: 'acc-b', address: 'ADDR-acc-b', type: 'standard' },
    ],
  }) as unknown as Wallet;

describe('useActiveAccountBalance reload follows the active account (GH #12)', () => {
  beforeEach(() => {
    mockGetAccount.mockClear();
    mockGetAccountBalance.mockClear();
    clearWalletUICache();
    useWalletStore.setState({
      accountStates: {},
      wallet: makeWallet('acc-a'),
    });
  });

  it('reloads the newly active account after a switch', async () => {
    const { result } = await renderHook(() => useActiveAccountBalance());

    await act(async () => {
      await result.current.reload();
    });
    expect(mockGetAccount).toHaveBeenLastCalledWith('acc-a');

    await act(async () => {
      useWalletStore.setState({ wallet: makeWallet('acc-b') });
    });

    mockGetAccount.mockClear();
    await act(async () => {
      await result.current.reload();
    });

    expect(mockGetAccount).toHaveBeenCalledTimes(1);
    expect(mockGetAccount).toHaveBeenLastCalledWith('acc-b');
  });

  it('keeps reload referentially stable while the account is unchanged', async () => {
    const { result } = await renderHook(() => useActiveAccountBalance());
    const first = result.current.reload;

    // An unrelated per-account state change (new accountStates entry) must not
    // churn the reload identity.
    await act(async () => {
      useWalletStore.setState({
        accountStates: {
          'acc-a': {
            ...(useWalletStore.getState().accountStates['acc-a'] ?? {}),
            isBalanceLoading: true,
          } as never,
        },
      });
    });

    expect(result.current.reload).toBe(first);
  });
});
