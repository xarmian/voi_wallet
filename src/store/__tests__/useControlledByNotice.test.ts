import { act, renderHook } from '@testing-library/react-native';
import { AccountType, AccountMetadata, Wallet } from '@/types/wallet';
import { AccountSecureStorage } from '@/services/secure/AccountSecureStorage';
import { networkRekeyStatus } from '@/services/wallet/networkRekeyStatus';
import { useWalletStore } from '../walletStore';
import { useControlledByNotice } from '../useControlledByNotice';

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
const account = (id: string, type = AccountType.STANDARD, extra = {}) =>
  ({ id, address: id, type, ...extra }) as AccountMetadata;
function select(active = 'ACTIVE', auth = account('AUTH')) {
  useWalletStore.setState({
    wallet: {
      activeAccountId: active,
      accounts: [
        account('ACTIVE', AccountType.REKEYED, { backupVerified: true }),
        account('OTHER'),
        auth,
        account('SIGNER'),
      ],
    } as Wallet,
  });
}
const paint = () =>
  act(async () => {
    await jest.advanceTimersByTimeAsync(40);
  });
beforeEach(() => {
  jest.useFakeTimers();
  networkRekeyStatus.invalidate();
  mockLookup
    .mockReset()
    .mockResolvedValue({ isRekeyed: true, authAddress: 'AUTH' });
  probe.mockReset().mockResolvedValue(true);
});
afterEach(() => {
  networkRekeyStatus.invalidate();
  jest.useRealTimers();
});

it.each([
  ['standard', AccountType.STANDARD, {}, 'present', true],
  [
    'invalid verification',
    AccountType.STANDARD,
    { backupVerified: 'true' },
    'present',
    true,
  ],
  [
    'original owner',
    AccountType.REKEYED,
    { originalOwner: true },
    'absent',
    true,
  ],
  ['strict presence', AccountType.REKEYED, {}, 'present', true],
  [
    'verified',
    AccountType.STANDARD,
    { backupVerified: true },
    'present',
    false,
  ],
  ['ledger', AccountType.LEDGER, {}, 'present', false],
  ['watch', AccountType.WATCH, {}, 'present', false],
  ['remote signer', AccountType.REMOTE_SIGNER, {}, 'present', false],
  ['absent', AccountType.REKEYED, {}, 'absent', false],
  ['error', AccountType.REKEYED, {}, 'error', false],
  ['pending', AccountType.REKEYED, {}, 'pending', false],
] as const)(
  '%s auth custody and its OWN verification',
  async (_n, type, extra, presence, expected) => {
    select('ACTIVE', account('AUTH', type, extra));
    if (presence === 'error') probe.mockRejectedValue(new Error('locked'));
    else if (presence === 'pending')
      probe.mockImplementation(() => new Promise(() => {}));
    else probe.mockResolvedValue(presence === 'present');
    const { result, unmount } = await renderHook(useControlledByNotice);
    expect(result.current).toEqual([]);
    expect(probe).not.toHaveBeenCalled();
    expect(mockLookup).not.toHaveBeenCalled();
    await paint();
    expect(result.current.map((n) => n.address)).toEqual(
      expected ? ['AUTH'] : []
    );
    expect(mockLookup.mock.calls.every(([a]) => a === 'ACTIVE')).toBe(true);
    expect(probe.mock.calls.every(([id]) => id === 'AUTH')).toBe(true);
    await unmount();
  }
);

it.each(['unknown', 'self', 'missing'] as const)(
  'hides for %s',
  async (status) => {
    select('ACTIVE', account(status === 'missing' ? 'ABSENT' : 'AUTH'));
    if (status !== 'missing')
      mockLookup.mockResolvedValue({
        isRekeyed: status === 'unknown',
        authAddress: 'AUTH',
        unavailable: status === 'unknown',
      });
    const { result, unmount } = await renderHook(useControlledByNotice);
    await paint();
    expect(result.current).toEqual([]);
    await unmount();
  }
);

it('dedupes the same auth and labels disagreeing networks, never following auth rekeys', async () => {
  select(
    'ACTIVE',
    account('AUTH', AccountType.REKEYED, {
      originalOwner: true,
      authAddress: 'SIGNER',
    })
  );
  const { result, unmount } = await renderHook(useControlledByNotice);
  await paint();
  expect(result.current).toEqual([
    {
      address: 'AUTH',
      networks: ['voi-mainnet', 'algorand-mainnet'],
      showNetworks: false,
    },
  ]);
  await act(() => {
    mockLookup.mockImplementation(async (_a, net) => ({
      isRekeyed: true,
      authAddress: net === 'voi-mainnet' ? 'AUTH' : 'SIGNER',
    }));
    networkRekeyStatus.invalidate();
  });
  await paint();
  expect(result.current.map((n) => [n.address, n.showNetworks])).toEqual([
    ['AUTH', true],
    ['SIGNER', true],
  ]);
  expect(mockLookup.mock.calls.every(([a]) => a === 'ACTIVE')).toBe(true);
  await unmount();
});

