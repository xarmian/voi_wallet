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
 * them out of everything but components/ and screens/.
 */
export type RekeyDisplayEntry = {
  status: 'self' | 'delegated' | 'unknown';
  authAddress?: string;
  checkedAt: number;
};
type StoredEntry = RekeyDisplayEntry & { seq: number };

const keyFor = (address: string, network: NetworkId) => `${address}:${network}`;
const store = createStore<Record<string, StoredEntry>>(() => ({}));
let epoch = 0;
let nextSeq = 0;

subscribeRekeyInvalidation(() => clearRekeyDisplayStatus());

/**
 * Taken when a read is ISSUED, before the network call. A result recorded
 * with it is dropped if a wipe/reset invalidated the store since, or if a
 * later-issued read already landed (Codex pass B #3).
 */
export type RekeyObservationToken = { epoch: number; seq: number };
export function beginRekeyObservation(): RekeyObservationToken {
  return { epoch, seq: ++nextSeq };
}

/** Record what a refresh observed. `null` means the lookup failed. */
export function recordRekeyObservation(
  token: RekeyObservationToken,
  address: string,
  network: NetworkId,
  info: RekeyInfo | null | undefined
): void {
  if (!address || token.epoch !== epoch) return;
  const value = info
    ? classifyNetworkRekey(address, info)
    : ({ status: 'unknown' } as const);
  const key = keyFor(address, network);
  const previous = store.getState()[key];
  if (previous && previous.seq > token.seq) return;
  // A failed read keeps the last known answer: unknown never overwrites it.
  if (value.status === 'unknown' && previous && previous.status !== 'unknown')
    return;
  store.setState({
    [key]: {
      status: value.status,
      authAddress: value.status === 'delegated' ? value.authAddress : undefined,
      checkedAt: Date.now(),
      seq: token.seq,
    },
  });
}

export function clearRekeyDisplayStatus(): void {
  epoch++;
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

/**
 * Whether the display status should override a loaded chain snapshot for a
 * BADGE (Codex pass B #1). A known display entry is the newest-issued
 * observation for its network, since the snapshot's own commit records into
 * it too. So when it disagrees, a later refresh saw something else and it
 * wins, with custody neutral until chain state reloads.
 */
export function displayOverridesLoaded(
  display: RekeyDisplayEntry | undefined,
  loaded: { isRekeyed: boolean; authAddress?: string }
): boolean {
  if (!display || display.status === 'unknown') return false;
  if ((display.status === 'delegated') !== loaded.isRekeyed) return true;
  return (
    display.status === 'delegated' && display.authAddress !== loaded.authAddress
  );
}
