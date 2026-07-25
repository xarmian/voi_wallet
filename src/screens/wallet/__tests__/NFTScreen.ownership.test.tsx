/**
 * TASK-246 — NFTScreen stale-ownership bug (sibling of the NFTThemeSelector one).
 *
 * NFTScreen's collection-tokens load effect had the same defect: keyed only on
 * [selectedCollection, viewMode] while loadCollectionTokens builds the owned-
 * badge map from the active account's NFTs. Switching accounts with a collection
 * open kept the previous account's ownership markers.
 *
 * The fix keys the effect on activeAccount?.address (plus a live-address ref
 * re-check after each await). This test drives an account switch with a
 * collection open and asserts the ownership map rebuilds for the new account.
 */

import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';

let mockActiveAccount: { id: string; address: string } = {
  id: 'a',
  address: 'ADDR_A',
};

jest.mock('@/store/walletStore', () => ({
  useActiveAccount: () => mockActiveAccount,
}));

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ dispatch: jest.fn(), navigate: jest.fn() }),
  CommonActions: { navigate: jest.fn() },
}));

jest.mock('@/contexts/ThemeContext', () => ({
  useTheme: () => ({
    theme: require('@/constants/themes').lightTheme,
    setNFTTheme: jest.fn(),
  }),
}));

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }), {
  virtual: true,
});

jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: ({ children }: { children: React.ReactNode }) => children,
}));

jest.mock('@/components/common/UniversalHeader', () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock('@/components/account/AccountListModal', () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock('@/components/account/AddAccountModal', () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock('@/components/common/NFTBackground', () => ({
  NFTBackground: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('@/components/common/GlassCard', () => ({
  GlassCard: ({ children }: { children: React.ReactNode }) => children,
}));

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

import NFTScreen from '../NFTScreen';

describe('NFTScreen ownership map (TASK-246)', () => {
  beforeEach(() => {
    mockActiveAccount = { id: 'a', address: 'ADDR_A' };
    mockFetchUserNFTs.mockClear();
  });

  it('rebuilds the ownership map when the account switches with a collection open', async () => {
    const { getByText, getByTestId, rerender } = render(<NFTScreen />);

    // Open a collection: Collections tab -> pick a collection.
    fireEvent.press(getByText('Collections'));
    fireEvent.press(getByTestId('pick-collection'));

    await waitFor(() =>
      expect(getByTestId('ownership').props.children).toBe('ids=1:a1')
    );
    expect(mockFetchUserNFTs).toHaveBeenCalledWith('ADDR_A');

    // Switch to account B with the collection still open.
    mockActiveAccount = { id: 'b', address: 'ADDR_B' };
    rerender(<NFTScreen />);

    await waitFor(() =>
      expect(getByTestId('ownership').props.children).toBe('ids=1:b1')
    );
    expect(mockFetchUserNFTs).toHaveBeenCalledWith('ADDR_B');
  });
});
