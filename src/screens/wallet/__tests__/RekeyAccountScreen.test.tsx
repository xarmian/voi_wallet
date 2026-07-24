/**
 * TASK-252 — the `isProcessing` guard on RekeyAccountScreen.
 *
 * The bug: `setIsProcessing` was never called, so `isProcessing` was frozen at
 * `false` and the two guards written against it were inert — during an in-flight
 * rekey (a change of signing authority) a user could still switch the target
 * network out from under the operation via the network selector (`disabled=
 * {isProcessing}`), and the Ledger picker never entered its busy state.
 *
 * The fix sets `isProcessing` true in `handleStartRekey` BEFORE the auth/signing
 * modal opens — the modal-open span IS the in-flight signing window — and clears
 * it on every exit: a top-level `try/finally` in `handleAuthComplete` (success,
 * every metadata-update catch, the failure Alert, or any throw) AND in
 * `handleAuthCancel`. A permanently-true flag would wedge the screen, so these
 * tests pin both directions: locked while the modal is open, released after
 * success, after error, and after cancellation.
 *
 * This is a guard-state test only — the rekey request, its submission, and
 * signing-authority resolution are exercised by the service-layer rekey suites
 * and are deliberately mocked out here.
 */

import React from 'react';
import { render, fireEvent, act, waitFor } from '@testing-library/react-native';
import { AccountType } from '@/types/wallet';

// ---------------------------------------------------------------------------
// Fixtures (mock-prefixed so jest.mock factories may close over them).
// ---------------------------------------------------------------------------
const mockSourceAccount = {
  id: 'src',
  address: 'SOURCE_ADDR',
  label: 'Source Account',
  type: AccountType.STANDARD,
};
const mockTargetAccount = {
  id: 'tgt',
  address: 'TARGET_ADDR',
  label: 'Target Account',
  type: AccountType.STANDARD,
};

const mockLoadAccountBalance = jest.fn(async () => {});
const mockWalletState = {
  wallet: { accounts: [mockSourceAccount, mockTargetAccount] },
  loadAccountBalance: mockLoadAccountBalance,
};

function mockUseWalletStore(selector: (state: unknown) => unknown) {
  return selector(mockWalletState);
}
mockUseWalletStore.getState = () => mockWalletState;
mockUseWalletStore.setState = jest.fn();

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
jest.mock('@/store/walletStore', () => ({
  useWalletStore: mockUseWalletStore,
}));

jest.mock('@/services/network', () => ({
  NetworkService: {
    getInstance: () => ({
      getAccountRekeyInfo: jest.fn(async () => ({
        isRekeyed: false,
        authAddress: undefined,
      })),
    }),
  },
}));

jest.mock('@/services/transactions', () => ({
  TransactionService: {
    // No validation errors → the proceed button is enabled and handleProceed
    // reaches its confirmation Alert.
    validateRekeyTransaction: jest.fn(async () => []),
  },
}));

jest.mock('@/services/wallet', () => ({
  MultiAccountWalletService: { updateAccountMetadata: jest.fn(async () => {}) },
}));

jest.mock('@/services/wallet/rekeyManager', () => ({
  __esModule: true,
  default: { updateAccountWithRekeyInfo: jest.fn() },
}));

jest.mock('@/services/auth/transactionAuthController', () => ({
  useTransactionAuthController: () => ({
    cleanup: jest.fn(),
    resetAfterDismiss: jest.fn(),
  }),
}));

jest.mock('@/utils/address', () => ({
  formatAddress: (address: string) => address,
}));

jest.mock('@/contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: require('@/constants/themes').lightTheme }),
}));

const mockNavigation = {
  goBack: jest.fn(),
  getParent: () => ({ navigate: jest.fn() }),
};
jest.mock('@react-navigation/native', () => ({
  useRoute: () => ({ params: { accountId: 'src' } }),
  useNavigation: () => mockNavigation,
}));

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }), {
  virtual: true,
});

jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: ({ children }: { children: React.ReactNode }) => children,
  initialWindowMetrics: null,
}));

