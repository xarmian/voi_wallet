// TASK-478: removing a quarantined key from this device. Behind a fresh
// authentication; refused while a storage write for the slot is unresolved.

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

import {
  AccountSecureStorage,
  FoundAccountOnlyCopyError,
  FoundAccountUncheckedError,
  FoundAccountWalletKeyUncheckedError,
} from '@/services/secure/AccountSecureStorage';
import { SessionKeyVault } from '@/services/secure/SessionKeyVault';
import { FreshAuthError } from '@/services/secure/freshAuth';
import { MultiAccountWalletService } from '@/services/wallet';
import { AccountType } from '@/types/wallet';
import { UNKNOWN_WRITES_STORAGE_KEY } from '@/services/secure/boundedWrites';
import {
  actionableOf,
  readFoundAccountsSummary,
  removeFoundAccount,
  scanFoundAccounts,
} from '../foundAccounts';
import { idsNeedingScan, walletHoldsOwnKey } from '../foundAccountsCount';
import { NetworkService } from '@/services/network';
import {
  CANARY_ADDRESS,
  CANARY_MNEMONIC,
  LEGACY,
  PIN,
  SCAN_KEY,
  SECRET,
  SEEN_KEY,
  addWatch,
  authed,
  boot,
  installPrompter,
  mockPlatform,
  pinDeviceWithTwoOrphans,
  readRegistry,
  readScanMap,
  resetAll,
  spyDecryptors,
  unlock,
  writeUnboundKey,
} from './fixtures/task478Helpers';

let unregister: (() => void) | undefined;
beforeEach(() => {
  resetAll();
  jest.restoreAllMocks();
  (
    global as typeof globalThis & { __voiProcessSessionId?: string }
  ).__voiProcessSessionId = 'task478-process';
});
afterEach(() => {
  unregister?.();
  unregister = undefined;
});

const remove = (...ids: string[]) =>
  authed('remove_found_account', (cap) => removeFoundAccount(ids, cap));

async function scanAll() {
  const summary = await readFoundAccountsSummary();
  const ids = idsNeedingScan(summary);
  if (ids.length > 0)
    await authed('scan_found_accounts', (cap) => scanFoundAccounts(ids, cap));
}

describe('TASK-478 remove a found key', () => {
  it('remove behind auth', async () => {
    const { formatA } = await pinDeviceWithTwoOrphans();
    const cancel = installPrompter(false);
    await expect(remove(formatA.id)).rejects.toBeInstanceOf(FreshAuthError);
    cancel.unregister();
    expect(typeof mockPlatform.__secure.get(SECRET(formatA.id))).toBe('string');
    expect(readRegistry()).toContain(formatA.id);

    unregister = installPrompter(true).unregister;
    const summary = await readFoundAccountsSummary();
    await authed('scan_found_accounts', (cap) =>
      scanFoundAccounts(summary.unscannedIds, cap)
    );
    await AccountSecureStorage.markFoundNoticeSeen([formatA.id]);
    expect(readScanMap()).toHaveProperty(formatA.id);

    await remove(formatA.id);
    expect(mockPlatform.__secure.has(SECRET(formatA.id))).toBe(false);
    expect(mockPlatform.__secure.has(LEGACY(formatA.id))).toBe(false);
    expect(readRegistry()).not.toContain(formatA.id);
    expect(readScanMap() ?? {}).not.toHaveProperty(formatA.id);
    expect(JSON.parse(mockPlatform.__kv.get(SEEN_KEY) ?? '[]')).not.toContain(
      formatA.id
    );
    expect((await readFoundAccountsSummary()).presentCount).toBe(1);
  });

  it('remove refuses an unresolved write', async () => {
    const { formatA } = await pinDeviceWithTwoOrphans();
    mockPlatform.__kv.set(
      UNKNOWN_WRITES_STORAGE_KEY,
      JSON.stringify({
        [SECRET(formatA.id)]: {
          key: SECRET(formatA.id),
          op: 'set',
          verifier: 'nonce',
          attempt: 'a1',
          sessionId: 'an-earlier-process',
          at: 1,
        },
      })
    );
    unregister = installPrompter(true).unregister;
    await expect(remove(formatA.id)).rejects.toThrow(/unresolved/);
    expect(typeof mockPlatform.__secure.get(SECRET(formatA.id))).toBe('string');
    expect(readRegistry()).toContain(formatA.id);
  });

  it('a key with no checked address is refused and kept', async () => {
    const { formatA } = await pinDeviceWithTwoOrphans();
    unregister = installPrompter(true).unregister;
    // Not scanned: no address names what the delete would erase, so the
    // wallet-account check cannot run. The key stays.
    expect(readScanMap() ?? {}).not.toHaveProperty(formatA.id);
    await expect(remove(formatA.id)).rejects.toBeInstanceOf(
      FoundAccountUncheckedError
    );
    expect(typeof mockPlatform.__secure.get(SECRET(formatA.id))).toBe('string');
    expect(readRegistry()).toContain(formatA.id);
  });

  it('an id that is not in the found list is refused', async () => {
    await pinDeviceWithTwoOrphans();
    unregister = installPrompter(true).unregister;
    await expect(remove('not-quarantined')).rejects.toThrow(
      /no longer in the found list/
    );
  });

  it('a ready row with two copies removes both', async () => {
    await addWatch();
    await AccountSecureStorage.setupPin(PIN, 'pin');
    unlock();
    const first = await writeUnboundKey('copy-1', CANARY_MNEMONIC);
    const second = await writeUnboundKey('copy-2', CANARY_MNEMONIC);
    await boot();
    unlock();
    unregister = installPrompter(true).unregister;
    await scanAll();
    const row = (await readFoundAccountsSummary()).rows.find(
      (r) => r.kind === 'ready' && r.address === CANARY_ADDRESS
    );
    expect(row?.kind === 'ready' && row.ids.sort()).toEqual(
      [first.id, second.id].sort()
    );

    await remove(...(row as { ids: string[] }).ids);
    expect(mockPlatform.__secure.has(SECRET(first.id))).toBe(false);
    expect(mockPlatform.__secure.has(SECRET(second.id))).toBe(false);
    expect(readRegistry()).toEqual([]);
    const after = await readFoundAccountsSummary();
    expect(after.rows).toEqual([]);
    expect(after.presentCount).toBe(0);
  });
});

