/**
 * Wiring tests for cold-start route delivery (DR-10 / TASK-381).
 *
 * Under UIScene the initial URL / launch notification can reach JS before the
 * NavigationContainer has mounted a navigator. The old navigateToRoute waited
 * 100 ms and then dropped the route. These specs drive the REAL DeepLinkService
 * with `react-native` Linking mocked and a fake navigation container ref, and
 * assert that each cold-start route reaches `deliver()` and is routed once the
 * container signals ready, even well after 100 ms. Parsing and WalletConnect
 * handling are the real (unchanged) code; only their leaves are mocked.
 */

import type { NavigationContainerRef } from '@react-navigation/native';

type UrlListener = (event: { url: string }) => void;

const mockUrlSubscription = { remove: jest.fn() };
const mockUrlListeners: UrlListener[] = [];
const mockLinking = {
  getInitialURL: jest.fn(async (): Promise<string | null> => null),
  addEventListener: jest.fn((type: string, listener: UrlListener) => {
    if (type === 'url') mockUrlListeners.push(listener);
    return mockUrlSubscription;
  }),
};

// Real react-native (expo-constants etc. need its native-module shims), with
// only Linking swapped for the mock.
jest.mock('react-native', () => {
  const RN = jest.requireActual('react-native');
  Object.defineProperty(RN, 'Linking', {
    configurable: true,
    get: () => mockLinking,
  });
  return RN;
});

jest.mock('@react-navigation/native', () => ({
  StackActions: {
    replace: (name: string, params?: object) => ({
      type: 'REPLACE',
      payload: { name, params },
    }),
  },
}));

const mockWcService = { pair: jest.fn(async (_uri: string) => {}) };
jest.mock('@/services/walletconnect', () => ({
  WalletConnectService: { getInstance: () => mockWcService },
}));
jest.mock('@/services/walletconnect/v1', () => ({
  WalletConnectV1Client: { getInstance: jest.fn() },
}));
jest.mock('@/services/walletconnect/TransactionRequestQueue', () => ({
  TransactionRequestQueue: { enqueue: jest.fn() },
}));

type TapHandler = (data: any, notificationId?: string) => unknown;
let mockTapHandler: TapHandler | null = null;
jest.mock('@/services/notifications', () => ({
  notificationService: {
    setNotificationTapHandler: (handler: TapHandler) => {
      mockTapHandler = handler;
    },
  },
}));

jest.mock('@/store/walletStore', () => ({
  useWalletStore: {
    getState: () => ({ wallet: null, setActiveAccount: jest.fn() }),
  },
}));
jest.mock('@/store/networkStore', () => ({
  useNetworkStore: { getState: () => ({ currentNetwork: 'voi-mainnet' }) },
}));
jest.mock('@/services/network/config', () => ({
  getNetworkConfig: () => ({ name: 'Voi' }),
}));

// Spy on deliver() while keeping the real queue behaviour.
const mockDeliverCalls: string[] = [];
jest.mock('../pendingRoute', () => {
  const actual = jest.requireActual('../pendingRoute');
  return {
    ...actual,
    createPendingRouteQueue: (deps: any) => {
      const queue = actual.createPendingRouteQueue(deps);
      return {
        ...queue,
        deliver: (key: string, run: () => unknown) => {
          mockDeliverCalls.push(key);
          return queue.deliver(key, run);
        },
      };
    },
  };
});

import { DeepLinkService } from '../index';

const makeNavRef = () => {
  let ready = false;
  const listeners: Record<string, Set<() => void>> = {
    ready: new Set(),
    state: new Set(),
  };
  const ref = {
    isReady: jest.fn(() => ready),
    navigate: jest.fn(),
    dispatch: jest.fn(),
    getCurrentRoute: jest.fn(),
    addListener: jest.fn((type: string, cb: () => void) => {
      listeners[type].add(cb);
      return () => listeners[type].delete(cb);
    }),
  };
  return {
    ref: ref as unknown as NavigationContainerRef<any>,
    navigate: ref.navigate,
    listenerCount: () => listeners.ready.size + listeners.state.size,
    /** What BaseNavigationContainer does when its navigator mounts. */
    becomeReady: () => {
      ready = true;
      listeners.ready.forEach((cb) => cb());
    },
  };
};

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

const ADDRESS = 'VOIADDRESS';
const WC_URI =
  'wc:7f6e504bfad60b485450578e05678ed3e8e8c4751d3c6160be17160d63ec90f9@2?relay-protocol=irn&symKey=587d5484ce2a2a6ee3ba1962fdd7e8588e06200c46823bd18fbd67def96ad303';

