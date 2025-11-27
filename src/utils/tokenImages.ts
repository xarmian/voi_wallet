/**
 * Token Image Utilities
 * Helper functions for resolving token images from SwapToken objects
 */

import { SwapToken } from '@/services/swap/types';
import { getNetworkConfig } from '@/services/network/config';
import { NetworkId } from '@/types/network';

export type TokenImageSource =
  | { type: 'uri'; uri: string }
  | { type: 'local'; source: any }
  | null;

/**
 * Get the image source for a SwapToken with priority:
 * 1. logoUrl from API (if not null/undefined/empty)
 * 2. For native token (id === 0): local native token image based on network
 * 3. null (no image available)
 */
export function getTokenImageSource(
  token: SwapToken,
  networkId?: NetworkId
): TokenImageSource {
  const tokenId = token.id;

  // Priority 1: Use logoUrl if available
  if (token.logoUrl != null && typeof token.logoUrl === 'string' && token.logoUrl.trim() !== '') {
    return { type: 'uri', uri: token.logoUrl };
  }

  // Priority 2: For native token (id === 0), use local image based on network
  if (tokenId === 0) {
    const network = networkId || NetworkId.VOI_MAINNET;
    const config = getNetworkConfig(network);
    return { type: 'local', source: config.nativeTokenImage };
  }

  // Priority 3: No image available
  return null;
}
