/**
 * TASK-45 — VerifyBackupScreen target pinning and key handling.
 *
 * The screen loads the phrase itself from the PIN/biometric-gated key store
 * (the route carries only an address — DR-9), so the target it eventually marks
 * as verified MUST be the same account whose phrase was rendered. The store is
 * live: if the target were re-resolved on every render, an active-account change
 * while the quiz was open would let account B be marked verified using account
 * A's phrase.
 *
 * SECURITY NOTE: the phrase here is a made-up fixture from a mocked key store.
 */

import React from 'react';
import { render, waitFor, act } from '@testing-library/react-native';

const MOCK_MNEMONIC =
  'abandon ability able abandon absent absorb abandon abstract';

const mockGetMnemonic = jest.fn(async () => MOCK_MNEMONIC);
jest.mock('@/services/secure/keyManager', () => ({
  SecureKeyManager: {
    getMnemonic: (...args: unknown[]) => mockGetMnemonic(...(args as [])),
  },
}));

const mockMarkBackupVerified = jest.fn(async () => {});

let mockAccounts: { id: string; address: string; type: string }[] | undefined =
  [];
let mockActiveAccountId = 'acc-a';

jest.mock('@/store/walletStore', () => ({
  useActiveAccount: () =>
    mockAccounts?.find((a) => a.id === mockActiveAccountId) ?? null,
  useWalletStore: (selector: (state: unknown) => unknown) =>
    selector({
      markBackupVerified: mockMarkBackupVerified,
      // `undefined` accounts models the pre-hydration store.
      wallet:
        mockAccounts === undefined ? undefined : { accounts: mockAccounts },
    }),
}));

const mockNavigation = { goBack: jest.fn() };
let mockRouteParams: Record<string, unknown> | undefined;

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => mockNavigation,
  useRoute: () => ({ params: mockRouteParams }),
}));

jest.mock('@/hooks/useSecureScreen', () => ({ useSecureScreen: () => {} }));

jest.mock('@/contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: require('@/constants/themes').lightTheme }),
}));

jest.mock(
  '@expo/vector-icons',
  () => ({
    Ionicons: () => null,
  }),
  { virtual: true }
);

jest.mock('@/components/common/NFTBackground', () => {
  const { View } = require('react-native');
  return { NFTBackground: ({ children }: never) => <View>{children}</View> };
});

jest.mock('@/components/common/UniversalHeader', () => {
  const { View } = require('react-native');
  return { __esModule: true, default: () => <View /> };
});

import { Alert } from 'react-native';
import VerifyBackupScreen from '../VerifyBackupScreen';
import {
  completeQuiz,
  pressWrongQuizOption,
} from '@/__tests__/fixtures/mnemonicQuiz';
import { MAX_MISTAKES } from '@/components/wallet/mnemonicQuiz';

const MOCK_WORDS = MOCK_MNEMONIC.split(' ');

