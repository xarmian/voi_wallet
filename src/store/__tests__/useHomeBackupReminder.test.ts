import { act, renderHook } from '@testing-library/react-native';
import { AccountType, AccountMetadata, Wallet } from '@/types/wallet';
import { AccountSecureStorage } from '@/services/secure/AccountSecureStorage';
import { networkRekeyStatus } from '@/services/wallet/networkRekeyStatus';
import { useWalletStore } from '../walletStore';
import { useHomeBackupReminder } from '../useHomeBackupReminder';

const mockLookup = jest.fn();
jest.mock('@/services/network', () => ({
  NetworkService: {
    getInstance: (network: string) => ({
      getAccountRekeyInfo: (address: string) => mockLookup(address, network),
    }),
  },
}));
jest.mock('@/services/secure/AccountSecureStorage', () => ({
  AccountSecureStorage: { probeSecretPresenceStrict: jest.fn() },
}));
jest.mock('../walletStore', () => ({
  useWalletStore: require('zustand').create(() => ({ wallet: null })),
}));
jest.mock('../networkStore', () => ({
  useNetworkStore: require('zustand/vanilla').createStore(() => ({
    availableNetworks: ['voi-mainnet', 'algorand-mainnet'],
  })),
}));
const probe = jest.mocked(AccountSecureStorage.probeSecretPresenceStrict);
const account = (id: string, type = AccountType.REKEYED, extra = {}) =>
  ({ id, address: id, type, ...extra }) as AccountMetadata;
function select(active: AccountMetadata, others: AccountMetadata[] = []) {
  useWalletStore.setState({
    wallet: {
      activeAccountId: active.id,
      accounts: [active, ...others],
    } as Wallet,
  });
}
const paint = () =>
  act(async () => {
    await jest.advanceTimersByTimeAsync(20);
  });
beforeEach(() => {
  jest.useFakeTimers();
  networkRekeyStatus.invalidate();
  mockLookup.mockReset().mockResolvedValue({ isRekeyed: false });
  probe.mockReset().mockResolvedValue(true);
});
afterEach(() => {
  networkRekeyStatus.invalidate();
  jest.useRealTimers();
});

it.each([
  ['standard unverified', AccountType.STANDARD, {}, 'present', 'self', true],
  [
    'standard verified',
    AccountType.STANDARD,
    { backupVerified: true },
    'present',
    'self',
    false,
  ],
  [
    'original owner',
    AccountType.REKEYED,
    { originalOwner: true },
    'absent',
    'self',
    true,
  ],
  [
    'rekeyed verified',
    AccountType.REKEYED,
    { backupVerified: true },
    'present',
    'self',
    false,
  ],
  [
    'probe present',
    AccountType.REKEYED,
    { canSign: false },
    'present',
    'self',
    true,
  ],
  [
    'probe absent despite signer',
    AccountType.REKEYED,
    { canSign: true },
    'absent',
    'self',
    false,
  ],
  ['probe error', AccountType.REKEYED, {}, 'error', 'self', true],
  [
    'delegated key holder',
    AccountType.REKEYED,
    { originalOwner: true },
    'present',
    'delegated',
    false,
  ],
  [
    'delegated standard',
    AccountType.STANDARD,
    {},
    'present',
    'delegated',
    false,
  ],
  ['one network unknown', AccountType.REKEYED, {}, 'present', 'unknown', true],
  ['ledger', AccountType.LEDGER, {}, 'present', 'self', false],
  ['watch', AccountType.WATCH, {}, 'present', 'self', false],
  ['remote signer', AccountType.REMOTE_SIGNER, {}, 'present', 'self', false],
] as const)('%s', async (_name, type, extra, presence, network, expected) => {
  select(account('ACTIVE', type, extra), [account('INACTIVE')]);
  if (presence === 'error')
    probe.mockRejectedValue(new Error('vault unavailable'));
  else probe.mockResolvedValue(presence === 'present');
  mockLookup.mockImplementation(async (_address, net) => {
    if (network === 'unknown' && net === 'algorand-mainnet')
      throw new Error('offline');
    return { isRekeyed: network !== 'self', authAddress: 'OTHER' };
  });
  const { result, unmount } = await renderHook(useHomeBackupReminder);
  expect(probe).not.toHaveBeenCalled();
  expect(mockLookup).not.toHaveBeenCalled();
  await paint();
  expect(result.current).toBe(expected);
  expect(probe.mock.calls.every(([id]) => id === 'ACTIVE')).toBe(true);
  expect(mockLookup.mock.calls.every(([address]) => address === 'ACTIVE')).toBe(
    true
  );
  if (type !== AccountType.REKEYED || 'originalOwner' in extra) {
    expect(probe).not.toHaveBeenCalled();
  }
  await unmount();
});

