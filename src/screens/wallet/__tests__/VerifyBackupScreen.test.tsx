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
    revealMnemonic: (...args: unknown[]) => mockGetMnemonic(...(args as [])),
  },
}));
const mockAuthSignals: (AbortSignal | undefined)[] = [];
const mockAuthReasons: string[] = [];
let mockAuthCalls = 0;
let mockAuthFailure: string | null = null;
jest.mock('@/services/secure/freshAuth', () => ({
  withFreshAuth: (
    reason: string,
    fn: (cap: object) => unknown,
    opts?: { signal?: AbortSignal }
  ) => {
    mockAuthCalls += 1;
    mockAuthReasons.push(reason);
    mockAuthSignals.push(opts?.signal);
    if (mockAuthFailure) {
      return Promise.reject(
        Object.assign(new Error(mockAuthFailure), { code: mockAuthFailure })
      );
    }
    return Promise.resolve(fn({}));
  },
}));

const mockMarkBackupVerified = jest.fn(async () => {});

let mockAccounts: { id: string; address: string; type: string }[] | undefined =
  [];
let mockActiveAccountId = 'acc-a';
let mockWalletHydrated = true;

jest.mock('@/store/walletStore', () => ({
  useActiveAccount: () =>
    mockAccounts?.find((a) => a.id === mockActiveAccountId) ?? null,
  useWalletStore: (selector: (state: unknown) => unknown) =>
    selector({
      markBackupVerified: mockMarkBackupVerified,
      // `undefined` accounts models the pre-hydration store.
      wallet:
        mockAccounts === undefined || !mockWalletHydrated
          ? undefined
          : { accounts: mockAccounts },
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

import { Alert, AppState, AppStateStatus } from 'react-native';
import VerifyBackupScreen from '../VerifyBackupScreen';
import {
  completeQuiz,
  pressWrongQuizOption,
} from '@/__tests__/fixtures/mnemonicQuiz';
import { MAX_MISTAKES } from '@/components/wallet/mnemonicQuiz';

const MOCK_WORDS = MOCK_MNEMONIC.split(' ');

beforeEach(() => {
  mockAuthCalls = 0;
  mockAuthFailure = null;
  mockAuthReasons.length = 0;
  mockWalletHydrated = true;
  mockAuthSignals.length = 0;
  mockNavigation.goBack.mockClear();
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
  const screen = await render(<VerifyBackupScreen />);
  await waitFor(() => screen.getByTestId('verify-backup-root'));
  return screen;
}

describe('VerifyBackupScreen', () => {
  // TASK-485: the phrase must not outlive the screen or the foreground.
  it('reads the stored phrase only through the verify_backup gate, and a refused prompt reads nothing', async () => {
    mockAuthFailure = 'cancelled';
    await render(<VerifyBackupScreen />);
    await waitFor(() => expect(mockNavigation.goBack).toHaveBeenCalled());
    expect(mockAuthReasons).toEqual(['verify_backup']);
    expect(mockGetMnemonic).not.toHaveBeenCalled();
  });

  it('keeps the screen with a message, without leaving, when authentication fails (not cancelled)', async () => {
    mockAuthFailure = 'failed';
    const screen = await render(<VerifyBackupScreen />);
    await waitFor(() =>
      expect(
        screen.getByText(/Could not load your recovery phrase/)
      ).toBeTruthy()
    );
    expect(mockNavigation.goBack).not.toHaveBeenCalled();
    expect(mockGetMnemonic).not.toHaveBeenCalled();
  });

  it('asks for authentication once per mount', async () => {
    await renderLoaded();
    expect(mockAuthCalls).toBe(1);
  });

  it('does not start a second prompt when the wallet hydrates after the target pins', async () => {
    // Entered with no address param: the active account pins the target while
    // the wallet blob is still hydrating, then the hydration flag flips.
    mockRouteParams = {};
    mockWalletHydrated = false;
    const screen = await render(<VerifyBackupScreen />);
    await waitFor(() => screen.getByTestId('verify-backup-root'));
    expect(mockAuthCalls).toBe(1);
    mockWalletHydrated = true;
    await screen.rerender(<VerifyBackupScreen />);
    await act(async () => {});
    expect(mockAuthCalls).toBe(1);
  });

  it('cancels the pending prompt when the screen unmounts', async () => {
    const screen = await renderLoaded();
    expect(mockAuthSignals[0]?.aborted).toBe(false);
    await screen.unmount();
    expect(mockAuthSignals[0]?.aborted).toBe(true);
  });

  it('cancels the prompt, drops the phrase and leaves when the app backgrounds', async () => {
    const listeners: ((state: AppStateStatus) => void)[] = [];
    jest
      .spyOn(AppState, 'addEventListener')
      .mockImplementation((_event, listener) => {
        listeners.push(listener as (state: AppStateStatus) => void);
        return { remove: jest.fn() } as never;
      });
    await renderLoaded();
    await act(async () => listeners.forEach((l) => l('background')));
    expect(mockAuthSignals[0]?.aborted).toBe(true);
    expect(mockNavigation.goBack).toHaveBeenCalled();
  });

  it('does not leave on inactive (the Face ID sheet makes the app inactive)', async () => {
    const listeners: ((state: AppStateStatus) => void)[] = [];
    jest
      .spyOn(AppState, 'addEventListener')
      .mockImplementation((_event, listener) => {
        listeners.push(listener as (state: AppStateStatus) => void);
        return { remove: jest.fn() } as never;
      });
    await renderLoaded();
    await act(async () => listeners.forEach((l) => l('inactive')));
    expect(mockNavigation.goBack).not.toHaveBeenCalled();
  });

  it('loads the phrase for the routed address, not from a nav param', async () => {
    await renderLoaded();
    expect(mockGetMnemonic).toHaveBeenCalledWith(
      'ADDRESS_A',
      expect.anything(),
      'verify_backup'
    );
    // The route never carries key material.
    expect(JSON.stringify(mockRouteParams)).not.toContain('abandon');
  });

  it('marks the account whose phrase was actually shown', async () => {
    const screen = await renderLoaded();

    await completeQuiz(screen, 'verify-backup', MOCK_WORDS);
    // Success kicks off an async store write which then clears the phrase from
    // screen state, and the challenge rebuilds itself in response. Flush that
    // continuation inside act() so the rebuild is not an unwrapped update.
    await act(async () => {});

    await waitFor(() => expect(mockMarkBackupVerified).toHaveBeenCalled());
    expect(mockMarkBackupVerified).toHaveBeenCalledWith('acc-a', 'ADDRESS_A');
  });

  it.each(['standard', 'rekeyed'])(
    'pins the %s account while the quiz is open',
    async (type) => {
      mockAccounts![0].type = type;
      // Entered with no address param, so the active account is the entry default.
      mockRouteParams = undefined;
      const screen = await renderLoaded();
      expect(mockGetMnemonic).toHaveBeenCalledWith(
        'ADDRESS_A',
        expect.anything(),
        'verify_backup'
      );

      // The user switches accounts elsewhere. The store hooks are mocked, so the
      // re-render has to be forced explicitly — otherwise this test would pass
      // even if the screen re-resolved its target on every store update.
      mockActiveAccountId = 'acc-b';
      await act(async () => {
        await screen.rerender(<VerifyBackupScreen />);
      });

      // The phrase on screen is still account A's — no reload was triggered.
      expect(mockGetMnemonic).toHaveBeenCalledTimes(1);
      expect(mockGetMnemonic).not.toHaveBeenCalledWith('ADDRESS_B');

      await completeQuiz(screen, 'verify-backup', MOCK_WORDS);
      // Success kicks off an async store write which then clears the phrase from
      // screen state, and the challenge rebuilds itself in response. Flush that
      // continuation inside act() so the rebuild is not an unwrapped update.
      await act(async () => {});

      await waitFor(() => expect(mockMarkBackupVerified).toHaveBeenCalled());
      // Still account A — the one whose phrase is on screen.
      expect(mockMarkBackupVerified).toHaveBeenCalledWith('acc-a', 'ADDRESS_A');
      expect(mockMarkBackupVerified).not.toHaveBeenCalledWith(
        'acc-b',
        'ADDRESS_B'
      );
    }
  );

  it('waits for the store to hydrate instead of declaring the account unverifiable', async () => {
    // Cold mount: the wallet is not in the store yet.
    mockAccounts = undefined;
    const screen = await render(<VerifyBackupScreen />);

    expect(screen.getByTestId('verify-backup-loading')).toBeTruthy();
    expect(screen.queryByTestId('verify-backup-error')).toBeNull();
    expect(mockGetMnemonic).not.toHaveBeenCalled();

    // Hydration lands.
    mockAccounts = [{ id: 'acc-a', address: 'ADDRESS_A', type: 'standard' }];
    await act(async () => {
      await screen.rerender(<VerifyBackupScreen />);
    });

    await waitFor(() => screen.getByTestId('verify-backup-root'));
    expect(mockGetMnemonic).toHaveBeenCalledWith(
      'ADDRESS_A',
      expect.anything(),
      'verify_backup'
    );
    expect(screen.queryByTestId('verify-backup-error')).toBeNull();
  });

  it.each(['watch', 'ledger', 'remote_signer'])(
    'refuses a %s target',
    async (type) => {
      mockAccounts = [{ id: 'acc-w', address: 'ADDRESS_W', type }];
      mockRouteParams = { accountAddress: 'ADDRESS_W' };

      const screen = await render(<VerifyBackupScreen />);
      await waitFor(() => screen.getByTestId('verify-backup-error'));

      expect(mockGetMnemonic).not.toHaveBeenCalled();
      expect(screen.queryByTestId('verify-backup-root')).toBeNull();
    }
  );

  it.each(['standard', 'rekeyed'])(
    'fails closed when the %s phrase cannot load',
    async (type) => {
      mockAccounts![0].type = type;
      mockGetMnemonic.mockRejectedValueOnce(
        new Error('keychain item SecureStore/voi_sk_acc-a is corrupt')
      );

      const screen = await render(<VerifyBackupScreen />);
      await waitFor(() => screen.getByTestId('verify-backup-error'));

      // The underlying key-store detail must not reach the UI.
      expect(screen.getByTestId('verify-backup-error')).not.toHaveTextContent(
        'SecureStore'
      );
      expect(mockMarkBackupVerified).not.toHaveBeenCalled();
    }
  );

  it('surfaces a failed write instead of pretending it succeeded', async () => {
    mockMarkBackupVerified.mockRejectedValueOnce(new Error('write failed'));
    const screen = await renderLoaded();

    await completeQuiz(screen, 'verify-backup', MOCK_WORDS);
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
      await pressWrongQuizOption(screen, 'verify-backup', MOCK_WORDS);
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
    await act(() => buttons[0].onPress?.());
    expect(mockNavigation.goBack).toHaveBeenCalled();
  });
});
