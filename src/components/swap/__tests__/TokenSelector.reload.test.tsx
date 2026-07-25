/**
 * TASK-246 — TokenSelector stale token-list bug.
 *
 * The bug: the token-load effect keyed only on [visible, accountBalance], while
 * loadTokens also reads networkId, excludeTokenId and ownedOnly. Changing any of
 * those config props while the modal stayed open left the previously-built list
 * on screen — the effect never re-fired.
 *
 * The fix adds networkId, excludeTokenId and ownedOnly to the effect deps. This
 * test opens the selector, then changes excludeTokenId while it stays visible and
 * asserts the list rebuilds (the newly-excluded token disappears and the
 * previously-excluded one returns). It fails against the pre-fix dependency array.
 */

import React from 'react';
import { render, waitFor } from '@testing-library/react-native';
import { NetworkId } from '@/types/network';

jest.mock('@/contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: require('@/constants/themes').lightTheme }),
}));

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }), {
  virtual: true,
});

jest.mock('expo-image', () => ({ Image: () => null }));

jest.mock('@/utils/tokenImages', () => ({ getTokenImageSource: () => null }));

// Store: one account with a VOI balance so accountBalance is truthy and the
// load path uses the store balance (no NetworkService round-trip).
const mockState = {
  wallet: { accounts: [{ id: 'acc1', address: 'ADDR1' }] },
  accountStates: { acc1: { balance: { amount: 1000000, assets: [] } } },
};
jest.mock('@/store/walletStore', () => ({
  useWalletStore: (selector: (s: unknown) => unknown) => selector(mockState),
}));

jest.mock('@/services/network', () => ({
  NetworkService: { getInstance: () => ({ getAccountBalance: jest.fn() }) },
}));

const TOKENS = [
  { id: 1, symbol: 'AAA', name: 'Token A', decimals: 6 },
  { id: 2, symbol: 'BBB', name: 'Token B', decimals: 6 },
  { id: 3, symbol: 'CCC', name: 'Token C', decimals: 6 },
];
jest.mock('@/services/swap', () => ({
  SwapService: {
    getProvider: () => ({ getTokens: async () => TOKENS }),
  },
}));

import { TokenSelector } from '../TokenSelector';

describe('TokenSelector token list (TASK-246)', () => {
  it('rebuilds the list when excludeTokenId changes while the modal stays open', async () => {
    const props = {
      visible: true,
      accountId: 'acc1',
      networkId: NetworkId.VOI_MAINNET,
      onClose: jest.fn(),
      onSelect: jest.fn(),
    };

    const { getByText, queryByText, rerender } = render(
      <TokenSelector {...props} excludeTokenId={2} />
    );

    // Initially token 2 (BBB) is excluded.
    await waitFor(() => expect(getByText('AAA')).toBeTruthy());
    expect(getByText('CCC')).toBeTruthy();
    expect(queryByText('BBB')).toBeNull();

    // Change the excluded token while the modal stays open.
    rerender(<TokenSelector {...props} excludeTokenId={1} />);

    // List must rebuild: BBB returns, AAA (now excluded) disappears.
    await waitFor(() => expect(getByText('BBB')).toBeTruthy());
    expect(getByText('CCC')).toBeTruthy();
    expect(queryByText('AAA')).toBeNull();
  });
});
