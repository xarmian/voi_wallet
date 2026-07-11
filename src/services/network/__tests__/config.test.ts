import { Buffer } from 'buffer';
import { NetworkId } from '@/types/network';
import { NETWORK_CONFIGURATIONS, getNetworkConfig } from '../config';

// Genesis identity is what the airgap signer stamps onto the payload it signs.
// A wrong/stale value = a wrong-chain signed transaction, so these constants are
// pinned here as a regression guard: they are VERIFIED-AGAINST-LIVE-NODES and
// must not drift. (See ImportFromOnlineWalletScreen, which sources genesis from
// the active network's config rather than a hardcoded literal.)
const EXPECTED = {
  [NetworkId.VOI_MAINNET]: {
    genesisId: 'voimain-v1.0',
    genesisHash: 'r20fSQI8gWe/kFZziNonSPCXLwcQmH/nxROvnnueWOk=',
  },
  [NetworkId.ALGORAND_MAINNET]: {
    genesisId: 'mainnet-v1.0',
    genesisHash: 'wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=',
  },
} as const;

describe('network config genesis identity', () => {
  for (const networkId of Object.values(NetworkId)) {
    const expected = EXPECTED[networkId];

    describe(networkId, () => {
      it('exposes the exact verified genesisId and genesisHash', () => {
        const config = getNetworkConfig(networkId);
        expect(config.genesisId).toBe(expected.genesisId);
        expect(config.genesisHash).toBe(expected.genesisHash);
      });

      it('genesisHash base64-decodes to exactly 32 bytes', () => {
        const bytes = Buffer.from(
          getNetworkConfig(networkId).genesisHash,
          'base64'
        );
        expect(bytes.length).toBe(32);
      });

      it('genesisHash is not the truncated 24-byte CAIP-2 chainId ref', () => {
        // The WalletConnect chainId carries a URL-safe, 24-byte-truncated
        // genesis ref (algorand:<ref>). It must never be used as the genesis
        // hash the raw key signs over.
        const config = getNetworkConfig(networkId);
        const chainRef = config.chainId.split(':')[1];
        const chainRefBytes = Buffer.from(
          chainRef.replace(/-/g, '+').replace(/_/g, '/'),
          'base64'
        );
        expect(chainRefBytes.length).toBeLessThan(32);
      });
    });
  }

  it('every configured network has genesis identity populated', () => {
    for (const config of Object.values(NETWORK_CONFIGURATIONS)) {
      expect(typeof config.genesisId).toBe('string');
      expect(config.genesisId.length).toBeGreaterThan(0);
      expect(typeof config.genesisHash).toBe('string');
      expect(Buffer.from(config.genesisHash, 'base64').length).toBe(32);
    }
  });
});
