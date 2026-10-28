import React from 'react';
import { Alert } from 'react-native';
import { act, fireEvent, render } from '@testing-library/react-native';
import BackupWalletScreen from '../BackupWalletScreen';
import { BackupService, BackupResult } from '@/services/backup';

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: jest.fn() }),
}));
jest.mock('@/store/walletStore', () => ({
  useAccounts: () => [{ type: 'rekeyed' }],
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
        onPress={() => onConfirm('test password')}
      />
    ) : null;
  };
});
jest.mock('@/services/backup', () => ({
  BackupService: {
    createBackup: jest.fn(),
    setProgressCallback: jest.fn(),
    clearProgressCallback: jest.fn(),
  },
  BackupError: class extends Error {},
}));

it.each([0, 1, 2])(
  'warns before save/share exactly when %s REKEYED keys were included',
  async (count) => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    jest.mocked(BackupService.createBackup).mockResolvedValue({
      rekeyedKeyCount: count,
      filename: 'backup',
      size: 100,
      accountCount: 2,
    } as BackupResult);
    const view = await render(<BackupWalletScreen />);
    await fireEvent.press(view.getByText('Create Backup'));
    await fireEvent.press(view.getByText('Confirm password'));
    if (count) {
      expect(alert).toHaveBeenCalledWith(
        'Update required when restoring',
        `Restore this backup with this version of Voi Wallet or newer, or the key for ${count} rekeyed account(s) won't be restored.`,
        expect.any(Array)
      );
      expect(view.queryByText('Backup Created')).toBeNull();
      await act(async () => alert.mock.calls[0][2]?.[1].onPress?.());
    } else expect(alert).not.toHaveBeenCalled();
    expect(view.getByText('Backup Created')).toBeTruthy();
    alert.mockRestore();
  }
);