describe('TASK-478 remove keeps the only usable copy', () => {
  it('a rekeyed original-owner account with an empty slot keeps the found key', async () => {
    const { formatA } = await pinDeviceWithTwoOrphans();
    unregister = installPrompter(true).unregister;
    await scanAll();
    const raw = await MultiAccountWalletService.readWalletStrict();
    // The wallet lists the address as REKEYED with originalOwner, but its own
    // slot holds no key: the found copy is the only one on this device.
    const wallet = {
      ...raw!,
      accounts: [
        ...raw!.accounts,
        {
          id: 'rekeyed-empty',
          address: formatA.address,
          publicKey: '',
          type: AccountType.REKEYED,
          label: 'Rekeyed',
          color: '#000000',
          isHidden: false,
          createdAt: new Date().toISOString(),
          authAddress: raw!.accounts[0].address,
          originalOwner: true,
          canSign: false,
        },
      ],
    };
    jest
      .spyOn(MultiAccountWalletService, 'readWalletStrict')
      .mockResolvedValue(wallet as never);
    const before = mockPlatform.__secure.get(SECRET(formatA.id));

    // Listed before the scan with no verdict; the scan finds the slot empty.
    await scanAll();
    const summary = await readFoundAccountsSummary();
    const row = summary.rows.find((r) => r.id === formatA.id);
    expect(row).toMatchObject({ kind: 'in-wallet', walletKeyUsable: false });

    await expect(remove(formatA.id)).rejects.toBeInstanceOf(
      FoundAccountOnlyCopyError
    );
    expect(mockPlatform.__secure.get(SECRET(formatA.id))).toBe(before);
    expect(readRegistry()).toContain(formatA.id);
  });

  it('a standard account whose slot holds the key lets the found copy go', async () => {
    const { formatA } = await pinDeviceWithTwoOrphans({
      formatAMnemonic: CANARY_MNEMONIC,
    });
    unregister = installPrompter(true).unregister;
    await scanAll();
    const account = await MultiAccountWalletService.importStandardAccount({
      type: AccountType.STANDARD,
      mnemonic: CANARY_MNEMONIC,
      label: 'Imported',
    });
    expect(account.address).toBe(CANARY_ADDRESS);

    // The scan after the import records the verdict; the summary then opens
    // no key.
    await scanAll();
    const reads = spyDecryptors();
    const summary = await readFoundAccountsSummary();
    expect(reads.total()).toBe(0);
    const row = summary.rows.find((r) => r.id === formatA.id);
    expect(row).toMatchObject({ kind: 'in-wallet', walletKeyUsable: true });

    await remove(formatA.id);
    expect(mockPlatform.__secure.has(SECRET(formatA.id))).toBe(false);
    expect(readRegistry()).not.toContain(formatA.id);
    expect(typeof mockPlatform.__secure.get(SECRET(account.id))).toBe('string');
  });

  it("a locked vault can't check the wallet account's key: refused, kept", async () => {
    const { formatA } = await pinDeviceWithTwoOrphans({
      formatAMnemonic: CANARY_MNEMONIC,
    });
    unregister = installPrompter(true).unregister;
    await scanAll();
    await MultiAccountWalletService.importStandardAccount({
      type: AccountType.STANDARD,
      mnemonic: CANARY_MNEMONIC,
      label: 'Imported',
    });
    const before = mockPlatform.__secure.get(SECRET(formatA.id));
    // Auto-lock fires while the remove prompt is open; a PIN is set.
    SessionKeyVault.clear();

    await expect(remove(formatA.id)).rejects.toBeInstanceOf(
      FoundAccountWalletKeyUncheckedError
    );
    expect(mockPlatform.__secure.get(SECRET(formatA.id))).toBe(before);
    expect(readRegistry()).toContain(formatA.id);
  });

  it('an unlocked vault with a corrupt wallet slot: the found key is the only usable copy, kept', async () => {
    const { formatA } = await pinDeviceWithTwoOrphans({
      formatAMnemonic: CANARY_MNEMONIC,
    });
    unregister = installPrompter(true).unregister;
    await scanAll();
    const account = await MultiAccountWalletService.importStandardAccount({
      type: AccountType.STANDARD,
      mnemonic: CANARY_MNEMONIC,
      label: 'Imported',
    });
    // The wallet account's own slot holds something that doesn't open;
    // unlocking can't change that, so this isn't an "unlock and retry" case.
    mockPlatform.__secure.set(SECRET(account.id), '{"not":"a key"}');
    const before = mockPlatform.__secure.get(SECRET(formatA.id));

    await expect(remove(formatA.id)).rejects.toBeInstanceOf(
      FoundAccountOnlyCopyError
    );
    expect(mockPlatform.__secure.get(SECRET(formatA.id))).toBe(before);
    expect(readRegistry()).toContain(formatA.id);
  });
});