it('ignores an old absent probe while the new active account is unresolved', async () => {
  let finish!: (present: boolean) => void;
  probe
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    )
    .mockImplementationOnce(() => new Promise(() => {}));
  select(account('A'));
  const { result, unmount } = await renderHook(useHomeBackupReminder);
  expect(result.current).toBe(true);
  await paint();
  await act(() => select(account('B'), [account('A')]));
  expect(result.current).toBe(true);
  await paint();
  await act(() => finish(false));
  expect(result.current).toBe(true);
  expect(probe.mock.calls.map(([id]) => id)).toEqual(['A', 'B']);
  expect(mockLookup.mock.calls.map(([address]) => address)).toEqual([
    'A',
    'A',
    'B',
    'B',
  ]);
  await unmount();
});

it('does not reuse a resolved absent result or probe on unrelated wallet updates', async () => {
  select(account('A'));
  probe.mockResolvedValue(false);
  const { result, unmount } = await renderHook(useHomeBackupReminder);
  await paint();
  expect(result.current).toBe(false);
  await act(() =>
    select(account('A'), [account('INACTIVE', AccountType.STANDARD)])
  );
  await paint();
  expect(probe).toHaveBeenCalledTimes(1);
  probe.mockImplementation(() => new Promise(() => {}));
  await act(() => select(account('B')));
  expect(result.current).toBe(true);
  await unmount();
});

it('cancels both scheduled operations if active account changes before paint', async () => {
  select(account('A'));
  const { unmount } = await renderHook(useHomeBackupReminder);
  await act(() => select(account('B')));
  await paint();
  expect(probe.mock.calls.map(([id]) => id)).toEqual(['B']);
  expect(mockLookup.mock.calls.map(([address]) => address)).toEqual(['B', 'B']);
  await unmount();
});

it.each([
  [
    'verified standard',
    account('A', AccountType.STANDARD, { backupVerified: true }),
  ],
  [
    'verified rekeyed',
    account('A', AccountType.REKEYED, { backupVerified: true }),
  ],
  ['watch', account('A', AccountType.WATCH)],
  ['ledger', account('A', AccountType.LEDGER)],
])('does no probe or network work for a %s account', async (_n, active) => {
  select(active);
  const { result, unmount } = await renderHook(useHomeBackupReminder);
  await paint();
  expect(result.current).toBe(false);
  expect(probe).not.toHaveBeenCalled();
  expect(mockLookup).not.toHaveBeenCalled();
  await unmount();
});

it('shows nothing and does no work before the wallet loads', async () => {
  useWalletStore.setState({ wallet: null });
  const { result, unmount } = await renderHook(useHomeBackupReminder);
  await paint();
  expect(result.current).toBe(false);
  expect(probe).not.toHaveBeenCalled();
  expect(mockLookup).not.toHaveBeenCalled();
  await unmount();
});

it('never adopts an old probe of A after an A -> B -> A switch', async () => {
  const finishers: ((present: boolean) => void)[] = [];
  probe.mockImplementation(
    () =>
      new Promise((resolve) => {
        finishers.push(resolve);
      })
  );
  select(account('A'));
  const { result, unmount } = await renderHook(useHomeBackupReminder);
  await paint();
  await act(() => select(account('B'), [account('A')]));
  await paint();
  await act(() => select(account('A'), [account('B')]));
  await paint();
  expect(probe.mock.calls.map(([id]) => id)).toEqual(['A', 'B', 'A']);
  // The FIRST A probe resolves absent; only the current A probe may decide.
  await act(() => finishers[0](false));
  expect(result.current).toBe(true);
  await act(() => finishers[2](false));
  expect(result.current).toBe(false);
  await unmount();
});

it('ignores a probe that completes after unmount', async () => {
  let finish!: (present: boolean) => void;
  probe.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
  select(account('A'));
  const { unmount } = await renderHook(useHomeBackupReminder);
  await paint();
  await unmount();
  await act(() => finish(false));
  expect(spy).not.toHaveBeenCalled();
  spy.mockRestore();
});
