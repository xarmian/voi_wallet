/**
 * useConnectivity — reactive connectivity state for the UI (TASK-40 / R-03).
 *
 * Reads through the platform `ConnectivityAdapter` (PLAN-12 DR-7) so the same
 * hook works on mobile (NetInfo) and on the extension/web target
 * (`navigator.onLine`) without either target importing the other's module.
 *
 * This is a passive observer only: it never gates or cancels a fetch. Gating
 * network work on offline state is TASK-191, which depends on this adapter.
 */

import { useEffect, useState } from 'react';
import { connectivity, isOffline as computeIsOffline } from '@/platform';
import type { ConnectivityState } from '@/platform';

/**
 * Optimistic default. Assuming online until the adapter reports otherwise
 * avoids flashing an offline banner during the first frames of a cold boot,
 * before NetInfo's first probe has settled.
 */
const ASSUMED_ONLINE: ConnectivityState = {
  isConnected: true,
  isInternetReachable: null,
  type: 'unknown',
};

export interface Connectivity extends ConnectivityState {
  /** True when the device cannot reach the network. */
  isOffline: boolean;
}

export function useConnectivity(): Connectivity {
  const [state, setState] = useState<ConnectivityState>(ASSUMED_ONLINE);

  useEffect(() => {
    let active = true;

    // Both adapters emit the current state on subscribe, but subscribing can
    // fail on platforms without the underlying API; the explicit fetch keeps a
    // first value flowing in that case.
    const unsubscribe = connectivity.subscribe((next) => {
      if (active) setState(next);
    });

    connectivity
      .getState()
      .then((next) => {
        if (active) setState(next);
      })
      .catch(() => {
        // Unable to determine connectivity — stay optimistic rather than
        // claiming the user is offline.
      });

    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  return { ...state, isOffline: computeIsOffline(state) };
}

export default useConnectivity;
