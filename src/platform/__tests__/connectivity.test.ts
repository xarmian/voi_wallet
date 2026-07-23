/**
 * ConnectivityAdapter tests (TASK-40 / PLAN-12 DR-7).
 *
 * The adapter exists so NetInfo — a NATIVE module — never reaches the
 * extension/web bundle. These tests cover both implementations plus the shared
 * `isOffline()` predicate that decides what "offline" means on both targets.
 */

import { ExtensionConnectivityAdapter } from '../extension/connectivity';
import { isOffline } from '../index';
import type { ConnectivityState } from '../types';

describe('isOffline', () => {
  const base: ConnectivityState = {
    isConnected: true,
    isInternetReachable: null,
    type: 'wifi',
  };

  it('is offline when no interface is up', () => {
    expect(isOffline({ ...base, isConnected: false })).toBe(true);
  });

  it('is offline when the interface is up but the internet is unreachable', () => {
    // The captive-portal / dead-uplink case: NetInfo reports a connected
    // interface, but nothing is actually reachable.
    expect(isOffline({ ...base, isInternetReachable: false })).toBe(true);
  });

  it('is online when reachability is unknown but an interface is up', () => {
    // `null` = "cannot determine". Treating it as offline would flash the
    // banner on every cold boot and on every browser (which can never answer).
    expect(isOffline({ ...base, isInternetReachable: null })).toBe(false);
  });

  it('is online when reachability is confirmed', () => {
    expect(isOffline({ ...base, isInternetReachable: true })).toBe(false);
  });

  it('lets confirmed reachability win over a stale interface flag', () => {
    // Contradictory but observable during a transport switch; if the internet
    // is demonstrably reachable, the user is not offline.
    expect(
      isOffline({ ...base, isConnected: false, isInternetReachable: true })
    ).toBe(false);
  });
});

describe('ExtensionConnectivityAdapter', () => {
  // The jest-expo (react-native) environment has no DOM window/navigator, so
  // stand up a minimal browser shim. That is also the honest shape of what the
  // extension target actually provides.
  const listeners: Record<string, ((e: unknown) => void)[]> = {};
  let originalWindow: unknown;
  let originalNavigator: unknown;

  const setOnLine = (value: boolean) => {
    (globalThis as any).navigator.onLine = value;
  };

  const dispatch = (type: 'online' | 'offline') => {
    (listeners[type] ?? []).forEach((fn) => fn({ type }));
  };

  beforeEach(() => {
    for (const key of Object.keys(listeners)) delete listeners[key];
    originalWindow = (globalThis as any).window;
    originalNavigator = (globalThis as any).navigator;

    (globalThis as any).navigator = { onLine: true };
    (globalThis as any).window = {
      addEventListener: (type: string, fn: (e: unknown) => void) => {
        (listeners[type] ??= []).push(fn);
      },
      removeEventListener: (type: string, fn: (e: unknown) => void) => {
        listeners[type] = (listeners[type] ?? []).filter((f) => f !== fn);
      },
    };
  });

  afterEach(() => {
    (globalThis as any).window = originalWindow;
    (globalThis as any).navigator = originalNavigator;
  });

  it('reads navigator.onLine', async () => {
    const adapter = new ExtensionConnectivityAdapter();

    setOnLine(true);
    await expect(adapter.getState()).resolves.toEqual({
      isConnected: true,
      isInternetReachable: null,
      type: 'unknown',
    });

    setOnLine(false);
    await expect(adapter.getState()).resolves.toEqual({
      isConnected: false,
      isInternetReachable: null,
      type: 'none',
    });
  });

  it('never claims to know internet reachability', async () => {
    // `navigator.onLine` cannot answer this; guessing would produce a false
    // "you are offline" on any network with a working interface.
    setOnLine(true);
    const state = await new ExtensionConnectivityAdapter().getState();
    expect(state.isInternetReachable).toBeNull();
  });

  it('assumes online when navigator is unavailable', async () => {
    // Service-worker startup / SSR: unknown must not read as offline.
    (globalThis as any).navigator = undefined;
    await expect(
      new ExtensionConnectivityAdapter().getState()
    ).resolves.toEqual({
      isConnected: true,
      isInternetReachable: null,
      type: 'unknown',
    });
  });

  it('emits the current state on subscribe and on every transition', () => {
    setOnLine(true);
    const adapter = new ExtensionConnectivityAdapter();
    const listener = jest.fn();

    const unsubscribe = adapter.subscribe(listener);

    // Primed immediately, matching the mobile adapter's contract.
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenLastCalledWith(
      expect.objectContaining({ isConnected: true })
    );

    setOnLine(false);
    dispatch('offline');
    expect(listener).toHaveBeenLastCalledWith(
      expect.objectContaining({ isConnected: false, type: 'none' })
    );

    setOnLine(true);
    dispatch('online');
    expect(listener).toHaveBeenLastCalledWith(
      expect.objectContaining({ isConnected: true })
    );

    unsubscribe();
  });

  it('stops emitting after unsubscribe, and unsubscribing twice is safe', () => {
    setOnLine(true);
    const adapter = new ExtensionConnectivityAdapter();
    const listener = jest.fn();

    const unsubscribe = adapter.subscribe(listener);
    listener.mockClear();

    unsubscribe();
    unsubscribe();

    setOnLine(false);
    dispatch('offline');
    expect(listener).not.toHaveBeenCalled();
  });

  it('is a no-op subscription when there is no window to listen on', () => {
    (globalThis as any).window = undefined;
    const unsubscribe = new ExtensionConnectivityAdapter().subscribe(jest.fn());
    expect(() => unsubscribe()).not.toThrow();
  });
});