describe('TASK-478 the delete guard corrects a stale verdict', () => {
  it('a stale true verdict over a broken wallet slot is refused, then counted', async () => {
    const { formatA } = await pinDeviceWithTwoOrphans({
      formatAMnemonic: CANARY_MNEMONIC,
    });
    unregister = installPrompter(true).unregister;
    const account = await MultiAccountWalletService.importStandardAccount({
      type: AccountType.STANDARD,
      mnemonic: CANARY_MNEMONIC,
      label: 'Imported',
    });
    await scanAll();
    const stale = await readFoundAccountsSummary();
    expect(stale.rows.find((r) => r.id === formatA.id)).toMatchObject({
      kind: 'in-wallet',
      walletKeyUsable: true,
    });
    expect(actionableOf(stale).ids).not.toContain(formatA.id);
    // The wallet account's slot breaks after the scan.
    mockPlatform.__secure.set(SECRET(account.id), '{"not":"a key"}');
    const before = mockPlatform.__secure.get(SECRET(formatA.id));

    await expect(remove(formatA.id)).rejects.toBeInstanceOf(
      FoundAccountOnlyCopyError
    );
    expect(mockPlatform.__secure.get(SECRET(formatA.id))).toBe(before);
    expect(readScanMap()?.[formatA.id]).toEqual({
      address: CANARY_ADDRESS,
      wallet: { ownerId: account.id, keyUsable: false },
    });
    const after = await readFoundAccountsSummary();
    expect(after.rows.find((r) => r.id === formatA.id)).toMatchObject({
      kind: 'in-wallet',
      walletKeyUsable: false,
    });
    expect(actionableOf(after).ids).toContain(formatA.id);
  });

  it('a failed verdict write still refuses with the only-copy error', async () => {
    const { formatA } = await pinDeviceWithTwoOrphans({
      formatAMnemonic: CANARY_MNEMONIC,
    });
    unregister = installPrompter(true).unregister;
    const account = await MultiAccountWalletService.importStandardAccount({
      type: AccountType.STANDARD,
      mnemonic: CANARY_MNEMONIC,
      label: 'Imported',
    });
    await scanAll();
    mockPlatform.__secure.set(SECRET(account.id), '{"not":"a key"}');
    const before = mockPlatform.__secure.get(SECRET(formatA.id));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockPlatform.__state.fault = (op, key) =>
      op === 'kv.set' && key === SCAN_KEY ? 'reject' : undefined;
    await expect(remove(formatA.id)).rejects.toBeInstanceOf(
      FoundAccountOnlyCopyError
    );
    mockPlatform.__state.fault = undefined;
    expect(warn).toHaveBeenCalled();
    expect(readRegistry()).toContain(formatA.id);
    expect(mockPlatform.__secure.get(SECRET(formatA.id))).toBe(before);
  });

  it.each([AccountType.WATCH, AccountType.LEDGER, AccountType.REMOTE_SIGNER])(
    'a %s owner is refused before any slot read',
    async (type) => {
      const { formatA } = await pinDeviceWithTwoOrphans();
      unregister = installPrompter(true).unregister;
      await scanAll();
      const scanBefore = readScanMap();
      const inspect = jest.spyOn(AccountSecureStorage, 'inspectSecretSlot');
      const reads = spyDecryptors();
      await expect(
        AccountSecureStorage.deleteQuarantinedOrphan(formatA.id, [
          { id: 'owner-no-key', address: formatA.address, type },
        ])
      ).rejects.toBeInstanceOf(FoundAccountOnlyCopyError);
      expect(inspect).not.toHaveBeenCalled();
      expect(reads.total()).toBe(0);
      // Nothing recorded either: the type alone decides.
      expect(readScanMap()).toEqual(scanBefore);
      expect(typeof mockPlatform.__secure.get(SECRET(formatA.id))).toBe(
        'string'
      );
      expect(readRegistry()).toContain(formatA.id);
    }
  );
});

