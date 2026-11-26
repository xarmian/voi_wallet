// GH #13 / TASK-391: a multi-network group's primary source (and so its
// native-icon network) is the group's native token, not processing order.

import { NetworkId } from '@/types/network';
import type { NetworkBalanceSource } from '@/services/token-mapping/types';
import {
  getNativeIconNetwork,
  selectPrimarySource,
} from '../mappedAssetPrimary';

const source = (
  networkId: NetworkId,
  assetId: number
): NetworkBalanceSource => ({
  networkId,
  balance: { assetId, amount: 1n, decimals: 6 },
});

const aAlgoOnVoi = source(NetworkId.VOI_MAINNET, 302189);
const algo = source(NetworkId.ALGORAND_MAINNET, 0);
const voi = source(NetworkId.VOI_MAINNET, 0);
const aVoiOnAlgorand = source(NetworkId.ALGORAND_MAINNET, 123456);

describe('selectPrimarySource', () => {
  it('picks the native ALGO source even when wrapped aAlgo was seen first', () => {
    expect(selectPrimarySource([aAlgoOnVoi, algo])).toBe(algo);
  });

  it('picks the native VOI source regardless of order', () => {
    expect(selectPrimarySource([aVoiOnAlgorand, voi])).toBe(voi);
    expect(selectPrimarySource([voi, aVoiOnAlgorand])).toBe(voi);
  });

  it('falls back to the first source when the group has no native token', () => {
    const usdcVoi = source(NetworkId.VOI_MAINNET, 302190);
    const usdcAlgo = source(NetworkId.ALGORAND_MAINNET, 31566704);
    expect(selectPrimarySource([usdcVoi, usdcAlgo])).toBe(usdcVoi);
  });

  it('returns undefined for no sources', () => {
    expect(selectPrimarySource([])).toBeUndefined();
  });
});

describe('getNativeIconNetwork', () => {
  it('uses the native source network over a stale primaryNetwork', () => {
    // Shape of a multi-network balance cached before the fix.
    expect(
      getNativeIconNetwork({
        sourceBalances: [aAlgoOnVoi, algo],
        primaryNetwork: NetworkId.VOI_MAINNET,
      })
    ).toBe(NetworkId.ALGORAND_MAINNET);
  });

  it('falls back to primaryNetwork without a native source', () => {
    expect(
      getNativeIconNetwork({
        sourceBalances: [aAlgoOnVoi],
        primaryNetwork: NetworkId.VOI_MAINNET,
      })
    ).toBe(NetworkId.VOI_MAINNET);
  });
});
