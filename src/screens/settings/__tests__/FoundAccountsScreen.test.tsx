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
  FoundAccountOnlyCopyError: class FoundAccountOnlyCopyError extends Error {},
  FoundAccountWalletKeyUncheckedError: class FoundAccountWalletKeyUncheckedError extends Error {},
}));

import FoundAccountsScreen from '../FoundAccountsScreen';
import * as found from '@/services/secure/foundAccounts';
import {
  AccountSecureStorage,
  FoundAccountMismatchError,
  FoundAccountOnlyCopyError,
  FoundAccountWalletKeyUncheckedError,
} from '@/services/secure/AccountSecureStorage';
import { registerFreshAuthPrompter } from '@/services/secure/freshAuth';
import { formatAddress } from '@/utils/address';
import type { FoundSummary } from '@/services/secure/foundAccounts';
import { AccountType } from '@/types/wallet';
import {
  actionableCount,
  idsNeedingScan,
} from '@/services/secure/foundAccountsCount';

const READY = 'AAAAREADYADDRESSAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const WALLET = 'BBBBWALLETADDRESSBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const summaryMock = found.readFoundAccountsSummary as jest.Mock;
const scanMock = found.scanFoundAccounts as jest.Mock;
const restoreMock = found.restoreFoundAccount as jest.Mock;
const removeMock = found.removeFoundAccount as jest.Mock;
const ONLY_COPY = `This key is the only usable copy for ${formatAddress(WALLET)} on this device. It's kept here.`;
/** An in-wallet row whose wallet account holds no key says how to recover. */
const onlyCopyRow = (walletLabel: string) =>
  `${ONLY_COPY} To use it, remove the account "${walletLabel}" from your wallet, then restore it here.`;
const notChecked = (walletLabel: string) =>
  `It hasn't been checked yet whether ${walletLabel} still holds its key.`;

const alertCalls = () => (Alert.alert as jest.Mock).mock.calls;