/** Two found copies of CANARY_ADDRESS and the STANDARD wallet account for it. */
async function twoCopiesInWallet() {
  await addWatch();
  await AccountSecureStorage.setupPin(PIN, 'pin');
  unlock();
  const q1 = await writeUnboundKey('copy-1', CANARY_MNEMONIC);
  const q2 = await writeUnboundKey('copy-2', CANARY_MNEMONIC);
  await boot();
  unlock();
  unregister = installPrompter(true).unregister;
  const account = await MultiAccountWalletService.importStandardAccount({
    type: AccountType.STANDARD,
    mnemonic: CANARY_MNEMONIC,
    label: 'Imported',
  });
  await scanAll();
  const holds = { ownerId: account.id, keyUsable: true };
  expect(readScanMap()).toEqual({
    [q1.id]: { address: CANARY_ADDRESS, wallet: holds },
    [q2.id]: { address: CANARY_ADDRESS, wallet: holds },
  });
  return { q1, q2, account };
}

describe('TASK-478 copies of one address share one verdict', () => {
  it('a refused Remove on one copy marks every copy as the only usable key', async () => {
    const { q1, q2, account } = await twoCopiesInWallet();
    mockPlatform.__secure.set(SECRET(account.id), '{"not":"a key"}');
    await expect(remove(q1.id)).rejects.toBeInstanceOf(
      FoundAccountOnlyCopyError
    );
    const onlyCopy = { ownerId: account.id, keyUsable: false };
    expect(readScanMap()).toEqual({
      [q1.id]: { address: CANARY_ADDRESS, wallet: onlyCopy },
      [q2.id]: { address: CANARY_ADDRESS, wallet: onlyCopy },
    });
    const summary = await readFoundAccountsSummary();
    for (const id of [q1.id, q2.id])
      expect(summary.rows.find((r) => r.id === id)).toMatchObject({
        kind: 'in-wallet',
        walletKeyUsable: false,
      });
    expect(actionableOf(summary).ids.sort()).toEqual([q1.id, q2.id].sort());
  });

  it("a scan of one copy updates the other copy's verdict", async () => {
    const { q1, q2, account } = await twoCopiesInWallet();
    mockPlatform.__secure.set(SECRET(account.id), '{"not":"a key"}');
    await authed('scan_found_accounts', (cap) =>
      scanFoundAccounts([q2.id], cap)
    );
    const onlyCopy = { ownerId: account.id, keyUsable: false };
    expect(readScanMap()).toEqual({
      [q1.id]: { address: CANARY_ADDRESS, wallet: onlyCopy },
      [q2.id]: { address: CANARY_ADDRESS, wallet: onlyCopy },
    });
  });

  it('a scan of one copy that learns nothing clears the other copy too', async () => {
    const { q1, q2 } = await twoCopiesInWallet();
    jest
      .spyOn(
        AccountSecureStorage as unknown as {
          inspectSlotUnderOneVaultState: () => Promise<unknown>;
        },
        'inspectSlotUnderOneVaultState'
      )
      .mockResolvedValueOnce({ state: 'occupied-unreadable', vault: 'locked' });
    await authed('scan_found_accounts', (cap) =>
      scanFoundAccounts([q2.id], cap)
    );
    expect(readScanMap()).toEqual({
      [q1.id]: { address: CANARY_ADDRESS },
      [q2.id]: { address: CANARY_ADDRESS },
    });
    expect(idsNeedingScan(await readFoundAccountsSummary()).sort()).toEqual(
      [q1.id, q2.id].sort()
    );
  });
});

