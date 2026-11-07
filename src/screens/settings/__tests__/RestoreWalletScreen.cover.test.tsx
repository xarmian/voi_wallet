// Render the real parent screen; mock native selection and the child modals.
import React from 'react';
import { Alert } from 'react-native';
import { act, fireEvent, render } from '@testing-library/react-native';
import RestoreWalletScreen from '../RestoreWalletScreen';
import { BackupService } from '@/services/backup';
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

let mockBackupInfo: unknown;
let mockConfirmRestore: () => Promise<void> = async () => {};
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
      <Button
        title="Confirm password"
        onPress={() => {
          void onConfirm('pw');
        }}
      />
    ) : null;
  };
});
jest.mock('@/components/backup/RestoreConfirmationModal', () => {
  const { Button } = require('react-native');
  return function Confirm({
    backupInfo,
    visible,
    onConfirm,
  }: {
    visible: boolean;
    backupInfo: unknown;
    onConfirm: () => Promise<void>;
  }) {
    mockBackupInfo = backupInfo;
    mockConfirmRestore = onConfirm;
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

let mockCovered = false;
jest.mock('@/hooks/useCoverPaused', () => ({
  useCoverPaused: () => mockCovered,
}));
beforeEach(() => {
  mockCovered = false;
  mockParams = undefined;
  mockAccountCount = 0;
  mockHasPin = false;
  jest
    .mocked(BackupService.validateBackupFile)
    .mockResolvedValue({ accountCount: 1 } as never);
  jest
    .mocked(BackupService.restoreBackup)
    .mockResolvedValue({ records: [], accountCount: 0 } as never);
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

it.each([true, false])(
  'DEFECT: parent restore password after cover=%s',
  async (cover) => {
    const view = await render(<RestoreWalletScreen />);
    await fireEvent.press(view.getByText('Select Backup File'));
    await fireEvent.press(view.getByText('Confirm password'));
    expect(view.getByText('Confirm restore')).toBeTruthy();
    if (cover) {
      mockCovered = true;
      await view.rerender(<RestoreWalletScreen />);
      mockCovered = false;
      await view.rerender(<RestoreWalletScreen />);
      // If stale confirmation survives, press it: it must never restore.
      const confirm = view.queryByText('Confirm restore');
      if (confirm) await fireEvent.press(confirm);
      await act(async () => mockConfirmRestore());
      expect(BackupService.restoreBackup).not.toHaveBeenCalled();
      expect(view.queryByText('Confirm restore')).toBeNull();
      expect(view.getByText('Confirm password')).toBeTruthy();
      await fireEvent.press(view.getByText('Confirm password'));
    }
    await fireEvent.press(view.getByText('Confirm restore'));
    expect(BackupService.restoreBackup).toHaveBeenCalledTimes(1);
    expect(BackupService.restoreBackup).toHaveBeenCalledWith(
      'file:///b.voibackup',
      'pw',
      {}
    );
  }
);

it.each([true, false])(
  'DEFECT: validation pending across cover=%s',
  async (cover) => {
    let finish!: (info: never) => void;
    jest.mocked(BackupService.validateBackupFile).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const view = await render(<RestoreWalletScreen />);
    await fireEvent.press(view.getByText('Select Backup File'));
    await fireEvent.press(view.getByText('Confirm password'));
    expect(BackupService.validateBackupFile).toHaveBeenCalledTimes(1);
    expect(mockBackupInfo).toBeNull();
    if (cover) {
      mockCovered = true;
      await view.rerender(<RestoreWalletScreen />);
      mockCovered = false;
      await view.rerender(<RestoreWalletScreen />);
    }
    const info = { accountCount: 1 } as never;
    await act(async () => finish(info));
    if (cover) {
      expect(view.queryByText('Confirm restore')).toBeNull();
      expect(mockBackupInfo).toBeNull();
      expect(view.getByText('Confirm password')).toBeTruthy();
      expect(BackupService.validateBackupFile).toHaveBeenLastCalledWith(
        'file:///b.voibackup',
        'pw'
      );
      await fireEvent.press(view.getByText('Confirm password'));
    }
    expect(view.getByText('Confirm restore')).toBeTruthy();
    expect(mockBackupInfo).toEqual(info);
  }
);
