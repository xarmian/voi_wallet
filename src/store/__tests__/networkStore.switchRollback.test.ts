/**
 * A network switch that fails after the service has already moved leaves the
 * service and the store on the same network (TASK-486).
 *
 * networkStore.switchNetwork switches the service first and only then persists
 * the preference. A rejected save used to leave the service on the NEW network
 * while the store (and so the UI) stayed on the old one.
 */

import { NetworkId } from '@/types/network';
import {
  AVAILABLE_NETWORKS,
  DEFAULT_NETWORK_ID,
} from '@/services/network/config';

jest.mock('@/utils/storage', () => ({
  AppStorage: {
    getSelectedNetwork: jest.fn(),
    saveSelectedNetwork: jest.fn(),
  },
}));

jest.mock('@/services/network', () => {
  class NetworkError extends Error {
    networkId?: string;
    constructor(message: string, networkId?: string) {
      super(message);
      this.networkId = networkId;
    }
  }
  return { NetworkService: { getInstance: jest.fn() }, NetworkError };
});

const mockInvalidateBalanceRequests = jest.fn();
jest.mock('../walletStore', () => ({
  invalidateBalanceRequests: () => mockInvalidateBalanceRequests(),
  useWalletStore: {
    getState: () => ({
      clearSingleNetworkCache: jest.fn().mockResolvedValue(undefined),
    }),
  },
}));

import { AppStorage } from '@/utils/storage';
import { NetworkService } from '@/services/network';
import { useNetworkStore } from '../networkStore';

const TARGET = AVAILABLE_NETWORKS.find(
  (n) => n !== DEFAULT_NETWORK_ID
) as NetworkId;

describe('networkStore.switchNetwork rollback (TASK-486)', () => {
  let serviceNetwork: NetworkId;
  let fakeService: {
    switchNetwork: jest.Mock;
    checkNetworkHealth: jest.Mock;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    useNetworkStore.setState({
      currentNetwork: DEFAULT_NETWORK_ID,
      isSwitching: false,
    });
    serviceNetwork = DEFAULT_NETWORK_ID;
    fakeService = {
      switchNetwork: jest.fn(async (id: NetworkId) => {
        serviceNetwork = id;
      }),
      checkNetworkHealth: jest.fn().mockResolvedValue({ isConnected: true }),
    };
    (NetworkService.getInstance as jest.Mock).mockReturnValue(fakeService);
    (AppStorage.saveSelectedNetwork as jest.Mock).mockResolvedValue(undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('a rejected preference save puts the service back on the old network', async () => {
    (AppStorage.saveSelectedNetwork as jest.Mock).mockRejectedValue(
      new Error('disk full')
    );

    await expect(
      useNetworkStore.getState().switchNetwork(TARGET)
    ).rejects.toThrow();

    expect(useNetworkStore.getState().currentNetwork).toBe(DEFAULT_NETWORK_ID);
    expect(useNetworkStore.getState().isSwitching).toBe(false);
    expect(serviceNetwork).toBe(DEFAULT_NETWORK_ID);
    expect(fakeService.switchNetwork).toHaveBeenLastCalledWith(
      DEFAULT_NETWORK_ID
    );
  });

  it('balance fetches that started on the new network are invalidated again after the rollback', async () => {
    (AppStorage.saveSelectedNetwork as jest.Mock).mockRejectedValue(
      new Error('disk full')
    );

    await expect(
      useNetworkStore.getState().switchNetwork(TARGET)
    ).rejects.toThrow();

    expect(mockInvalidateBalanceRequests).toHaveBeenCalledTimes(2);
    const rollbackCall = fakeService.switchNetwork.mock.invocationCallOrder[1];
    expect(
      mockInvalidateBalanceRequests.mock.invocationCallOrder[1]
    ).toBeGreaterThan(rollbackCall);
  });

  it('a failed rollback does not mask the original error and still resets isSwitching', async () => {
    (AppStorage.saveSelectedNetwork as jest.Mock).mockRejectedValue(
      new Error('disk full')
    );
    fakeService.switchNetwork
      .mockImplementationOnce(async (id: NetworkId) => {
        serviceNetwork = id;
      })
      .mockRejectedValueOnce(new Error('rollback failed'));

    await expect(
      useNetworkStore.getState().switchNetwork(TARGET)
    ).rejects.toThrow(/Failed to switch/);

    expect(useNetworkStore.getState().isSwitching).toBe(false);
    expect(useNetworkStore.getState().currentNetwork).toBe(DEFAULT_NETWORK_ID);
  });

  it('a service switch that fails by itself is not "rolled back" (the service restores itself)', async () => {
    fakeService.switchNetwork.mockRejectedValue(new Error('bad config'));

    await expect(
      useNetworkStore.getState().switchNetwork(TARGET)
    ).rejects.toThrow();

    expect(fakeService.switchNetwork).toHaveBeenCalledTimes(1);
    expect(AppStorage.saveSelectedNetwork).not.toHaveBeenCalled();
    expect(useNetworkStore.getState().currentNetwork).toBe(DEFAULT_NETWORK_ID);
  });
});
