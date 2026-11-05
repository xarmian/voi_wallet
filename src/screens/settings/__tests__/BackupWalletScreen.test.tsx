import React from 'react';
import { Alert } from 'react-native';
import { act, fireEvent, render } from '@testing-library/react-native';
import BackupWalletScreen from '../BackupWalletScreen';
import { BackupService, BackupResult } from '@/services/backup';

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: jest.fn() }),
}));
let mockAccounts: { type: string }[] = [{ type: 'rekeyed' }];
jest.mock('@/store/walletStore', () => ({
  useAccounts: () => mockAccounts,
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
let mockAuthFailure: string | null = null;
const mockAuthCalls: {
  reason: string;
  opts?: { maxReads?: number; signal?: AbortSignal };
}[] = [];
jest.mock('@/services/secure/freshAuth', () => {
  class FreshAuthError extends Error {
    code: string;
    constructor(code: string) {
      super(code);
      this.code = code;
    }
  }
  return {
    withFreshAuth: (
      reason: string,
      fn: (cap: object) => unknown,
      opts?: { maxReads?: number; signal?: AbortSignal }
    ) => {
      mockAuthCalls.push({ reason, opts });
      if (mockAuthFailure)
        return Promise.reject(new FreshAuthError(mockAuthFailure));
      return Promise.resolve(fn({}));
    },
    FreshAuthError,
  };
});

beforeEach(() => {
  mockAccounts = [{ type: 'rekeyed' }];
  mockAuthFailure = null;
  mockAuthCalls.length = 0;
  jest.mocked(BackupService.createBackup).mockClear();
});

// TASK-485: the backup export needs a fresh prompt, and a refused prompt must
// stop the export before any key is collected.
it('asks for fresh authentication sized to the account count, before creating the backup', async () => {
  jest.mocked(BackupService.createBackup).mockResolvedValue({
    rekeyedKeyCount: 0,
    filename: 'backup',
    size: 100,
    accountCount: 1,
  } as BackupResult);
  const view = await render(<BackupWalletScreen />);
  await fireEvent.press(view.getByText('Create Backup'));
  await fireEvent.press(view.getByText('Confirm password'));
  expect(mockAuthCalls).toEqual([
    {
      reason: 'export_backup',
      opts: { maxReads: 1, signal: expect.any(AbortSignal) },
    },
  ]);
  expect(BackupService.createBackup).toHaveBeenCalledTimes(1);
});

it('cancels the pending prompt when the screen unmounts', async () => {
  const view = await render(<BackupWalletScreen />);
  await fireEvent.press(view.getByText('Create Backup'));
  await fireEvent.press(view.getByText('Confirm password'));
  const signal = mockAuthCalls[0].opts?.signal;
  expect(signal?.aborted).toBe(false);
  await view.unmount();
  expect(signal?.aborted).toBe(true);
});

it('a cancelled prompt creates no backup and shows no error', async () => {
  mockAuthFailure = 'cancelled';
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  const view = await render(<BackupWalletScreen />);
  await fireEvent.press(view.getByText('Create Backup'));
  await fireEvent.press(view.getByText('Confirm password'));
  expect(BackupService.createBackup).not.toHaveBeenCalled();
  expect(alert).not.toHaveBeenCalled();
  expect(view.queryByText('Backup Created')).toBeNull();
  alert.mockRestore();
});

it.each(['unavailable', 'failed', 'timeout', 'busy'])(
  'a %s prompt creates no backup and reports the failure',
  async (code) => {
    mockAuthFailure = code;
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const view = await render(<BackupWalletScreen />);
    await fireEvent.press(view.getByText('Create Backup'));
    await fireEvent.press(view.getByText('Confirm password'));
    expect(BackupService.createBackup).not.toHaveBeenCalled();
    expect(alert).toHaveBeenCalledWith(
      'Backup Failed',
      expect.any(String),
      expect.any(Array)
    );
    alert.mockRestore();
  }
);

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

// TASK-504: an incomplete backup is never a success state and names every
// account it left out, with its address.
it('an incomplete backup reads "Backup incomplete", never created or saved, and lists each left-out account', async () => {
  jest.mocked(BackupService.createBackup).mockResolvedValue({
    filename: 'voi-wallet-2026-11-05-incomplete.voibackup',
    fileUri: 'file:///x',
    fileContent: '{}',
    size: 100,
    accountCount: 3,
    totalAccountCount: 4,
    incomplete: {
      leftOut: [
        {
          address: 'A'.repeat(58),
          label: 'Imported Account 10/9/2025',
          reason: 'key-unreadable',
        },
      ],
    },
  } as unknown as BackupResult);
  const view = await render(<BackupWalletScreen />);
  await fireEvent.press(view.getByText('Create Backup'));
  await fireEvent.press(view.getByText('Confirm password'));

  expect(view.getAllByText('Backup incomplete').length).toBeGreaterThan(0);
  expect(
    view.getByText("Saved 3 of 4 accounts. These weren't included:")
  ).toBeTruthy();
  expect(view.getByText(/Imported Account 10\/9\/2025 \(/)).toBeTruthy();
  expect(view.getByText("Couldn't read this key")).toBeTruthy();
  expect(view.getByText(/Keep this wallet installed/)).toBeTruthy();
  expect(view.queryByText('Backup Created')).toBeNull();
  expect(view.queryByText('Backup Saved!')).toBeNull();
  expect(view.queryByText('Backup Ready')).toBeNull();
});

it("a complete backup keeps today's wording", async () => {
  jest.mocked(BackupService.createBackup).mockResolvedValue({
    filename: 'voi-wallet-2026-11-05.voibackup',
    fileUri: 'file:///x',
    fileContent: '{}',
    size: 100,
    accountCount: 1,
    totalAccountCount: 1,
  } as unknown as BackupResult);
  const view = await render(<BackupWalletScreen />);
  await fireEvent.press(view.getByText('Create Backup'));
  await fireEvent.press(view.getByText('Confirm password'));
  expect(view.getByText('Backup Created')).toBeTruthy();
  expect(view.queryByText('Backup incomplete')).toBeNull();
});

it("What's Included counts airgap accounts, so the rows add up to the wallet", async () => {
  mockAccounts = [
    { type: 'standard' },
    { type: 'remote_signer' },
    { type: 'remote_signer' },
  ];
  const view = await render(<BackupWalletScreen />);
  expect(view.getByText('Airgap Accounts')).toBeTruthy();
  expect(
    view.getByText('Metadata only - the keys stay on the signer device')
  ).toBeTruthy();
});
