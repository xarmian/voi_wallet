// TASK-504 (product e7912207 item 3, dev lead ef933e70 conditions 1-3): restore
// of a record the file carries WITHOUT its key. A standard one is added as Watch
// Only; a rekeyed one as a key-less rekeyed record that keeps its rekey fields.
// Neither ever binds to an occupied slot (4.1 item 8); on the old-PIN screen,
// with every item-9 condition holding, either takes the surviving key it
// derives to and comes back as a working account of its real type. Real storage,
// wallet service and restorers; only the platform layer is faked.

jest.mock('@/platform', () => {
  const nodeCrypto = require('crypto');
  const secure = new Map<string, string>();
  const kv = new Map<string, string>();
  return {
    __secure: secure,
    __kv: kv,
    __reset: () => {
      secure.clear();
      kv.clear();
    },
    crypto: {
      getRandomBytes: async (n: number): Promise<Uint8Array> =>
        Uint8Array.from(nodeCrypto.randomBytes(n)),
      sha256: async (input: string): Promise<string> =>
        nodeCrypto.createHash('sha256').update(input).digest('hex'),
      randomUUID: () => nodeCrypto.randomUUID(),
    },
    secureStorage: {
      getItem: async (k: string) => (secure.has(k) ? secure.get(k)! : null),
      setItem: async (k: string, v: string) => {
        secure.set(k, v);
      },
      deleteItem: async (k: string) => {
        secure.delete(k);
      },
      getItemWithAuth: async (k: string) =>
        secure.has(k) ? secure.get(k)! : null,
    },
    storage: {
      getItem: async (k: string) => (kv.has(k) ? kv.get(k)! : null),
      setItem: async (k: string, v: string) => {
        kv.set(k, v);
      },
      removeItem: async (k: string) => {
        kv.delete(k);
      },
    },
    biometrics: {
      isAvailable: async () => false,
      isEnrolled: async () => false,
    },
    deviceId: { getDeviceId: async () => 'task504-device-idfv' },
  };
});

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
import * as platform from '@/platform';
import { AccountSecureStorage } from '@/services/secure/AccountSecureStorage';
import { SessionKeyVault } from '@/services/secure/SessionKeyVault';
import { MultiAccountWalletService } from '@/services/wallet';
import { AccountType } from '@/types/wallet';
import {
  planRestore,
  restoreAccounts,
  validateRetainedKeys,
} from '../restorers';
import type { BackupAccountData } from '../types';

const PIN = '123456';
const mockPlatform = platform as unknown as {
  __secure: Map<string, string>;
  __kv: Map<string, string>;
  __reset: () => void;
};

function keyed(id: string) {
  const kp = algosdk.generateAccount();
  const address = kp.addr.toString();
  return {
    id,
    address,
    publicKey: Buffer.from(algosdk.decodeAddress(address).publicKey).toString(
      'hex'
    ),
    type: AccountType.STANDARD,
    label: id,
    color: '#000000',
    isHidden: false,
    createdAt: new Date().toISOString(),
    mnemonic: algosdk.secretKeyToMnemonic(kp.sk),
    hasBackup: true,
  } as BackupAccountData;
}

/** The same account as the file carries it when its key could not be exported. */
function flagged(record: BackupAccountData): BackupAccountData {
  const { mnemonic: _drop, ...rest } = record;
  void _drop;
  return { ...rest, withoutKey: true } as BackupAccountData;
}

function flaggedRekeyed(id: string) {
  const base = flagged(keyed(id));
  return {
    ...base,
    type: AccountType.REKEYED,
    authAddress: algosdk.generateAccount().addr.toString(),
    originalOwner: true,
    canSign: false,
    rekeyedAt: '2026-10-01T00:00:00.000Z',
  } as unknown as BackupAccountData;
}

/** The type the secure store itself recorded for an account id (not the blob's). */
function storedType(id: string): string | undefined {
  const raw = mockPlatform.__kv.get(`voi_account_metadata_${id}`);
  return raw ? (JSON.parse(raw) as { type?: string }).type : undefined;
}

async function deviceAccounts() {
  const wallet = await MultiAccountWalletService.getCurrentWallet();
  return wallet?.accounts ?? [];
}

/** After a reinstall with the PIN credential kept: a PIN-wrapped orphan under
 *  orphan-1, no account list, and the vault filled as by a verified old PIN. */
async function oldPinDevice() {
  const orphan = keyed('orphan-1');
  await restoreAccounts([orphan]);
  await AccountSecureStorage.setupPin(PIN, 'pin');
  mockPlatform.__kv.clear();
  SessionKeyVault.set(PIN, 'pin');
  AccountSecureStorage.clearPrivateKeyCache();
  return orphan;
}
const ORPHAN_SLOT = 'voi_account_secret_orphan-1';

