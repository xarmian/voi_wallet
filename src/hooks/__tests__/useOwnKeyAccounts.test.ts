/**
 * TASK-425 U2: useOwnKeyAccounts is null only before its first answer, keeps
 * the last answer (limited to present accounts) while re-probing, and re-probes
 * when the account set changes or the screen regains focus.
 */
import { act, renderHook } from '@testing-library/react-native';
import { AccountMetadata, AccountType } from '@/types/wallet';

let mockFocused = true;
jest.mock('@react-navigation/native', () => ({
  useIsFocused: () => mockFocused,
}));
jest.mock('@/services/wallet/ownKeyCustody', () => ({
  filterOwnKeyAccounts: jest.fn(),
}));

import { useOwnKeyAccounts } from '../useOwnKeyAccounts';

const acc = (id: string, type = AccountType.REKEYED) =>
  ({ id, type, address: `ADDR_${id}` }) as unknown as AccountMetadata;

/** A filter whose answers the test releases one at a time. */
function controlledFilter() {
  const pending: ((ids: string[]) => void)[] = [];
  const filter = jest.fn(
    (accounts: readonly AccountMetadata[]) =>
      new Promise<AccountMetadata[]>((resolve) => {
        pending.push((ids) =>
          resolve(accounts.filter((a) => ids.includes(a.id)))
        );
      })
  );
  const answer = async (ids: string[]) => {
    await act(async () => {
      pending.shift()!(ids);
    });
  };
  return { filter, answer };
}

const ids = (result: AccountMetadata[] | null) =>
  result === null ? null : result.map((a) => a.id);

beforeEach(() => {
  mockFocused = true;
});

describe('useOwnKeyAccounts', () => {
  it('is null until the first probe answers', async () => {
    const { filter, answer } = controlledFilter();
    const accounts = [acc('a'), acc('b')];
    const { result } = await renderHook(() =>
      useOwnKeyAccounts(accounts, filter)
    );
    expect(result.current).toBeNull();
    await answer(['a']);
    expect(ids(result.current)).toEqual(['a']);
  });

  it('keeps the last answer while re-probing, minus removed accounts', async () => {
    const { filter, answer } = controlledFilter();
    let accounts = [acc('a'), acc('b')];
    const { result, rerender } = await renderHook(() =>
      useOwnKeyAccounts(accounts, filter)
    );
    await answer(['a', 'b']);

    // b is removed and c added: no tear-down, b drops at once, c waits.
    accounts = [acc('a'), acc('c')];
    await rerender({});
    expect(filter).toHaveBeenCalledTimes(2);
    expect(ids(result.current)).toEqual(['a']);

    await answer(['a', 'c']);
    expect(ids(result.current)).toEqual(['a', 'c']);
  });

  it('re-probes when the screen regains focus', async () => {
    const { filter, answer } = controlledFilter();
    const accounts = [acc('a')];
    const { result, rerender } = await renderHook(() =>
      useOwnKeyAccounts(accounts, filter)
    );
    await answer(['a']);

    mockFocused = false;
    await rerender({});
    expect(filter).toHaveBeenCalledTimes(1);

    // The secret went away while the screen was in the background.
    mockFocused = true;
    await rerender({});
    expect(filter).toHaveBeenCalledTimes(2);
    await answer([]);
    expect(ids(result.current)).toEqual([]);
  });

  it('does not re-probe on a store tick that changes no id or type', async () => {
    const { filter, answer } = controlledFilter();
    let accounts = [acc('a')];
    const { result, rerender } = await renderHook(() =>
      useOwnKeyAccounts(accounts, filter)
    );
    await answer(['a']);

    accounts = [{ ...acc('a'), label: 'renamed' } as AccountMetadata];
    await rerender({});
    expect(filter).toHaveBeenCalledTimes(1);
    expect(result.current?.[0]).toMatchObject({ label: 'renamed' });
  });
});
