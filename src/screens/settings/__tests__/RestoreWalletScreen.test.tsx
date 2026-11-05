// TASK-504: the restore screen's landings and report (DOC-507 3.6). The real
// screen and the real report text; BackupService is mocked at its boundary.
// SecuritySetup is right only for a fresh device; every other restore keeps the
// PIN it has and ends with the accounts-only line.

import React from 'react';
import { Alert } from 'react-native';
import algosdk from 'algosdk';
import { fireEvent, render } from '@testing-library/react-native';
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
jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ recheckAuthState: mockRecheck }),
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
  await fireEvent.press(view.getByText('Select Backup File'));
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
