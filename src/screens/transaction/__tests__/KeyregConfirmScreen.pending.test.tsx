/**
 * TASK-447: a keyreg that was submitted but is not confirmed is neither a
 * success ("now registered") nor a failure ("Transaction Failed"). Both shapes
 * reach this screen: a local signer throws TransactionPendingError (it arrives
 * as result.error), and a remote-signer result says confirmed=false.
 *
 * Negative control: against the base, the pending cases render 'Transaction
 * Failed' and 'Success' respectively, so both fail. The confirmed and
 * genuine-failure cases pin the rendering that must not change.
 */

import React from 'react';
import { Alert } from 'react-native';
import { act, fireEvent, render } from '@testing-library/react-native';
import KeyregConfirmScreen from '../KeyregConfirmScreen';
import {
  TransactionMaybeSubmittedError,
  TransactionPendingError,
} from '@/types/network';

const ADDRESS = 'OFFLINEACCOUNT';
let mockParams: Record<string, unknown>;
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: jest.fn() }),
  useRoute: () => ({ params: mockParams }),
}));
jest.mock('@/store/walletStore', () => ({
  useWalletStore: () => ({
    wallet: { accounts: [{ id: 'acct', address: 'OFFLINEACCOUNT' }] },
  }),
}));
jest.mock('@/services/auth/transactionAuthController', () => ({
  useTransactionAuthController: () => ({ cleanup: jest.fn() }),
}));
// The auth modal reports the signer's outcome through onComplete; capture it
// so each test can hand the screen an outcome.
let mockOnComplete: ((success: boolean, result?: unknown) => void) | null;
jest.mock('@/components/UnifiedTransactionAuthModal', () => ({
  __esModule: true,
  default: ({
    onComplete,
  }: {
    onComplete: (success: boolean, result?: unknown) => void;
  }) => {
    mockOnComplete = onComplete;
    return null;
  },
}));
// The real module builds a network client on load.
jest.mock('@/utils/address', () => ({
  formatAddress: (address: string) => address,
}));
jest.mock('@/hooks/useThemedStyles', () => ({
  useThemedStyles: (create: (theme: unknown) => unknown) =>
    create(require('@/constants/themes').lightTheme),
  useThemeColors: () => require('@/constants/themes').lightTheme.colors,
}));
jest.mock('@/services/network/config', () => ({
  getNetworkConfig: () => ({ name: 'Voi', currency: 'VOI' }),
}));
jest.mock('@/components/common/UniversalHeader', () => () => null);
jest.mock('@/components/common/GlassCard', () => ({
  GlassCard: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('react-native-safe-area-context', () => {
  const { View } = require('react-native');
  return { SafeAreaView: View };
});

beforeEach(() => {
  mockOnComplete = null;
  mockParams = { address: ADDRESS, isOnline: false, networkId: 'voi-mainnet' };
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

const complete = async (success: boolean, result: unknown) => {
  const view = await render(<KeyregConfirmScreen />);
  await fireEvent.press(view.getAllByText('Go Offline').at(-1)!);
  await act(async () => {
    mockOnComplete!(success, result);
  });
  return view;
};

const alertTitle = () => (Alert.alert as jest.Mock).mock.calls.at(-1)?.[0];

it('renders a thrown TransactionPendingError as Not Confirmed Yet, not a failure', async () => {
  const view = await complete(false, {
    error: new TransactionPendingError('TX'),
  });

  expect(alertTitle()).toBe('Not Confirmed Yet');
  // No inline failure banner either.
  expect(view.queryByText(/couldn.t submit|not confirmed yet/i)).toBeNull();
});

it('renders a maybe-submitted error as May Have Been Sent', async () => {
  await complete(false, { error: new TransactionMaybeSubmittedError() });

  expect(alertTitle()).toBe('May Have Been Sent');
});

it('renders a confirmed=false success as Not Confirmed Yet, not Success', async () => {
  await complete(true, { transactionId: 'TX', confirmed: false });

  expect(alertTitle()).toBe('Not Confirmed Yet');
});

it('keeps Success for a confirmed keyreg', async () => {
  await complete(true, { transactionId: 'TX', confirmed: true });

  expect(alertTitle()).toBe('Success');
});

it('keeps Transaction Failed for a genuine failure', async () => {
  await complete(false, {
    error: new Error('TransactionPool.Remember: transaction X: overspend'),
  });

  expect(alertTitle()).toBe('Transaction Failed');
});
