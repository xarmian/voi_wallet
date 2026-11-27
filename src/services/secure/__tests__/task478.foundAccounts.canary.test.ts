// TASK-478: no form of a found key's secret reaches a log, an error, a return
// value or a stored value (other than the key's own encrypted slot), across the
// scan, a refused restore, a failed restore, a restore and a remove.

jest.mock('@/platform', () =>
  require('./fixtures/task478Platform').createTask478Platform()
);
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async () => null),
    setItem: jest.fn(async () => {}),
    removeItem: jest.fn(async () => {}),
    multiRemove: jest.fn(async () => {}),
    multiSet: jest.fn(async () => {}),
    getAllKeys: jest.fn(async () => []),
  },
}));
jest.mock('@/store/walletStore', () => ({
  removePersistedBalanceCaches: jest.fn(async () => {}),
}));

import algosdk from 'algosdk';
import { MultiAccountWalletService } from '@/services/wallet';
import {
  readFoundAccountsSummary,
  removeFoundAccount,
  restoreFoundAccount,
  scanFoundAccounts,
} from '../foundAccounts';
import {
  CANARY_ADDRESS,
  CANARY_MNEMONIC,
  authed,
  boot,
  installPrompter,
  keyFromMnemonic,
  mockPlatform,
  pinDeviceWithTwoOrphans,
  resetAll,
  unlock,
  writeUnboundKey,
} from './fixtures/task478Helpers';

const sk = keyFromMnemonic(CANARY_MNEMONIC);
const words = CANARY_MNEMONIC.split(' ');
const forbidden = [
  CANARY_MNEMONIC,
  ...words
    .slice(0, words.length - 2)
    .map((_, i) => words.slice(i, i + 3).join(' ')),
  Buffer.from(sk).toString('hex'),
  Buffer.from(sk.slice(0, 32)).toString('hex'),
  Buffer.from(sk).toString('base64'),
  Buffer.from(sk.slice(0, 32)).toString('base64'),
  Array.from(sk).join(','),
];

function serialize(value: unknown): string {
  const text = JSON.stringify(value, (_key, v) => {
    if (v instanceof Uint8Array)
      return `${Buffer.from(v).toString('hex')}|${Array.from(v).join(',')}`;
    if (v instanceof Error) return `${v.name}:${v.message}:${v.stack}`;
    if (typeof v === 'bigint') return v.toString();
    return v;
  });
  return text ?? String(value);
}

it('no secret text anywhere', async () => {
  resetAll();
  const seen: string[] = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const)
    jest.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      seen.push(serialize(args));
    });
  const unregister = installPrompter(true).unregister;
  const run = async <T>(fn: () => Promise<T>) => {
    try {
      const value = await fn();
      seen.push(serialize(value));
      return value;
    } catch (error) {
      seen.push(serialize(error));
      return undefined;
    }
  };
  try {
    const { formatA } = await pinDeviceWithTwoOrphans({
      formatAMnemonic: CANARY_MNEMONIC,
    });
    expect(formatA.address).toBe(CANARY_ADDRESS);
    mockPlatform.__state.writes.length = 0;

    const summary = await run(() => readFoundAccountsSummary());
    await run(() =>
      authed('scan_found_accounts', (cap) =>
        scanFoundAccounts(summary!.unscannedIds, cap)
      )
    );
    await run(() => readFoundAccountsSummary());
    const restore = (address: string) =>
      run(() =>
        authed('restore_found_account', (cap) =>
          restoreFoundAccount(formatA.id, address, cap)
        )
      );
    // A refused restore (mismatch), a failed one, then a restore.
    await restore(algosdk.generateAccount().addr.toString());
    const add = jest
      .spyOn(
        MultiAccountWalletService as unknown as {
          addAccountToWallet: () => Promise<void>;
        },
        'addAccountToWallet'
      )
      .mockRejectedValueOnce(new Error('blob write failed'));
    await run(() => readFoundAccountsSummary());
    await run(() =>
      authed('scan_found_accounts', async (cap) => {
        const again = await readFoundAccountsSummary();
        await scanFoundAccounts(again.unscannedIds, cap);
      })
    );
    await restore(formatA.address);
    add.mockRestore();
    expect(await restore(formatA.address)).toEqual({
      kind: 'restored',
      address: CANARY_ADDRESS,
    });

    // The same key found again (left by another interrupted create), then removed.
    await writeUnboundKey('orphan-canary-2', CANARY_MNEMONIC);
    await boot();
    unlock();
    const later = await run(() => readFoundAccountsSummary());
    await run(() =>
      authed('scan_found_accounts', (cap) =>
        scanFoundAccounts(later!.unscannedIds, cap)
      )
    );
    const listed = await run(() => readFoundAccountsSummary());
    expect(listed?.rows.find((r) => r.id === 'orphan-canary-2')?.kind).toBe(
      'in-wallet'
    );
    await run(() =>
      authed('remove_found_account', (cap) =>
        removeFoundAccount(['orphan-canary-2'], cap)
      )
    );
    expect(
      mockPlatform.__secure.has('voi_account_secret_orphan-canary-2')
    ).toBe(false);
  } finally {
    unregister();
  }

  const stored = mockPlatform.__state.writes
    .filter(
      (w) => !(w.op === 'secure.set' && w.key.startsWith('voi_account_secret_'))
    )
    .map((w) => `${w.key}=${w.value ?? ''}`);
  const haystack = [...seen, ...stored];
  const leaks = forbidden.filter((needle) =>
    haystack.some((text) => text.includes(needle))
  );
  expect(leaks).toEqual([]);
  // The checks above saw real traffic.
  expect(stored.length).toBeGreaterThan(0);
});
