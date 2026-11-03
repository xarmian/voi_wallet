import React from 'react';
import { act, render } from '@testing-library/react-native';
import { useRemovedAccountNotices } from '../useRemovedAccountNotices';
import { AccountSecureStorage } from '@/services/secure/AccountSecureStorage';
import { MultiAccountWalletService } from '@/services/wallet';
import { refocus } from '@/__tests__/fixtures/navigationFocus';

jest.mock('@react-navigation/native', () =>
  require('@/__tests__/fixtures/navigationFocus').createNavigationFocusMock()
);
jest.mock('@/services/secure/AccountSecureStorage', () => ({
  AccountSecureStorage: {
    readUnexplainedRemovals: jest.fn(),
    clearUnexplainedRemoval: jest.fn(),
  },
}));
jest.mock('@/services/wallet', () => ({
  MultiAccountWalletService: { getAllAccounts: jest.fn() },
}));

const records = [
  { id: 'one', address: 'ADDRONE', label: 'First' },
  { id: 'two', address: 'ADDRTWO', label: 'Second' },
];
const Harness = ({
  onValue,
}: {
  onValue: (v: ReturnType<typeof useRemovedAccountNotices>) => void;
}) => {
  const value = useRemovedAccountNotices();
  onValue(value);
  return null;
};
const account = (address: string) => ({ address });

describe('useRemovedAccountNotices', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (
      AccountSecureStorage.readUnexplainedRemovals as jest.Mock
    ).mockResolvedValue(records);
    (
      AccountSecureStorage.clearUnexplainedRemoval as jest.Mock
    ).mockResolvedValue(undefined);
    (MultiAccountWalletService.getAllAccounts as jest.Mock).mockResolvedValue(
      []
    );
  });
  it('clears and hides records whose addresses are present; leaves other records visible', async () => {
    (MultiAccountWalletService.getAllAccounts as jest.Mock).mockResolvedValue([
      account('ADDRONE'),
    ]);
    const values: ReturnType<typeof useRemovedAccountNotices>[] = [];
    await render(<Harness onValue={(v) => values.push(v)} />);
    expect(AccountSecureStorage.clearUnexplainedRemoval).toHaveBeenCalledWith(
      'one'
    );
    expect(values.at(-1)?.notices).toEqual([records[1]]);
  });
  it('does not clear while accounts lack the record address', async () => {
    (MultiAccountWalletService.getAllAccounts as jest.Mock).mockResolvedValue([
      account('OTHER'),
    ]);
    const values: ReturnType<typeof useRemovedAccountNotices>[] = [];
    await render(<Harness onValue={(v) => values.push(v)} />);
    expect(AccountSecureStorage.clearUnexplainedRemoval).not.toHaveBeenCalled();
    expect(values.at(-1)?.notices).toEqual([records[0]]);
  });
  it('does not treat a watch-only account for that address as the import coming back', async () => {
    (MultiAccountWalletService.getAllAccounts as jest.Mock).mockResolvedValue([
      { address: 'ADDRONE', type: 'watch' },
    ]);
    const values: ReturnType<typeof useRemovedAccountNotices>[] = [];
    await render(<Harness onValue={(v) => values.push(v)} />);
    expect(AccountSecureStorage.clearUnexplainedRemoval).not.toHaveBeenCalled();
    expect(values.at(-1)?.notices).toEqual([records[0]]);
  });
  it('counts a signing account type (standard) for that address as the import coming back', async () => {
    (MultiAccountWalletService.getAllAccounts as jest.Mock).mockResolvedValue([
      { address: 'ADDRONE', type: 'standard' },
    ]);
    const values: ReturnType<typeof useRemovedAccountNotices>[] = [];
    await render(<Harness onValue={(v) => values.push(v)} />);
    expect(AccountSecureStorage.clearUnexplainedRemoval).toHaveBeenCalledWith(
      'one'
    );
    expect(values.at(-1)?.notices).toEqual([records[1]]);
  });
  it('shows all records when wallet lookup fails and clears nothing', async () => {
    (MultiAccountWalletService.getAllAccounts as jest.Mock).mockRejectedValue(
      new Error('bad')
    );
    const values: ReturnType<typeof useRemovedAccountNotices>[] = [];
    await render(<Harness onValue={(v) => values.push(v)} />);
    expect(AccountSecureStorage.clearUnexplainedRemoval).not.toHaveBeenCalled();
    expect(values.at(-1)?.notices).toEqual([records[0]]);
  });
  it('after refocus clears when the matching address returns', async () => {
    const values: ReturnType<typeof useRemovedAccountNotices>[] = [];
    await render(<Harness onValue={(v) => values.push(v)} />);
    (MultiAccountWalletService.getAllAccounts as jest.Mock).mockResolvedValue([
      account('ADDRONE'),
    ]);
    await act(async () => {
      refocus();
    });
    expect(AccountSecureStorage.clearUnexplainedRemoval).toHaveBeenCalledWith(
      'one'
    );
    expect(values.at(-1)?.notices).toEqual([records[1]]);
  });
  it('does not clear or hide when refocus gains a different address', async () => {
    const values: ReturnType<typeof useRemovedAccountNotices>[] = [];
    await render(<Harness onValue={(v) => values.push(v)} />);
    (MultiAccountWalletService.getAllAccounts as jest.Mock).mockResolvedValue([
      account('DIFFERENT'),
    ]);
    await act(async () => {
      refocus();
    });
    expect(AccountSecureStorage.clearUnexplainedRemoval).not.toHaveBeenCalled();
    expect(values.at(-1)?.notices).toEqual([records[0]]);
  });
  it('returns empty and warns when records are unreadable', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    (
      AccountSecureStorage.readUnexplainedRemovals as jest.Mock
    ).mockRejectedValue(new Error('bad'));
    const values: ReturnType<typeof useRemovedAccountNotices>[] = [];
    await render(<Harness onValue={(v) => values.push(v)} />);
    expect(values.at(-1)?.notices).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
  it('dismiss resolves only after clearing and shows one notice at a time', async () => {
    let release: () => void = () => {};
    (AccountSecureStorage.clearUnexplainedRemoval as jest.Mock).mockReturnValue(
      new Promise<void>((resolve) => {
        release = resolve;
      })
    );
    const values: ReturnType<typeof useRemovedAccountNotices>[] = [];
    await render(<Harness onValue={(v) => values.push(v)} />);
    expect(values.at(-1)?.notices).toEqual([records[0]]);
    let settled = false;
    let pending!: Promise<void>;
    await act(async () => {
      pending = values
        .at(-1)!
        .dismiss('one')
        .then(() => {
          settled = true;
        });
    });
    expect(settled).toBe(false);
    await act(async () => {
      release();
      await pending;
    });
    expect(settled).toBe(true);
    expect(values.at(-1)?.notices).toEqual([records[1]]);
  });
});
