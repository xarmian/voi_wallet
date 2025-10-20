/**
 * Utility functions for blockchain network block explorer integration
 */

import { NetworkId, NetworkConfiguration } from '@/types/network';
import { getNetworkConfig } from '@/services/network/config';

// Legacy constant for backwards compatibility
const VOI_BLOCK_EXPLORER_BASE_URL = 'https://block.voi.network/explorer';

/**
 * Generate a block explorer URL for a transaction
 * @param transactionId - The transaction ID to view
 * @param networkId - The network to use (defaults to current network)
 * @returns URL to view the transaction on the appropriate block explorer
 */
export const getTransactionUrl = (
  transactionId: string,
  networkId?: NetworkId
): string => {
  const baseUrl = networkId
    ? getNetworkConfig(networkId).blockExplorerUrl
    : VOI_BLOCK_EXPLORER_BASE_URL;

  if (baseUrl.includes('allo.info')) {
    return `${baseUrl}/tx/${transactionId}`;
  }

  return `${baseUrl}/transaction/${transactionId}`;
};

/**
 * Generate a block explorer URL for an address
 * @param address - The address to view
 * @param networkId - The network to use (defaults to current network)
 * @returns URL to view the address on the appropriate block explorer
 */
export const getAddressUrl = (
  address: string,
  networkId?: NetworkId
): string => {
  const baseUrl = networkId
    ? getNetworkConfig(networkId).blockExplorerUrl
    : VOI_BLOCK_EXPLORER_BASE_URL;

  if (baseUrl.includes('allo.info')) {
    return `${baseUrl}/address/${address}`;
  }

  return `${baseUrl}/address/${address}`;
};

/**
 * Generate a block explorer URL for an asset
 * @param assetId - The asset ID to view
 * @param networkId - The network to use (defaults to current network)
 * @returns URL to view the asset on the appropriate block explorer
 */
export const getAssetUrl = (assetId: number, networkId?: NetworkId): string => {
  const baseUrl = networkId
    ? getNetworkConfig(networkId).blockExplorerUrl
    : VOI_BLOCK_EXPLORER_BASE_URL;

  if (baseUrl.includes('allo.info')) {
    return `${baseUrl}/asset/${assetId}`;
  }

  return `${baseUrl}/asset/${assetId}`;
};

/**
 * Generate a block explorer URL for a block
 * @param blockNumber - The block number to view
 * @param networkId - The network to use (defaults to current network)
 * @returns URL to view the block on the appropriate block explorer
 */
export const getBlockUrl = (
  blockNumber: number,
  networkId?: NetworkId
): string => {
  const baseUrl = networkId
    ? getNetworkConfig(networkId).blockExplorerUrl
    : VOI_BLOCK_EXPLORER_BASE_URL;

  if (baseUrl.includes('allo.info')) {
    return `${baseUrl}/block/${blockNumber}`;
  }

  return `${baseUrl}/block/${blockNumber}`;
};

/**
 * Get the block explorer base URL for a network
 * @param networkId - The network ID
 * @returns The block explorer base URL
 */
export const getBlockExplorerUrl = (networkId: NetworkId): string => {
  return getNetworkConfig(networkId).blockExplorerUrl;
};

/**
 * Get the block explorer name for a network
 * @param networkId - The network ID
 * @returns Human-readable name of the block explorer
 */
export const getBlockExplorerName = (networkId: NetworkId): string => {
  const url = getNetworkConfig(networkId).blockExplorerUrl;

  if (url.includes('allo.info')) {
    return 'Allo Explorer';
  } else if (url.includes('block.voi.network/explorer')) {
    return 'Voi Explorer';
  }

  return 'Block Explorer';
};
