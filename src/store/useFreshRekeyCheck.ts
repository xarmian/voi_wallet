import { useEffect, useState } from 'react';
import { NetworkService } from '@/services/network';
import { NetworkId } from '@/types/network';
import {
  classifyNetworkRekey,
  NetworkRekeyStatus,
} from '@/services/wallet/rekeyClassify';
import { useNetworkStore } from './networkStore';
import { recordRekeyObservation } from './rekeyDisplayStatus';

/**
 * Screen-scoped, cache-bypassing rekey read on every configured network
 * (TASK-458). A cached `self` taken before a rekey landed can't vouch for the
 * present, so only reads issued after mount count. `allSelf` is true only
 * when the network list is non-empty and every network freshly read `self`.
 * Pending, failed and delegated reads all leave it false.
 */
export function useFreshRekeyCheck(address: string | undefined): {
  allSelf: boolean;
} {
  const networks = useNetworkStore((state) => state.availableNetworks);
  const [results, setResults] = useState<{
    address: string | undefined;
    networks: readonly NetworkId[];
    statuses: Partial<Record<NetworkId, NetworkRekeyStatus['status']>>;
  }>({ address: undefined, networks: [], statuses: {} });

  useEffect(() => {
    if (!address) return;
    let live = true;
    for (const network of networks) {
      void NetworkService.getInstance(network)
        .getAccountRekeyInfo(address, true, true)
        .then(
          (info) => {
            recordRekeyObservation(address, network, info);
            return classifyNetworkRekey(address, info).status;
          },
          () => 'unknown' as const
        )
        .then((status) => {
          if (!live) return;
          setResults((previous) => ({
            address,
            networks,
            statuses: {
              ...(previous.address === address && previous.networks === networks
                ? previous.statuses
                : {}),
              [network]: status,
            },
          }));
        });
    }
    return () => {
      live = false;
    };
  }, [address, networks]);

  const allSelf =
    !!address &&
    networks.length > 0 &&
    results.address === address &&
    results.networks === networks &&
    networks.every((network) => results.statuses[network] === 'self');
  return { allSelf };
}
