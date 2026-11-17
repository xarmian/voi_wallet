import type { NetworkId } from '@/types/network';
import type { NetworkBalanceSource } from '@/services/token-mapping/types';

/**
 * Pick the source that represents a multi-network group (GH #13 / TASK-391).
 *
 * A group that contains a chain's native token (assetId 0) is THAT chain's
 * token: the ALGO group is ALGO even when wrapped aAlgo on Voi is seen first,
 * because networks are walked Voi-first. Choosing by processing order made the
 * group's `primaryNetwork` (and so its native icon fallback) depend on whether
 * the user had opted into the wrapped asset. Without a native source the first
 * source seen stays primary, as before.
 */
export const selectPrimarySource = <T extends NetworkBalanceSource>(
  sources: readonly T[]
): T | undefined =>
  sources.find((source) => source.balance.assetId === 0) ?? sources[0];

/**
 * Network whose native-token image a mapped/native asset should fall back to.
 * Reads the sources directly rather than trusting `primaryNetwork`, so a
 * multi-network balance cached before the TASK-391 fix renders correctly too.
 */
export const getNativeIconNetwork = (asset: {
  sourceBalances: readonly NetworkBalanceSource[];
  primaryNetwork: NetworkId;
}): NetworkId =>
  asset.sourceBalances.find((source) => source.balance.assetId === 0)
    ?.networkId ?? asset.primaryNetwork;
