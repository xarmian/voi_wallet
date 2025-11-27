import { NetworkId, NetworkConfiguration } from '@/types/network';

/**
 * Hardcoded network configurations for supported blockchain networks
 */
export const NETWORK_CONFIGURATIONS: Record<NetworkId, NetworkConfiguration> = {
  [NetworkId.VOI_MAINNET]: {
    id: NetworkId.VOI_MAINNET,
    name: 'Voi Network',
    currency: 'VOI',
    currencyName: 'Voi',
    color: '#8B5CF6',
    iconUrl: 'https://voiapp.com/voi-logo.png',
    nativeToken: 'VOI',
    nativeTokenImage: require('../../../assets/voi-token.png'),

    // Core Voi Network endpoints
    algodUrl: 'https://mainnet-api.voi.nodely.dev',
    indexerUrl: 'https://mainnet-idx.voi.nodely.dev',
    token: '',
    port: 443,

    // Voi-specific service endpoints
    mimirApiUrl: 'https://voi-mainnet-mimirapi.voirewards.com',
    envoiApiUrl: 'https://api.envoi.sh',
    priceApiUrl: 'https://voirewards.com/api',
    blockExplorerUrl: 'https://block.voi.network/explorer',
    discoverUrl: 'https://voirewards.com/discover',

    // WalletConnect configuration
    chainId: 'algorand:r20fSQI8gWe_kFZziNonSPCXLwcQmH_n',

    // Available features
    features: {
      mimir: true,
      envoi: true,
      arc200: true,
      arc72: true,
      pricing: true,
      swap: true,
    },
  },

  [NetworkId.ALGORAND_MAINNET]: {
    id: NetworkId.ALGORAND_MAINNET,
    name: 'Algorand',
    currency: 'ALGO',
    currencyName: 'ALGO',
    color: '#059669',
    iconUrl: 'https://algorand.foundation/logo.png',
    nativeToken: 'ALGO',
    nativeTokenImage: require('../../../assets/algo-token.png'),

    // Algorand Mainnet endpoints
    algodUrl: 'https://mainnet-api.4160.nodely.dev',
    indexerUrl: 'https://mainnet-idx.4160.nodely.dev',
    token: '',
    port: 443,

    // Algorand does not have these Voi-specific services
    mimirApiUrl: undefined,
    envoiApiUrl: undefined,
    priceApiUrl: 'https://api.vestigelabs.org',
    blockExplorerUrl: 'https://allo.info',
    discoverUrl: undefined,

    // WalletConnect configuration
    chainId: 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k',

    // Limited features compared to Voi
    features: {
      mimir: false,
      envoi: false,
      arc200: false,
      arc72: false,
      pricing: true, // VestigeLabs pricing API
      swap: true, // Deflex swap router
    },
  },
};

/**
 * Default network to use when no preference is set
 */
export const DEFAULT_NETWORK_ID = NetworkId.VOI_MAINNET;

/**
 * List of all available networks
 */
export const AVAILABLE_NETWORKS = Object.keys(
  NETWORK_CONFIGURATIONS
) as NetworkId[];

/**
 * Get network configuration by ID
 */
export function getNetworkConfig(networkId: NetworkId): NetworkConfiguration {
  const config = NETWORK_CONFIGURATIONS[networkId];
  if (!config) {
    throw new Error(`Network configuration not found for ${networkId}`);
  }
  return config;
}

/**
 * Check if a feature is available on a network
 */
export function isFeatureAvailable(
  networkId: NetworkId,
  feature: keyof NetworkConfiguration['features']
): boolean {
  const config = getNetworkConfig(networkId);
  return config.features[feature];
}

/**
 * Get all networks that support a specific feature
 */
export function getNetworksWithFeature(
  feature: keyof NetworkConfiguration['features']
): NetworkId[] {
  return AVAILABLE_NETWORKS.filter((networkId) =>
    isFeatureAvailable(networkId, feature)
  );
}

/**
 * Get display name for network
 */
export function getNetworkDisplayName(networkId: NetworkId): string {
  return getNetworkConfig(networkId).name;
}

/**
 * Get currency symbol for network
 */
export function getNetworkCurrency(networkId: NetworkId): string {
  return getNetworkConfig(networkId).currency;
}
