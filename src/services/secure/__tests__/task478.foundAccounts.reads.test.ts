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

import algosdk from 'algosdk';
import { AccountSecureStorage } from '@/services/secure/AccountSecureStorage';
import { FreshAuthError, withFreshAuth } from '@/services/secure/freshAuth';
import type { FreshAuthCapability } from '@/services/secure/freshAuth';
import { MultiAccountWalletService } from '@/services/wallet';
import { AccountType } from '@/types/wallet';
import {
  readFoundAccountsSummary,
  removeFoundAccount,
  scanFoundAccounts,
} from '../foundAccounts';
import { idsNeedingScan } from '../foundAccountsCount';
import {
  CANARY_ADDRESS,
  CANARY_MNEMONIC,
  PIN,
  SCAN_KEY,
  SECRET,
  addWatch,
  authed,
  boot,
  installPrompter,
  pinDeviceWithTwoOrphans,
  readScanMap,
  resetAll,
  spyDecryptors,
  mockPlatform,
  unlock,
  writeUnboundKey,
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

/** The side-effect-free slot reader the scan and the delete guard use. */
const spyInspect = () =>
  jest.spyOn(
    AccountSecureStorage as unknown as {
      inspectSlotUnderOneVaultState: (
        id: string,
        address: string
      ) => Promise<{ state: string; vault: string }>;
    },
    'inspectSlotUnderOneVaultState'
  );

const scanAll = async () => {
  const summary = await readFoundAccountsSummary();
  await authed('scan_found_accounts', (cap) =>
    scanFoundAccounts(idsNeedingScan(summary), cap)
  );
};

/** formatA derives to CANARY_ADDRESS, which a STANDARD wallet account holds. */
async function canaryInWallet() {
  const { v2, formatA } = await pinDeviceWithTwoOrphans({
    formatAMnemonic: CANARY_MNEMONIC,
  });
  unregister = installPrompter(true).unregister;
  const account = await MultiAccountWalletService.importStandardAccount({
    type: AccountType.STANDARD,
    mnemonic: CANARY_MNEMONIC,
    label: 'Imported',
  });
  expect(account.address).toBe(CANARY_ADDRESS);
  return { v2, formatA, account };
}

/** The wallet as stored, with `edit` applied to a copy, served to every read. */
async function serveWallet(
  edit: (accounts: Record<string, unknown>[]) => Record<string, unknown>[]
) {
  const raw = await MultiAccountWalletService.readWalletStrict();
  const wallet = {
    ...raw!,
    accounts: edit(raw!.accounts.map((a) => ({ ...a }))),
  };
  jest
    .spyOn(MultiAccountWalletService, 'readWalletStrict')
    .mockResolvedValue(wallet as never);
}

describe("TASK-478 the wallet account's own key: one post-auth verdict", () => {
  it("the summary reads no wallet account's slot", async () => {
    const { formatA, account } = await canaryInWallet();
    await scanAll();
    const watch = (await MultiAccountWalletService.readWalletStrict())!
      .accounts[0];
    const probe = jest.spyOn(AccountSecureStorage, 'probeSecretPresenceStrict');
    const inspect = spyInspect();
    const slot = jest.spyOn(AccountSecureStorage, 'inspectSecretSlot');
    const reads = spyDecryptors();
    const summary = await readFoundAccountsSummary();
    expect(summary.rows.find((r) => r.id === formatA.id)?.kind).toBe(
      'in-wallet'
    );
    const walletIds = [account.id, watch.id];
    expect(probe.mock.calls.filter(([id]) => walletIds.includes(id))).toEqual(
      []
    );
    expect(inspect).not.toHaveBeenCalled();
    expect(slot).not.toHaveBeenCalled();
    expect(reads.total()).toBe(0);
  });

  it('the scan inspects each matching STANDARD account once, and no other', async () => {
    const { v2, formatA, account } = await canaryInWallet();
    const inspect = spyInspect();
    await scanAll();
    expect(inspect.mock.calls).toEqual([[account.id, CANARY_ADDRESS]]);
    expect(readScanMap()).toEqual({
      [v2.id]: { address: v2.address },
      [formatA.id]: {
        address: CANARY_ADDRESS,
        wallet: { ownerId: account.id, keyUsable: true },
      },
    });
    const row = (await readFoundAccountsSummary()).rows.find(
      (r) => r.id === formatA.id
    );
    expect(row).toMatchObject({ kind: 'in-wallet', walletKeyUsable: true });
  });

  it('two found keys for one owner give one inspect', async () => {
    await addWatch();
    await AccountSecureStorage.setupPin(PIN, 'pin');
    unlock();
    const first = await writeUnboundKey('copy-1', CANARY_MNEMONIC);
    const second = await writeUnboundKey('copy-2', CANARY_MNEMONIC);
    await boot();
    unlock();
    unregister = installPrompter(true).unregister;
    const account = await MultiAccountWalletService.importStandardAccount({
      type: AccountType.STANDARD,
      mnemonic: CANARY_MNEMONIC,
      label: 'Imported',
    });
    const inspect = spyInspect();
    await scanAll();
    expect(inspect).toHaveBeenCalledTimes(1);
    const verdict = { ownerId: account.id, keyUsable: true };
    expect(readScanMap()).toEqual({
      [first.id]: { address: CANARY_ADDRESS, wallet: verdict },
      [second.id]: { address: CANARY_ADDRESS, wallet: verdict },
    });
  });

  it.each([AccountType.WATCH, AccountType.LEDGER, AccountType.REMOTE_SIGNER])(
    'a %s owner records keyUsable false with no slot read',
    async (type) => {
      const { formatA } = await pinDeviceWithTwoOrphans();
      unregister = installPrompter(true).unregister;
      await serveWallet((accounts) => [
        ...accounts,
        {
          ...accounts[0],
          id: 'owner-no-key',
          address: formatA.address,
          type,
          label: 'Owner',
        },
      ]);
      const inspect = spyInspect();
      const slot = jest.spyOn(AccountSecureStorage, 'inspectSecretSlot');
      await scanAll();
      expect(inspect).not.toHaveBeenCalled();
      expect(slot).not.toHaveBeenCalled();
      expect(readScanMap()?.[formatA.id]).toEqual({
        address: formatA.address,
        wallet: { ownerId: 'owner-no-key', keyUsable: false },
      });
    }
  );

  it('a corrupt wallet slot or a different key records false', async () => {
    const { formatA, account } = await canaryInWallet();
    mockPlatform.__secure.set(SECRET(account.id), '{"not":"a key"}');
    await scanAll();
    expect(readScanMap()?.[formatA.id]).toEqual({
      address: CANARY_ADDRESS,
      wallet: { ownerId: account.id, keyUsable: false },
    });

    // A wallet account whose slot opens to some other key.
    const other = await MultiAccountWalletService.importStandardAccount({
      type: AccountType.STANDARD,
      mnemonic: algosdk.secretKeyToMnemonic(algosdk.generateAccount().sk),
      label: 'Other',
    });
    await serveWallet((accounts) =>
      accounts
        .filter((a) => a.id !== account.id)
        .map((a) => (a.id === other.id ? { ...a, address: CANARY_ADDRESS } : a))
    );
    await scanAll();
    expect(readScanMap()?.[formatA.id]).toEqual({
      address: CANARY_ADDRESS,
      wallet: { ownerId: other.id, keyUsable: false },
    });
  });

  it('a locked vault at the inspect records no verdict', async () => {
    const { formatA } = await canaryInWallet();
    spyInspect().mockResolvedValueOnce({
      state: 'occupied-unreadable',
      vault: 'locked',
    });
    await scanAll();
    expect(readScanMap()?.[formatA.id]).toEqual({ address: CANARY_ADDRESS });
    const summary = await readFoundAccountsSummary();
    const row = summary.rows.find((r) => r.id === formatA.id);
    expect(row).toMatchObject({ kind: 'in-wallet' });
    expect(row).not.toHaveProperty('walletKeyUsable');
    expect(idsNeedingScan(summary)).toContain(formatA.id);
  });

  it('an inspect that throws stops the scan and keeps what was read', async () => {
    const { formatA } = await canaryInWallet();
    spyInspect().mockRejectedValueOnce(new Error('inspect failed'));
    const summary = await readFoundAccountsSummary();
    await expect(
      authed('scan_found_accounts', (cap) =>
        scanFoundAccounts(idsNeedingScan(summary), cap)
      )
    ).rejects.toThrow('inspect failed');
    expect(readScanMap()?.[formatA.id]).toEqual({ address: CANARY_ADDRESS });
  });

  it('a verdict for another owner id reads as missing', async () => {
    const { formatA } = await canaryInWallet();
    mockPlatform.__kv.set(
      SCAN_KEY,
      JSON.stringify({
        [formatA.id]: {
          address: CANARY_ADDRESS,
          wallet: { ownerId: 'someone-else', keyUsable: true },
        },
      })
    );
    const summary = await readFoundAccountsSummary();
    const row = summary.rows.find((r) => r.id === formatA.id);
    expect(row).toMatchObject({ kind: 'in-wallet' });
    expect(row).not.toHaveProperty('walletKeyUsable');
  });

  it('a malformed verdict is dropped and the address kept', async () => {
    const { v2, formatA } = await pinDeviceWithTwoOrphans();
    mockPlatform.__kv.set(
      SCAN_KEY,
      JSON.stringify({
        [v2.id]: {
          address: v2.address,
          wallet: { ownerId: 'owner', keyUsable: true },
        },
        [formatA.id]: {
          address: formatA.address,
          wallet: { ownerId: '', keyUsable: 'yes' },
        },
      })
    );
    const index = await AccountSecureStorage.readQuarantineIndex(new Set());
    const scanOf = (id: string) => index.find((row) => row.id === id)?.scan;
    expect(scanOf(v2.id)).toEqual({
      address: v2.address,
      wallet: { ownerId: 'owner', keyUsable: true },
    });
    expect(scanOf(formatA.id)).toEqual({ address: formatA.address });
    for (const wallet of [
      { ownerId: 'owner' },
      { ownerId: 7, keyUsable: false },
      'yes',
      null,
    ]) {
      mockPlatform.__kv.set(
        SCAN_KEY,
        JSON.stringify({ [formatA.id]: { address: formatA.address, wallet } })
      );
      const again = await AccountSecureStorage.readQuarantineIndex(new Set());
      expect(again.find((row) => row.id === formatA.id)?.scan).toEqual({
        address: formatA.address,
      });
    }
  });
});
