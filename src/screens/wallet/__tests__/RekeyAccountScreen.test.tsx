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
import algosdk from 'algosdk';
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
const mockWalletState: {
  wallet: {
    accounts: {
      id: string;
      address: string;
      type: AccountType;
      originalOwner?: boolean;
    }[];
  };
  loadAccountBalance: typeof mockLoadAccountBalance;
} = {
  wallet: { accounts: [mockSourceAccount, mockTargetAccount] },
  loadAccountBalance: mockLoadAccountBalance,
};
let mockRekeyInfo: { isRekeyed: boolean; authAddress?: string } = {
  isRekeyed: false,
  authAddress: undefined,
};
// TASK-425 U3: which REKEYED records hold their own secret.
const mockProbe = jest.fn(async (_id: string) => false);
const mockGetPrivateKey = jest.fn(async (_id: string): Promise<Uint8Array> => {
  throw new Error('no key');
});
let mockFocused = true;
let mockAuthState = { isAuthenticated: true, isLocked: false };

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
      getAccountRekeyInfo: jest.fn(async () => mockRekeyInfo),
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

jest.mock('@/services/secure/AccountSecureStorage', () => ({
  AccountSecureStorage: {
    probeSecretPresenceStrict: (id: string) => mockProbe(id),
    getPrivateKey: (id: string) => mockGetPrivateKey(id),
  },
}));

const mockRekeyToAirgap = jest.fn();
const mockRekeyToLedger = jest.fn();
jest.mock('@/services/wallet/rekeyManager', () => ({
  __esModule: true,
  default: {
    rekeyToAirgap: (...args: unknown[]) => mockRekeyToAirgap(...args),
    rekeyToLedger: (...args: unknown[]) => mockRekeyToLedger(...args),
  },
}));

jest.mock('@/services/auth/transactionAuthController', () => ({
  useTransactionAuthController: () => ({
    cleanup: jest.fn(),
    resetAfterDismiss: jest.fn(),
  }),
}));

jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ authState: mockAuthState }),
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
  useIsFocused: () => mockFocused,
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
jest.mock('@/components/rekey/AirgapVerificationFlow', () => {
  const { Pressable, Text } = require('react-native');
  return {
    __esModule: true,
    default: ({
      onVerificationSuccess,
    }: {
      onVerificationSuccess: () => void;
    }) => (
      <Pressable
        testID="airgap-verify-ok"
        onPress={() => onVerificationSuccess()}
      >
        <Text>verified</Text>
      </Pressable>
    ),
  };
});

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
          <Pressable
            testID="auth-complete-confirmed"
            onPress={() =>
              onComplete(true, { transactionId: 'abcdef1234', confirmed: true })
            }
          >
            <Text>confirmed</Text>
          </Pressable>
          <Pressable
            testID="auth-complete-pending"
            onPress={() =>
              onComplete(true, {
                transactionId: 'abcdef1234',
                confirmed: false,
              })
            }
          >
            <Text>pending</Text>
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
import { PENDING_TRANSACTION_ALERT } from '@/utils/errorMapping';
import { MultiAccountWalletService } from '@/services/wallet';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const VOI_NETWORK = 'Voi Network';
const ALGO_NETWORK = 'Algorand';

/** Flush pending effects (rekey-info fetch, async validation). */
const settle = () => act(async () => {});

/** Invoke a button on the most recent Alert.alert call, as the UI would. */
async function pressAlertButton(label: string) {
  const spy = Alert.alert as unknown as jest.Mock;
  const calls = spy.mock.calls;
  const buttons = calls[calls.length - 1][2] as {
    text: string;
    onPress?: () => void;
  }[];
  const button = buttons.find((b) => b.text === label);
  expect(button).toBeDefined();
  await act(() => {
    button!.onPress?.();
  });
}

/**
 * Select the target account and confirm through to the auth modal, leaving the
 * screen in its in-flight state (modal open, isProcessing true).
 */
async function startRekeyToInFlight(
  screen: Awaited<ReturnType<typeof render>>
) {
  await fireEvent.press(screen.getByText('Target Account'));
  // Async validation must resolve (to []) before the proceed button enables.
  await settle();
  await waitFor(() => expect(screen.getByText('Rekey Account')).toBeEnabled());

  await fireEvent.press(screen.getByText('Rekey Account'));
  // handleProceed shows the "Confirm Rekey Operation" alert; confirming it is
  // what calls handleStartRekey → setIsProcessing(true) + opens the modal.
  await pressAlertButton('Continue');
  expect(screen.getByTestId('auth-modal-open')).toBeTruthy();
}

