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
import { render, fireEvent, act } from '@testing-library/react-native';

import TransactionHistoryScreen from '../TransactionHistoryScreen';
import { lightTheme } from '@/constants/themes';

const mockLoadAllTransactions = jest.fn(async () => {});

// Mutable account UI state driven per test.
let mockAccountState: Record<string, unknown> = {};
let mockActiveAccountId = 'acct-1';

jest.mock('@/store/walletStore', () => ({
  ALL_TRANSACTIONS_SCOPE: 'all',
  useActiveAccount: () => ({ id: mockActiveAccountId, address: 'ADDR1' }),
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
  mockActiveAccountId = 'acct-1';
  mockAccountState = { ...baseState };
  // Keep the theme import referenced so the mock factory's require resolves the
  // same module instance the screen renders against.
  expect(lightTheme).toBeDefined();
});

// The mount effect fetches; settle it so assertions run after the first load
// attempt has registered.
const settle = () => act(async () => {});

describe('TransactionHistoryScreen error surfacing', () => {
  it('shows the empty state when the account genuinely has no transactions', async () => {
    const { getByText, queryByTestId } = render(<TransactionHistoryScreen />);
    await settle();

    expect(getByText('No Transactions')).toBeTruthy();
    expect(queryByTestId('transactions-error')).toBeNull();
  });

  it('shows a loading state, not the empty state, before the first fetch settles', async () => {
    // The store only flips `isTransactionsLoading` after an await, so the
    // definitive "No Transactions" copy must not be reachable in the meantime.
    const { queryByText, getByText } = render(<TransactionHistoryScreen />);

    expect(queryByText('No Transactions')).toBeNull();
    expect(getByText('Loading transactions...')).toBeTruthy();

    await settle();
  });

  it('goes back to loading when the active account changes', async () => {
    // The "already attempted" marker is keyed by account, so a newly selected
    // account cannot inherit the previous one's "definitely empty" verdict.
    const { getByText, rerender } = render(<TransactionHistoryScreen />);
    await settle();
    expect(getByText('No Transactions')).toBeTruthy();

    mockActiveAccountId = 'acct-2';
    rerender(<TransactionHistoryScreen />);

    expect(getByText('Loading transactions...')).toBeTruthy();
    await settle();
  });

  it('shows an error state instead of "No Transactions" when the fetch failed', async () => {
    mockAccountState = {
      ...baseState,
      transactionsError: { scope: 'all', message: 'Network request failed' },
    };

    const { queryByText, getByTestId } = render(<TransactionHistoryScreen />);
    await settle();

    // The whole point of the fix: a failure must not look like an empty account.
    expect(queryByText('No Transactions')).toBeNull();
    expect(getByTestId('transactions-error')).toBeTruthy();
  });

  it('offers a retry that re-runs the load', async () => {
    mockAccountState = {
      ...baseState,
      transactionsError: { scope: 'all', message: 'Network request failed' },
    };

    const { getByTestId } = render(<TransactionHistoryScreen />);
    await settle();
    mockLoadAllTransactions.mockClear();

    fireEvent.press(getByTestId('transactions-error-retry'));
    await settle();

    expect(mockLoadAllTransactions).toHaveBeenCalledWith('acct-1');
  });

  it('ignores an asset-scoped error and still shows the genuine empty state', async () => {
    // AssetDetailScreen writes into the same field; blaming this list for its
    // failure would be wrong, and hiding a real empty state behind it worse.
    mockAccountState = {
      ...baseState,
      transactionsError: { scope: '42_asa', message: 'asset fetch failed' },
    };

    const { getByText, queryByTestId } = render(<TransactionHistoryScreen />);
    await settle();

    expect(getByText('No Transactions')).toBeTruthy();
    expect(queryByTestId('transactions-error')).toBeNull();
  });

  it('ignores rows the store is currently holding for a different resource', async () => {
    // AssetDetailScreen loads a single asset's history into the SAME array.
    // Rendering those rows here would present another list's transactions as
    // this account's full history.
    mockAccountState = {
      ...baseState,
      recentTransactions: [{ id: 'a' }, { id: 'b' }],
      recentTransactionsScope: '42_asa',
    };

    const { queryByText, getByText } = render(<TransactionHistoryScreen />);
    await settle();

    expect(queryByText('tx-a')).toBeNull();
    expect(getByText('No Transactions')).toBeTruthy();
  });

  it('keeps loaded rows and surfaces a footer error when a later page fails', async () => {
    mockAccountState = {
      ...baseState,
      recentTransactions: [{ id: 'a' }, { id: 'b' }],
      transactionsError: { scope: 'all', message: 'Network request failed' },
      transactionsPagination: { hasMore: true, isLoadingMore: false },
    };

    const { getByText, getByTestId, queryByTestId } = render(
      <TransactionHistoryScreen />
    );
    await settle();

    // Already-loaded rows are still valid — only the next page failed.
    expect(getByText('tx-a')).toBeTruthy();
    expect(getByTestId('transactions-footer-error')).toBeTruthy();
    // ...and the whole-screen error state is NOT used for a partial failure.
    expect(queryByTestId('transactions-error')).toBeNull();
  });
});
