/**
 * TASK-45 / DR-11 carrier #2 — the add-account flow.
 *
 * This flow does NOT pass through SecuritySetup: `handleBackupConfirmed` calls
 * `importAccount(...)` directly. So the quiz outcome has to travel on the
 * `ImportAccountRequest` itself. Without that, a successfully verified added
 * account could not persist `backupVerified: true` and its Home banner would be
 * wrong.
 *
 * Also pins DR-2: the quiz is actually ENABLED here (every consumer used to
 * pass `requireVerification={false}`), with a working skip escape.
 *
 * SECURITY NOTE: the phrase comes from a mocked WalletService; nothing real.
 */

import React from 'react';
import { render, fireEvent, act, waitFor } from '@testing-library/react-native';

const MOCK_MNEMONIC =
  'abandon ability able abandon absent absorb abandon abstract';

// TASK-522: the import's own duplicate check, run before a PIN is set.
const mockAssertNotInWallet = jest.fn(async (_mnemonic: string) => {});
jest.mock('@/services/wallet', () => ({
  WalletService: {
    generateWallet: jest.fn(() => ({ mnemonic: MOCK_MNEMONIC })),
    assertMnemonicNotInWalletStrict: (mnemonic: string) =>
      mockAssertNotInWallet(mnemonic),
  },
}));

const mockImportAccount = jest.fn(async () => ({ id: 'new-account-id' }));
const mockSetActiveAccount = jest.fn(async () => {});

jest.mock('@/store/walletStore', () => ({
  useWalletStore: (selector: (state: unknown) => unknown) =>
    selector({
      importAccount: mockImportAccount,
      setActiveAccount: mockSetActiveAccount,
    }),
}));

const mockNavigation = {
  getState: jest.fn(() => ({ type: 'stack', index: 0, routes: [] })),
  reset: jest.fn(),
  goBack: jest.fn(),
  navigate: jest.fn(),
};

const mockHasPin = jest.fn(async () => true);
jest.mock('@/services/secure', () => ({
  AccountSecureStorage: { hasPin: () => mockHasPin() },
}));

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => mockNavigation,
  useFocusEffect: () => {},
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

jest.mock('@/components/wallet/MnemonicDisplay', () => {
  const { Text } = require('react-native');
  return {
    __esModule: true,
    default: ({ mnemonic }: { mnemonic: string }) => (
      <Text testID="mnemonic-display">{mnemonic}</Text>
    ),
  };
});

import { Alert } from 'react-native';
import CreateAccountScreen from '../CreateAccountScreen';
import { completeQuiz } from '@/__tests__/fixtures/mnemonicQuiz';
import * as accountQRParser from '@/utils/accountQRParser';
import {
  clearAllAccountSecrets,
  getAccountSecret,
} from '@/utils/accountQRParser';

const MOCK_WORDS = MOCK_MNEMONIC.split(' ');

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

beforeEach(() => {
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
  mockHasPin.mockReset().mockResolvedValue(true);
  mockAssertNotInWallet.mockReset().mockResolvedValue(undefined);
  clearAllAccountSecrets();
});

/** Generate the account and advance to the backup step. */
async function renderAtBackupStep() {
  const screen = await render(<CreateAccountScreen />);
  await fireEvent.press(screen.getByText('Generate New Account'));
  return screen;
}

describe('CreateAccountScreen — quiz enabled (DR-2)', () => {
  it('routes the "saved it" button into the quiz instead of importing', async () => {
    const screen = await renderAtBackupStep();

    await fireEvent.press(screen.getByTestId('backup-continue'));

    // The quiz is on screen and nothing has been imported yet.
    expect(screen.getByTestId('backup-verification-root')).toBeTruthy();
    expect(mockImportAccount).not.toHaveBeenCalled();
  });
});

describe('CreateAccountScreen — backupVerified carrier (DR-11)', () => {
  it('imports with backupVerified: true after the quiz passes', async () => {
    const screen = await renderAtBackupStep();
    await fireEvent.press(screen.getByTestId('backup-continue'));

    await completeQuiz(screen, 'backup-verification', MOCK_WORDS);

    // Success is confirmed through an alert before the import runs.
    await pressAlertButton('Continue');

    await waitFor(() => expect(mockImportAccount).toHaveBeenCalledTimes(1));
    expect(mockImportAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        mnemonic: MOCK_MNEMONIC,
        backupVerified: true,
      })
    );
  });

  it('imports with backupVerified: false when the user skips', async () => {
    const screen = await renderAtBackupStep();
    await fireEvent.press(screen.getByTestId('backup-continue'));

    await fireEvent.press(screen.getByTestId('backup-verification-skip'));
    expect(mockImportAccount).not.toHaveBeenCalled();

    await pressAlertButton('Skip for now');

    await waitFor(() => expect(mockImportAccount).toHaveBeenCalledTimes(1));
    expect(mockImportAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        mnemonic: MOCK_MNEMONIC,
        backupVerified: false,
      })
    );
  });

  it('does not import if the skip confirmation is cancelled', async () => {
    const screen = await renderAtBackupStep();
    await fireEvent.press(screen.getByTestId('backup-continue'));
    await fireEvent.press(screen.getByTestId('backup-verification-skip'));
    await pressAlertButton('Cancel');

    expect(mockImportAccount).not.toHaveBeenCalled();
  });
});