/** Presses `button` in the most recent Alert that offered it. */
async function pressAlertButton(button: string) {
  const call = [...alertCalls()]
    .reverse()
    .find((c) =>
      ((c[2] ?? []) as { text: string }[]).some((b) => b.text === button)
    );
  const buttons = call![2] as { text: string; onPress?: () => void }[];
  await act(async () => {
    buttons.find((b) => b.text === button)!.onPress!();
    // The action and its reload finish inside this act scope.
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

const flush = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

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

  it('no-pin counts what can be acted on, as Home and Settings do', async () => {
    prompter(true);
    summaryMock.mockResolvedValue(
      summary({
        hasPin: false,
        presentCount: 3,
        rows: [
          { kind: 'ready', id: 'r1', ids: ['r1', 'r2'], address: READY },
          {
            kind: 'in-wallet',
            id: 'w1',
            address: WALLET,
            walletLabel: 'Main',
            walletType: AccountType.STANDARD,
            walletKeyUsable: true,
          },
        ],
      })
    );
    const view = await render(<FoundAccountsScreen />);
    await view.findByText('1 account found on this device');
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
            walletKeyUsable: true,
          },
          {
            kind: 'in-wallet',
            id: 'q3',
            address: WALLET,
            walletLabel: 'Watcher',
            walletType: AccountType.WATCH,
            walletKeyUsable: false,
          },
        ],
        unreadableIds: ['q4', 'q5'],
      })
    );
    const view = await render(<FoundAccountsScreen />);
    await view.findByText('Lost');
    expect(view.getAllByText('Restore')).toHaveLength(1);
    // The ready row and the in-wallet row whose wallet account has its key.
    expect(view.getAllByText('Remove')).toHaveLength(2);
    expect(view.getByText('Already in your wallet as Savings')).toBeTruthy();
    expect(view.getByText(onlyCopyRow('Watcher'))).toBeTruthy();
    expect(view.getByText(/2 accounts couldn't be read/)).toBeTruthy();
    expect(view.getByText('Try again')).toBeTruthy();
    expect(prompts).toEqual([]);
  });

  it('no PIN and only duplicate in-wallet copies shows the empty state, not "0 accounts"', async () => {
    prompter(true);
    summaryMock.mockResolvedValue(
      summary({
        hasPin: false,
        presentCount: 1,
        rows: [
          {
            kind: 'in-wallet',
            id: 'w1',
            address: READY,
            walletLabel: '',
            walletType: AccountType.STANDARD,
            walletKeyUsable: true,
          },
        ],
      })
    );
    const view = await render(<FoundAccountsScreen />);
    await view.findByText('No accounts found on this device.');
    expect(view.queryByText(/0 accounts/)).toBeNull();
  });

  it('an unlabelled wallet account is named by its short address', async () => {
    prompter(true);
    summaryMock.mockResolvedValue(
      summary({
        presentCount: 1,
        rows: [
          {
            kind: 'in-wallet',
            id: 'w1',
            address: READY,
            walletLabel: '',
            walletType: AccountType.WATCH,
            walletKeyUsable: false,
          },
        ],
      })
    );
    const view = await render(<FoundAccountsScreen />);
    await view.findByText(
      new RegExp(
        `remove the account "${formatAddress(READY)}" from your wallet`
      )
    );
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
    await fireEvent.press(await view.findByText('Restore'));
    expect(restoreMock).not.toHaveBeenCalled();
    const confirm = (Alert.alert as jest.Mock).mock.calls[0][2] as {
      text: string;
      onPress?: () => void;
    }[];
    await act(async () => {
      confirm.find((b) => b.text === 'Restore')!.onPress!();
      // The restore and its reload finish inside this act scope.
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(mockRefresh).toHaveBeenCalled();
    expect(prompts).toEqual(['restore_found_account']);
    expect(restoreMock.mock.calls[0].slice(0, 2)).toEqual(['q1', READY]);
    expect(
      (Alert.alert as jest.Mock).mock.calls.some(
        (c) => c[0] === 'Account restored'
      )
    ).toBe(true);
  });

  it.each([
    ['an empty wallet slot', AccountType.STANDARD, false],
    ['a watch account', AccountType.WATCH, true],
    ['a Ledger account', AccountType.LEDGER, true],
    ['a remote signer', AccountType.REMOTE_SIGNER, true],
  ])(
    'an in-wallet row over %s offers no Remove',
    async (_label, walletType, walletKeyUsable) => {
      prompter(true);
      summaryMock.mockResolvedValue(
        summary({
          presentCount: 1,
          rows: [
            {
              kind: 'in-wallet',
              id: 'q2',
              address: WALLET,
              walletLabel: 'Savings',
              walletType,
              walletKeyUsable,
            },
          ],
        })
      );
      const view = await render(<FoundAccountsScreen />);
      await view.findByText(onlyCopyRow('Savings'));
      expect(view.queryByText('Remove')).toBeNull();
    }
  );

  it('a refused remove says the only copy is kept', async () => {
    prompter(true);
    summaryMock.mockResolvedValue(
      summary({
        presentCount: 1,
        rows: [
          {
            kind: 'in-wallet',
            id: 'q2',
            address: WALLET,
            walletLabel: 'Savings',
            walletType: AccountType.STANDARD,
            walletKeyUsable: true,
          },
        ],
      })
    );
    removeMock.mockRejectedValueOnce(new FoundAccountOnlyCopyError());
    const view = await render(<FoundAccountsScreen />);
    await fireEvent.press(await view.findByText('Remove'));
    await pressAlertButton('Remove');
    await waitFor(() => expect(removeMock).toHaveBeenCalled());
    expect(removeMock.mock.calls[0][0]).toEqual(['q2']);
    // An in-wallet row's refusal says how to recover the key.
    await waitFor(() =>
      expect(alertCalls().some((c) => c[1] === onlyCopyRow('Savings'))).toBe(
        true
      )
    );
  });

  it('a refused remove on a ready row keeps the short only-copy text', async () => {
    prompter(true);
    summaryMock.mockResolvedValue(
      summary({
        presentCount: 1,
        rows: [{ kind: 'ready', id: 'q1', ids: ['q1'], address: WALLET }],
      })
    );
    removeMock.mockRejectedValueOnce(new FoundAccountOnlyCopyError());
    const view = await render(<FoundAccountsScreen />);
    await fireEvent.press(await view.findByText('Remove'));
    await pressAlertButton('Remove');
    await waitFor(() =>
      expect(alertCalls().some((c) => c[1] === ONLY_COPY)).toBe(true)
    );
  });

  it('a STANDARD account with a corrupt slot: scanned, then the only-copy row', async () => {
    prompter(true);
    const inWallet = {
      kind: 'in-wallet' as const,
      id: 'q2',
      address: WALLET,
      walletLabel: 'Savings',
      walletType: AccountType.STANDARD,
    };
    const unchecked = summary({ presentCount: 1, rows: [inWallet] });
    const scanned = summary({
      presentCount: 1,
      rows: [{ ...inWallet, walletKeyUsable: false }],
    });
    summaryMock.mockResolvedValueOnce(unchecked).mockResolvedValue(scanned);
    const view = await render(<FoundAccountsScreen />);
    await view.findByText(onlyCopyRow('Savings'));
    // The verdict comes from the scan, which ran inside the authentication.
    expect(prompts).toEqual(['scan_found_accounts']);
    expect(scanMock.mock.calls[0][0]).toEqual(['q2']);
    expect(view.queryByText('Remove')).toBeNull();
    expect(actionableCount(scanned)).toBe(1);
  });

  it('an in-wallet row with no verdict says not checked yet and offers no Remove', async () => {
    prompter(true);
    const unchecked = summary({
      presentCount: 1,
      rows: [
        {
          kind: 'in-wallet',
          id: 'q2',
          address: WALLET,
          walletLabel: 'Savings',
          walletType: AccountType.STANDARD,
        },
      ],
    });
    // The scan left no verdict (the vault locked during it).
    summaryMock.mockResolvedValue(unchecked);
    expect(idsNeedingScan(unchecked)).toEqual(['q2']);
    const view = await render(<FoundAccountsScreen />);
    await view.findByText(notChecked('Savings'));
    expect(view.queryByText('Remove')).toBeNull();
    expect(view.queryByText(/Already in your wallet/)).toBeNull();
    expect(scanMock).toHaveBeenCalledTimes(1);
    // The existing rescan path checks it again.
    await act(async () => {
      fireEvent.press(view.getByText('Check 1 account'));
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(scanMock).toHaveBeenCalledTimes(2);
    expect(scanMock.mock.calls[1][0]).toEqual(['q2']);
  });

  it('a remote-signer row with no verdict is the only copy, needs no scan, and counts', async () => {
    prompter(true);
    const keyless = summary({
      presentCount: 1,
      rows: [
        {
          kind: 'in-wallet',
          id: 'q2',
          address: WALLET,
          walletLabel: 'Signer',
          walletType: AccountType.REMOTE_SIGNER,
        },
      ],
    });
    summaryMock.mockResolvedValue(keyless);
    expect(idsNeedingScan(keyless)).toEqual([]);
    expect(actionableCount(keyless)).toBe(1);
    const view = await render(<FoundAccountsScreen />);
    await view.findByText(onlyCopyRow('Signer'));
    await flush();
    expect(view.queryByText(notChecked('Signer'))).toBeNull();
    expect(view.queryByText('Remove')).toBeNull();
    expect(view.queryByText(/^Check /)).toBeNull();
    expect(prompts).toEqual([]);
    expect(scanMock).not.toHaveBeenCalled();
  });

  it('a restore that kept the found copy lands in the list with no second prompt', async () => {
    prompter(true);
    summaryMock
      .mockResolvedValueOnce(
        summary({
          presentCount: 1,
          rows: [{ kind: 'ready', id: 'q1', ids: ['q1'], address: WALLET }],
        })
      )
      // The release recorded that the new account holds the key.
      .mockResolvedValue(
        summary({
          presentCount: 1,
          rows: [
            {
              kind: 'in-wallet',
              id: 'q1',
              address: WALLET,
              walletLabel: 'Restored',
              walletType: AccountType.STANDARD,
              walletKeyUsable: true,
            },
          ],
        })
      );
    restoreMock.mockResolvedValue({
      kind: 'restored-copy-kept',
      address: WALLET,
    });
    const view = await render(<FoundAccountsScreen />);
    await fireEvent.press(await view.findByText('Restore'));
    await pressAlertButton('Restore');
    await view.findByText('Already in your wallet as Restored');
    await flush();
    expect(view.getByText('Remove')).toBeTruthy();
    expect(prompts).toEqual(['restore_found_account']);
    expect(scanMock).not.toHaveBeenCalled();
  });

  it('a remove whose wallet key could not be checked says to unlock and retry', async () => {
    prompter(true);
    summaryMock.mockResolvedValue(
      summary({
        presentCount: 1,
        rows: [
          {
            kind: 'in-wallet',
            id: 'q2',
            address: WALLET,
            walletLabel: 'Savings',
            walletType: AccountType.STANDARD,
            walletKeyUsable: true,
          },
        ],
      })
    );
    removeMock.mockRejectedValueOnce(new FoundAccountWalletKeyUncheckedError());
    const view = await render(<FoundAccountsScreen />);
    await fireEvent.press(await view.findByText('Remove'));
    await pressAlertButton('Remove');
    await waitFor(() =>
      expect(
        alertCalls().some(
          (c) =>
            c[1] ===
            "Couldn't check this account's own key right now. Nothing was removed. Unlock the wallet and try again."
        )
      ).toBe(true)
    );
  });

  it('Remove on a ready row removes every copy', async () => {
    prompter(true);
    summaryMock.mockResolvedValue(
      summary({
        presentCount: 2,
        rows: [{ kind: 'ready', id: 'q1', ids: ['q1', 'q1b'], address: READY }],
      })
    );
    const view = await render(<FoundAccountsScreen />);
    await fireEvent.press(await view.findByText('Remove'));
    await pressAlertButton('Remove');
    await waitFor(() => expect(removeMock).toHaveBeenCalled());
    expect(prompts).toEqual(['remove_found_account']);
    expect(removeMock.mock.calls[0][0]).toEqual(['q1', 'q1b']);
  });

  it('restored-unconfirmed says the step did not finish', async () => {
    prompter(true);
    summaryMock.mockResolvedValue(
      summary({
        presentCount: 1,
        rows: [{ kind: 'ready', id: 'q1', ids: ['q1'], address: READY }],
      })
    );
    restoreMock.mockResolvedValue({
      kind: 'restored-unconfirmed',
      address: READY,
    });
    const view = await render(<FoundAccountsScreen />);
    await fireEvent.press(await view.findByText('Restore'));
    await pressAlertButton('Restore');
    await waitFor(() => expect(mockRefresh).toHaveBeenCalled());
    const texts = alertCalls().map((c) => `${c[0]}|${c[1] ?? ''}`);
    expect(texts).toContain(
      "Restore Account|The account was added to your wallet, but this step didn't finish. The found key may still be on this device; check this screen again after restarting the app."
    );
    expect(texts.some((t) => t.includes('Nothing was removed'))).toBe(false);
    expect(texts.some((t) => t.startsWith('Account restored'))).toBe(false);
  });

  it('a mismatch, then the reload, opens no second prompt', async () => {
    prompter(true);
    const listed = summary({
      presentCount: 1,
      rows: [{ kind: 'ready', id: 'q1', ids: ['q1'], address: READY }],
    });
    // The mismatch cleared the id's scan entry, so it lists as unscanned.
    const rescanned = summary({
      presentCount: 1,
      unscannedIds: ['q1'],
      rows: [{ kind: 'unscanned', id: 'q1' }],
    });
    summaryMock.mockResolvedValueOnce(listed).mockResolvedValue(rescanned);
    restoreMock.mockRejectedValueOnce(new FoundAccountMismatchError());
    const view = await render(<FoundAccountsScreen />);
    await fireEvent.press(await view.findByText('Restore'));
    await pressAlertButton('Restore');
    await view.findByText('Check 1 account');
    await flush();
    expect(prompts).toEqual(['restore_found_account']);
    expect(scanMock).not.toHaveBeenCalled();
  });

  it('leaving during a restore opens no prompt afterwards', async () => {
    prompter(true);
    summaryMock
      .mockResolvedValueOnce(
        summary({
          presentCount: 1,
          rows: [{ kind: 'ready', id: 'q1', ids: ['q1'], address: READY }],
        })
      )
      .mockResolvedValue(
        summary({
          presentCount: 1,
          unscannedIds: ['q1'],
          rows: [{ kind: 'unscanned', id: 'q1' }],
        })
      );
    let finish: (value: unknown) => void = () => {};
    restoreMock.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    const view = await render(<FoundAccountsScreen />);
    await fireEvent.press(await view.findByText('Restore'));
    await pressAlertButton('Restore');
    await waitFor(() => expect(restoreMock).toHaveBeenCalled());
    await act(async () => {
      view.unmount();
    });
    await act(async () => {
      finish({ kind: 'restored', address: READY });
    });
    await flush();
    expect(prompts).toEqual(['restore_found_account']);
    expect(scanMock).not.toHaveBeenCalled();
  });

  it.each(['Restore', 'Remove'])(
    'a %s confirmation answered after leaving opens no prompt',
    async (button) => {
      prompter(true);
      summaryMock.mockResolvedValue(
        summary({
          presentCount: 1,
          rows: [{ kind: 'ready', id: 'q1', ids: ['q1'], address: READY }],
        })
      );
      const view = await render(<FoundAccountsScreen />);
      await fireEvent.press(await view.findByText(button));
      // The confirmation is still open when the screen goes away.
      await act(async () => {
        view.unmount();
      });
      await pressAlertButton(button);
      await flush();
      expect(prompts).toEqual([]);
      expect(restoreMock).not.toHaveBeenCalled();
      expect(removeMock).not.toHaveBeenCalled();
    }
  );
});
