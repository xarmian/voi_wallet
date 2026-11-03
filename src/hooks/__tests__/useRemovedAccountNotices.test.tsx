import React from 'react';
import { act, render } from '@testing-library/react-native';
import { useRemovedAccountNotices } from '../useRemovedAccountNotices';
import { AccountSecureStorage } from '@/services/secure/AccountSecureStorage';

jest.mock('@/services/secure/AccountSecureStorage', () => ({
  AccountSecureStorage: {
    readUnexplainedRemovals: jest.fn(),
    clearUnexplainedRemoval: jest.fn(),
  },
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

describe('useRemovedAccountNotices', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (
      AccountSecureStorage.clearUnexplainedRemoval as jest.Mock
    ).mockResolvedValue(undefined);
  });
  it('shows one at a time and clears dismissed records', async () => {
    (
      AccountSecureStorage.readUnexplainedRemovals as jest.Mock
    ).mockResolvedValue(records);
    const values: ReturnType<typeof useRemovedAccountNotices>[] = [];
    const { rerender } = await render(
      <Harness onValue={(v) => values.push(v)} />
    );
    expect(values.at(-1)?.notices).toEqual([records[0]]);
    await act(async () => {
      values.at(-1)?.dismiss('one');
    });
    expect(AccountSecureStorage.clearUnexplainedRemoval).toHaveBeenCalledTimes(
      1
    );
    expect(AccountSecureStorage.clearUnexplainedRemoval).toHaveBeenCalledWith(
      'one'
    );
    expect(values.at(-1)?.notices).toEqual([records[1]]);
    rerender(<Harness onValue={(v) => values.push(v)} />);
  });
  it('returns empty when storage is empty or unreadable', async () => {
    const values: ReturnType<typeof useRemovedAccountNotices>[] = [];
    (
      AccountSecureStorage.readUnexplainedRemovals as jest.Mock
    ).mockResolvedValue([]);
    await render(<Harness onValue={(v) => values.push(v)} />);
    expect(values.at(-1)?.notices).toEqual([]);
  });
  it('returns empty and does not throw when the records are unreadable', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    (
      AccountSecureStorage.readUnexplainedRemovals as jest.Mock
    ).mockRejectedValue(new Error('bad'));
    const values: ReturnType<typeof useRemovedAccountNotices>[] = [];
    await render(<Harness onValue={(v) => values.push(v)} />);
    await act(async () => {});
    expect(AccountSecureStorage.readUnexplainedRemovals).toHaveBeenCalledTimes(
      1
    );
    expect(warn).toHaveBeenCalled();
    expect(values.at(-1)?.notices).toEqual([]);
    warn.mockRestore();
  });
  it('dismiss resolves only after the record is cleared', async () => {
    (
      AccountSecureStorage.readUnexplainedRemovals as jest.Mock
    ).mockResolvedValue(records.slice(0, 1));
    let release: () => void = () => {};
    (AccountSecureStorage.clearUnexplainedRemoval as jest.Mock).mockReturnValue(
      new Promise<void>((resolve) => (release = resolve))
    );
    const values: ReturnType<typeof useRemovedAccountNotices>[] = [];
    await render(<Harness onValue={(v) => values.push(v)} />);
    let settled = false;
    let pending: Promise<void> | undefined;
    await act(async () => {
      pending = values.at(-1)?.dismiss('one');
      void pending?.then(() => {
        settled = true;
      });
    });
    expect(settled).toBe(false);
    await act(async () => {
      release();
      await pending;
    });
    expect(settled).toBe(true);
  });
  it('keeps a dismissal local if storage clearing fails', async () => {
    (
      AccountSecureStorage.readUnexplainedRemovals as jest.Mock
    ).mockResolvedValue(records.slice(0, 1));
    (
      AccountSecureStorage.clearUnexplainedRemoval as jest.Mock
    ).mockRejectedValue(new Error('bad'));
    const values: ReturnType<typeof useRemovedAccountNotices>[] = [];
    await render(<Harness onValue={(v) => values.push(v)} />);
    await act(async () => {
      values.at(-1)?.dismiss('one');
    });
    expect(values.at(-1)?.notices).toEqual([]);
  });
});
