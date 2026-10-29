/**
 * TASK-246 — NFT theme picker stale-ownership bug (the picker became
 * NFTThemeSettingsScreen in TASK-435; the behaviour under test is unchanged).
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

// Active account is swapped between renders via this mutable fixture.
let mockActiveAccount: { id: string; address: string } = {
  id: 'a',
  address: 'ADDR_A',
};

jest.mock('@/store/walletStore', () => ({
  useActiveAccount: () => mockActiveAccount,
}));

jest.mock('@/contexts/ThemeContext', () => ({
  useTheme: () => ({
    theme: require('@/constants/themes').lightTheme,
    setNFTTheme: jest.fn(),
  }),
}));

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: jest.fn() }),
}));

jest.mock('react-native-safe-area-context', () => {
  const { View } = require('react-native');
  return {
    SafeAreaView: View,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});

jest.mock('@/components/common/NFTBackground', () => ({
  NFTBackground: ({ children }: { children: React.ReactNode }) => children,
}));

jest.mock('@/components/common/UniversalHeader', () => () => null);

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

import NFTThemeSettingsScreen from '../NFTThemeSettingsScreen';

describe('NFTThemeSettingsScreen ownership map (TASK-246)', () => {
  beforeEach(() => {
    mockActiveAccount = { id: 'a', address: 'ADDR_A' };
    mockFetchUserNFTs.mockClear();
  });

  it('rebuilds the ownership map when the account switches with a collection open', async () => {
    const { getByText, getByTestId, rerender } = await render(
      <NFTThemeSettingsScreen />
    );

    // Open a collection: Browse Collections tab -> pick a collection.
    await fireEvent.press(getByText('Browse Collections'));
    await fireEvent.press(getByTestId('pick-collection'));

    // Ownership reflects account A.
    await waitFor(() =>
      expect(getByTestId('ownership').props.children).toBe('ids=1:a1')
    );
    expect(mockFetchUserNFTs).toHaveBeenCalledWith('ADDR_A');

    // Switch to account B with the collection still open.
    mockActiveAccount = { id: 'b', address: 'ADDR_B' };
    await rerender(<NFTThemeSettingsScreen />);

    // Ownership must rebuild for account B (pre-fix it stayed 1:a1).
    await waitFor(() =>
      expect(getByTestId('ownership').props.children).toBe('ids=1:b1')
    );
    expect(mockFetchUserNFTs).toHaveBeenCalledWith('ADDR_B');
  });
});