jest.mock('@/components/common/UniversalHeader', () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock('@/components/account/AccountAvatar', () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock('@/components/ledger/RekeyToLedger', () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock('@/components/rekey/AirgapVerificationFlow', () => ({
  __esModule: true,
  default: () => null,
}));

// The real auth modal drives native signing; here it just exposes its
// visibility plus one press target per exit path so a test can complete or
// cancel exactly as the screen's callbacks expect.
jest.mock('@/components/UnifiedTransactionAuthModal', () => {
  const { View, Text, Pressable } = require('react-native');
  return {
    __esModule: true,
    default: ({
      visible,
      onComplete,
      onCancel,
    }: {
      visible: boolean;
      onComplete: (success: boolean, result?: unknown) => void;
      onCancel: () => void;
    }) =>
      visible ? (
        <View>
          <Text testID="auth-modal-open">open</Text>
          <Pressable
            testID="auth-complete-success"
            onPress={() => onComplete(true, { transactionId: 'abcdef1234' })}
          >
            <Text>ok</Text>
          </Pressable>
          <Pressable
            testID="auth-complete-error"
            onPress={() => onComplete(false, new Error('signing failed'))}
          >
            <Text>err</Text>
          </Pressable>
          <Pressable testID="auth-cancel" onPress={() => onCancel()}>
            <Text>cancel</Text>
          </Pressable>
        </View>
      ) : null,
  };
});

import { Alert } from 'react-native';
import RekeyAccountScreen from '../RekeyAccountScreen';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const VOI_NETWORK = 'Voi Network';
const ALGO_NETWORK = 'Algorand';

/** Flush pending effects (rekey-info fetch, async validation). */
const settle = () => act(async () => {});

/** Invoke a button on the most recent Alert.alert call, as the UI would. */
function pressAlertButton(label: string) {
  const spy = Alert.alert as unknown as jest.Mock;
  const calls = spy.mock.calls;
  const buttons = calls[calls.length - 1][2] as {
    text: string;
    onPress?: () => void;
  }[];
  const button = buttons.find((b) => b.text === label);
  expect(button).toBeDefined();
  act(() => {
    button!.onPress?.();
  });
}

/**
 * Select the target account and confirm through to the auth modal, leaving the
 * screen in its in-flight state (modal open, isProcessing true).
 */
async function startRekeyToInFlight(screen: ReturnType<typeof render>) {
  fireEvent.press(screen.getByText('Target Account'));
  // Async validation must resolve (to []) before the proceed button enables.
  await settle();
  await waitFor(() => expect(screen.getByText('Rekey Account')).toBeEnabled());

  fireEvent.press(screen.getByText('Rekey Account'));
  // handleProceed shows the "Confirm Rekey Operation" alert; confirming it is
  // what calls handleStartRekey → setIsProcessing(true) + opens the modal.
  pressAlertButton('Continue');
  expect(screen.getByTestId('auth-modal-open')).toBeTruthy();
}

beforeEach(() => {
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('RekeyAccountScreen — isProcessing guard (TASK-252)', () => {
  it('leaves the network selector enabled before a rekey is started', async () => {
    const screen = render(<RekeyAccountScreen />);
    await settle();

    expect(screen.getByText(VOI_NETWORK)).toBeEnabled();
    expect(screen.getByText(ALGO_NETWORK)).toBeEnabled();
  });

  it('disables the network selector while a rekey is in flight and re-enables it after completion', async () => {
    const screen = render(<RekeyAccountScreen />);
    await settle();

    await startRekeyToInFlight(screen);

    // In-flight: the user must not be able to switch the target network mid-sign.
    expect(screen.getByText(VOI_NETWORK)).toBeDisabled();
    expect(screen.getByText(ALGO_NETWORK)).toBeDisabled();

    // Signing completes (success path) — the finally releases the guard. The
    // success branch schedules a 3s balance refresh; catch it under fake timers
    // and drop it so nothing leaks past the test.
    jest.useFakeTimers();
    try {
      await act(async () => {
        fireEvent.press(screen.getByTestId('auth-complete-success'));
      });
      jest.clearAllTimers();
    } finally {
      jest.useRealTimers();
    }

    expect(screen.queryByTestId('auth-modal-open')).toBeNull();
    expect(screen.getByText(VOI_NETWORK)).toBeEnabled();
    expect(screen.getByText(ALGO_NETWORK)).toBeEnabled();
  });

  it('re-enables the network selector after a failed completion', async () => {
    const screen = render(<RekeyAccountScreen />);
    await settle();

    await startRekeyToInFlight(screen);
    expect(screen.getByText(ALGO_NETWORK)).toBeDisabled();

    // The error branch of handleAuthComplete still runs through the finally.
    await act(async () => {
      fireEvent.press(screen.getByTestId('auth-complete-error'));
    });

    expect(screen.getByText(VOI_NETWORK)).toBeEnabled();
    expect(screen.getByText(ALGO_NETWORK)).toBeEnabled();
  });

  it('re-enables the network selector after the auth modal is cancelled', async () => {
    const screen = render(<RekeyAccountScreen />);
    await settle();

    await startRekeyToInFlight(screen);
    expect(screen.getByText(ALGO_NETWORK)).toBeDisabled();

    // Dismissal is an exit too — a permanently-true flag here would wedge the
    // screen, which is strictly worse than the original inert guard.
    await act(async () => {
      fireEvent.press(screen.getByTestId('auth-cancel'));
    });

    expect(screen.queryByTestId('auth-modal-open')).toBeNull();
    expect(screen.getByText(VOI_NETWORK)).toBeEnabled();
    expect(screen.getByText(ALGO_NETWORK)).toBeEnabled();
  });
});
