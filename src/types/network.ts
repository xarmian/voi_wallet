export enum NetworkId {
  VOI_MAINNET = 'voi-mainnet',
  ALGORAND_MAINNET = 'algorand-mainnet',
}

export interface NetworkFeatures {
  /** Mimir API support for ARC-200/ASA data */
  mimir: boolean;
  /** Envoi naming service support */
  envoi: boolean;
  /** ARC-200 token support */
  arc200: boolean;
  /** ARC-72 NFT support */
  arc72: boolean;
  /** Price data availability */
  pricing: boolean;
}

export interface NetworkConfiguration {
  /** Unique network identifier */
  id: NetworkId;
  /** Display name for the network */
  name: string;
  /** Native currency symbol */
  currency: string;
  /** Currency display name */
  currencyName: string;
  /** Network icon/logo URL */
  iconUrl?: string;
  /** Primary brand color */
  color: string;
  /** Native token symbol (e.g., 'VOI', 'ALGO') */
  nativeToken: string;
  /** Native token image source (local require or URI) */
  nativeTokenImage: any;

  // Core blockchain endpoints
  /** Algod API endpoint */
  algodUrl: string;
  /** Indexer API endpoint */
  indexerUrl: string;
  /** API token (empty for public endpoints) */
  token: string;
  /** API port */
  port: number;

  // Optional service endpoints
  /** Mimir API endpoint for ARC-200/ASA data */
  mimirApiUrl?: string;
  /** Envoi naming service endpoint */
  envoiApiUrl?: string;
  /** Price API endpoint */
  priceApiUrl?: string;
  /** Block explorer base URL */
  blockExplorerUrl: string;
  /** Discover/DApp directory URL */
  discoverUrl?: string;

  // WalletConnect integration
  /** WalletConnect chain identifier */
  chainId: string;

  // Feature flags
  /** Available features on this network */
  features: NetworkFeatures;
}

export interface NetworkStatus {
  /** Whether network is currently reachable */
  isConnected: boolean;
  /** Last successful sync timestamp */
  lastSync: number;
  /** Current algod block height */
  algodHeight: number;
  /** Indexer health status */
  indexerHealth: boolean;
  /** Optional service health */
  mimirHealth?: boolean;
  envoiHealth?: boolean;
}

export interface NetworkState {
  /** Currently active network */
  currentNetwork: NetworkId;
  /** Available networks */
  availableNetworks: NetworkId[];
  /** Network configurations */
  networks: Record<NetworkId, NetworkConfiguration>;
  /** Network health status */
  status: Record<NetworkId, NetworkStatus>;
  /** Whether network switching is in progress */
  isSwitching: boolean;
}

// Network-related errors
export class NetworkError extends Error {
  constructor(
    message: string,
    public networkId: NetworkId,
    public code?: string
  ) {
    super(message);
    this.name = 'NetworkError';
  }
}

export class NetworkUnavailableError extends NetworkError {
  constructor(networkId: NetworkId, service?: string) {
    const message = service
      ? `${service} service unavailable on ${networkId}`
      : `Network ${networkId} is unavailable`;
    super(message, networkId, 'NETWORK_UNAVAILABLE');
  }
}

export class NetworkSwitchError extends NetworkError {
  constructor(fromNetwork: NetworkId, toNetwork: NetworkId, reason: string) {
    super(
      `Failed to switch from ${fromNetwork} to ${toNetwork}: ${reason}`,
      toNetwork,
      'SWITCH_FAILED'
    );
  }
}
