import { NetworkId } from '@/types/network';
import { AssetBalance } from '@/types/wallet';

/**
 * Reference to a specific token on a specific network
 */
export interface TokenReference {
  networkId: NetworkId;
  assetId: number;
  symbol: string;
  decimals: number;
}

/**
 * Defines a mapping between equivalent tokens across different networks
 */
export interface TokenMapping {
  /** Unique identifier for this mapping */
  mappingId: string;
  /** Human-readable name for this mapping group */
  name: string;
  /** List of equivalent tokens across networks */
  tokens: TokenReference[];
  /** Whether this mapping is verified/trusted */
  verified: boolean;
  /** Optional bridge information if these tokens are bridged */
  bridgeInfo?: {
    bridgeProvider: string;
    bridgeUrl?: string;
    contractAddresses?: Record<NetworkId, string>;
  };
  /** Optional metadata about the mapping */
  metadata?: {
    description?: string;
  };
}

/**
 * Balance information for a specific network
 */
export interface NetworkBalanceSource {
  networkId: NetworkId;
  balance: AssetBalance;
}

/**
 * An asset that may be mapped to equivalent assets on other networks
 */
export interface MappedAsset extends AssetBalance {
  /** ID of the token mapping this asset belongs to */
  mappingId?: string;
  /** Balances from all source networks */
  sourceBalances: NetworkBalanceSource[];
  /** Whether this asset is part of a multi-network mapping */
  isMapped: boolean;
  /** Whether the mapping is verified */
  verified?: boolean;
  /** Primary network for this asset (for UI display) */
  primaryNetwork: NetworkId;
}

/**
 * Account balance aggregated across multiple networks
 */
export interface MultiNetworkBalance {
  /** Account address */
  address: string;
  /** Combined native token amount across all networks */
  combinedAmount: bigint;
  /** Minimum balance requirement (sum across networks) */
  minBalance: bigint;
  /** Mapped and combined assets */
  assets: MappedAsset[];
  /** Networks included in this aggregated balance */
  sourceNetworks: NetworkId[];
  /** Per-network native token amounts */
  perNetworkAmounts: Record<NetworkId, bigint>;
  /** Per-network price data */
  perNetworkPrices: Record<NetworkId, number | undefined>;
  /** Timestamp when this balance was fetched */
  timestamp: number;
}

/**
 * Response format from the token mapping API
 */
export interface TokenMappingAPIResponse {
  /** API version for schema compatibility */
  version: string;
  /** List of token mappings */
  mappings: TokenMapping[];
  /** Timestamp when mappings were last updated */
  lastUpdated: number;
}

/**
 * Configuration for token mapping service
 */
export interface TokenMappingConfig {
  /** API endpoint URL */
  apiUrl: string;
  /** Cache duration in milliseconds */
  cacheDuration: number;
  /** Request timeout in milliseconds */
  timeout: number;
  /** Number of retry attempts */
  retryAttempts: number;
}

/**
 * Errors specific to token mapping operations
 */
export class TokenMappingError extends Error {
  constructor(
    message: string,
    public code: string,
    public details?: any
  ) {
    super(message);
    this.name = 'TokenMappingError';
  }
}

export class TokenMappingAPIError extends TokenMappingError {
  constructor(message: string, public status?: number) {
    super(message, 'API_ERROR', { status });
  }
}

export class TokenMappingCacheError extends TokenMappingError {
  constructor(message: string) {
    super(message, 'CACHE_ERROR');
  }
}

export class TokenMappingValidationError extends TokenMappingError {
  constructor(message: string, details?: any) {
    super(message, 'VALIDATION_ERROR', details);
  }
}