describe("TASK-478 deleting a wallet account's slot clears verdicts naming it", () => {
  async function canaryInWalletScanned() {
    const { formatA } = await pinDeviceWithTwoOrphans({
      formatAMnemonic: CANARY_MNEMONIC,
    });
    unregister = installPrompter(true).unregister;
    const account = await MultiAccountWalletService.importStandardAccount({
      type: AccountType.STANDARD,
      mnemonic: CANARY_MNEMONIC,
      label: 'Imported',
    });
    await scanAll();
    expect(readScanMap()?.[formatA.id]).toEqual({
      address: CANARY_ADDRESS,
      wallet: { ownerId: account.id, keyUsable: true },
    });
    return { formatA, account };
  }

  it('converting the owner to a remote signer: the found key is no duplicate, and counts', async () => {
    const { formatA, account } = await canaryInWalletScanned();
    // The custody check asks the network whether the account is rekeyed.
    jest.spyOn(NetworkService, 'getInstance').mockReturnValue({
      getAccountRekeyInfo: async () => ({ isRekeyed: false }),
    } as never);
    await MultiAccountWalletService.convertStandardToRemoteSigner(
      account.id,
      'signer-device'
    );
    const converted =
      (await MultiAccountWalletService.readWalletStrict())!.accounts.find(
        (a) => a.id === account.id
      );
    expect(converted?.type).toBe(AccountType.REMOTE_SIGNER);
    expect(mockPlatform.__secure.has(SECRET(account.id))).toBe(false);
    expect(readScanMap()?.[formatA.id]).toEqual({ address: CANARY_ADDRESS });

    const summary = await readFoundAccountsSummary();
    const row = summary.rows.find((r) => r.id === formatA.id);
    expect(row).toMatchObject({
      kind: 'in-wallet',
      walletType: AccountType.REMOTE_SIGNER,
    });
    expect(row && row.kind === 'in-wallet' && walletHoldsOwnKey(row)).toBe(
      false
    );
    expect(actionableOf(summary).ids).toContain(formatA.id);
    // A remote signer can't hold the key: nothing to scan for it.
    expect(idsNeedingScan(summary)).not.toContain(formatA.id);
  });

  it('deleteAccount of a STANDARD owner still in the wallet: the verdict is cleared and the id queued', async () => {
    const { formatA, account } = await canaryInWalletScanned();
    const listed = await MultiAccountWalletService.readWalletStrict();
    await AccountSecureStorage.deleteAccount(account.id);
    expect(mockPlatform.__secure.has(SECRET(account.id))).toBe(false);
    // The wallet record still names the account, as STANDARD.
    jest
      .spyOn(MultiAccountWalletService, 'readWalletStrict')
      .mockResolvedValue(listed as never);
    expect(readScanMap()?.[formatA.id]).toEqual({ address: CANARY_ADDRESS });
    const summary = await readFoundAccountsSummary();
    const row = summary.rows.find((r) => r.id === formatA.id);
    expect(row).toMatchObject({
      kind: 'in-wallet',
      walletType: AccountType.STANDARD,
    });
    expect(row).not.toHaveProperty('walletKeyUsable');
    expect(actionableOf(summary).ids).toContain(formatA.id);
    expect(idsNeedingScan(summary)).toContain(formatA.id);
  });
});
