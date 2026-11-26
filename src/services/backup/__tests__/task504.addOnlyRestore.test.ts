// TASK-504: restore is add-only. Real AccountSecureStorage + wallet service +
// restoreAccounts; only platform storage is in memory. Keys are generated
// in-process; nothing is committed.

jest.mock('@/platform', () => {
  const nodeCrypto = require('crypto');
  const secure = new Map<string, string>();
  const kv = new Map<string, string>();
  const flags = { deviceIdFailuresLeft: 0 };
  return {
    __secure: secure,
    __kv: kv,
    __flags: flags,
    __reset: () => {
      secure.clear();
      kv.clear();
      flags.deviceIdFailuresLeft = 0;
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
    deviceId: {
      getDeviceId: async () => {
        if (flags.deviceIdFailuresLeft > 0) {
          flags.deviceIdFailuresLeft -= 1;
          throw new Error('keychain read failed');
        }
        return 'task504-device-idfv';
      },
    },
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
import { AccountType, ResetRacedError } from '@/types/wallet';
import { restoreAccounts } from '../restorers';
import type { BackupAccountData } from '../types';

const PIN = '123456';
const SECRET = 'voi_account_secret_';
const mockPlatform = platform as unknown as {
  __secure: Map<string, string>;
  __kv: Map<string, string>;
  __flags: { deviceIdFailuresLeft: number };
  __reset: () => void;
};

function keyed(id: string, label = id) {
  const kp = algosdk.generateAccount();
  const address = kp.addr.toString();
  const record = {
    id,
    address,
    publicKey: Buffer.from(algosdk.decodeAddress(address).publicKey).toString(
      'hex'
    ),
    type: AccountType.STANDARD,
    label,
    color: '#000000',
    isHidden: false,
    createdAt: new Date().toISOString(),
    mnemonic: algosdk.secretKeyToMnemonic(kp.sk),
    hasBackup: true,
  } as BackupAccountData;
  return { record, sk: kp.sk, address };
}

function watch(id: string, address: string) {
  return {
    id,
    address,
    publicKey: Buffer.from(algosdk.decodeAddress(address).publicKey).toString(
      'hex'
    ),
    type: AccountType.WATCH,
    label: id,
    color: '#000000',
    isHidden: false,
    createdAt: new Date().toISOString(),
  } as BackupAccountData;
}

async function accountIds(): Promise<string[]> {
  const wallet = await MultiAccountWalletService.getCurrentWallet();
  return (wallet?.accounts ?? []).map((a) => a.id);
}

function snapshotSecrets(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of mockPlatform.__secure) {
    if (k.startsWith(SECRET)) out[k] = v;
  }
  return out;
}

beforeEach(() => {
  mockPlatform.__reset();
  SessionKeyVault.clear();
  AccountSecureStorage.clearPrivateKeyCache();
  jest.restoreAllMocks();
});

describe('TASK-504: add-only restore, per-record results', () => {
  it('adds to a device that already has accounts and leaves every existing secret byte-identical', async () => {
    const existing = keyed('dev-1');
    await restoreAccounts([existing.record]);
    const before = snapshotSecrets();
    const blobBefore = mockPlatform.__kv.get('voi_wallet_metadata');
    expect(Object.keys(before)).toEqual([`${SECRET}dev-1`]);

    const incoming = keyed('file-2');
    const result = await restoreAccounts([incoming.record]);

    expect(result.records).toEqual([
      expect.objectContaining({ id: 'file-2', outcome: 'added' }),
    ]);
    expect(await accountIds()).toEqual(['dev-1', 'file-2']);
    for (const [k, v] of Object.entries(before)) {
      expect(mockPlatform.__secure.get(k)).toBe(v);
    }
    // The wallet blob keeps its own id and active account.
    const blobAfter = JSON.parse(mockPlatform.__kv.get('voi_wallet_metadata')!);
    expect(blobAfter.id).toBe(JSON.parse(blobBefore!).id);
    expect(blobAfter.activeAccountId).toBe('dev-1');
    expect(result.total).toBe(1);
    expect(result.standard).toBe(1);
  });

  it('rule 4: same id and address is already present, and the same id with another address is rejected', async () => {
    const dev = keyed('dev-1');
    await restoreAccounts([dev.record]);
    const before = snapshotSecrets();

    const same = await restoreAccounts([{ ...dev.record }]);
    expect(same.records.map((r) => r.outcome)).toEqual(['already-present']);

    const other = keyed('dev-1'); // same id, a different key and address
    const conflict = await restoreAccounts([other.record]);
    expect(conflict.records.map((r) => r.outcome)).toEqual([
      'rejected-id-conflict',
    ]);

    expect(await accountIds()).toEqual(['dev-1']);
    expect(snapshotSecrets()).toEqual(before);
    expect(same.total + conflict.total).toBe(0);
  });

  it('rule 4: the address on the device under another id is kept, nothing added', async () => {
    const dev = keyed('dev-1');
    await restoreAccounts([dev.record]);
    const result = await restoreAccounts([{ ...dev.record, id: 'file-9' }]);
    expect(result.records).toEqual([
      expect.objectContaining({ id: 'file-9', outcome: 'kept-device-record' }),
    ]);
    expect(await accountIds()).toEqual(['dev-1']);
    expect(mockPlatform.__secure.has(`${SECRET}file-9`)).toBe(false);
  });

  it('rule 4: a device watch entry for the address blocks a file STANDARD record, and the report says so', async () => {
    const incoming = keyed('file-1');
    await restoreAccounts([watch('dev-w', incoming.address)]);
    const result = await restoreAccounts([incoming.record]);
    expect(result.records[0].outcome).toBe('device-keyless');
    expect(result.records[0].deviceType).toBe(AccountType.WATCH);
    expect(mockPlatform.__secure.has(`${SECRET}file-1`)).toBe(false);
  });

  it('4.1 item 1: a slot that positively holds a DIFFERENT readable key is not re-id-ed: the record is rejected, reported, and nothing is written', async () => {
    // An unlisted slot that holds a different key (as after a reinstall).
    const orphan = keyed('orphan-1');
    await restoreAccounts([orphan.record]);
    // Forget the account but keep the slot, as a reinstalled app would.
    mockPlatform.__kv.clear();
    const secretsBefore = snapshotSecrets();
    const kvBefore = new Map(mockPlatform.__kv);
    expect(secretsBefore[`${SECRET}orphan-1`]).toBeDefined();

    const incoming = keyed('orphan-1'); // same id, a different key
    const result = await restoreAccounts([incoming.record]);

    expect(result.records).toEqual([
      expect.objectContaining({
        id: 'orphan-1',
        outcome: 'rejected-slot-occupied',
      }),
    ]);
    expect(result.records[0].storedId).toBeUndefined();
    expect(result.total).toBe(0);
    expect(snapshotSecrets()).toEqual(secretsBefore);
    expect(await AccountSecureStorage.readPendingCreatesStrict()).toEqual({});
    expect(await accountIds()).toEqual([]);
    // No account list, metadata or wallet blob was written for it either.
    expect(new Map(mockPlatform.__kv)).toEqual(kvBefore);
  });

  it('4.1 item 1: a slot read that fails is never read as occupied: restore stops, nothing is written', async () => {
    // A slot holding the file's own key as a device-key copy (no PIN).
    const orphan = keyed('orphan-4');
    await restoreAccounts([orphan.record]);
    mockPlatform.__kv.clear();
    const secretsBefore = snapshotSecrets();
    const kvBefore = new Map(mockPlatform.__kv);

    // The device-id keychain read fails once. A device-key copy cannot be
    // opened without it, so the check cannot tell what the slot holds. That is
    // a failed read, not "something is there that does not open".
    mockPlatform.__flags.deviceIdFailuresLeft = 1;
    await expect(restoreAccounts([orphan.record])).rejects.toThrow(
      'keychain read failed'
    );
    expect(mockPlatform.__flags.deviceIdFailuresLeft).toBe(0);

    expect(snapshotSecrets()).toEqual(secretsBefore);
    expect(new Map(mockPlatform.__kv)).toEqual(kvBefore);
    expect(await accountIds()).toEqual([]);
  });

  it('4.1 item 1: a slot positively shown occupied and unreadable (PIN-wrapped, vault empty) takes the new-id route and the occupied slot is untouched', async () => {
    // A PIN-wrapped orphan: the PIN credential survives, the vault is empty.
    const orphan = keyed('orphan-3');
    await restoreAccounts([orphan.record]);
    await AccountSecureStorage.setupPin(PIN, 'pin');
    SessionKeyVault.clear();
    mockPlatform.__kv.clear(); // app storage gone, keychain kept
    const slotBefore = mockPlatform.__secure.get(`${SECRET}orphan-3`);
    expect(slotBefore).toBeDefined();
    expect(await AccountSecureStorage.hasPinStrict()).toBe(true);

    const incoming = keyed('orphan-3'); // same id, a different key
    const result = await restoreAccounts([incoming.record]);

    expect(result.records[0].outcome).toBe('added-new-id');
    const storedId = result.records[0].storedId!;
    expect(storedId).not.toBe('orphan-3');
    expect(mockPlatform.__secure.get(`${SECRET}orphan-3`)).toBe(slotBefore);
    expect(mockPlatform.__secure.has(`${SECRET}${storedId}`)).toBe(true);
    expect(await accountIds()).toEqual([storedId]);
    // The new key reads through the new id (vault filled, as after an unlock)
    // and is the file's key.
    SessionKeyVault.set(PIN, 'pin');
    AccountSecureStorage.clearPrivateKeyCache();
    const key = await AccountSecureStorage.getPrivateKey(storedId);
    expect(Buffer.from(key.slice(32)).toString('hex')).toBe(
      incoming.record.publicKey
    );
  });

  it('a keyed record whose id names a slot already holding its key is added in place: nothing is written, nothing is journaled', async () => {
    const orphan = keyed('orphan-2');
    await restoreAccounts([orphan.record]);
    mockPlatform.__kv.clear();
    const slotBefore = mockPlatform.__secure.get(`${SECRET}orphan-2`);

    const result = await restoreAccounts([orphan.record]);

    expect(result.records[0].outcome).toBe('added-in-place');
    expect(mockPlatform.__secure.get(`${SECRET}orphan-2`)).toBe(slotBefore);
    expect(await AccountSecureStorage.readPendingCreatesStrict()).toEqual({});
    expect(await accountIds()).toEqual(['orphan-2']);
  });

  it('a device with a PIN and accounts needs an unlocked vault: locked stops with nothing changed', async () => {
    const dev = keyed('dev-1');
    await restoreAccounts([dev.record]);
    await AccountSecureStorage.setupPin(PIN, 'pin');
    SessionKeyVault.clear();
    const secretsBefore = snapshotSecrets();
    const kvBefore = new Map(mockPlatform.__kv);

    await expect(
      restoreAccounts([keyed('file-2').record])
    ).rejects.toMatchObject({ code: 'AUTHENTICATION_REQUIRED' });

    expect(snapshotSecrets()).toEqual(secretsBefore);
    expect(new Map(mockPlatform.__kv)).toEqual(kvBefore);
  });

  it('a reset racing the commit rolls back only what this attempt wrote', async () => {
    const dev = keyed('dev-1');
    await restoreAccounts([dev.record]);
    const keyless = watch('file-w', algosdk.generateAccount().addr.toString());
    const incoming = keyed('file-2');
    const secretsBefore = snapshotSecrets();
    jest
      .spyOn(MultiAccountWalletService, 'mergeRestoredAccounts')
      .mockRejectedValueOnce(new ResetRacedError());

    await expect(
      restoreAccounts([incoming.record, keyless])
    ).rejects.toBeInstanceOf(ResetRacedError);

    // The existing key is untouched, this attempt's new slot is gone, and the
    // key-less record's metadata is gone with no slot ever written for it.
    expect(snapshotSecrets()).toEqual(secretsBefore);
    expect(await AccountSecureStorage.readAccountListStrict()).toEqual([
      'dev-1',
    ]);
    expect(await AccountSecureStorage.readPendingCreatesStrict()).toEqual({});
    expect(await accountIds()).toEqual(['dev-1']);
  });

  it('every record of the file gets exactly one result', async () => {
    const dev = keyed('dev-1');
    const clash = keyed('dev-2');
    await restoreAccounts([dev.record, clash.record]);
    const records = [
      { ...dev.record },
      keyed('a').record,
      watch('w', algosdk.generateAccount().addr.toString()),
      { ...keyed('dev-2').record },
    ];
    const result = await restoreAccounts(records);
    expect(result.records).toHaveLength(records.length);
    expect(result.records.map((r) => r.outcome)).toEqual([
      'already-present',
      'added',
      'added',
      'rejected-id-conflict',
    ]);
  });
});