beforeEach(() => {
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  mockWalletState.wallet = { accounts: [mockSourceAccount, mockTargetAccount] };
  mockRekeyInfo = { isRekeyed: false, authAddress: undefined };
  mockProbe.mockReset();
  mockProbe.mockResolvedValue(false);
  mockGetPrivateKey.mockReset();
  mockGetPrivateKey.mockRejectedValue(new Error('no key'));
  mockFocused = true;
  mockAuthState = { isAuthenticated: true, isLocked: false };
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('RekeyAccountScreen — isProcessing guard (TASK-252)', () => {
  it('leaves the network selector enabled before a rekey is started', async () => {
    const screen = await render(<RekeyAccountScreen />);
    await settle();

    expect(screen.getByText(VOI_NETWORK)).toBeEnabled();
    expect(screen.getByText(ALGO_NETWORK)).toBeEnabled();
  });

  it('disables the network selector while a rekey is in flight and re-enables it after completion', async () => {
    const screen = await render(<RekeyAccountScreen />);
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
        await fireEvent.press(screen.getByTestId('auth-complete-success'));
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
    const screen = await render(<RekeyAccountScreen />);
    await settle();

    await startRekeyToInFlight(screen);
    expect(screen.getByText(ALGO_NETWORK)).toBeDisabled();

    // The error branch of handleAuthComplete still runs through the finally.
    await act(async () => {
      await fireEvent.press(screen.getByTestId('auth-complete-error'));
    });

    expect(screen.getByText(VOI_NETWORK)).toBeEnabled();
    expect(screen.getByText(ALGO_NETWORK)).toBeEnabled();
  });

  it('re-enables the network selector after the auth modal is cancelled', async () => {
    const screen = await render(<RekeyAccountScreen />);
    await settle();

    await startRekeyToInFlight(screen);
    expect(screen.getByText(ALGO_NETWORK)).toBeDisabled();

    // Dismissal is an exit too — a permanently-true flag here would wedge the
    // screen, which is strictly worse than the original inert guard.
    await act(async () => {
      await fireEvent.press(screen.getByTestId('auth-cancel'));
    });

    expect(screen.queryByTestId('auth-modal-open')).toBeNull();
    expect(screen.getByText(VOI_NETWORK)).toBeEnabled();
    expect(screen.getByText(ALGO_NETWORK)).toBeEnabled();
  });
});

describe('RekeyAccountScreen — own-key targets and controllers (TASK-425 U3)', () => {
  // A retained key that reads and is its own: originalOwner alone no longer
  // counts (TASK-425 U4).
  const KEPT = algosdk.generateAccount();
  const KEPT_ADDR = KEPT.addr.toString();
  beforeEach(() => {
    mockGetPrivateKey.mockImplementation(async (id: string) => {
      if (id === 'kept') return KEPT.sk.slice();
      throw new Error('no key');
    });
  });
  const retained = {
    id: 'kept',
    address: KEPT_ADDR,
    label: 'Retained Key',
    type: AccountType.REKEYED,
    originalOwner: true,
  };
  // Probes present, but its key doesn't read (a keyless legacy blob).
  const legacy = {
    id: 'legacy',
    address: 'LEGACY_ADDR',
    label: 'Legacy Blob',
    type: AccountType.REKEYED,
  };
  const keyless = {
    id: 'gone',
    address: 'GONE_ADDR',
    label: 'Keyless Rekeyed',
    type: AccountType.REKEYED,
  };
  const watch = {
    id: 'watch',
    address: 'WATCH_ADDR',
    label: 'Watch Only',
    type: AccountType.WATCH,
  };

  it('lists a REKEYED account whose own key is held as a target, and not one without', async () => {
    mockWalletState.wallet = {
      accounts: [mockSourceAccount, retained, keyless, watch],
    };
    mockProbe.mockImplementation(async (id: string) => id === 'kept');
    const screen = await render(<RekeyAccountScreen />);
    await settle();

    expect(screen.getByText('Retained Key')).toBeTruthy();
    expect(screen.queryByText('Keyless Rekeyed')).toBeNull();
    expect(screen.queryByText('Watch Only')).toBeNull();
    // The source is never its own target: its label shows once, in the header.
    expect(screen.getAllByText('Source Account')).toHaveLength(1);
  });

  it('shows the empty state once no other account holds a key', async () => {
    mockWalletState.wallet = { accounts: [mockSourceAccount, keyless] };
    const screen = await render(<RekeyAccountScreen />);
    await settle();

    expect(
      screen.getByText(
        'No other accounts with a key in this wallet are available for rekeying'
      )
    ).toBeTruthy();
  });

  it('lets a source rekeyed to a retained REKEYED key remove the rekey', async () => {
    mockWalletState.wallet = { accounts: [mockSourceAccount, retained] };
    mockRekeyInfo = { isRekeyed: true, authAddress: KEPT_ADDR };
    mockProbe.mockImplementation(async (id: string) => id === 'kept');
    const screen = await render(<RekeyAccountScreen />);
    await settle();
    expect(screen.queryAllByText('Remove Rekey')).toHaveLength(0);

    await fireEvent.press(screen.getByText('Remove Rekey (Return to Self)'));
    await settle();

    expect(Alert.alert).not.toHaveBeenCalledWith(
      'Cannot Remove Rekey',
      expect.anything()
    );
    // The reverse flow is entered: its title and proceed button render.
    expect(screen.queryAllByText('Remove Rekey').length).toBeGreaterThan(0);
  });

  it('refuses to remove the rekey when the controller is REKEYED without its key', async () => {
    mockWalletState.wallet = { accounts: [mockSourceAccount, keyless] };
    mockRekeyInfo = { isRekeyed: true, authAddress: 'GONE_ADDR' };
    const screen = await render(<RekeyAccountScreen />);
    await settle();

    await fireEvent.press(screen.getByText('Remove Rekey (Return to Self)'));

    expect(Alert.alert).toHaveBeenCalledWith(
      'Cannot Remove Rekey',
      'You do not have signing authority for this rekeyed account'
    );
  });

  it('does not offer a REKEYED record whose key does not read as a target', async () => {
    mockWalletState.wallet = { accounts: [mockSourceAccount, legacy] };
    mockProbe.mockResolvedValue(true);
    const screen = await render(<RekeyAccountScreen />);
    await settle();

    expect(screen.queryByText('Legacy Blob')).toBeNull();
  });

  it('refuses to remove a rekey that would return control to a WATCH source', async () => {
    const watchSource = { ...watch, id: 'src', label: 'Source Account' };
    mockWalletState.wallet = { accounts: [watchSource, retained] };
    mockRekeyInfo = { isRekeyed: true, authAddress: KEPT_ADDR };
    mockProbe.mockImplementation(async (id: string) => id === 'kept');
    const screen = await render(<RekeyAccountScreen />);
    await settle();

    await fireEvent.press(screen.getByText('Remove Rekey (Return to Self)'));

    expect(Alert.alert).toHaveBeenCalledWith(
      'Cannot Remove Rekey',
      "Removing the rekey returns control to this account's own key, which is not in your wallet."
    );
  });

  it('does not refuse Remove Rekey while custody is still being probed', async () => {
    mockWalletState.wallet = { accounts: [mockSourceAccount, retained] };
    mockRekeyInfo = { isRekeyed: true, authAddress: KEPT_ADDR };
    mockProbe.mockImplementation(() => new Promise(() => {}));
    const screen = await render(<RekeyAccountScreen />);
    await settle();

    await fireEvent.press(screen.getByText('Remove Rekey (Return to Self)'));

    expect(Alert.alert).not.toHaveBeenCalled();
  });

  it('drops a selected target whose key a refocus probe no longer finds', async () => {
    mockWalletState.wallet = { accounts: [mockSourceAccount, retained] };
    mockProbe.mockResolvedValue(true);
    const screen = await render(<RekeyAccountScreen />);
    await settle();
    await fireEvent.press(screen.getByText('Retained Key'));
    await settle();
    await waitFor(() =>
      expect(screen.getByText('Rekey Account')).toBeEnabled()
    );

    // Leave and return to the screen; the re-probe now finds no key.
    mockFocused = false;
    await screen.rerender(<RekeyAccountScreen />);
    mockProbe.mockResolvedValue(false);
    mockFocused = true;
    await screen.rerender(<RekeyAccountScreen />);
    await settle();

    expect(screen.queryByText('Retained Key')).toBeNull();
    expect(screen.getByText('Rekey Account')).toBeDisabled();
  });

  it('disables Remove Rekey when a refocus probe finds the source key gone', async () => {
    const SRC = algosdk.generateAccount();
    const keptSource = {
      ...retained,
      id: 'src',
      address: SRC.addr.toString(),
      label: 'Source Account',
    };
    const controller = { ...retained, id: 'ctl', label: 'Controller' };
    mockGetPrivateKey.mockImplementation(async (id: string) => {
      if (id === 'src') return SRC.sk.slice();
      if (id === 'ctl') return KEPT.sk.slice();
      throw new Error('no key');
    });
    mockWalletState.wallet = { accounts: [keptSource, controller] };
    mockRekeyInfo = { isRekeyed: true, authAddress: KEPT_ADDR };
    mockProbe.mockResolvedValue(true);
    const screen = await render(<RekeyAccountScreen />);
    await settle();
    await fireEvent.press(screen.getByText('Remove Rekey (Return to Self)'));
    await settle();
    const proceed = () => screen.getAllByText('Remove Rekey').at(-1)!;
    await waitFor(() => expect(proceed()).toBeEnabled());

    // The source's key goes; the controller's stays.
    mockFocused = false;
    await screen.rerender(<RekeyAccountScreen />);
    mockProbe.mockImplementation(async (id: string) => id === 'ctl');
    mockFocused = true;
    await screen.rerender(<RekeyAccountScreen />);
    await settle();

    expect(proceed()).toBeDisabled();
  });

  // Rekey state is per network: completing a reverse rekey on one network
  // must not persist a type conversion for all of them (TASK-425 U5).
  it('persists no metadata when a reverse rekey completes', async () => {
    const SRC = algosdk.generateAccount();
    const keptSource = {
      ...retained,
      id: 'src',
      address: SRC.addr.toString(),
      label: 'Source Account',
    };
    const controller = { ...retained, id: 'ctl', label: 'Controller' };
    mockGetPrivateKey.mockImplementation(async (id: string) => {
      if (id === 'src') return SRC.sk.slice();
      if (id === 'ctl') return KEPT.sk.slice();
      throw new Error('no key');
    });
    mockWalletState.wallet = { accounts: [keptSource, controller] };
    mockRekeyInfo = { isRekeyed: true, authAddress: KEPT_ADDR };
    mockProbe.mockResolvedValue(true);
    const screen = await render(<RekeyAccountScreen />);
    await settle();
    await fireEvent.press(screen.getByText('Remove Rekey (Return to Self)'));
    await settle();
    const proceed = () => screen.getAllByText('Remove Rekey').at(-1)!;
    await waitFor(() => expect(proceed()).toBeEnabled());
    await fireEvent.press(proceed());
    await pressAlertButton('Remove Rekey');
    expect(screen.getByTestId('auth-modal-open')).toBeTruthy();

    jest.useFakeTimers();
    try {
      await act(async () => {
        await fireEvent.press(screen.getByTestId('auth-complete-success'));
      });
      jest.clearAllTimers();
    } finally {
      jest.useRealTimers();
    }

    expect(
      jest.mocked(MultiAccountWalletService.updateAccountMetadata)
    ).not.toHaveBeenCalled();
  });

  it('re-probes custody when the app unlocks', async () => {
    mockWalletState.wallet = { accounts: [mockSourceAccount, retained] };
    mockAuthState = { isAuthenticated: true, isLocked: true };
    // Locked: the custody read fails.
    mockProbe.mockRejectedValue(new Error('vault locked'));
    const screen = await render(<RekeyAccountScreen />);
    await settle();
    expect(screen.queryByText('Retained Key')).toBeNull();

    mockProbe.mockResolvedValue(true);
    mockAuthState = { isAuthenticated: true, isLocked: false };
    await screen.rerender(<RekeyAccountScreen />);
    await settle();

    expect(screen.getByText('Retained Key')).toBeTruthy();
  });
});

// TASK-452: custody metadata follows a CONFIRMED rekey only. An unconfirmed
// one may never land; signing authority is read from chain state either way.
describe('RekeyAccountScreen — rekey metadata waits for confirmation (TASK-452)', () => {
  const signer = {
    id: 'signer',
    address: 'SIGNER_ADDR',
    label: 'Airgap Phone',
    type: AccountType.REMOTE_SIGNER,
  };

  beforeEach(() => {
    mockWalletState.wallet = { accounts: [mockSourceAccount, signer] };
    mockRekeyToAirgap.mockReset();
    mockRekeyToAirgap.mockImplementation(async (source: { id: string }) => ({
      ...source,
      type: AccountType.REKEYED,
      authAddress: signer.address,
    }));
    jest.mocked(MultiAccountWalletService.updateAccountMetadata).mockClear();
  });

  async function airgapRekeyToAuthModal(
    screen: Awaited<ReturnType<typeof render>>
  ) {
    await fireEvent.press(screen.getAllByText('Rekey to Airgap Signer')[0]);
    await settle();
    // The single signer auto-selects; proceeding first runs verification.
    await waitFor(() =>
      expect(screen.getByText('Verify Airgap Signer')).toBeEnabled()
    );
    await fireEvent.press(screen.getByText('Verify Airgap Signer'));
    await fireEvent.press(screen.getByTestId('airgap-verify-ok'));
    await settle();
    const proceed = () => screen.getAllByText('Rekey to Airgap Signer').at(-1)!;
    await waitFor(() => expect(proceed()).toBeEnabled());
    await fireEvent.press(proceed());
    await pressAlertButton('Continue');
    expect(screen.getByTestId('auth-modal-open')).toBeTruthy();
  }

  async function complete(
    screen: Awaited<ReturnType<typeof render>>,
    testID: string
  ) {
    jest.useFakeTimers();
    try {
      await act(async () => {
        await fireEvent.press(screen.getByTestId(testID));
      });
      jest.clearAllTimers();
    } finally {
      jest.useRealTimers();
    }
  }

  it('a confirmed airgap rekey writes the custody metadata', async () => {
    const screen = await render(<RekeyAccountScreen />);
    await settle();
    await airgapRekeyToAuthModal(screen);

    await complete(screen, 'auth-complete-confirmed');

    expect(mockRekeyToAirgap).toHaveBeenCalledTimes(1);
    expect(
      jest.mocked(MultiAccountWalletService.updateAccountMetadata)
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'src',
        type: AccountType.REKEYED,
        authAddress: signer.address,
      })
    );
  });

  it('a submitted but unconfirmed airgap rekey writes nothing and shows the pending alert', async () => {
    const screen = await render(<RekeyAccountScreen />);
    await settle();
    await airgapRekeyToAuthModal(screen);

    await complete(screen, 'auth-complete-pending');

    expect(mockRekeyToAirgap).not.toHaveBeenCalled();
    expect(
      jest.mocked(MultiAccountWalletService.updateAccountMetadata)
    ).not.toHaveBeenCalled();
    const titles = jest.mocked(Alert.alert).mock.calls.map((c) => c[0]);
    expect(titles).toContain(PENDING_TRANSACTION_ALERT.title);
    expect(titles).not.toContain('Airgap Rekey Successful');
  });
});

