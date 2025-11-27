/**
 * Token Image Utilities
 * Helper functions for resolving token images from SnowballToken objects
 */

import { SnowballToken } from '@/services/snowball/types';
import { getNetworkConfig } from '@/services/network/config';
import { NetworkId } from '@/types/network';

export type TokenImageSource =
  | { type: 'uri'; uri: string }
  | { type: 'local'; source: any }
  | null;

/**
 * Get the image source for a SnowballToken with priority:
 * 1. imageUrl from API (if not null/undefined/empty)
 * 2. For VOI (id === 0): local VOI token image when imageUrl is null
 * 3. logoURI (for backward compatibility)
 * 4. null (no image available)
 */
export function getTokenImageSource(token: SnowballToken): TokenImageSource {
  const tokenId = typeof token.id === 'string' ? parseInt(token.id, 10) : token.id;

  // Priority 1: Use imageUrl if available (check for both null and undefined, and non-empty string)
  if (token.imageUrl != null && typeof token.imageUrl === 'string' && token.imageUrl.trim() !== '') {
    return { type: 'uri', uri: token.imageUrl };
  }

  // Priority 2: For VOI (id === 0), use local image when imageUrl is null
  if (tokenId === 0) {
    const voiConfig = getNetworkConfig(NetworkId.VOI_MAINNET);
    return { type: 'local', source: voiConfig.nativeTokenImage };
  }

  // Priority 3: Fallback to logoURI
  if (token.logoURI) {
    return { type: 'uri', uri: token.logoURI };
  }

  // Priority 4: No image available
  return null;
}



