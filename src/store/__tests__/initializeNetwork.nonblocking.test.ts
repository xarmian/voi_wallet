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
});
