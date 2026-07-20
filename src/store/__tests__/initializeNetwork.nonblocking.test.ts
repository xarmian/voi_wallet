import { NetworkId } from '@/types/network';
import {
  AVAILABLE_NETWORKS,
  DEFAULT_NETWORK_ID,
} from '@/services/network/config';

// The store's initializeNetwork must await the persisted-network selection +
// switchNetwork (client reconfiguration) but NOT the post-selection health
// refresh. Stub the dependencies so we can assert it resolves even when the
// health probe never settles (F-04, TASK-178).
jest.mock('@/utils/storage', () => ({
  AppStorage: {
    getSelectedNetwork: jest.fn(),
    saveSelectedNetwork: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('@/services/network', () => ({
  NetworkService: { getInstance: jest.fn() },
}));

jest.mock('../walletStore', () => ({
  useWalletStore: {
    getState: () => ({
      clearSingleNetworkCache: jest.fn().mockResolvedValue(undefined),
    }),
  },
}));

import { AppStorage } from '@/utils/storage';
import { NetworkService } from '@/services/network';
import { useNetworkStore } from '../networkStore';

describe('networkStore.initializeNetwork (F-04 non-blocking health, TASK-178)', () => {
  const NON_DEFAULT = AVAILABLE_NETWORKS.find(
    (n) => n !== DEFAULT_NETWORK_ID
  ) as NetworkId;

  it('resolves without awaiting the post-selection health refresh on a non-default network', async () => {
    (AppStorage.getSelectedNetwork as jest.Mock).mockResolvedValue(NON_DEFAULT);

    let healthProbeStarted = false;
    const fakeService = {
      getCurrentNetworkId: jest.fn().mockReturnValue(DEFAULT_NETWORK_ID),
      switchNetwork: jest.fn().mockResolvedValue(undefined),
      // A hung/unavailable node: the health probe never settles.
      checkNetworkHealth: jest.fn().mockImplementation(() => {
        healthProbeStarted = true;
        return new Promise<never>(() => {});
      }),
    };
    (NetworkService.getInstance as jest.Mock).mockReturnValue(fakeService);

    // If initializeNetwork awaited the health refresh, this would never resolve
    // and Jest would time out. The persisted-network switch is still awaited.
    await useNetworkStore.getState().initializeNetwork();

    expect(fakeService.switchNetwork).toHaveBeenCalledWith(NON_DEFAULT);
    expect(useNetworkStore.getState().currentNetwork).toBe(NON_DEFAULT);
    // The refresh was still kicked off — just fired, not awaited.
    expect(healthProbeStarted).toBe(true);
  });

  it('does not let a superseded (stale) refresh overwrite fresher status for the same network', async () => {
    // Each refresh gets its own deferred probe so we can control settle order.
    const resolvers: ((status: unknown) => void)[] = [];
    const fakeService = {
      getCurrentNetworkId: jest.fn().mockReturnValue(NON_DEFAULT),
      switchNetwork: jest.fn().mockResolvedValue(undefined),
      checkNetworkHealth: jest.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            resolvers.push(resolve);
          })
      ),
    };
    (NetworkService.getInstance as jest.Mock).mockReturnValue(fakeService);

    const store = useNetworkStore.getState();
    const older = store.refreshNetworkStatus(NON_DEFAULT); // earlier refresh
    const newer = store.refreshNetworkStatus(NON_DEFAULT); // later refresh
    expect(resolvers).toHaveLength(2);

    const fresh = {
      isConnected: true,
      lastSync: 2,
      algodHeight: 2,
      indexerHealth: true,
    };
    const stale = {
      isConnected: false,
      lastSync: 1,
      algodHeight: 1,
      indexerHealth: false,
    };

    // The later refresh settles first and publishes; the earlier one settles
    // afterwards and must be dropped, not overwrite the fresher status.
    resolvers[1](fresh);
    await newer;
    resolvers[0](stale);
    await older;

    expect(useNetworkStore.getState().status[NON_DEFAULT]).toEqual(fresh);
  });
});
