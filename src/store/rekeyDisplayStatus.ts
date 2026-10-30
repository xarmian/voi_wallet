import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import type { RekeyInfo } from '@/services/network';
import type { NetworkId } from '@/types/network';
import { classifyNetworkRekey } from '@/services/wallet/rekeyClassify';
import { subscribeRekeyInvalidation } from '@/services/wallet/rekeyStatusInvalidation';

/**
 * DISPLAY-ONLY per-network rekey status (TASK-458). It is fed by the balance
 * refreshes that already read authAddr, so an external rekey shows up on the
 * next refresh. It is never persisted and never written to wallet metadata.
 *
 * NO GATE MAY READ THIS. Signing, custody, eligibility and validation read
 * chain state (getSigningInfo / getRekeyStateStrict / rekeyInfo). That is why
 * there is no getter: the only read API is the hooks below, and a test keeps
 * them out of src/services.
 */
export type RekeyDisplayEntry = {
  status: 'self' | 'delegated' | 'unknown';
  authAddress?: string;
  checkedAt: number;
};

const keyFor = (address: string, network: NetworkId) => `${address}:${network}`;
const store = createStore<Record<string, RekeyDisplayEntry>>(() => ({}));

subscribeRekeyInvalidation(() => store.setState({}, true));

/** Record what a refresh observed. `null` means the lookup failed. */
export function recordRekeyObservation(
  address: string,
  network: NetworkId,
  info: RekeyInfo | null | undefined
): void {
  if (!address) return;
  const value = info
    ? classifyNetworkRekey(address, info)
    : ({ status: 'unknown' } as const);
  const key = keyFor(address, network);
  const previous = store.getState()[key];
  // A failed read keeps the last known answer: unknown never overwrites it.
  if (value.status === 'unknown' && previous && previous.status !== 'unknown')
    return;
  store.setState({
    [key]: {
      status: value.status,
      authAddress: value.status === 'delegated' ? value.authAddress : undefined,
      checkedAt: Date.now(),
    },
  });
}

export function clearRekeyDisplayStatus(): void {
  store.setState({}, true);
}

export function useRekeyDisplayStatus(
  address: string,
  network: NetworkId
): RekeyDisplayEntry | undefined {
  return useStore(store, (state) => state[keyFor(address, network)]);
}

/** True when any network's last refresh saw this address delegated. */
export function useRekeyDisplayDelegatedAnywhere(address: string): boolean {
  return useStore(store, (state) =>
    Object.entries(state).some(
      ([key, entry]) =>
        entry.status === 'delegated' && key.startsWith(`${address}:`)
    )
  );
}
