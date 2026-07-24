/**
 * TASK-246 — NFTThemeSelector stale-ownership bug.
 *
 * The bug: the collection-tokens load effect keyed only on
 * [selectedCollection, viewMode]. loadCollectionTokens builds the "owned" badge
 * map from the ACTIVE account's NFTs, so switching accounts while a collection
 * was open left the previous account's ownership markers on screen — the effect
 * never re-fired because neither the collection nor the view mode changed.
 *
 * The fix keys the effect on activeAccount?.address as well (and re-checks a
 * live address ref after each await so a slow previous-account fetch can't
 * clobber the newer one). This test drives an account switch with a collection
 * open and asserts the ownership map rebuilds for the new account — it fails
 * against the pre-fix [selectedCollection, viewMode] dependency array.
 */

import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import { lightTheme } from '@/constants/themes';

// Active account is swapped between renders via this mutable fixture.
let mockActiveAccount: { id: string; address: string } = {
  id: 'a',
  address: 'ADDR_A',
};

jest.mock('@/store/walletStore', () => ({
  useActiveAccount: () => mockActiveAccount,
}));

jest.mock('@/contexts/ThemeContext', () => ({
  useTheme: () => ({ setNFTTheme: jest.fn() }),
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }), {
  virtual: true,
});

// Ownership map keyed by `${contractId}:${tokenId}` so the test can read which
// account's NFTs the map was built from.
const mockFetchUserNFTs = jest.fn(async (address: string) => ({
  tokens:
    address === 'ADDR_A'
      ? [{ contractId: 1, tokenId: 'a1' }]
      : [{ contractId: 1, tokenId: 'b1' }],
}));

jest.mock('@/services/nft', () => ({
  NFTService: {
    fetchUserNFTs: (address: string) => mockFetchUserNFTs(address),
    createOwnershipMap: (tokens: { contractId: number; tokenId: string }[]) =>
      new Set(tokens.map((t) => `${t.contractId}:${t.tokenId}`)),
    fetchTokensByCollection: jest.fn(async () => ({
      tokens: [],
      nextToken: undefined,
    })),
    hasValidImage: () => true,
    getDisplayName: () => 'name',
  },
}));

// CollectionBrowser mock: one press target that selects a fake collection.
jest.mock('@/components/nft/CollectionBrowser', () => {
  const { Pressable, Text } = require('react-native');
  return {
    __esModule: true,
    default: ({
      onCollectionPress,
    }: {
      onCollectionPress: (c: unknown) => void;
    }) => (
      <Pressable
        testID="pick-collection"
        onPress={() =>
          onCollectionPress({ contractId: 1, name: 'Coll', totalSupply: 10 })
        }
      >
        <Text>pick</Text>
      </Pressable>
    ),
  };
});

// NFTGridView mock: surfaces the ownership map so the test can inspect it.
jest.mock('@/components/nft/NFTGridView', () => {
  const { Text } = require('react-native');
  return {
    __esModule: true,
    default: ({ ownershipMap }: { ownershipMap?: Set<string> }) => (
      <Text testID="ownership">
        {'ids=' +
          Array.from(ownershipMap ?? [])
            .sort()
            .join(',')}
      </Text>
    ),
  };
});

import NFTThemeSelector from '../NFTThemeSelector';

describe('NFTThemeSelector ownership map (TASK-246)', () => {
  beforeEach(() => {
    mockActiveAccount = { id: 'a', address: 'ADDR_A' };
    mockFetchUserNFTs.mockClear();
  });

  it('rebuilds the ownership map when the account switches with a collection open', async () => {
    const { getByText, getByTestId, rerender } = render(
      <NFTThemeSelector visible onClose={jest.fn()} theme={lightTheme} />
    );

    // Open a collection: Browse Collections tab -> pick a collection.
    fireEvent.press(getByText('Browse Collections'));
    fireEvent.press(getByTestId('pick-collection'));

    // Ownership reflects account A.
    await waitFor(() =>
      expect(getByTestId('ownership').props.children).toBe('ids=1:a1')
    );
    expect(mockFetchUserNFTs).toHaveBeenCalledWith('ADDR_A');

    // Switch to account B with the collection still open.
    mockActiveAccount = { id: 'b', address: 'ADDR_B' };
    rerender(
      <NFTThemeSelector visible onClose={jest.fn()} theme={lightTheme} />
    );

    // Ownership must rebuild for account B (pre-fix it stayed 1:a1).
    await waitFor(() =>
      expect(getByTestId('ownership').props.children).toBe('ids=1:b1')
    );
    expect(mockFetchUserNFTs).toHaveBeenCalledWith('ADDR_B');
  });
});
