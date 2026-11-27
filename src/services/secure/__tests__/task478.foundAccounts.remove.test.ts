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
} from '@/services/secure/AccountSecureStorage';
import { FreshAuthError } from '@/services/secure/freshAuth';
import { MultiAccountWalletService } from '@/services/wallet';
import { AccountType } from '@/types/wallet';
import { UNKNOWN_WRITES_STORAGE_KEY } from '@/services/secure/boundedWrites';
import {
  readFoundAccountsSummary,
  removeFoundAccount,
  scanFoundAccounts,
} from '../foundAccounts';
import {
  CANARY_ADDRESS,
  CANARY_MNEMONIC,
  LEGACY,
  PIN,
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
  if (summary.unscannedIds.length > 0)
    await authed('scan_found_accounts', (cap) =>
      scanFoundAccounts(summary.unscannedIds, cap)
    );
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

    const summary = await readFoundAccountsSummary();
    const row = summary.rows.find((r) => r.id === formatA.id);
    expect(row).toMatchObject({ kind: 'in-wallet', walletHasKey: false });

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

    const reads = spyDecryptors();
    const summary = await readFoundAccountsSummary();
    // The wallet-key check is the presence probe: no key is opened.
    expect(reads.total()).toBe(0);
    const row = summary.rows.find((r) => r.id === formatA.id);
    expect(row).toMatchObject({ kind: 'in-wallet', walletHasKey: true });

    await remove(formatA.id);
    expect(mockPlatform.__secure.has(SECRET(formatA.id))).toBe(false);
    expect(readRegistry()).not.toContain(formatA.id);
    expect(typeof mockPlatform.__secure.get(SECRET(account.id))).toBe('string');
  });
});
