// TASK-49: in-flight request dedup for loadAccountBalance (walletStore).
//
// Proves that concurrent loadAccountBalance calls for the SAME account+network
// share a single underlying getAccountBalance request (and therefore run the
// expensive fetch + rekey persist exactly once), while a DIFFERENT network is
// NOT deduped together — because the in-flight key includes the networkId, a
// mid-load network switch starts its own fetch instead of joining (and
// inheriting/persisting) the previous network's result.
//
// The heavy service graph is mocked so the store imports lightweight; only the
// two dependencies loadAccountBalance actually drives (NetworkService +
// MultiAccountWalletService) carry behavior.

const mockGetAccountBalance = jest.fn();
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

// Drain microtasks + 0ms timers so the shared in-flight promise advances to the
// (still-pending) getAccountBalance call.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('loadAccountBalance in-flight dedup (TASK-49)', () => {
  beforeEach(() => {
    mockGetAccountBalance.mockReset();
    mockGetAccount.mockClear();
    mockGetCurrentNetworkId.mockReset();
    mockGetCurrentNetworkId.mockReturnValue('voi-mainnet');
    // Clear cached balance state so the cache-freshness guard never short-circuits.
    useWalletStore.setState({ accountStates: {}, wallet: null });
  });

  it('shares a single request across concurrent callers for the same account+network', async () => {
    let resolveBalance!: (value: unknown) => void;
    mockGetAccountBalance.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveBalance = resolve as (value: unknown) => void;
        })
    );

    const { loadAccountBalance } = useWalletStore.getState();

    // Two overlapping callers (e.g. HomeScreen mount + pull-to-refresh) fired
    // before the first fetch settles.
    const p1 = loadAccountBalance('acc-1', true);
    const p2 = loadAccountBalance('acc-1', true);

    await flush();

    // The expensive chain (getAccount + getAccountBalance) ran exactly once and
    // is shared by both callers.
    expect(mockGetAccount).toHaveBeenCalledTimes(1);
    expect(mockGetAccountBalance).toHaveBeenCalledTimes(1);

    resolveBalance({});
    await Promise.all([p1, p2]);

    expect(mockGetAccountBalance).toHaveBeenCalledTimes(1);
  });

  it('does NOT dedup across networks — a mid-load network switch starts its own fetch', async () => {
    const resolvers: ((value: unknown) => void)[] = [];
    mockGetAccountBalance.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve as (value: unknown) => void);
        })
    );

    const { loadAccountBalance } = useWalletStore.getState();

    mockGetCurrentNetworkId.mockReturnValue('voi-mainnet');
    const p1 = loadAccountBalance('acc-1', true);
    await flush();

    // Network switches while the mainnet load is still in flight.
    mockGetCurrentNetworkId.mockReturnValue('voi-testnet');
    const p2 = loadAccountBalance('acc-1', true);
    await flush();

    // Two distinct fetches: the testnet caller did NOT join the mainnet
    // in-flight load, so no wrong-network balance can be applied/persisted.
    expect(mockGetAccountBalance).toHaveBeenCalledTimes(2);

    resolvers.forEach((resolve) => resolve({}));
    await Promise.all([p1, p2]);
  });

  it('clears the in-flight entry so a later forced load runs again (finally cleanup)', async () => {
    mockGetAccountBalance.mockResolvedValue({});

    const { loadAccountBalance } = useWalletStore.getState();

    await loadAccountBalance('acc-1', true);
    expect(mockGetAccountBalance).toHaveBeenCalledTimes(1);

    // The map entry was removed in `finally`, so a subsequent forceRefresh is
    // free to start a fresh load rather than being wedged.
    await loadAccountBalance('acc-1', true);
    expect(mockGetAccountBalance).toHaveBeenCalledTimes(2);
  });

  it('clears the in-flight entry even when the load throws (no wedged future loads)', async () => {
    mockGetAccountBalance.mockRejectedValueOnce(new Error('network down'));

    const { loadAccountBalance } = useWalletStore.getState();

    // The failed load must not reject to callers (errors are handled to state)…
    await expect(loadAccountBalance('acc-1', true)).resolves.toBeUndefined();

    // …and must not wedge future loads: the next attempt fetches again.
    mockGetAccountBalance.mockResolvedValueOnce({});
    await loadAccountBalance('acc-1', true);
    expect(mockGetAccountBalance).toHaveBeenCalledTimes(2);
  });
});
