/**
 * Extension/Web Connectivity Adapter
 *
 * Uses the browser `navigator.onLine` flag plus the `online`/`offline` window
 * events. This is deliberately NOT NetInfo: NetInfo is a native module and must
 * not reach the extension/web bundle (PLAN-12 DR-7).
 *
 * `navigator.onLine` only reports whether a network interface is up — it cannot
 * tell whether the internet is actually reachable — so `isInternetReachable` is
 * always reported as `null` (unknown) rather than guessed.
 */

import type { ConnectivityAdapter, ConnectivityState } from '../types';

const UNKNOWN_ONLINE: ConnectivityState = {
  isConnected: true,
  isInternetReachable: null,
  type: 'unknown',
};

function readNavigatorState(): ConnectivityState {
  // Environments without `navigator` (service worker startup, SSR, tests)
  // cannot answer, so assume online rather than falsely reporting offline.
  if (
    typeof navigator === 'undefined' ||
    typeof navigator.onLine !== 'boolean'
  ) {
    return UNKNOWN_ONLINE;
  }

  const online = navigator.onLine;
  return {
    isConnected: online,
    isInternetReachable: null,
    type: online ? 'unknown' : 'none',
  };
}

export class ExtensionConnectivityAdapter implements ConnectivityAdapter {
  async getState(): Promise<ConnectivityState> {
    return readNavigatorState();
  }

  subscribe(listener: (state: ConnectivityState) => void): () => void {
    if (typeof window === 'undefined' || !window.addEventListener) {
      return () => {};
    }

    const emit = () => listener(readNavigatorState());

    window.addEventListener('online', emit);
    window.addEventListener('offline', emit);

    // Match the mobile adapter: deliver the current state on subscribe so
    // consumers have a value without a separate priming fetch.
    emit();

    let released = false;
    return () => {
      if (released) return;
      released = true;
      window.removeEventListener('online', emit);
      window.removeEventListener('offline', emit);
    };
  }
}

// Singleton instance
export const extensionConnectivity = new ExtensionConnectivityAdapter();
