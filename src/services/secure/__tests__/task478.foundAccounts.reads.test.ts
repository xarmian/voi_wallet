// TASK-478: when a quarantined key is read. Boot, the unlock sweep and the
// found-accounts summary read none; the scan reads each key once, and only
// behind a fresh authentication. Real storage, wallet service and reconcile;
// only the platform is in memory.

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

import { AccountSecureStorage } from '@/services/secure/AccountSecureStorage';
import { FreshAuthError, withFreshAuth } from '@/services/secure/freshAuth';
import type { FreshAuthCapability } from '@/services/secure/freshAuth';
import { MultiAccountWalletService } from '@/services/wallet';
import {
  readFoundAccountsSummary,
  removeFoundAccount,
  scanFoundAccounts,
} from '../foundAccounts';
import {
  SECRET,
  addWatch,
  boot,
  installPrompter,
  pinDeviceWithTwoOrphans,
  readScanMap,
  resetAll,
  spyDecryptors,
  mockPlatform,
  unlock,
} from './fixtures/task478Helpers';

let unregister: (() => void) | undefined;
beforeEach(() => {
  resetAll();
  jest.restoreAllMocks();
});
afterEach(() => {
  unregister?.();
  unregister = undefined;
});

describe('TASK-478 found accounts: secret reads', () => {
  it('zero reads across boot, unlock sweep and summary', async () => {
    const { v2, formatA, result } = await pinDeviceWithTwoOrphans();
    expect(result.orphanSecretsQuarantined.sort()).toEqual(
      [v2.id, formatA.id].sort()
    );
    const reads = spyDecryptors();
    // A second boot and the unlock sweep, as on the next app launch.
    await boot();
    unlock();
    await AccountSecureStorage.migrateAllAccountsToV2();
    expect(reads.total()).toBe(0);
    const first = await readFoundAccountsSummary();
    const second = await readFoundAccountsSummary();
    expect(reads.total()).toBe(0);
    expect(first.presentCount).toBe(2);
    expect(second.presentCount).toBe(2);
    expect(first.unscannedIds.sort()).toEqual([v2.id, formatA.id].sort());
  });

  it.each([
    ['cancelled', false],
    ['failed', new Error('prompt broke')],
  ] as const)('zero reads when auth is %s', async (_label, answer) => {
    await pinDeviceWithTwoOrphans();
    const summary = await readFoundAccountsSummary();
    const reads = spyDecryptors();
    unregister = installPrompter(answer).unregister;
    await expect(
      withFreshAuth('scan_found_accounts', (cap) =>
        scanFoundAccounts(summary.unscannedIds, cap)
      )
    ).rejects.toBeInstanceOf(FreshAuthError);
    expect(reads.total()).toBe(0);
    expect(readScanMap()).toBeUndefined();
  });

  it('one read per secret after auth', async () => {
    const { v2, formatA } = await pinDeviceWithTwoOrphans();
    const formatACiphertext = JSON.parse(
      mockPlatform.__secure.get(SECRET(formatA.id))!
    ).encryptedPrivateKey;
    const summary = await readFoundAccountsSummary();
    const reads = spyDecryptors();
    unregister = installPrompter(true).unregister;
    await withFreshAuth('scan_found_accounts', (cap) =>
      scanFoundAccounts(summary.unscannedIds, cap)
    );
    expect(reads.spies.tryDecryptV2Blobs).toHaveBeenCalledTimes(1);
    expect(reads.spies.tryDecryptV2Blobs.mock.calls[0][0]).toBe(v2.id);
    expect(reads.spies.decryptPrivateKey).toHaveBeenCalledTimes(1);
    expect(reads.spies.decryptPrivateKey.mock.calls[0][0]).toBe(
      formatACiphertext
    );
    expect(reads.total()).toBe(2);
    expect(readScanMap()).toEqual({
      [v2.id]: { address: v2.address },
      [formatA.id]: { address: formatA.address },
    });

    const again = await readFoundAccountsSummary();
    expect(again.unscannedIds).toEqual([]);
    expect(
      again.rows
        .filter((row) => row.kind === 'ready')
        .map((row) => (row as { address: string }).address)
        .sort()
    ).toEqual([v2.address, formatA.address].sort());
    await withFreshAuth('scan_found_accounts', (cap) =>
      scanFoundAccounts(again.unscannedIds, cap)
    );
    expect(reads.total()).toBe(2);
  });

  it('capability is required', async () => {
    await pinDeviceWithTwoOrphans();
    const summary = await readFoundAccountsSummary();
    unregister = installPrompter(true).unregister;
    let stale: FreshAuthCapability | undefined;
    await withFreshAuth('scan_found_accounts', async (cap) => {
      stale = cap;
    });
    const reads = spyDecryptors();
    await expect(
      scanFoundAccounts(summary.unscannedIds, stale!)
    ).rejects.toBeInstanceOf(FreshAuthError);
    // A capability minted for another reason does not open the scan either.
    await expect(
      withFreshAuth('reveal_recovery_phrase', (cap) =>
        scanFoundAccounts(summary.unscannedIds, cap)
      )
    ).rejects.toBeInstanceOf(FreshAuthError);
    expect(reads.total()).toBe(0);
    expect(readScanMap()).toBeUndefined();
  });

  it('owned registry id is excluded and not removable', async () => {
    const { formatA } = await pinDeviceWithTwoOrphans();
    // A backup restore bound the quarantined id into the wallet in place.
    const watch = await addWatch(undefined, 'Bound');
    const raw = await MultiAccountWalletService.readWalletStrict();
    const wallet = { ...raw!, accounts: raw!.accounts.map((a) => ({ ...a })) };
    const bound = wallet.accounts.find((a) => a.id === watch.id)!;
    bound.id = formatA.id;
    bound.address = formatA.address;
    jest
      .spyOn(MultiAccountWalletService, 'readWalletStrict')
      .mockResolvedValue(wallet);

    const summary = await readFoundAccountsSummary();
    const ids = [
      ...summary.rows.flatMap((row) =>
        row.kind === 'ready' ? row.ids : [row.id]
      ),
      ...summary.unreadableIds,
    ];
    expect(ids).not.toContain(formatA.id);
    expect(summary.presentCount).toBe(1);

    unregister = installPrompter(true).unregister;
    await expect(
      withFreshAuth('remove_found_account', (cap) =>
        removeFoundAccount([formatA.id], cap)
      )
    ).rejects.toThrow();
    expect(typeof mockPlatform.__secure.get(SECRET(formatA.id))).toBe('string');
  });
});
