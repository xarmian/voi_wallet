import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import {
  NetworkId,
  NetworkConfiguration,
  NetworkStatus,
  NetworkState,
  NetworkError,
} from '@/types/network';
import {
  getNetworkConfig,
  DEFAULT_NETWORK_ID,
  AVAILABLE_NETWORKS,
} from '@/services/network/config';
import { NetworkService } from '@/services/network';
import { AppStorage } from '@/utils/storage';
import { useWalletStore } from './walletStore';

interface NetworkStoreState extends NetworkState {
  // Actions
  switchNetwork: (networkId: NetworkId) => Promise<void>;
  refreshNetworkStatus: (networkId?: NetworkId) => Promise<void>;
  initializeNetwork: () => Promise<void>;

  // Computed properties
  currentNetworkConfig: NetworkConfiguration;
  isCurrentNetworkHealthy: boolean;
}

export const useNetworkStore = create<NetworkStoreState>()(
  subscribeWithSelector((set, get) => ({
    // Initial state
    currentNetwork: DEFAULT_NETWORK_ID,
    availableNetworks: AVAILABLE_NETWORKS,
    networks: Object.fromEntries(
      AVAILABLE_NETWORKS.map((networkId) => [
        networkId,
        getNetworkConfig(networkId),
      ])
    ) as Record<NetworkId, NetworkConfiguration>,
    status: Object.fromEntries(
      AVAILABLE_NETWORKS.map((networkId) => [
        networkId,
        {
          isConnected: false,
          lastSync: 0,
          algodHeight: 0,
          indexerHealth: false,
          mimirHealth: undefined,
          envoiHealth: undefined,
        } as NetworkStatus,
      ])
    ) as Record<NetworkId, NetworkStatus>,
    isSwitching: false,

    // Computed properties
    get currentNetworkConfig() {
      return get().networks[get().currentNetwork];
    },

    get isCurrentNetworkHealthy() {
      const status = get().status[get().currentNetwork];
      return status.isConnected && status.indexerHealth;
    },

    // Actions
    async initializeNetwork() {
      try {
        // Try to load saved network preference first
        const savedNetworkId = await AppStorage.getSelectedNetwork();

        let networkToUse = DEFAULT_NETWORK_ID;

        // Use saved network if it exists and is valid
        if (savedNetworkId && AVAILABLE_NETWORKS.includes(savedNetworkId)) {
          networkToUse = savedNetworkId;
        }

        const networkService = NetworkService.getInstance();

        // If we're using a different network than the current one, switch to it
        if (networkService.getCurrentNetworkId() !== networkToUse) {
          await networkService.switchNetwork(networkToUse);
        }

        set({ currentNetwork: networkToUse });

        // Perform initial health check
        await get().refreshNetworkStatus(networkToUse);

        console.log(`Network store initialized with: ${networkToUse}`);
      } catch (error) {
        console.error('Failed to initialize network store:', error);
        // Fallback to default network on error
        set({ currentNetwork: DEFAULT_NETWORK_ID });
      }
    },

    async switchNetwork(networkId: NetworkId) {
      const state = get();

      if (state.currentNetwork === networkId) {
        return; // Already on this network
      }

      if (!AVAILABLE_NETWORKS.includes(networkId)) {
        throw new Error(`Network ${networkId} is not available`);
      }

      set({ isSwitching: true });

      try {
        // Switch the network service
        const networkService = NetworkService.getInstance();
        await networkService.switchNetwork(networkId);

        // Save the network preference to persistent storage
        await AppStorage.saveSelectedNetwork(networkId);

        // Clear single-network cache when switching networks
        // This prevents wrong network data from being displayed
        try {
          const clearSingleNetworkCache =
            useWalletStore.getState().clearSingleNetworkCache;
          await clearSingleNetworkCache(); // Clear all single-network caches
          console.log('[NetworkStore] Cleared single-network cache after network switch');
        } catch (cacheError) {
          console.warn('[NetworkStore] Failed to clear single-network cache:', cacheError);
        }

        // Update store state
        set({
          currentNetwork: networkId,
          isSwitching: false,
        });

        // Refresh network status
        await get().refreshNetworkStatus(networkId);

        console.log(`Successfully switched to network: ${networkId}`);
      } catch (error) {
        set({ isSwitching: false });
        const networkError =
          error instanceof NetworkError
            ? error
            : new NetworkError(`Failed to switch to ${networkId}`, networkId);
        throw networkError;
      }
    },

    async refreshNetworkStatus(networkId?: NetworkId) {
      const targetNetworkId = networkId || get().currentNetwork;

      try {
        const networkService = NetworkService.getInstance(targetNetworkId);
        const networkStatus = await networkService.checkNetworkHealth();

        set((state) => ({
          status: {
            ...state.status,
            [targetNetworkId]: networkStatus,
          },
        }));
      } catch (error) {
        console.error(
          `Failed to refresh network status for ${targetNetworkId}:`,
          error
        );

        // Set unhealthy status on error
        set((state) => ({
          status: {
            ...state.status,
            [targetNetworkId]: {
              isConnected: false,
              lastSync: Date.now(),
              algodHeight: 0,
              indexerHealth: false,
              mimirHealth: false,
              envoiHealth: false,
            },
          },
        }));
      }
    },
  }))
);

// Computed selectors for better performance
export const useCurrentNetwork = () =>
  useNetworkStore((state) => state.currentNetwork);
export const useCurrentNetworkConfig = () =>
  useNetworkStore((state) => state.networks[state.currentNetwork]);
export const useNetworkStatus = (networkId?: NetworkId) =>
  useNetworkStore((state) => state.status[networkId || state.currentNetwork]);
export const useIsNetworkSwitching = () =>
  useNetworkStore((state) => state.isSwitching);
export const useAvailableNetworks = () =>
  useNetworkStore((state) => state.availableNetworks);
export const useIsCurrentNetworkHealthy = () =>
  useNetworkStore((state) => state.isCurrentNetworkHealthy);

// Network feature helpers
export const useNetworkFeature = (
  feature: keyof NetworkConfiguration['features']
) => useNetworkStore((state) => state.currentNetworkConfig.features[feature]);

export const useIsMimirAvailable = () => useNetworkFeature('mimir');
export const useIsEnvoiAvailable = () => useNetworkFeature('envoi');
export const useIsArc200Available = () => useNetworkFeature('arc200');
export const useIsArc72Available = () => useNetworkFeature('arc72');
export const useIsPricingAvailable = () => useNetworkFeature('pricing');