describe('RekeyAccountScreen — Ledger rekey metadata waits for confirmation (TASK-452)', () => {
  const ledger = {
    id: 'ledger',
    address: 'LEDGER_ADDR',
    label: 'Nano X',
    type: AccountType.LEDGER,
    deviceId: 'dev-1',
  };

  beforeEach(() => {
    mockWalletState.wallet = { accounts: [mockSourceAccount, ledger] };
    mockRekeyToLedger.mockReset();
    mockRekeyToLedger.mockImplementation(async (source: { id: string }) => ({
      ...source,
      type: AccountType.REKEYED,
      authAddress: ledger.address,
    }));
    jest.mocked(MultiAccountWalletService.updateAccountMetadata).mockClear();
  });

  async function ledgerRekeyThrough(
    screen: Awaited<ReturnType<typeof render>>,
    testID: string
  ) {
    await fireEvent.press(screen.getByText('Rekey to Ledger Device'));
    await settle();
    const proceed = () => screen.getAllByText('Rekey to Ledger').at(-1)!;
    await waitFor(() => expect(proceed()).toBeEnabled());
    await fireEvent.press(proceed());
    await pressAlertButton('Continue');
    expect(screen.getByTestId('auth-modal-open')).toBeTruthy();
    jest.useFakeTimers();
    try {
      await act(async () => {
        await fireEvent.press(screen.getByTestId(testID));
      });
      jest.clearAllTimers();
    } finally {
      jest.useRealTimers();
    }
  }

  it('a confirmed Ledger rekey writes the custody metadata', async () => {
    const screen = await render(<RekeyAccountScreen />);
    await settle();
    await ledgerRekeyThrough(screen, 'auth-complete-confirmed');

    expect(mockRekeyToLedger).toHaveBeenCalledTimes(1);
    expect(
      jest.mocked(MultiAccountWalletService.updateAccountMetadata)
    ).toHaveBeenCalledWith(expect.objectContaining({ id: 'src' }));
  });

  it('a submitted but unconfirmed Ledger rekey writes nothing', async () => {
    const screen = await render(<RekeyAccountScreen />);
    await settle();
    await ledgerRekeyThrough(screen, 'auth-complete-pending');

    expect(mockRekeyToLedger).not.toHaveBeenCalled();
    expect(
      jest.mocked(MultiAccountWalletService.updateAccountMetadata)
    ).not.toHaveBeenCalled();
  });
});
