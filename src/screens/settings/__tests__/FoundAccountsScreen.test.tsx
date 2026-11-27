// TASK-478: the found-accounts screen. The scan runs only after a fresh
// authentication; with no PIN nothing is read or offered; each state renders
// from a fixed summary. The service is mocked; freshAuth is real.
import React from 'react';
import { Alert } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

const mockGoBack = jest.fn();
const mockRefresh = jest.fn(async () => {});
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: mockGoBack }),
}));
jest.mock('@/hooks/useCoverPaused', () => ({ useCoverPaused: () => false }));
jest.mock('@/contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: require('@/constants/themes').lightTheme }),
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('@/store/walletStore', () => ({
  useWalletStore: (select: (s: { refresh: () => Promise<void> }) => unknown) =>
    select({ refresh: mockRefresh }),
}));
jest.mock('@/services/secure/foundAccounts', () => ({
  readFoundAccountsSummary: jest.fn(),
  scanFoundAccounts: jest.fn(async () => {}),
  restoreFoundAccount: jest.fn(),
  removeFoundAccount: jest.fn(async () => {}),
}));
jest.mock('@/services/secure/AccountSecureStorage', () => ({
  AccountSecureStorage: { scanQuarantinedAddresses: jest.fn() },
  FoundAccountMismatchError: class FoundAccountMismatchError extends Error {},
}));

import FoundAccountsScreen from '../FoundAccountsScreen';
import * as found from '@/services/secure/foundAccounts';
import { AccountSecureStorage } from '@/services/secure/AccountSecureStorage';
import { registerFreshAuthPrompter } from '@/services/secure/freshAuth';
import type { FoundSummary } from '@/services/secure/foundAccounts';
import { AccountType } from '@/types/wallet';

const READY = 'AAAAREADYADDRESSAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const WALLET = 'BBBBWALLETADDRESSBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const summaryMock = found.readFoundAccountsSummary as jest.Mock;
const scanMock = found.scanFoundAccounts as jest.Mock;
const restoreMock = found.restoreFoundAccount as jest.Mock;

function summary(overrides: Partial<FoundSummary> = {}): FoundSummary {
  return {
    hasPin: true,
    presentCount: 0,
    rows: [],
    unreadableIds: [],
    unscannedIds: [],
    ...overrides,
  };
}

let prompts: string[] = [];
let unregister: (() => void) | undefined;
function prompter(answer: boolean) {
  prompts = [];
  unregister = registerFreshAuthPrompter(async (reason) => {
    prompts.push(reason);
    return answer;
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
});
afterEach(() => {
  unregister?.();
  unregister = undefined;
});

describe('FoundAccountsScreen', () => {
  it('no read before auth', async () => {
    prompter(false);
    summaryMock.mockResolvedValue(
      summary({
        presentCount: 2,
        unscannedIds: ['q1', 'q2'],
        rows: [
          { kind: 'unscanned', id: 'q1', hintAddress: READY, hintLabel: 'Old' },
          { kind: 'unscanned', id: 'q2' },
        ],
      })
    );
    const view = await render(<FoundAccountsScreen />);
    await view.findByText('Check 2 accounts');
    expect(prompts).toEqual(['scan_found_accounts']);
    expect(scanMock).not.toHaveBeenCalled();
    expect(
      AccountSecureStorage.scanQuarantinedAddresses
    ).not.toHaveBeenCalled();
    expect(view.getByText('Old')).toBeTruthy();
    expect(view.queryByText('Restore')).toBeNull();
    // A cancel shows no alert.
    expect(Alert.alert).not.toHaveBeenCalled();
  });

  it('runs the scan inside the authentication, then lists', async () => {
    prompter(true);
    summaryMock
      .mockResolvedValueOnce(
        summary({ presentCount: 1, unscannedIds: ['q1'], rows: [] })
      )
      .mockResolvedValue(
        summary({
          presentCount: 1,
          rows: [{ kind: 'ready', id: 'q1', ids: ['q1'], address: READY }],
        })
      );
    const view = await render(<FoundAccountsScreen />);
    await view.findByText('Restore');
    expect(prompts).toEqual(['scan_found_accounts']);
    expect(scanMock).toHaveBeenCalledTimes(1);
    expect(scanMock.mock.calls[0][0]).toEqual(['q1']);
  });

  it('no-pin state', async () => {
    prompter(true);
    summaryMock.mockResolvedValue(
      summary({
        hasPin: false,
        presentCount: 1,
        unscannedIds: ['q1'],
        rows: [{ kind: 'unscanned', id: 'q1' }],
      })
    );
    const view = await render(<FoundAccountsScreen />);
    await view.findByText(/this wallet needs a PIN/);
    expect(prompts).toEqual([]);
    expect(scanMock).not.toHaveBeenCalled();
    expect(view.queryByText('Restore')).toBeNull();
    expect(view.queryByText('Remove')).toBeNull();
  });

  it('states: list, unreadable card, in-wallet', async () => {
    prompter(true);
    summaryMock.mockResolvedValue(
      summary({
        presentCount: 5,
        rows: [
          {
            kind: 'ready',
            id: 'q1',
            ids: ['q1'],
            address: READY,
            label: 'Lost',
          },
          {
            kind: 'in-wallet',
            id: 'q2',
            address: WALLET,
            walletLabel: 'Savings',
            walletType: AccountType.STANDARD,
            keyed: true,
          },
          {
            kind: 'in-wallet',
            id: 'q3',
            address: WALLET,
            walletLabel: 'Watcher',
            walletType: AccountType.WATCH,
            keyed: false,
          },
        ],
        unreadableIds: ['q4', 'q5'],
      })
    );
    const view = await render(<FoundAccountsScreen />);
    await view.findByText('Lost');
    expect(view.getAllByText('Restore')).toHaveLength(1);
    expect(view.getAllByText('Remove')).toHaveLength(3);
    expect(view.getByText('Already in your wallet as Savings')).toBeTruthy();
    expect(
      view.getByText(/as a watch-only account, so it can't be restored here/)
    ).toBeTruthy();
    expect(view.getByText(/2 accounts couldn't be read/)).toBeTruthy();
    expect(view.getByText('Try again')).toBeTruthy();
    expect(prompts).toEqual([]);
  });

  it('states: empty', async () => {
    prompter(true);
    summaryMock.mockResolvedValue(summary());
    const view = await render(<FoundAccountsScreen />);
    await view.findByText('No accounts found on this device.');
  });

  it('states: error, then retry', async () => {
    prompter(true);
    summaryMock
      .mockRejectedValueOnce(new Error('read failed'))
      .mockResolvedValue(summary());
    const view = await render(<FoundAccountsScreen />);
    await view.findByText("Couldn't check the accounts on this device.");
    await act(async () => {
      fireEvent.press(view.getByText('Retry'));
    });
    await view.findByText('No accounts found on this device.');
  });

  it('restore asks first, runs inside the authentication and refreshes', async () => {
    prompter(true);
    summaryMock.mockResolvedValue(
      summary({
        presentCount: 1,
        rows: [{ kind: 'ready', id: 'q1', ids: ['q1'], address: READY }],
      })
    );
    restoreMock.mockResolvedValue({ kind: 'restored', address: READY });
    const view = await render(<FoundAccountsScreen />);
    fireEvent.press(await view.findByText('Restore'));
    expect(restoreMock).not.toHaveBeenCalled();
    const confirm = (Alert.alert as jest.Mock).mock.calls[0][2] as {
      text: string;
      onPress?: () => void;
    }[];
    await act(async () => {
      confirm.find((b) => b.text === 'Restore')!.onPress!();
    });
    await waitFor(() => expect(mockRefresh).toHaveBeenCalled());
    expect(prompts).toEqual(['restore_found_account']);
    expect(restoreMock.mock.calls[0].slice(0, 2)).toEqual(['q1', READY]);
    expect(
      (Alert.alert as jest.Mock).mock.calls.some(
        (c) => c[0] === 'Account restored'
      )
    ).toBe(true);
  });
});