beforeEach(() => {
  mockPlatform.__reset();
  SessionKeyVault.clear();
  AccountSecureStorage.clearPrivateKeyCache();
  jest.restoreAllMocks();
});

describe('TASK-504: a flagged record is added without a key', () => {
  it('a flagged standard record is stored as Watch Only: its address is listed, no secret is written, and the result says so', async () => {
    const a = keyed('std-1');
    const result = await restoreAccounts([flagged(a)]);

    const [rec] = result.records;
    expect(rec.outcome).toBe('added');
    expect(rec.withoutKey).toBe('watch-only');
    const [stored] = await deviceAccounts();
    expect(stored.type).toBe(AccountType.WATCH);
    expect(stored.address).toBe(a.address);
    expect(stored.label).toBe('std-1');
    expect(storedType('std-1')).toBe('watch');
    expect(
      [...mockPlatform.__secure.keys()].filter((k) => k.includes('secret'))
    ).toEqual([]);
    expect(JSON.stringify([...mockPlatform.__kv.entries()])).not.toContain(
      a.mnemonic!
    );
  });

  it('a flagged rekeyed record is stored as a key-less rekeyed record that keeps its rekey fields', async () => {
    const r = flaggedRekeyed('rk-1');
    const result = await restoreAccounts([r]);

    expect(result.records[0].outcome).toBe('added');
    expect(result.records[0].withoutKey).toBe('rekeyed');
    const [stored] = await deviceAccounts();
    expect(stored.type).toBe(AccountType.REKEYED);
    expect((stored as { authAddress: string }).authAddress).toBe(r.authAddress);
    expect((stored as { rekeyedAt?: string }).rekeyedAt).toBe(r.rekeyedAt);
    expect((stored as { originalOwner?: boolean }).originalOwner).toBe(false);
    expect(storedType('rk-1')).toBe('rekeyed');
    expect(
      [...mockPlatform.__secure.keys()].filter((k) => k.includes('secret'))
    ).toEqual([]);
  });

  it('a mixed file restores onto a wallet that already has accounts: keyed ones keep their keys, flagged ones are added without', async () => {
    const existing = keyed('have-1');
    await restoreAccounts([existing]);
    const k = keyed('std-k');
    const f = flagged(keyed('std-f'));

    const result = await restoreAccounts([k, f]);

    expect(result.records.map((x) => x.outcome)).toEqual(['added', 'added']);
    const byId = new Map((await deviceAccounts()).map((a) => [a.address, a]));
    expect(byId.get(k.address)?.type).toBe(AccountType.STANDARD);
    expect(byId.get(f.address)?.type).toBe(AccountType.WATCH);
    expect(byId.get(existing.address)?.type).toBe(AccountType.STANDARD);
    const key = await AccountSecureStorage.getPrivateKey('std-k');
    expect(Buffer.from(key.slice(32)).toString('hex')).toBe(k.publicKey);
  });

  it('an address already on the device is reported as it is today and no slot is read for the flagged record', async () => {
    const a = keyed('dup');
    await restoreAccounts([a]);
    const inspect = jest.spyOn(AccountSecureStorage, 'inspectSecretSlot');

    const result = await restoreAccounts([flagged({ ...a, id: 'dup-file' })]);

    expect(result.records[0].outcome).toBe('kept-device-record');
    expect(result.records[0].withoutKey).toBeUndefined();
    expect(inspect).not.toHaveBeenCalled();
    expect(await deviceAccounts()).toHaveLength(1);
  });
});

describe('TASK-504: the validators let a flagged record through and nothing else', () => {
  it('a flagged standard record needs no phrase (restorers.ts:101); an unflagged one still does', () => {
    expect(() => validateRetainedKeys([flagged(keyed('a'))])).not.toThrow();
    const noPhrase = { ...keyed('b'), mnemonic: undefined };
    expect(() => validateRetainedKeys([noPhrase])).toThrow(/recovery phrase/);
  });

  it('a flagged record that carries a phrase is refused', () => {
    expect(() =>
      validateRetainedKeys([{ ...keyed('a'), withoutKey: true }])
    ).toThrow();
  });

  it('planRestore does not count a flagged record as carrying a key even if it somehow also carries a phrase', () => {
    const odd = { ...keyed('a'), withoutKey: true } as BackupAccountData;
    expect(planRestore([odd]).addableWithKey).toBe(0);
  });

  it('planRestore never counts a flagged record as carrying a key', () => {
    const plan = planRestore([
      flagged(keyed('a')),
      flaggedRekeyed('b'),
      keyed('c'),
    ]);
    expect(plan.total).toBe(3);
    expect(plan.addable).toBe(3);
    expect(plan.addableWithKey).toBe(1);
    expect(
      planRestore([flagged(keyed('a')), flaggedRekeyed('b')]).addableWithKey
    ).toBe(0);
  });
});