describe('DeepLinkService cold-start delivery (TASK-381)', () => {
  let service: DeepLinkService;
  let nav: ReturnType<typeof makeNavRef>;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    mockDeliverCalls.length = 0;
    mockUrlListeners.length = 0;
    mockTapHandler = null;
    mockLinking.getInitialURL.mockResolvedValue(null);
    service = new DeepLinkService();
    nav = makeNavRef();
    service.setNavigationRef(nav.ref);
  });

  afterEach(() => {
    service.cleanup();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  /** Cold start: init, then readiness arrives well past the old 100 ms. */
  const coldStartThenReady = async () => {
    await service.initialize();
    await jest.advanceTimersByTimeAsync(1_500);
    expect(nav.navigate).not.toHaveBeenCalled();
    nav.becomeReady();
    await flush();
  };

  it('a cold voi:// link is queued and routed once navigation is ready', async () => {
    const url = `voi://send?to=${ADDRESS}&amount=5`;
    mockLinking.getInitialURL.mockResolvedValue(url);

    await coldStartThenReady();

    expect(mockDeliverCalls).toEqual([`url:${url}`]);
    expect(nav.navigate).toHaveBeenCalledTimes(1);
    expect(nav.navigate).toHaveBeenCalledWith('Main', {
      screen: 'Home',
      params: {
        screen: 'Send',
        params: { recipient: ADDRESS, amount: '5', note: undefined },
      },
    });
  });

  it('a cold wc: pairing URI is queued and paired once navigation is ready', async () => {
    mockLinking.getInitialURL.mockResolvedValue(WC_URI);

    await service.initialize();
    await jest.advanceTimersByTimeAsync(1_500);
    expect(mockWcService.pair).not.toHaveBeenCalled();
    nav.becomeReady();
    await flush();

    expect(mockDeliverCalls).toEqual([`url:${WC_URI}`]);
    expect(mockWcService.pair).toHaveBeenCalledTimes(1);
    expect(mockWcService.pair).toHaveBeenCalledWith(WC_URI);
  });

  it('a cold https://www.getvoi.app/wc universal link is queued and paired once navigation is ready', async () => {
    const url = `https://www.getvoi.app/wc?uri=${encodeURIComponent(WC_URI)}`;
    mockLinking.getInitialURL.mockResolvedValue(url);

    await service.initialize();
    await jest.advanceTimersByTimeAsync(1_500);
    expect(mockWcService.pair).not.toHaveBeenCalled();
    nav.becomeReady();
    await flush();

    expect(mockDeliverCalls).toEqual([`url:${url}`]);
    expect(mockWcService.pair).toHaveBeenCalledWith(WC_URI);
  });

  it('getInitialURL and the first url event for the same URL route once', async () => {
    const url = `voi://send?to=${ADDRESS}&amount=5`;
    // The 'url' event fires while getInitialURL is still pending (UIScene can
    // deliver the launch URL both ways). The listener must already be
    // attached, and the duplicate must not route twice.
    mockLinking.getInitialURL.mockImplementation(async () => {
      mockUrlListeners.forEach((listener) => listener({ url }));
      return url;
    });

    await coldStartThenReady();

    expect(mockDeliverCalls).toEqual([`url:${url}`, `url:${url}`]);
    expect(nav.navigate).toHaveBeenCalledTimes(1);
  });

  it('a warm url event routes immediately when navigation is ready', async () => {
    await service.initialize();
    nav.becomeReady();

    mockUrlListeners.forEach((listener) =>
      listener({ url: `voi://receive?x=1` })
    );
    await flush();

    expect(nav.navigate).toHaveBeenCalledWith('Main', {
      screen: 'Receive',
      params: { x: '1' },
    });
  });

  it('a cold notification response (unlocked) is queued and routed once navigation is ready', async () => {
    await service.initialize();
    service.setUnlockState(true);
    expect(mockTapHandler).not.toBeNull();

    void mockTapHandler!({ type: 'payment' }, 'notif-1');
    await jest.advanceTimersByTimeAsync(1_500);
    expect(nav.navigate).not.toHaveBeenCalled();

    nav.becomeReady();
    await flush();

    expect(mockDeliverCalls).toEqual(['notification:notif-1']);
    expect(nav.navigate).toHaveBeenCalledWith('Main', {
      screen: 'Home',
      params: { screen: 'HomeMain' },
    });
  });

  it('the same notification identifier (cold-start + response listener) routes once', async () => {
    await service.initialize();
    service.setUnlockState(true);
    nav.becomeReady();

    await mockTapHandler!({ type: 'payment' }, 'notif-1');
    await mockTapHandler!({ type: 'payment' }, 'notif-1');

    expect(nav.navigate).toHaveBeenCalledTimes(1);
  });

  it('an unlock-gated notification still waits for unlock AFTER readiness', async () => {
    await service.initialize();
    service.setUnlockState(false);

    void mockTapHandler!({ type: 'payment' }, 'notif-2');
    nav.becomeReady();
    await flush();

    // Ready, but locked: held, not routed.
    expect(mockDeliverCalls).toEqual(['notification:notif-2']);
    expect(nav.navigate).not.toHaveBeenCalled();
    expect(service.hasPendingNotification()).toBe(true);

    service.setUnlockState(true);
    await flush();

    expect(service.hasPendingNotification()).toBe(false);
    expect(nav.navigate).toHaveBeenCalledWith('Main', {
      screen: 'Home',
      params: { screen: 'HomeMain' },
    });
  });

  it('teardown removes the Linking subscription and the navigation listeners', async () => {
    await service.initialize();
    expect(mockLinking.addEventListener).toHaveBeenCalledWith(
      'url',
      expect.any(Function)
    );
    expect(nav.listenerCount()).toBe(2);

    service.cleanup();

    expect(mockUrlSubscription.remove).toHaveBeenCalledTimes(1);
    expect(nav.listenerCount()).toBe(0);
  });

  it('teardown keeps a route still waiting for readiness; a remount delivers it', async () => {
    mockLinking.getInitialURL.mockResolvedValue(`voi://receive?x=1`);
    await service.initialize();

    service.cleanup();
    nav.becomeReady(); // the torn-down container: listeners already detached
    await flush();
    expect(nav.navigate).not.toHaveBeenCalled();

    const remounted = makeNavRef();
    service.setNavigationRef(remounted.ref);
    remounted.becomeReady();
    await flush();

    expect(remounted.navigate).toHaveBeenCalledTimes(1);
    expect(remounted.navigate).toHaveBeenCalledWith('Main', {
      screen: 'Receive',
      params: { x: '1' },
    });
  });
});
