/**
 * Offline gate (TASK-191).
 *
 * The gate decides whether a retry ladder runs at all, so the cold-start
 * behaviour matters more than the steady state: `unknown` MUST read as online.
 * A gate that guesses "offline" while it waits for its first probe would turn
 * every cold launch into a wallet that refuses to fetch anything.
 */

import type { ConnectivityState } from '@/platform';

const mockSubscribe = jest.fn();
const mockGetState = jest.fn();

jest.mock('@/platform', () => {
  const actual = jest.requireActual('@/platform');
  return {
    ...actual,
    connectivity: {
      subscribe: (listener: (state: ConnectivityState) => void) =>
        mockSubscribe(listener),
      getState: () => mockGetState(),
    },
  };
});

import {
  getOfflineCounters,
  getReachability,
  isDefinitelyOffline,
  resetOfflineCounters,
  resetOfflineGate,
  shouldSkipForOffline,
} from '../offline';

const ONLINE: ConnectivityState = {
  isConnected: true,
  isInternetReachable: true,
  type: 'wifi',
};

const OFFLINE: ConnectivityState = {
  isConnected: false,
  isInternetReachable: false,
  type: 'none',
};

/** Never-settling probe, so subscription behaviour can be tested in isolation. */
const pending = () => new Promise<ConnectivityState>(() => {});

describe('offline gate (TASK-191)', () => {
  let emit: ((state: ConnectivityState) => void) | null;
  let unsubscribe: jest.Mock;

  beforeEach(() => {
    emit = null;
    unsubscribe = jest.fn();
    mockSubscribe.mockImplementation(
      (listener: (state: ConnectivityState) => void) => {
        emit = listener;
        return unsubscribe;
      }
    );
    mockGetState.mockImplementation(pending);
    resetOfflineGate();
  });

  afterEach(() => {
    resetOfflineGate();
  });

  describe('cold start (fail open)', () => {
    it('reads as unknown — and therefore NOT offline — before the adapter answers', () => {
      expect(getReachability()).toBe('unknown');
      expect(isDefinitelyOffline()).toBe(false);
      expect(shouldSkipForOffline('mimir')).toBe(false);
    });

    it('stays online when subscribing throws', () => {
      resetOfflineGate();
      mockSubscribe.mockImplementation(() => {
        throw new Error('no adapter');
      });

      expect(getReachability()).toBe('unknown');
      expect(isDefinitelyOffline()).toBe(false);
    });

    it('stays online when the probe rejects', async () => {
      resetOfflineGate();
      mockGetState.mockRejectedValue(new Error('probe failed'));

      expect(isDefinitelyOffline()).toBe(false);
      await Promise.resolve();
      await Promise.resolve();
      expect(isDefinitelyOffline()).toBe(false);
      expect(getReachability()).toBe('unknown');
    });

    it('stays online when getState throws synchronously', () => {
      resetOfflineGate();
      mockGetState.mockImplementation(() => {
        throw new Error('adapter exploded');
      });

      expect(() => getReachability()).not.toThrow();
      expect(isDefinitelyOffline()).toBe(false);
    });

    it('primes lazily on first read — nothing needs to bootstrap it', () => {
      expect(mockSubscribe).not.toHaveBeenCalled();
      expect(mockGetState).not.toHaveBeenCalled();

      getReachability();

      expect(mockSubscribe).toHaveBeenCalledTimes(1);
      expect(mockGetState).toHaveBeenCalledTimes(1);

      // Repeat reads must not re-register.
      getReachability();
      isDefinitelyOffline();
      expect(mockSubscribe).toHaveBeenCalledTimes(1);
      expect(mockGetState).toHaveBeenCalledTimes(1);
    });
  });

  describe('snapshot', () => {
    it('goes offline and back online as the subscription reports transitions', () => {
      getReachability();

      emit!(OFFLINE);
      expect(getReachability()).toBe('offline');
      expect(isDefinitelyOffline()).toBe(true);

      emit!(ONLINE);
      expect(getReachability()).toBe('online');
      expect(isDefinitelyOffline()).toBe(false);
    });

    it('treats undetermined reachability with an interface up as online', () => {
      getReachability();
      emit!({ isConnected: true, isInternetReachable: null, type: 'wifi' });
      expect(getReachability()).toBe('online');
    });

    it('fills the initial gap from the one-shot probe', async () => {
      resetOfflineGate();
      mockSubscribe.mockImplementation(() => unsubscribe); // never emits
      mockGetState.mockResolvedValue(OFFLINE);

      expect(getReachability()).toBe('unknown');
      await Promise.resolve();
      await Promise.resolve();
      expect(getReachability()).toBe('offline');
    });

    it('lets a subscription value win over a probe that resolves later', async () => {
      resetOfflineGate();
      let settleProbe!: (state: ConnectivityState) => void;
      mockGetState.mockImplementation(
        () =>
          new Promise<ConnectivityState>((resolve) => (settleProbe = resolve))
      );

      getReachability();
      emit!(ONLINE);
      expect(getReachability()).toBe('online');

      // Stale probe result must not clobber the fresher subscription value.
      settleProbe(OFFLINE);
      await Promise.resolve();
      await Promise.resolve();
      expect(getReachability()).toBe('online');
    });

    it('drops the subscription on reset', () => {
      getReachability();
      resetOfflineGate();
      expect(unsubscribe).toHaveBeenCalledTimes(1);
    });
  });

  describe('counters', () => {
    it('counts nothing while online', () => {
      getReachability();
      emit!(ONLINE);

      expect(shouldSkipForOffline('voi-price')).toBe(false);
      expect(getOfflineCounters().offlineSkips).toBe(0);
    });

    it('counts a skip per gated call, per scope', () => {
      getReachability();
      emit!(OFFLINE);

      expect(shouldSkipForOffline('mimir')).toBe(true);
      expect(shouldSkipForOffline('mimir')).toBe(true);
      expect(shouldSkipForOffline('envoi')).toBe(true);

      const counters = getOfflineCounters();
      expect(counters.offlineSkips).toBe(3);
      expect(counters.offlineSkipsByScope.mimir).toBe(2);
      expect(counters.offlineSkipsByScope.envoi).toBe(1);
      expect(counters.offlineSkipsByScope['voi-price']).toBe(0);
    });

    it('exposes counts only — every value is a number', () => {
      getReachability();
      emit!(OFFLINE);
      shouldSkipForOffline('home-refresh');

      const counters = getOfflineCounters();
      expect(typeof counters.offlineSkips).toBe('number');
      for (const value of Object.values(counters.offlineSkipsByScope)) {
        expect(typeof value).toBe('number');
      }
    });

    it('resets counters without dropping the connectivity snapshot', () => {
      getReachability();
      emit!(OFFLINE);
      shouldSkipForOffline('messages-poll');

      resetOfflineCounters();

      expect(getOfflineCounters().offlineSkips).toBe(0);
      expect(getReachability()).toBe('offline');
      expect(unsubscribe).not.toHaveBeenCalled();
    });
  });
});