describe('TASK-504 4.1 items 8 and 9 on a flagged record', () => {
  it('item 8: a flagged standard record never binds to an occupied slot: a fresh id, Watch Only, the orphan byte-identical', async () => {
    const orphan = await oldPinDevice();
    const slotBefore = mockPlatform.__secure.get(ORPHAN_SLOT);

    // No old-PIN session: the unlocked-wallet path.
    const result = await restoreAccounts([
      flagged({ ...orphan, id: 'orphan-1' }),
    ]);

    expect(result.records[0].outcome).toBe('added-new-id');
    expect(result.records[0].withoutKey).toBe('watch-only');
    // Stored as Watch Only under a fresh id, and counted as Watch Only.
    expect([result.standard, result.watch]).toEqual([0, 1]);
    const accounts = await deviceAccounts();
    expect(accounts.map((a) => a.id)).not.toContain('orphan-1');
    expect(accounts[0].type).toBe(AccountType.WATCH);
    expect(storedType(accounts[0].id)).toBe('watch');
    expect(mockPlatform.__secure.get(ORPHAN_SLOT)).toBe(slotBefore);
  });

  it('item 8: the same for a flagged rekeyed record', async () => {
    const orphan = await oldPinDevice();
    const slotBefore = mockPlatform.__secure.get(ORPHAN_SLOT);
    const r = {
      ...flaggedRekeyed('orphan-1'),
      address: orphan.address,
      publicKey: orphan.publicKey,
    };

    const result = await restoreAccounts([r]);

    expect(result.records[0].outcome).toBe('added-new-id');
    expect(result.records[0].withoutKey).toBe('rekeyed');
    expect((await deviceAccounts()).map((a) => a.id)).not.toContain('orphan-1');
    expect(mockPlatform.__secure.get(ORPHAN_SLOT)).toBe(slotBefore);
  });

  it('item 9: on the old-PIN screen a flagged standard record binds to its surviving key and comes back as a working standard account', async () => {
    const orphan = await oldPinDevice();
    const slotBefore = mockPlatform.__secure.get(ORPHAN_SLOT);
    const epoch = SessionKeyVault.currentEpoch();

    const result = await restoreAccounts([flagged(orphan)], {
      oldPinSession: { epoch },
    });

    expect(result.records[0].outcome).toBe('added-in-place');
    expect(result.records[0].withoutKey).toBeUndefined();
    const [stored] = await deviceAccounts();
    expect(stored.id).toBe('orphan-1');
    expect(stored.type).toBe(AccountType.STANDARD);
    // It came back as the working standard account it was, and is counted so.
    expect([result.standard, result.watch]).toEqual([1, 0]);
    expect(storedType('orphan-1')).toBe('standard');
    expect(mockPlatform.__secure.get(ORPHAN_SLOT)).toBe(slotBefore);
    const key = await AccountSecureStorage.getPrivateKey('orphan-1');
    expect(Buffer.from(key.slice(32)).toString('hex')).toBe(orphan.publicKey);
  });

  it('item 9: a flagged rekeyed record binds the same way and keeps its real type', async () => {
    const orphan = await oldPinDevice();
    const epoch = SessionKeyVault.currentEpoch();
    const r = {
      ...flaggedRekeyed('orphan-1'),
      address: orphan.address,
      publicKey: orphan.publicKey,
    };

    const result = await restoreAccounts([r], { oldPinSession: { epoch } });

    expect(result.records[0].outcome).toBe('added-in-place');
    const [stored] = await deviceAccounts();
    expect(stored.id).toBe('orphan-1');
    expect(stored.type).toBe(AccountType.REKEYED);
  });

  it('item 9 refused: the surviving key derives to another address: a fresh id, Watch Only, the slot untouched', async () => {
    await oldPinDevice();
    const other = keyed('x');
    const slotBefore = mockPlatform.__secure.get(ORPHAN_SLOT);

    const result = await restoreAccounts(
      [flagged({ ...other, id: 'orphan-1' })],
      { oldPinSession: { epoch: SessionKeyVault.currentEpoch() } }
    );

    expect(result.records[0].outcome).toBe('added-new-id');
    expect((await deviceAccounts())[0].type).toBe(AccountType.WATCH);
    expect(storedType((await deviceAccounts())[0].id)).toBe('watch');
    expect(mockPlatform.__secure.get(ORPHAN_SLOT)).toBe(slotBefore);
  });

  it('item 9 refused: the vault epoch moved: the restore stops, nothing written', async () => {
    const orphan = await oldPinDevice();
    const epoch = SessionKeyVault.currentEpoch();
    SessionKeyVault.set(PIN, 'pin');
    const before = [...mockPlatform.__secure.entries()].sort();

    await expect(
      restoreAccounts([flagged(orphan)], { oldPinSession: { epoch } })
    ).rejects.toMatchObject({ code: 'AUTHENTICATION_REQUIRED' });

    expect([...mockPlatform.__secure.entries()].sort()).toEqual(before);
    expect(await deviceAccounts()).toEqual([]);
  });

  it('item 9 refused: no old-PIN session on an unlocked wallet with accounts: never binds', async () => {
    const orphan = await oldPinDevice();
    await restoreAccounts([keyed('have-1')]); // the wallet has an account now
    const slotBefore = mockPlatform.__secure.get(ORPHAN_SLOT);

    const result = await restoreAccounts([flagged(orphan)]);

    expect(result.records[0].outcome).toBe('added-new-id');
    expect(mockPlatform.__secure.get(ORPHAN_SLOT)).toBe(slotBefore);
  });
});