it('does not use the unverified active flag for a verified auth account', async () => {
  select(
    'OTHER',
    account('AUTH', AccountType.STANDARD, { backupVerified: true })
  );
  const { result, unmount } = await renderHook(useControlledByNotice);
  await paint();
  expect(result.current).toEqual([]);
  await unmount();
});

it('ignores stale probes through A -> B -> A and after unmount', async () => {
  const finishers: ((present: boolean) => void)[] = [];
  probe.mockImplementation(
    () =>
      new Promise((resolve) => {
        finishers.push(resolve);
      })
  );
  select('ACTIVE', account('AUTH', AccountType.REKEYED));
  const { result, unmount } = await renderHook(useControlledByNotice);
  await paint();
  await act(() => select('OTHER', account('AUTH', AccountType.REKEYED)));
  await paint();
  await act(() => select('ACTIVE', account('AUTH', AccountType.REKEYED)));
  await paint();
  await act(() => {
    finishers[0](true);
    finishers[1](true);
  });
  expect(result.current).toEqual([]);
  await act(() => finishers[2](true));
  expect(result.current.map((n) => n.address)).toEqual(['AUTH']);
  await act(() => select('OTHER', account('AUTH', AccountType.REKEYED)));
  await paint();
  await unmount();
  await act(() => finishers[3](true));
});

it('retains auth projections on unrelated wallet edits and cancels before paint', async () => {
  select('ACTIVE', account('AUTH', AccountType.REKEYED));
  const { unmount } = await renderHook(useControlledByNotice);
  await paint();
  await act(() => select('ACTIVE', account('AUTH', AccountType.REKEYED)));
  await paint();
  expect(probe).toHaveBeenCalledTimes(1);
  await unmount();
  probe.mockClear();
  const next = await renderHook(useControlledByNotice);
  await next.unmount();
  await paint();
  expect(probe).not.toHaveBeenCalled();
});

it('keeps a probe result when a status refresh briefly drops the controller', async () => {
  select('ACTIVE', account('AUTH', AccountType.REKEYED));
  const { result, unmount } = await renderHook(useControlledByNotice);
  await paint();
  await paint();
  expect(result.current.map((n) => n.address)).toEqual(['AUTH']);
  expect(probe).toHaveBeenCalledTimes(1);
  // A cache expiry: statuses read UNKNOWN until the refetch lands.
  await act(async () => networkRekeyStatus.invalidate());
  expect(result.current).toEqual([]);
  await paint();
  await paint();
  expect(result.current.map((n) => n.address)).toEqual(['AUTH']);
  expect(probe).toHaveBeenCalledTimes(1);
  await unmount();
});

it('collects probes that resolve in reverse order', async () => {
  useWalletStore.setState({
    wallet: {
      activeAccountId: 'ACTIVE',
      accounts: [
        account('ACTIVE', AccountType.REKEYED, { backupVerified: true }),
        account('AUTH', AccountType.REKEYED),
        account('AUTH2', AccountType.REKEYED),
      ],
    } as Wallet,
  });
  mockLookup.mockImplementation(async (_address, network) => ({
    isRekeyed: true,
    authAddress: network === 'voi-mainnet' ? 'AUTH' : 'AUTH2',
  }));
  const finish: Record<string, (present: boolean) => void> = {};
  probe.mockImplementation(
    (id: string) =>
      new Promise((resolve) => {
        finish[id] = resolve;
      })
  );
  const { result, unmount } = await renderHook(useControlledByNotice);
  await paint();
  await paint();
  expect(Object.keys(finish).sort()).toEqual(['AUTH', 'AUTH2']);
  await act(async () => finish.AUTH2(true));
  expect(result.current.map((n) => n.address)).toEqual(['AUTH2']);
  await act(async () => finish.AUTH(true));
  expect(result.current.map((n) => n.address).sort()).toEqual([
    'AUTH',
    'AUTH2',
  ]);
  await unmount();
});

it('a late rejection from an earlier A never unblocks a duplicate probe of the current A', async () => {
  const pending: { id: string; reject: (e: Error) => void }[] = [];
  probe.mockImplementation(
    (id: string) =>
      new Promise((_resolve, reject) => {
        pending.push({ id, reject });
      })
  );
  select('ACTIVE', account('AUTH', AccountType.REKEYED));
  const { unmount } = await renderHook(useControlledByNotice);
  await paint();
  await paint();
  expect(probe).toHaveBeenCalledTimes(1);
  // A -> B -> A: the first A probe is still pending; the new A starts its own.
  await act(async () => select('OTHER', account('AUTH', AccountType.REKEYED)));
  await paint();
  await act(async () => select('ACTIVE', account('AUTH', AccountType.REKEYED)));
  await paint();
  await paint();
  const calls = probe.mock.calls.length;
  // The OLD probe rejects late, then the controller briefly drops and returns.
  await act(async () => pending[0].reject(new Error('late')));
  await act(async () => networkRekeyStatus.invalidate());
  await paint();
  await paint();
  // The new A probe is still in flight, so no duplicate read starts.
  expect(probe).toHaveBeenCalledTimes(calls);
  await unmount();
});
