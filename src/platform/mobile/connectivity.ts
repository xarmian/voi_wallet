/**
 * Mobile Connectivity Adapter
 *
 * Wraps `@react-native-community/netinfo`, which is a NATIVE module. It is
 * deliberately reachable only through the platform adapter (`@/platform`) —
 * importing it directly from shared code would pull the native module into the
 * extension/web bundle (PLAN-12 DR-7).
 *
 * OTA-safe (PLAN-12 DR-8): `react-native-netinfo (11.4.1)` is already in
 * `ios/Podfile.lock`, so the native module is present in shipped binaries and
 * adding this import is a JS-only change.
 */

import NetInfo, { type NetInfoState } from '@react-native-community/netinfo';
import type { ConnectivityAdapter, ConnectivityState } from '../types';

function toConnectivityState(state: NetInfoState): ConnectivityState {
  return {
    // NetInfo types `isConnected` as `boolean | null` — null means "not yet
    // determined". Treating that as offline would flash the banner on every
    // cold boot, so an undetermined interface is optimistically "connected"
    // and the reachability field carries the uncertainty instead.
    isConnected: state.isConnected ?? true,
    isInternetReachable: state.isInternetReachable ?? null,
    type: state.type ?? 'unknown',
  };
}

export class MobileConnectivityAdapter implements ConnectivityAdapter {
  async getState(): Promise<ConnectivityState> {
    const state = await NetInfo.fetch();
    return toConnectivityState(state);
  }

  subscribe(listener: (state: ConnectivityState) => void): () => void {
    // NetInfo emits the current state immediately on subscribe, so callers do
    // not need a separate priming fetch.
    const unsubscribe = NetInfo.addEventListener((state) => {
      listener(toConnectivityState(state));
    });

    let released = false;
    return () => {
      if (released) return;
      released = true;
      unsubscribe();
    };
  }
}

// Singleton instance
export const mobileConnectivity = new MobileConnectivityAdapter();
