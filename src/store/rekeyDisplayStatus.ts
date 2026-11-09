import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import type { RekeyInfo } from '@/services/network';
import type { NetworkId } from '@/types/network';
import { classifyNetworkRekey } from '@/services/wallet/rekeyClassify';
import {
  getRekeyStatusEpoch,
  subscribeRekeyInvalidation,
} from '@/services/wallet/rekeyStatusInvalidation';
import { getRekeyObservation } from '@/services/network/rekeyObservation';

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

subscribeRekeyInvalidation(() => clearRekeyDisplayStatus());

/**
 * Record what a refresh observed. Ordering and fencing use the read's own
 * provenance (getRekeyObservation), stamped when the algod request was
 * issued (Codex pass C #3/#4): a cached replay keeps its old stamp and can't
 * overwrite a newer answer, and a read issued before a wipe/reset is dropped.
 * `null`, or a result with no stamp (the lookup failed), records unknown only
 * where nothing is known: unknown never overwrites a known status.
 */
export function recordRekeyObservation(
  address: string,
  network: NetworkId,
  info: RekeyInfo | null | undefined
): void {
  if (!address) return;
  const key = keyFor(address, network);
  const previous = store.getState()[key];
  const observation = getRekeyObservation(info);
  if (!info || !observation) {
    if (!previous)
      store.setState({
        [key]: { status: 'unknown', checkedAt: Date.now(), seq: -1 },
      });
    return;
  }
  if (observation.epoch !== getRekeyStatusEpoch()) return;
  if (previous && previous.seq >= observation.seq) return;
  const value = classifyNetworkRekey(address, info);
  if (value.status === 'unknown' && previous && previous.status !== 'unknown')
    return;
  store.setState({
    [key]: {
      status: value.status,
      authAddress: value.status === 'delegated' ? value.authAddress : undefined,
      checkedAt: Date.now(),
      seq: observation.seq,
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
