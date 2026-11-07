import { useEffect, useMemo } from 'react';
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { networkRekeyStatus } from '@/services/wallet/networkRekeyStatus';
import { useNetworkStore } from './networkStore';

// This watches the configured list, independent of the selected network.
networkRekeyStatus.setNetworks(useNetworkStore.getState().availableNetworks);
useNetworkStore.subscribe((state) => {
  networkRekeyStatus.setNetworks(state.availableNetworks);
});

/** Only the requested address is fetched, after its initial frame. */
export function useNetworkRekeyStatus(address: string) {
  const networks = useStore(
    networkRekeyStatus.store,
    (state) => state.networks
  );
  const entries = useStore(
    networkRekeyStatus.store,
    useShallow((state) =>
      networks.map((network) => state.entries[`${address}:${network}`])
    )
  );
  const result = useMemo(
    () => networkRekeyStatus.get(address, networks, entries),
    [address, networks, entries]
  );
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const frame = requestAnimationFrame(() => {
      timer = setTimeout(() => {
        void networkRekeyStatus.ensure(address);
      }, 0);
    });
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, [address, networks, entries]);
  return result;
}