beforeEach(() => {
  mockAccounts = [
    { id: 'acc-a', address: 'ADDRESS_A', type: 'standard' },
    { id: 'acc-b', address: 'ADDRESS_B', type: 'standard' },
  ];
  mockActiveAccountId = 'acc-a';
  mockRouteParams = { accountAddress: 'ADDRESS_A' };
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

async function renderLoaded() {
  const screen = render(<VerifyBackupScreen />);
  await waitFor(() => screen.getByTestId('verify-backup-root'));
  return screen;
}

describe('VerifyBackupScreen', () => {
  it('loads the phrase for the routed address, not from a nav param', async () => {
    await renderLoaded();
    expect(mockGetMnemonic).toHaveBeenCalledWith('ADDRESS_A');
    // The route never carries key material.
    expect(JSON.stringify(mockRouteParams)).not.toContain('abandon');
  });

  it('marks the account whose phrase was actually shown', async () => {
    const screen = await renderLoaded();

    completeQuiz(screen, 'verify-backup', MOCK_WORDS);
    // Success kicks off an async store write which then clears the phrase from
    // screen state, and the challenge rebuilds itself in response. Flush that
    // continuation inside act() so the rebuild is not an unwrapped update.
    await act(async () => {});

    await waitFor(() => expect(mockMarkBackupVerified).toHaveBeenCalled());
    expect(mockMarkBackupVerified).toHaveBeenCalledWith('acc-a');
  });

  it('does not follow an active-account change made while the quiz is open', async () => {
    // Entered with no address param, so the active account is the entry default.
    mockRouteParams = undefined;
    const screen = await renderLoaded();
    expect(mockGetMnemonic).toHaveBeenCalledWith('ADDRESS_A');

    // The user switches accounts elsewhere. The store hooks are mocked, so the
    // re-render has to be forced explicitly — otherwise this test would pass
    // even if the screen re-resolved its target on every store update.
    mockActiveAccountId = 'acc-b';
    await act(async () => {
      screen.rerender(<VerifyBackupScreen />);
    });

    // The phrase on screen is still account A's — no reload was triggered.
    expect(mockGetMnemonic).toHaveBeenCalledTimes(1);
    expect(mockGetMnemonic).not.toHaveBeenCalledWith('ADDRESS_B');

    completeQuiz(screen, 'verify-backup', MOCK_WORDS);
    // Success kicks off an async store write which then clears the phrase from
    // screen state, and the challenge rebuilds itself in response. Flush that
    // continuation inside act() so the rebuild is not an unwrapped update.
    await act(async () => {});

    await waitFor(() => expect(mockMarkBackupVerified).toHaveBeenCalled());
    // Still account A — the one whose phrase is on screen.
    expect(mockMarkBackupVerified).toHaveBeenCalledWith('acc-a');
    expect(mockMarkBackupVerified).not.toHaveBeenCalledWith('acc-b');
  });

  it('waits for the store to hydrate instead of declaring the account unverifiable', async () => {
    // Cold mount: the wallet is not in the store yet.
    mockAccounts = undefined;
    const screen = render(<VerifyBackupScreen />);

    expect(screen.getByTestId('verify-backup-loading')).toBeTruthy();
    expect(screen.queryByTestId('verify-backup-error')).toBeNull();
    expect(mockGetMnemonic).not.toHaveBeenCalled();

    // Hydration lands.
    mockAccounts = [{ id: 'acc-a', address: 'ADDRESS_A', type: 'standard' }];
    await act(async () => {
      screen.rerender(<VerifyBackupScreen />);
    });

    await waitFor(() => screen.getByTestId('verify-backup-root'));
    expect(mockGetMnemonic).toHaveBeenCalledWith('ADDRESS_A');
    expect(screen.queryByTestId('verify-backup-error')).toBeNull();
  });

  it('refuses a non-standard target instead of loading anything', async () => {
    mockAccounts = [{ id: 'acc-w', address: 'ADDRESS_W', type: 'watch' }];
    mockRouteParams = { accountAddress: 'ADDRESS_W' };

    const screen = render(<VerifyBackupScreen />);
    await waitFor(() => screen.getByTestId('verify-backup-error'));

    expect(mockGetMnemonic).not.toHaveBeenCalled();
    expect(screen.queryByTestId('verify-backup-root')).toBeNull();
  });

  it('shows a generic error and never marks verified when the phrase cannot load', async () => {
    mockGetMnemonic.mockRejectedValueOnce(
      new Error('keychain item SecureStore/voi_sk_acc-a is corrupt')
    );

    const screen = render(<VerifyBackupScreen />);
    await waitFor(() => screen.getByTestId('verify-backup-error'));

    // The underlying key-store detail must not reach the UI.
    expect(screen.getByTestId('verify-backup-error')).not.toHaveTextContent(
      'SecureStore'
    );
    expect(mockMarkBackupVerified).not.toHaveBeenCalled();
  });

  it('surfaces a failed write instead of pretending it succeeded', async () => {
    mockMarkBackupVerified.mockRejectedValueOnce(new Error('write failed'));
    const screen = await renderLoaded();

    completeQuiz(screen, 'verify-backup', MOCK_WORDS);
    // Success kicks off an async store write which then clears the phrase from
    // screen state, and the challenge rebuilds itself in response. Flush that
    // continuation inside act() so the rebuild is not an unwrapped update.
    await act(async () => {});

    await waitFor(() =>
      expect(Alert.alert).toHaveBeenCalledWith(
        'Could not save',
        expect.any(String)
      )
    );
    expect(mockNavigation.goBack).not.toHaveBeenCalled();
  });

  it('never marks the account verified on wrong answers (TASK-226)', async () => {
    const screen = await renderLoaded();

    // Exhaust the mistake budget — this used to be a silent no-op on an
    // auto-routing board, so the account could be marked backed-up without the
    // user ever knowing the phrase.
    for (let mistake = 0; mistake <= MAX_MISTAKES; mistake++) {
      pressWrongQuizOption(screen, 'verify-backup', MOCK_WORDS);
    }

    expect(mockMarkBackupVerified).not.toHaveBeenCalled();
    // This screen has no phrase step to fall back to, so it bounces the user out
    // rather than letting them grind attempts in place. Friction, not a lockout:
    // the Settings entry point is still there and re-entering re-reads the
    // phrase from the gated key store.
    expect(Alert.alert).toHaveBeenCalledWith(
      'Too many incorrect answers',
      expect.any(String),
      expect.any(Array)
    );

    const calls = (Alert.alert as unknown as jest.Mock).mock.calls;
    const buttons = calls[calls.length - 1][2] as { onPress?: () => void }[];
    act(() => buttons[0].onPress?.());
    expect(mockNavigation.goBack).toHaveBeenCalled();
  });
});