describe('TASK-504: a flagged standard record still competes at its address (hunter r4 A P2-1)', () => {
  /** A Ledger record at the same address as `base`. */
  function ledgerAt(
    base: BackupAccountData,
    id = 'ledger-1'
  ): BackupAccountData {
    return {
      id,
      address: base.address,
      publicKey: base.publicKey,
      type: AccountType.LEDGER,
      label: 'ledger',
      color: '#000000',
      isHidden: false,
      createdAt: new Date().toISOString(),
      deviceId: 'ledger-1',
      derivationIndex: 0,
      ledgerDerivationPath: "44'/283'/0'/0/0",
    } as unknown as BackupAccountData;
  }

  it('a Ledger record at the same address beats a flagged standard record that comes first: the signing-capable record is kept', async () => {
    const a = keyed('s-1');
    const result = await restoreAccounts([flagged(a), ledgerAt(a)]);

    expect(result.duplicatesDropped).toBe(1);
    expect(result.records.map((r) => [r.id, r.outcome])).toEqual([
      ['ledger-1', 'added'],
    ]);
    const stored = await deviceAccounts();
    expect(stored).toHaveLength(1);
    expect(stored[0].type).toBe(AccountType.LEDGER);
    expect(result.records[0].withoutKey).toBeUndefined();
  });

  it('a keyed record at the same address beats a flagged standard record that comes first: the key is kept', async () => {
    const a = keyed('s-1');
    const result = await restoreAccounts([
      flagged(a),
      { ...a, id: 's-2' } as BackupAccountData,
    ]);

    expect(result.duplicatesDropped).toBe(1);
    const stored = await deviceAccounts();
    expect(stored).toHaveLength(1);
    expect(stored[0].type).toBe(AccountType.STANDARD);
    const key = await AccountSecureStorage.getPrivateKey('s-2');
    expect(Buffer.from(key.slice(32)).toString('hex')).toBe(a.publicKey);
  });

  it('two flagged records at one address merge into one account (as two watch records would)', async () => {
    const a = keyed('s-1');
    const result = await restoreAccounts([
      flagged(a),
      flagged({ ...a, id: 's-2' } as BackupAccountData),
    ]);
    expect(result.duplicatesDropped).toBe(1);
    expect(await deviceAccounts()).toHaveLength(1);
  });

  it('a flagged record that the blob merge skips is reported as the device record it lost to, never as added without a key', async () => {
    const a = keyed('s-1');
    jest
      .spyOn(MultiAccountWalletService, 'mergeRestoredAccounts')
      .mockResolvedValue({
        hadAccounts: false,
        skipped: [{ id: 's-1', reason: 'address' }],
      } as never);

    const result = await restoreAccounts([flagged(a)]);

    expect(result.records[0].outcome).toBe('kept-device-record');
    expect(result.records[0].withoutKey).toBeUndefined();
  });

  it('the counts: a flagged standard record is a Watch Only account, not a standard one', async () => {
    const result = await restoreAccounts([keyed('k'), flagged(keyed('f'))]);
    expect(result.standard).toBe(1);
    expect(result.watch).toBe(1);
    expect(result.total).toBe(2);
  });
});
