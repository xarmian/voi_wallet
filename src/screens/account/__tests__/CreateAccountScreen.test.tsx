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

jest.mock('@/services/wallet', () => ({
  WalletService: {
    generateWallet: jest.fn(() => ({ mnemonic: MOCK_MNEMONIC })),
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
};

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => mockNavigation,
  useFocusEffect: () => {},
}));

jest.mock('@/hooks/useSecureScreen', () => ({ useSecureScreen: () => {} }));

jest.mock('@/contexts/ThemeContext', () => ({
  // eslint-disable-next-line @typescript-eslint/no-require-imports
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
  // eslint-disable-next-line @typescript-eslint/no-require-imports
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

const MOCK_WORDS = MOCK_MNEMONIC.split(' ');

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

beforeEach(() => {
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

/** Generate the account and advance to the backup step. */
function renderAtBackupStep() {
  const screen = render(<CreateAccountScreen />);
  fireEvent.press(screen.getByText('Generate New Account'));
  return screen;
}

describe('CreateAccountScreen — quiz enabled (DR-2)', () => {
  it('routes the "saved it" button into the quiz instead of importing', () => {
    const screen = renderAtBackupStep();

    fireEvent.press(screen.getByTestId('backup-continue'));

    // The quiz is on screen and nothing has been imported yet.
    expect(screen.getByTestId('backup-verification-root')).toBeTruthy();
    expect(mockImportAccount).not.toHaveBeenCalled();
  });
});

describe('CreateAccountScreen — backupVerified carrier (DR-11)', () => {
  it('imports with backupVerified: true after the quiz passes', async () => {
    const screen = renderAtBackupStep();
    fireEvent.press(screen.getByTestId('backup-continue'));

    completeQuiz(screen, 'backup-verification', MOCK_WORDS);

    // Success is confirmed through an alert before the import runs.
    pressAlertButton('Continue');

    await waitFor(() => expect(mockImportAccount).toHaveBeenCalledTimes(1));
    expect(mockImportAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        mnemonic: MOCK_MNEMONIC,
        backupVerified: true,
      })
    );
  });

  it('imports with backupVerified: false when the user skips', async () => {
    const screen = renderAtBackupStep();
    fireEvent.press(screen.getByTestId('backup-continue'));

    fireEvent.press(screen.getByTestId('backup-verification-skip'));
    expect(mockImportAccount).not.toHaveBeenCalled();

    pressAlertButton('Skip for now');

    await waitFor(() => expect(mockImportAccount).toHaveBeenCalledTimes(1));
    expect(mockImportAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        mnemonic: MOCK_MNEMONIC,
        backupVerified: false,
      })
    );
  });

  it('does not import if the skip confirmation is cancelled', () => {
    const screen = renderAtBackupStep();
    fireEvent.press(screen.getByTestId('backup-continue'));
    fireEvent.press(screen.getByTestId('backup-verification-skip'));
    pressAlertButton('Cancel');

    expect(mockImportAccount).not.toHaveBeenCalled();
  });
});
