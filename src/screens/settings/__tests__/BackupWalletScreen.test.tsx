import React from 'react';
import { Alert, Platform } from 'react-native';
import { act, fireEvent, render } from '@testing-library/react-native';
import * as FileSystem from 'expo-file-system/legacy';
import {
  buildBackupReport,
  androidSavedAlertText,
} from '@/services/backup/backupReport';
import type { BackupLeftOutReason } from '@/services/backup/types';
import BackupWalletScreen from '../BackupWalletScreen';
import { BackupService, BackupResult } from '@/services/backup';

const mockScrollTo = jest.fn();
const mockExportButtons: { disabled: boolean; onPress: () => Promise<void> }[] =
  [];
jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  const React = require('react');
  return Object.defineProperties(Object.create(actual), {
    ScrollView: {
      value: function MockScrollView({
        ref,
        ...props
      }: React.ComponentProps<typeof actual.ScrollView>) {
        React.useImperativeHandle(ref, () => ({ scrollTo: mockScrollTo }));
        return <actual.ScrollView {...props} />;
      },
    },
    TouchableOpacity: {
      value: (props: React.ComponentProps<typeof actual.TouchableOpacity>) => {
        if (props.disabled !== undefined) mockExportButtons.push(props);
        return <actual.TouchableOpacity {...props} />;
      },
    },
  });
});
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
    shareBackup: jest.fn(async () => {}),
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
  await fireEvent.press(view.getByText(/confirm password/i));
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
  await fireEvent.press(view.getByText(/confirm password/i));
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
  await fireEvent.press(view.getByText(/confirm password/i));
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
    await fireEvent.press(view.getByText(/confirm password/i));
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
    await fireEvent.press(view.getByText(/confirm password/i));
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

jest.mock('expo-file-system/legacy', () => ({
  StorageAccessFramework: {
    requestDirectoryPermissionsAsync: jest.fn(async () => ({
      granted: true,
      directoryUri: 'folder',
    })),
    createFileAsync: jest.fn(async () => 'file:///saved'),
  },
  writeAsStringAsync: jest.fn(async () => {}),
}));

it.each([
  [],
  ['key-unreadable'],
  ['key-unreadable', 'no-key-on-device'],
  ['other-key-on-device'],
  ['key-unreadable', 'other-key-on-device'],
] as BackupLeftOutReason[][])(
  'gates exports, preserves report and scrolls after saving %j',
  async (...reasons) => {
    const originalOS = Platform.OS;
    Platform.OS = 'android';
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    jest.clearAllMocks();
    const result = {
      filename: 'backup.voibackup',
      fileUri: 'file:///x',
      fileContent: '{}',
      size: 100,
      accountCount: 2,
      incomplete: {
        leftOut: reasons.map((reason, i) => ({
          reason,
          address: String(i).repeat(58),
          label: `Account ${i}`,
        })),
      },
    } as BackupResult;
    const report = buildBackupReport(result);
    jest.mocked(BackupService.createBackup).mockResolvedValue(result);
    const view = await render(<BackupWalletScreen />);
    await fireEvent.press(view.getByText('Create Backup'));
    mockExportButtons.length = 0;
    await fireEvent.press(view.getByText(/confirm password/i));
    if (report.incomplete) {
      expect(
        view.getByRole('button', { name: report.acknowledgeText })
      ).toBeTruthy();
      expect(mockExportButtons.length).toBeGreaterThanOrEqual(2);
      for (const button of mockExportButtons.slice(-2)) {
        expect(button.disabled).toBe(true);
        await fireEvent.press(view.getByText('Save to Device'));
        await fireEvent.press(view.getByText('Share to Cloud or Other Apps'));
        // Invoke the actual handler as well: disabled alone is insufficient.
        await act(async () => {
          await button.onPress();
        });
        expect(BackupService.shareBackup).not.toHaveBeenCalled();
        expect(
          FileSystem.StorageAccessFramework.requestDirectoryPermissionsAsync
        ).not.toHaveBeenCalled();
      }
      expect(BackupService.shareBackup).not.toHaveBeenCalled();
      expect(
        FileSystem.StorageAccessFramework.requestDirectoryPermissionsAsync
      ).not.toHaveBeenCalled();
      await fireEvent.press(
        view.getByRole('button', { name: report.acknowledgeText })
      );
      expect(view.getAllByText(report.title!)).toHaveLength(2);
      for (const block of [report.withoutKey, report.otherKey]) {
        if (!block) continue;
        expect(view.getByText(block.text)).toBeTruthy();
        if (block.advice) expect(view.getByText(block.advice)).toBeTruthy();
        for (const row of block.rows)
          expect(
            view.getByText(`${row.label} (${row.shortAddress})`)
          ).toBeTruthy();
      }
    } else {
      expect(view.getByText('Backup Ready')).toBeTruthy();
      expect(view.getByText('Backup Created')).toBeTruthy();
    }
    await fireEvent.press(view.getByText('Save to Device'));
    expect(FileSystem.writeAsStringAsync).toHaveBeenCalledWith(
      'file:///saved',
      '{}'
    );
    expect(alert).toHaveBeenCalledWith('Saved', androidSavedAlertText(report));
    expect(mockScrollTo).toHaveBeenCalledWith({ y: 0, animated: true });
    mockScrollTo.mockClear();
    await fireEvent.press(view.getByText('Share to Cloud or Other Apps'));
    expect(BackupService.shareBackup).toHaveBeenCalledWith(result.fileUri);
    expect(mockScrollTo).toHaveBeenCalledWith({ y: 0, animated: true });
    if (report.incomplete) {
      for (const title of ['Backup Ready', 'Backup Created', 'Backup Saved!'])
        expect(view.queryByText(title)).toBeNull();
      expect(view.queryByText(/Saved \d+ of \d+/)).toBeNull();
    } else expect(view.getByText('Backup Saved!')).toBeTruthy();
    Platform.OS = originalOS;
    alert.mockRestore();
  }
);

it('shows the acknowledgement after the update-required alert, and gates iOS export', async () => {
  const originalOS = Platform.OS;
  Platform.OS = 'ios';
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  const result = {
    filename: 'backup.voibackup',
    fileUri: 'file:///x',
    fileContent: '{}',
    size: 100,
    accountCount: 1,
    rekeyedKeyCount: 1,
    incomplete: {
      leftOut: [{ address: 'A'.repeat(58), reason: 'key-unreadable' as const }],
    },
  } as BackupResult;
  const report = buildBackupReport(result);
  jest.mocked(BackupService.createBackup).mockResolvedValue(result);
  const view = await render(<BackupWalletScreen />);
  await fireEvent.press(view.getByText('Create Backup'));
  await fireEvent.press(view.getByText(/confirm password/i));
  expect(alert.mock.calls[0][0]).toBe('Update required when restoring');
  expect(view.queryByText(report.acknowledgeText)).toBeNull();
  await act(async () => alert.mock.calls[0][2]?.[1].onPress?.());
  await fireEvent.press(view.getByText('Export Backup'));
  await act(async () => {
    await mockExportButtons[mockExportButtons.length - 1].onPress();
  });
  expect(BackupService.shareBackup).not.toHaveBeenCalled();
  await fireEvent.press(
    view.getByRole('button', { name: report.acknowledgeText })
  );
  await fireEvent.press(view.getByText('Export Backup'));
  expect(BackupService.shareBackup).toHaveBeenCalledWith(result.fileUri);
  expect(mockScrollTo).toHaveBeenCalledWith({ y: 0, animated: true });
  Platform.OS = originalOS;
  alert.mockRestore();
});
