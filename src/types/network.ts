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
  /** Swap functionality (SnowballSwap for VOI, Deflex for Algorand) */
  swap: boolean;
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

  // Chain identity (used for airgap/offline transaction construction)
  /** Genesis ID of the network (e.g., 'voimain-v1.0') */
  genesisId: string;
  /** Base64-encoded genesis hash of the network */
  genesisHash: string;

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

/**
 * algod refused the transaction at submit (a 4xx on sendRawTransaction, other
 * than "already in the ledger/pool"): it never entered the pool, so it can't
 * land. This is the only hard rejection. A pool error read after a successful
 * submit is one node's view and is NOT one: that transaction may still commit
 * until its last valid round (TASK-440 audit #8; director 10-29).
 */
export class TransactionRejectedError extends Error {
  constructor(
    public txId: string,
    public reason: string
  ) {
    super(`Transaction rejected by the network: ${reason}`);
    this.name = 'TransactionRejectedError';
  }
}

/**
 * A submitted transaction that never confirmed and can no longer land: the
 * node's own round is past its last valid round, and the node still reads it
 * as unconfirmed. Only from here is sending it again safe.
 */
export class TransactionExpiredError extends Error {
  constructor(
    public txId: string,
    public lastValid: bigint
  ) {
    super(
      `Transaction expired without being confirmed: its last valid round (${lastValid}) has passed, so it can no longer be committed`
    );
    this.name = 'TransactionExpiredError';
  }
}

/**
 * A send that the node may have accepted (it answered "already in the
 * ledger/pool", or every attempt failed ambiguously) whose transaction id
 * can't be derived from the signed bytes, so it can't be reconciled. Not a
 * failure: sending it again is unsafe until its history is checked.
 */
export class TransactionMaybeSubmittedError extends Error {
  constructor() {
    super(
      'This transaction may already have been submitted. Check your transaction history to see whether it went through.'
    );
    this.name = 'TransactionMaybeSubmittedError';
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
