// Block-explorer URL builder tests. Assertions are SPECIFICATION-based: every
// expected URL is hand-written from each explorer's documented/verified URL
// scheme, not read back from the implementation, so a regression fails the test.
//
// Verified live URL schemes (2026-07):
//   Voi explorer (https://block.voi.network/explorer):
//     tx -> /transaction/, address -> /address/, asset -> /asset/, block -> /block/
//   allo.info (https://allo.info):
//     tx -> /tx/, address -> /account/ (/address/ 302-redirects here),
//     asset -> /asset/, block -> /block/
//
// The default (no networkId) branch uses the legacy Voi base URL, which equals
// the VOI_MAINNET blockExplorerUrl, so it shares the Voi expectations.

import { NetworkId } from '@/types/network';
import {
  getTransactionUrl,
  getAddressUrl,
  getAssetUrl,
  getBlockUrl,
  getBlockExplorerUrl,
  getBlockExplorerName,
} from '../blockExplorer';

const VOI_BASE = 'https://block.voi.network/explorer';
const ALLO_BASE = 'https://allo.info';

const TX_ID = 'ABCDEF1234567890';
const ADDRESS =
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ';
const ASSET_ID = 31566704;
const BLOCK_NUMBER = 1234567;

describe('blockExplorer URL builders', () => {
  describe('getTransactionUrl', () => {
    it('builds a Voi explorer /transaction/ URL for VOI_MAINNET', () => {
      expect(getTransactionUrl(TX_ID, NetworkId.VOI_MAINNET)).toBe(
        `${VOI_BASE}/transaction/${TX_ID}`
      );
    });

    it('builds an allo.info /tx/ URL for ALGORAND_MAINNET', () => {
      expect(getTransactionUrl(TX_ID, NetworkId.ALGORAND_MAINNET)).toBe(
        `${ALLO_BASE}/tx/${TX_ID}`
      );
    });

    it('defaults to the Voi explorer /transaction/ URL when no network is given', () => {
      expect(getTransactionUrl(TX_ID)).toBe(`${VOI_BASE}/transaction/${TX_ID}`);
    });
  });

  describe('getAddressUrl', () => {
    it('builds a Voi explorer /address/ URL for VOI_MAINNET', () => {
      expect(getAddressUrl(ADDRESS, NetworkId.VOI_MAINNET)).toBe(
        `${VOI_BASE}/address/${ADDRESS}`
      );
    });

    it('builds an allo.info /account/ URL for ALGORAND_MAINNET', () => {
      // Regression guard: allo.info addresses live under /account/, not
      // /address/ (the previous dead branch returned the fallback /address/).
      expect(getAddressUrl(ADDRESS, NetworkId.ALGORAND_MAINNET)).toBe(
        `${ALLO_BASE}/account/${ADDRESS}`
      );
    });

    it('defaults to the Voi explorer /address/ URL when no network is given', () => {
      expect(getAddressUrl(ADDRESS)).toBe(`${VOI_BASE}/address/${ADDRESS}`);
    });
  });

  describe('getAssetUrl', () => {
    it('builds a Voi explorer /asset/ URL for VOI_MAINNET', () => {
      expect(getAssetUrl(ASSET_ID, NetworkId.VOI_MAINNET)).toBe(
        `${VOI_BASE}/asset/${ASSET_ID}`
      );
    });

    it('builds an allo.info /asset/ URL for ALGORAND_MAINNET', () => {
      expect(getAssetUrl(ASSET_ID, NetworkId.ALGORAND_MAINNET)).toBe(
        `${ALLO_BASE}/asset/${ASSET_ID}`
      );
    });

    it('defaults to the Voi explorer /asset/ URL when no network is given', () => {
      expect(getAssetUrl(ASSET_ID)).toBe(`${VOI_BASE}/asset/${ASSET_ID}`);
    });
  });

  describe('getBlockUrl', () => {
    it('builds a Voi explorer /block/ URL for VOI_MAINNET', () => {
      expect(getBlockUrl(BLOCK_NUMBER, NetworkId.VOI_MAINNET)).toBe(
        `${VOI_BASE}/block/${BLOCK_NUMBER}`
      );
    });

    it('builds an allo.info /block/ URL for ALGORAND_MAINNET', () => {
      expect(getBlockUrl(BLOCK_NUMBER, NetworkId.ALGORAND_MAINNET)).toBe(
        `${ALLO_BASE}/block/${BLOCK_NUMBER}`
      );
    });

    it('defaults to the Voi explorer /block/ URL when no network is given', () => {
      expect(getBlockUrl(BLOCK_NUMBER)).toBe(
        `${VOI_BASE}/block/${BLOCK_NUMBER}`
      );
    });
  });

  describe('getBlockExplorerUrl', () => {
    it('returns the Voi explorer base URL for VOI_MAINNET', () => {
      expect(getBlockExplorerUrl(NetworkId.VOI_MAINNET)).toBe(VOI_BASE);
    });

    it('returns the allo.info base URL for ALGORAND_MAINNET', () => {
      expect(getBlockExplorerUrl(NetworkId.ALGORAND_MAINNET)).toBe(ALLO_BASE);
    });
  });

  describe('getBlockExplorerName', () => {
    it('names the Voi explorer for VOI_MAINNET', () => {
      expect(getBlockExplorerName(NetworkId.VOI_MAINNET)).toBe('Voi Explorer');
    });

    it('names the Allo explorer for ALGORAND_MAINNET', () => {
      expect(getBlockExplorerName(NetworkId.ALGORAND_MAINNET)).toBe(
        'Allo Explorer'
      );
    });
  });
});