describe('CreateAccountScreen — a wallet with no PIN (TASK-522)', () => {
  it('routes to SecuritySetup with only a secret id and stores nothing', async () => {
    mockHasPin.mockResolvedValue(false);
    const screen = await renderAtBackupStep();
    await fireEvent.press(screen.getByTestId('backup-continue'));
    await completeQuiz(screen, 'backup-verification', MOCK_WORDS);
    await pressAlertButton('Continue');

    await waitFor(() =>
      expect(mockNavigation.navigate).toHaveBeenCalledTimes(1)
    );
    const [route, params] = mockNavigation.navigate.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(route).toBe('SecuritySetup');
    expect(params).toEqual({
      source: 'create',
      addingAccount: true,
      backupVerified: true,
      mnemonicSecretId: expect.any(String),
    });
    expect(JSON.stringify(params)).not.toContain(MOCK_WORDS[0]);
    expect(getAccountSecret(params.mnemonicSecretId as string)?.mnemonic).toBe(
      MOCK_MNEMONIC
    );
    expect(mockImportAccount).not.toHaveBeenCalled();
    expect(mockSetActiveAccount).not.toHaveBeenCalled();
  });

  it('runs the duplicate check on the phrase before routing', async () => {
    mockHasPin.mockResolvedValue(false);
    const screen = await renderAtBackupStep();
    await fireEvent.press(screen.getByTestId('backup-continue'));
    await completeQuiz(screen, 'backup-verification', MOCK_WORDS);
    await pressAlertButton('Continue');

    await waitFor(() =>
      expect(mockNavigation.navigate).toHaveBeenCalledTimes(1)
    );
    expect(mockAssertNotInWallet).toHaveBeenCalledTimes(1);
    expect(mockAssertNotInWallet).toHaveBeenCalledWith(MOCK_MNEMONIC);
  });

  it('a phrase already in the wallet shows the create error, routes nowhere and sets no PIN', async () => {
    mockHasPin.mockResolvedValue(false);
    mockAssertNotInWallet.mockRejectedValue(
      new Error('Account already exists in wallet')
    );
    const store = jest.spyOn(accountQRParser, 'storeMnemonicSecret');
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const screen = await renderAtBackupStep();
    await fireEvent.press(screen.getByTestId('backup-continue'));
    await completeQuiz(screen, 'backup-verification', MOCK_WORDS);
    await pressAlertButton('Continue');

    await waitFor(() =>
      expect(Alert.alert).toHaveBeenCalledWith(
        'Error',
        'Failed to create new account'
      )
    );
    expect(mockNavigation.navigate).not.toHaveBeenCalled();
    expect(store).not.toHaveBeenCalled();
    expect(mockImportAccount).not.toHaveBeenCalled();
  });

  it('a skipped quiz carries backupVerified false', async () => {
    mockHasPin.mockResolvedValue(false);
    const screen = await renderAtBackupStep();
    await fireEvent.press(screen.getByTestId('backup-continue'));
    await fireEvent.press(screen.getByTestId('backup-verification-skip'));
    await pressAlertButton('Skip for now');

    await waitFor(() =>
      expect(mockNavigation.navigate).toHaveBeenCalledWith(
        'SecuritySetup',
        expect.objectContaining({ backupVerified: false })
      )
    );
    expect(mockImportAccount).not.toHaveBeenCalled();
  });

  it('with a PIN imports directly, as before', async () => {
    const screen = await renderAtBackupStep();
    await fireEvent.press(screen.getByTestId('backup-continue'));
    await completeQuiz(screen, 'backup-verification', MOCK_WORDS);
    await pressAlertButton('Continue');

    await waitFor(() => expect(mockImportAccount).toHaveBeenCalledTimes(1));
    expect(mockHasPin).toHaveBeenCalledTimes(1);
    expect(mockAssertNotInWallet).not.toHaveBeenCalled();
    expect(mockNavigation.navigate).not.toHaveBeenCalled();
  });

  it('a failed PIN read alerts, routes nowhere and imports nothing', async () => {
    mockHasPin.mockRejectedValue(new Error('keychain unavailable'));
    const screen = await renderAtBackupStep();
    await fireEvent.press(screen.getByTestId('backup-continue'));
    await completeQuiz(screen, 'backup-verification', MOCK_WORDS);
    await pressAlertButton('Continue');

    await waitFor(() =>
      expect(Alert.alert).toHaveBeenCalledWith(
        'Error',
        'Failed to create new account'
      )
    );
    expect(mockNavigation.navigate).not.toHaveBeenCalled();
    expect(mockImportAccount).not.toHaveBeenCalled();
  });
});