describe('MobileConnectivityAdapter', () => {
  const addEventListener = jest.fn();
  const fetchState = jest.fn();

  beforeEach(() => {
    jest.resetModules();
    addEventListener.mockReset();
    fetchState.mockReset();
    jest.doMock('@react-native-community/netinfo', () => ({
      __esModule: true,
      default: { addEventListener, fetch: fetchState },
    }));
  });

  afterEach(() => {
    jest.dontMock('@react-native-community/netinfo');
  });

  const loadAdapter = () => {
    const { MobileConnectivityAdapter } = require('../mobile/connectivity');
    return new MobileConnectivityAdapter();
  };

  it('normalizes a NetInfo snapshot', async () => {
    fetchState.mockResolvedValue({
      isConnected: false,
      isInternetReachable: false,
      type: 'none',
    });

    await expect(loadAdapter().getState()).resolves.toEqual({
      isConnected: false,
      isInternetReachable: false,
      type: 'none',
    });
  });

  it('treats an undetermined isConnected as connected', async () => {
    // NetInfo reports null before its first probe settles; reporting that as
    // offline would flash the banner on every cold boot.
    fetchState.mockResolvedValue({
      isConnected: null,
      isInternetReachable: null,
      type: 'unknown',
    });

    await expect(loadAdapter().getState()).resolves.toEqual({
      isConnected: true,
      isInternetReachable: null,
      type: 'unknown',
    });
  });

  it('forwards normalized states to subscribers and unsubscribes once', () => {
    const netInfoUnsubscribe = jest.fn();
    addEventListener.mockReturnValue(netInfoUnsubscribe);

    const adapter = loadAdapter();
    const listener = jest.fn();
    const unsubscribe = adapter.subscribe(listener);

    const emit = addEventListener.mock.calls[0][0];
    emit({ isConnected: true, isInternetReachable: false, type: 'wifi' });

    expect(listener).toHaveBeenCalledWith({
      isConnected: true,
      isInternetReachable: false,
      type: 'wifi',
    });

    unsubscribe();
    unsubscribe();
    expect(netInfoUnsubscribe).toHaveBeenCalledTimes(1);
  });
});
