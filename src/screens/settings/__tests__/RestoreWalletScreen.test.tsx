// TASK-504: the restore screen's landings and report (DOC-507 3.6). The real
// screen and the real report text; BackupService is mocked at its boundary.
// SecuritySetup is right only for a fresh device; every other restore keeps the
// PIN it has and ends with the accounts-only line.

import React from 'react';
import { Alert, AppState } from 'react-native';
import algosdk from 'algosdk';
import { act, fireEvent, render } from '@testing-library/react-native';
import RestoreWalletScreen from '../RestoreWalletScreen';
import { BackupService } from '@/services/backup';
import {
  NOT_FRESH_LINE,
  RESTORE_ADDS_TEXT,
  SETTINGS_STAY_TEXT,
} from '@/services/backup/restoreReport';

const mockGoBack = jest.fn();
const mockDispatch = jest.fn();
const mockRecheck = jest.fn(async () => {});
let mockParams: { isOnboarding?: boolean } | undefined;
let mockAccountCount = 0;

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: mockGoBack, dispatch: mockDispatch }),
  useRoute: () => ({ params: mockParams }),
  CommonActions: {
    reset: (state: object) => ({ type: 'RESET', ...state }),
  },
}));
jest.mock('@/contexts/ThemeContext', () => ({
  useTheme: () => ({ reloadTheme: async () => {} }),
}));
const mockUnlockForRestore = jest.fn();
const mockClearRestoreVault = jest.fn();
jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    recheckAuthState: mockRecheck,
    unlockForRestore: mockUnlockForRestore,
    clearRestoreVault: mockClearRestoreVault,
  }),
}));
let mockHasPin = false;
let mockLockedUntil: number | null = null;
jest.mock('@/services/secure/AccountSecureStorage', () => ({
  AccountSecureStorage: {
    hasPinStrict: async () => mockHasPin,
    getPinThrottleState: async () => ({
      lockedUntil: mockLockedUntil,
      attemptsRemaining: 5,
    }),
  },
}));
jest.mock('@/store/walletStore', () => ({
  useWalletStore: (
    selector: (state: { wallet: { accounts: unknown[] } }) => unknown
  ) =>
    selector({
      wallet: { accounts: new Array(mockAccountCount).fill({}) },
    }),
}));
jest.mock('@/hooks/useThemedStyles', () => ({
  useThemedStyles: () => ({}),
  useThemeColors: () => ({}),
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('@/components/common/GlassCard', () => ({
  GlassCard: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('@/components/backup/BackupProgressModal', () => () => null);
jest.mock('@/components/backup/PasswordInputModal', () => {
  const { Button } = require('react-native');
  return function Password({
    visible,
    onConfirm,
  }: {
    visible: boolean;
    onConfirm: (value: string) => void;
  }) {
    return visible ? (
      <Button title="Confirm password" onPress={() => onConfirm('pw')} />
    ) : null;
  };
});
jest.mock('@/components/backup/RestoreConfirmationModal', () => {
  const { Button } = require('react-native');
  return function Confirm({
    visible,
    onConfirm,
  }: {
    visible: boolean;
    onConfirm: () => void;
  }) {
    return visible ? (
      <Button title="Confirm restore" onPress={onConfirm} />
    ) : null;
  };
});
jest.mock('expo-document-picker', () => ({
  getDocumentAsync: jest.fn(async () => ({
    canceled: false,
    assets: [{ uri: 'file:///b.voibackup', name: 'b.voibackup' }],
  })),
}));
jest.mock('@/services/backup', () => ({
  BackupService: {
    validateBackupFile: jest.fn(),
    restoreBackup: jest.fn(),
    setProgressCallback: jest.fn(),
    clearProgressCallback: jest.fn(),
  },
  BackupError: class extends Error {},
}));

// A real address: formatAddress only shortens a valid one.
const ADDRESS = algosdk.generateAccount().addr.toString();

const record = (outcome: string, label = 'Acct') => ({
  id: label,
  address: ADDRESS,
  label,
  outcome,
});

function restoreResult(
  settingsRestored: boolean,
  records = [record('added')],
  extra: object = {}
) {
  return {
    records,
    accountCount: records.length,
    ledgerAccountCount: 0,
    standardAccountCount: 0,
    watchAccountCount: 0,
    rekeyedAccountCount: 0,
    remoteSignerAccountCount: 0,
    duplicateAccountsDropped: 0,
    settingsRestored,
    friendsCount: 0,
    remoteSignerSettingsRestored: false,
    pairedSignersNotRestored: 0,
    ...extra,
  };
}

/** Walk the real screen through select, password and confirm; return the alert. */
async function restoreThroughScreen(result: object) {
  jest
    .mocked(BackupService.validateBackupFile)
    .mockResolvedValue({ accountCount: 1 } as never);
  jest.mocked(BackupService.restoreBackup).mockResolvedValue(result as never);
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  const view = await render(<RestoreWalletScreen />);
  await fireEvent.press(await view.findByText('Select Backup File'));
  await fireEvent.press(await view.findByText('Confirm password'));
  await fireEvent.press(await view.findByText('Confirm restore'));
  await view.findByText('Select Backup File');
  expect(alert).toHaveBeenCalledTimes(1);
  const [title, message, buttons] = alert.mock.calls[0] as [
    string,
    string,
    { onPress: () => void }[],
  ];
  return { view, alert, title, message, pressOk: () => buttons[0].onPress() };
}

beforeEach(() => {
  mockGoBack.mockClear();
  mockDispatch.mockClear();
  mockRecheck.mockClear();
  mockParams = undefined;
  mockAccountCount = 0;
  mockHasPin = false;
  mockLockedUntil = null;
  mockUnlockForRestore.mockReset();
  mockClearRestoreVault.mockClear();
  jest.restoreAllMocks();
});

describe('restore screen landings', () => {
  it('fresh: reports "Restore complete" without the accounts-only line, and lands on SecuritySetup', async () => {
    mockParams = { isOnboarding: true };
    const { title, message, pressOk } = await restoreThroughScreen(
      restoreResult(true)
    );
    expect(title).toBe('Restore complete');
    expect(message).not.toContain(NOT_FRESH_LINE);
    pressOk();
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    expect(mockDispatch.mock.calls[0][0]).toMatchObject({
      type: 'RESET',
      routes: [{ name: 'SecuritySetup', params: { source: 'restore' } }],
    });
    expect(mockRecheck).not.toHaveBeenCalled();
    expect(mockGoBack).not.toHaveBeenCalled();
  });

  it('not fresh, from Settings: ends with the accounts-only line and never shows SecuritySetup', async () => {
    mockAccountCount = 2;
    const { message, pressOk } = await restoreThroughScreen(
      restoreResult(false)
    );
    expect(message.endsWith(NOT_FRESH_LINE)).toBe(true);
    pressOk();
    expect(mockGoBack).toHaveBeenCalledTimes(1);
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(mockRecheck).not.toHaveBeenCalled();
  });

  it('not fresh, from onboarding (a PIN stays): re-reads the auth state and never shows SecuritySetup', async () => {
    mockParams = { isOnboarding: true };
    const { message, pressOk } = await restoreThroughScreen(
      restoreResult(false)
    );
    expect(message.endsWith(NOT_FRESH_LINE)).toBe(true);
    pressOk();
    expect(mockRecheck).toHaveBeenCalledTimes(1);
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(mockGoBack).not.toHaveBeenCalled();
  });

  it('a mixed result lists each record that was not simply added', async () => {
    mockAccountCount = 1;
    const { title, message } = await restoreThroughScreen(
      restoreResult(false, [
        record('added', 'One'),
        record('rejected-slot-occupied', 'Two'),
      ])
    );
    expect(title).toBe('Restore finished');
    expect(message).toContain('Added 1 of 2 accounts. Check the list below.');
    expect(message).toContain(
      `Two (${ADDRESS.slice(0, 6)}...${ADDRESS.slice(-4)}): Not added. A stored key is already in its place on this device.`
    );
    expect(message).not.toContain('One (');
  });
});

describe('restore screen words', () => {
  it('says restore only adds, and adds the settings line only on a wallet with accounts', async () => {
    mockAccountCount = 0;
    const empty = await render(<RestoreWalletScreen />);
    expect(empty.getByText(RESTORE_ADDS_TEXT)).toBeTruthy();
    expect(empty.queryByText(/replace ALL/i)).toBeNull();
    await empty.unmount();

    mockAccountCount = 3;
    const full = await render(<RestoreWalletScreen />);
    expect(
      full.getByText(`${RESTORE_ADDS_TEXT} ${SETTINGS_STAY_TEXT}`)
    ).toBeTruthy();
    expect(full.queryByText(/replace ALL/i)).toBeNull();
  });
});

// DOC-507 section 3: the old-PIN step.
describe('restore screen: the old-PIN step (onboarding, the device still has a PIN)', () => {
  const NORMAL =
    'This phone still has a PIN from before. Enter it to restore your backup.';

  async function openOnboardingWithPin() {
    mockParams = { isOnboarding: true };
    mockHasPin = true;
    return render(<RestoreWalletScreen />);
  }

  it('shows product copy and keeps the file chooser away until the PIN is verified', async () => {
    const view = await openOnboardingWithPin();
    expect(await view.findByText(NORMAL)).toBeTruthy();
    expect(view.queryByText('Select Backup File')).toBeNull();
    expect(mockUnlockForRestore).not.toHaveBeenCalled();
  });

  it('a wrong PIN keeps the chooser away and fills nothing', async () => {
    mockUnlockForRestore.mockResolvedValue({ status: 'invalid' });
    const view = await openOnboardingWithPin();
    await view.findByText(NORMAL);
    await fireEvent.changeText(view.getByLabelText('Old PIN'), '000000');
    await fireEvent.press(view.getByText('Continue'));
    expect(
      await view.findByText('That PIN is not right. Try again.')
    ).toBeTruthy();
    expect(view.queryByText('Select Backup File')).toBeNull();
  });

  it('a verified PIN opens the chooser, the restore carries the epoch, and finishing clears the vault and re-reads auth (never SecuritySetup)', async () => {
    mockUnlockForRestore.mockResolvedValue({ status: 'verified', epoch: 42 });
    jest
      .mocked(BackupService.validateBackupFile)
      .mockResolvedValue({ accountCount: 1 } as never);
    jest
      .mocked(BackupService.restoreBackup)
      .mockResolvedValue(restoreResult(false) as never);
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const view = await openOnboardingWithPin();
    await view.findByText(NORMAL);
    await fireEvent.changeText(view.getByLabelText('Old PIN'), '123456');
    await fireEvent.press(view.getByText('Continue'));
    await fireEvent.press(await view.findByText('Select Backup File'));
    await fireEvent.press(await view.findByText('Confirm password'));
    await fireEvent.press(await view.findByText('Confirm restore'));
    await view.findByText('Select Backup File');

    expect(BackupService.restoreBackup).toHaveBeenCalledWith(
      'file:///b.voibackup',
      'pw',
      { oldPinSession: { epoch: 42 } }
    );
    const buttons = alert.mock.calls[0][2] as { onPress: () => void }[];
    buttons[0].onPress();
    expect(mockClearRestoreVault).toHaveBeenCalledTimes(1);
    expect(mockRecheck).toHaveBeenCalledTimes(1);
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('locked: the stored end time shows as time left, no PIN field is offered, and nothing is verified', async () => {
    mockLockedUntil = Date.now() + 2 * 60 * 60 * 1000 + 5 * 60 * 1000 - 1000;
    const view = await openOnboardingWithPin();
    expect(
      await view.findByText(
        'Too many wrong tries, so PIN entry is paused. Try again in 2 hr 5 min. Nothing on this phone has changed.'
      )
    ).toBeTruthy();
    expect(view.queryByLabelText('Old PIN')).toBeNull();
    expect(view.queryByText('Select Backup File')).toBeNull();
    expect(view.queryByText(/Reset/i)).toBeNull();
    expect(mockUnlockForRestore).not.toHaveBeenCalled();
  });

  it('from Settings the step never appears and the PIN is not even asked about', async () => {
    mockParams = undefined;
    mockHasPin = true;
    mockAccountCount = 2;
    const view = await render(<RestoreWalletScreen />);
    expect(await view.findByText('Select Backup File')).toBeTruthy();
    expect(view.queryByText(NORMAL)).toBeNull();
  });

  describe('the vault does not outlive the session', () => {
    let handler: (state: string) => void;
    beforeEach(() => {
      jest
        .spyOn(AppState, 'addEventListener')
        .mockImplementation((_type, fn) => {
          handler = fn as (state: string) => void;
          return { remove: jest.fn() } as never;
        });
    });

    async function verified() {
      mockUnlockForRestore.mockResolvedValue({ status: 'verified', epoch: 1 });
      const view = await openOnboardingWithPin();
      await view.findByText(NORMAL);
      await fireEvent.changeText(view.getByLabelText('Old PIN'), '123456');
      await fireEvent.press(view.getByText('Continue'));
      await view.findByText('Select Backup File');
      return view;
    }

    it('going to the background clears the vault and brings the step back', async () => {
      const view = await verified();
      handler('background');
      expect(mockClearRestoreVault).toHaveBeenCalledTimes(1);
      expect(await view.findByText(NORMAL)).toBeTruthy();
      expect(view.queryByText('Select Backup File')).toBeNull();
    });

    it('leaving the screen clears the vault', async () => {
      const view = await verified();
      await view.unmount();
      expect(mockClearRestoreVault).toHaveBeenCalledTimes(1);
    });

    it('a background event before any PIN is verified clears nothing and changes nothing', async () => {
      const view = await openOnboardingWithPin();
      await view.findByText(NORMAL);
      handler('background');
      expect(mockClearRestoreVault).not.toHaveBeenCalled();
      expect(view.getByText(NORMAL)).toBeTruthy();
    });

    it('the session times out: the vault is cleared and the step returns', async () => {
      jest.useFakeTimers();
      try {
        const view = await verified();
        await act(async () => {
          jest.advanceTimersByTime(5 * 60 * 1000 + 1);
        });
        expect(mockClearRestoreVault).toHaveBeenCalledTimes(1);
        expect(view.queryByText('Select Backup File')).toBeNull();
      } finally {
        jest.useRealTimers();
      }
    });
  });
});
