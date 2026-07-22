/**
 * Regression tests for the core finding of TASK-40 / U-03.
 *
 * TransactionHistoryScreen used to catch load errors with `console.error` only
 * and then render its "No Transactions" empty state. In a wallet that is
 * actively alarming: a failed indexer fetch is indistinguishable from an
 * account whose history has vanished. A failed fetch must render as a failure,
 * with a retry, and must never render the empty state.
 */

import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';

import TransactionHistoryScreen from '../TransactionHistoryScreen';
import { lightTheme } from '@/constants/themes';

const mockLoadAllTransactions = jest.fn(async () => {});

// Mutable account UI state driven per test.
let mockAccountState: Record<string, unknown> = {};

jest.mock('@/store/walletStore', () => ({
  ALL_TRANSACTIONS_SCOPE: 'all',
  useActiveAccount: () => ({ id: 'acct-1', address: 'ADDR1' }),
  useAccountState: () => mockAccountState,
  useWalletStore: (selector: (s: any) => unknown) =>
    selector({
      loadAllTransactions: mockLoadAllTransactions,
      loadMoreTransactions: jest.fn(async () => {}),
      loadTokenMetadata: jest.fn(),
      getTokenMetadata: () => null,
      loadAssetMetadata: jest.fn(),
      getAssetMetadata: () => null,
      assetMetadataCache: {},
    }),
}));

jest.mock('@/store/networkStore', () => ({
  useCurrentNetwork: () => 'voi-mainnet',
}));

jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ updateActivity: jest.fn() }),
}));

jest.mock('@/contexts/ThemeContext', () => ({
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  useTheme: () => ({ theme: require('@/constants/themes').lightTheme }),
}));

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: jest.fn(), goBack: jest.fn() }),
}));

jest.mock(
  '@expo/vector-icons',
  () => ({
    Ionicons: () => null,
  }),
  { virtual: true }
);

jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: ({ children }: { children: React.ReactNode }) => children,
  initialWindowMetrics: null,
}));

jest.mock('@/components/common/NFTBackground', () => ({
  NFTBackground: ({ children }: { children: React.ReactNode }) => children,
}));

jest.mock('@/components/common/BlurredContainer', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { View } = require('react-native');
  return {
    BlurredContainer: ({ children }: { children: React.ReactNode }) => (
      <View>{children}</View>
    ),
  };
});

jest.mock('@/components/transaction/TransactionListItem', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Text } = require('react-native');
  return {
    __esModule: true,
    default: ({ transaction }: { transaction: { id: string } }) => (
      <Text>{`tx-${transaction.id}`}</Text>
    ),
  };
});

const baseState = {
  isLoading: false,
  lastError: null,
  balanceError: null,
  transactionsError: null,
  multiNetworkBalanceError: null,
  recentTransactions: [],
  recentTransactionsScope: 'all',
  isBalanceLoading: false,
  isBackgroundRefreshing: false,
  balanceLastUpdated: 0,
  isTransactionsLoading: false,
  isEnvoiLoading: false,
  isMultiNetworkBalanceLoading: false,
  multiNetworkBalanceLastUpdated: 0,
  transactionsPagination: { hasMore: false, isLoadingMore: false },
};

beforeEach(() => {
  mockLoadAllTransactions.mockClear();
  mockAccountState = { ...baseState };
  // Keep the theme import referenced so the mock factory's require resolves the
  // same module instance the screen renders against.
  expect(lightTheme).toBeDefined();
});

describe('TransactionHistoryScreen error surfacing', () => {
  it('shows the empty state when the account genuinely has no transactions', () => {
    const { getByText, queryByTestId } = render(<TransactionHistoryScreen />);

    expect(getByText('No Transactions')).toBeTruthy();
    expect(queryByTestId('transactions-error')).toBeNull();
  });

  it('shows an error state instead of "No Transactions" when the fetch failed', () => {
    mockAccountState = {
      ...baseState,
      transactionsError: { scope: 'all', message: 'Network request failed' },
    };

    const { queryByText, getByTestId } = render(<TransactionHistoryScreen />);

    // The whole point of the fix: a failure must not look like an empty account.
    expect(queryByText('No Transactions')).toBeNull();
    expect(getByTestId('transactions-error')).toBeTruthy();
  });

  it('offers a retry that re-runs the load', () => {
    mockAccountState = {
      ...baseState,
      transactionsError: { scope: 'all', message: 'Network request failed' },
    };

    const { getByTestId } = render(<TransactionHistoryScreen />);
    mockLoadAllTransactions.mockClear();

    fireEvent.press(getByTestId('transactions-error-retry'));

    expect(mockLoadAllTransactions).toHaveBeenCalledWith('acct-1');
  });

  it('ignores an asset-scoped error and still shows the genuine empty state', () => {
    // AssetDetailScreen writes into the same field; blaming this list for its
    // failure would be wrong, and hiding a real empty state behind it worse.
    mockAccountState = {
      ...baseState,
      transactionsError: { scope: '42_asa', message: 'asset fetch failed' },
    };

    const { getByText, queryByTestId } = render(<TransactionHistoryScreen />);

    expect(getByText('No Transactions')).toBeTruthy();
    expect(queryByTestId('transactions-error')).toBeNull();
  });

  it('ignores rows the store is currently holding for a different resource', () => {
    // AssetDetailScreen loads a single asset's history into the SAME array.
    // Rendering those rows here would present another list's transactions as
    // this account's full history.
    mockAccountState = {
      ...baseState,
      recentTransactions: [{ id: 'a' }, { id: 'b' }],
      recentTransactionsScope: '42_asa',
    };

    const { queryByText, getByText } = render(<TransactionHistoryScreen />);

    expect(queryByText('tx-a')).toBeNull();
    expect(getByText('No Transactions')).toBeTruthy();
  });

  it('keeps loaded rows and surfaces a footer error when a later page fails', () => {
    mockAccountState = {
      ...baseState,
      recentTransactions: [{ id: 'a' }, { id: 'b' }],
      transactionsError: { scope: 'all', message: 'Network request failed' },
      transactionsPagination: { hasMore: true, isLoadingMore: false },
    };

    const { getByText, getByTestId, queryByTestId } = render(
      <TransactionHistoryScreen />
    );

    // Already-loaded rows are still valid — only the next page failed.
    expect(getByText('tx-a')).toBeTruthy();
    expect(getByTestId('transactions-footer-error')).toBeTruthy();
    // ...and the whole-screen error state is NOT used for a partial failure.
    expect(queryByTestId('transactions-error')).toBeNull();
  });
});
