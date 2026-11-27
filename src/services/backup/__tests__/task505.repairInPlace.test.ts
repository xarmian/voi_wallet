// TASK-505: a restore puts the file's key back onto an account already on this
// device whose key slot reads empty, in place, under the device record's own
// id. Real AccountSecureStorage + wallet service + restoreAccounts + boot
// reconcile; only platform storage is in memory.

jest.mock('@/platform', () => {
  const nodeCrypto = require('crypto');
  const secure = new Map<string, string>();
  const kv = new Map<string, string>();
  const failing = new Set<string>();
  const writes: string[] = [];
  return {
    __secure: secure,
    __kv: kv,
    __failing: failing,
    __writes: writes,
    __reset: () => {
      secure.clear();
      kv.clear();
      failing.clear();
      writes.length = 0;
    },
    crypto: {
      getRandomBytes: async (n: number): Promise<Uint8Array> =>
        Uint8Array.from(nodeCrypto.randomBytes(n)),
      sha256: async (input: string): Promise<string> =>
        nodeCrypto.createHash('sha256').update(input).digest('hex'),
      randomUUID: () => nodeCrypto.randomUUID(),
    },
    secureStorage: {
      getItem: async (k: string) => {
        if (failing.has(`secure:${k}`)) throw new Error('keychain read failed');
        return secure.has(k) ? secure.get(k)! : null;
      },
      setItem: async (k: string, v: string) => {
        writes.push(k);
        secure.set(k, v);
      },
      deleteItem: async (k: string) => {
        secure.delete(k);
      },
      getItemWithAuth: async (k: string) =>
        secure.has(k) ? secure.get(k)! : null,
    },
    storage: {
      getItem: async (k: string) => {
        if (failing.has(`kv:${k}`)) throw new Error('storage read failed');
        return kv.has(k) ? kv.get(k)! : null;
      },
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
    deviceId: { getDeviceId: async () => 'task505-device-idfv' },
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
import { reconcileCrossStoreHalfState } from '@/services/wallet/crossStoreReconcile';
import { AccountType } from '@/types/wallet';
import { restoreAccounts } from '../restorers';
import {
  REMOVE_ADVICE,
  KEY_UNREADABLE_TEXT,
  buildRestoreReport,
} from '../restoreReport';
import type { BackupAccountData, RestoreResult } from '../types';

const PIN = '123456';
const SECRET = (id: string) => `voi_account_secret_${id}`;
const META = (id: string) => `voi_account_metadata_${id}`;
const WALLET_BLOB = 'voi_wallet_metadata';
const mockPlatform = platform as unknown as {
  __secure: Map<string, string>;
  __kv: Map<string, string>;
  __failing: Set<string>;
  __writes: string[];
  __reset: () => void;
};

function standard(id: string, kp = algosdk.generateAccount()) {
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

/** A rekeyed record; with `keep` the file holds its retained (own) key. */
function rekeyed(id: string, kp: algosdk.Account, keep: boolean) {
  const record = {
    ...standard(id, kp),
    type: AccountType.REKEYED,
    authAddress: algosdk.generateAccount().addr.toString(),
  } as Record<string, unknown>;
  if (!keep) delete record.mnemonic;
  return record as unknown as BackupAccountData;
}

const asFileRecord = (record: BackupAccountData, id = 'file-9') =>
  ({ ...record, id }) as BackupAccountData;

async function publicHalfOf(id: string): Promise<string> {
  AccountSecureStorage.clearPrivateKeyCache();
  const key = await AccountSecureStorage.getPrivateKey(id);
  return Buffer.from(key.slice(32)).toString('hex');
}

function addDuplicateEntry(fromId: string, id: string) {
  const blob = JSON.parse(mockPlatform.__kv.get(WALLET_BLOB)!);
  const source = blob.accounts.find((a: { id: string }) => a.id === fromId);
  blob.accounts.push({ ...source, id });
  mockPlatform.__kv.set(WALLET_BLOB, JSON.stringify(blob));
}

function reportOf(records: RestoreResult['records']) {
  return buildRestoreReport({
    records,
    accountCount: 0,
    ledgerAccountCount: 0,
    standardAccountCount: 0,
    watchAccountCount: 0,
    rekeyedAccountCount: 0,
    remoteSignerAccountCount: 0,
    duplicateAccountsDropped: 0,
    settingsRestored: false,
    friendsCount: 0,
    remoteSignerSettingsRestored: false,
    pairedSignersNotRestored: 0,
  });
}

beforeEach(() => {
  mockPlatform.__reset();
  SessionKeyVault.clear();
  AccountSecureStorage.clearPrivateKeyCache();
  jest.restoreAllMocks();
});

describe('TASK-505: the key goes back under the device record', () => {
  it('a same-id file record: key-repaired, the wallet blob unchanged, the key reads', async () => {
    const dev = standard('dev-1');
    await restoreAccounts([dev]);
    mockPlatform.__secure.delete(SECRET('dev-1'));
    const blobBefore = mockPlatform.__kv.get(WALLET_BLOB);

    const result = await restoreAccounts([{ ...dev }]);

    expect(result.records.map((r) => r.outcome)).toEqual(['key-repaired']);
    expect(result.records[0].deviceEntries).toBeUndefined();
    expect(mockPlatform.__kv.get(WALLET_BLOB)).toBe(blobBefore);
    expect(await publicHalfOf('dev-1')).toBe(dev.publicKey);
  });

  it('a file record under another id: repaired under the device id, nothing at the file id', async () => {
    const dev = standard('dev-1');
    await restoreAccounts([dev]);
    mockPlatform.__secure.delete(SECRET('dev-1'));

    const result = await restoreAccounts([asFileRecord(dev)]);

    expect(result.records[0].outcome).toBe('key-repaired');
    expect(await publicHalfOf('dev-1')).toBe(dev.publicKey);
    expect(mockPlatform.__secure.has(SECRET('file-9'))).toBe(false);
    expect(mockPlatform.__kv.has(META('file-9'))).toBe(false);
  });

  it.each([
    ['a rekeyed file record', true],
    ['a standard file record', false],
  ] as const)(
    'a REKEYED device record with originalOwner, %s: repaired with its own key',
    async (_n, fileIsRekeyed) => {
      const kp = algosdk.generateAccount();
      const dev = rekeyed('dev-r', kp, true);
      await restoreAccounts([dev]);
      mockPlatform.__secure.delete(SECRET('dev-r'));

      const file = fileIsRekeyed
        ? asFileRecord(dev)
        : asFileRecord(standard('x', kp));
      const result = await restoreAccounts([file]);

      expect(result.records[0].outcome).toBe('key-repaired');
      expect(await publicHalfOf('dev-r')).toBe(dev.publicKey);
    }
  );
});

describe('TASK-505: records that keep the row they had', () => {
  it('a REKEYED device record without originalOwner: the unreadable row with the remove advice, nothing written', async () => {
    const kp = algosdk.generateAccount();
    await restoreAccounts([rekeyed('dev-r', kp, false)]);
    mockPlatform.__writes.length = 0;

    const result = await restoreAccounts([
      asFileRecord(rekeyed('x', kp, true)),
    ]);

    expect(result.records[0].outcome).toBe('device-key-unreadable');
    expect(result.records[0].deviceEntries).toBe(1);
    expect(reportOf(result.records).rows[0].text).toBe(
      `${KEY_UNREADABLE_TEXT} ${REMOVE_ADVICE}`
    );
    expect(mockPlatform.__writes).toEqual([]);
  });

  it('two device entries at the address: unchanged, nothing written', async () => {
    const dev = standard('dev-1');
    await restoreAccounts([dev]);
    addDuplicateEntry('dev-1', 'dev-2');
    mockPlatform.__secure.delete(SECRET('dev-1'));
    mockPlatform.__writes.length = 0;

    const result = await restoreAccounts([asFileRecord(dev)]);

    expect(result.records[0].outcome).toBe('device-key-unreadable');
    expect(result.records[0].deviceEntries).toBe(2);
    expect(mockPlatform.__writes).toEqual([]);
  });

  it('the old-PIN path: no repair', async () => {
    const dev = standard('dev-1');
    await restoreAccounts([dev]);
    mockPlatform.__secure.delete(SECRET('dev-1'));
    const repairSpy = jest.spyOn(
      AccountSecureStorage,
      'repairMissingKeyForRestore'
    );

    const result = await restoreAccounts([asFileRecord(dev)], {
      oldPinSession: { epoch: SessionKeyVault.currentEpoch() },
    });

    expect(result.records[0].outcome).toBe('device-key-unreadable');
    expect(repairSpy).not.toHaveBeenCalled();
    expect(mockPlatform.__secure.has(SECRET('dev-1'))).toBe(false);
  });
});

describe('TASK-505: failures around the repair', () => {
  it('a failure on the repair read only: the skipped row, and the next record is still added', async () => {
    const dev = standard('dev-1');
    await restoreAccounts([dev]);
    mockPlatform.__secure.delete(SECRET('dev-1'));
    mockPlatform.__failing.add(`kv:${META('dev-1')}`);
    const next = standard('new-2');

    const result = await restoreAccounts([asFileRecord(dev), next]);

    expect(result.records.map((r) => r.outcome)).toEqual([
      'device-key-repair-skipped',
      'added',
    ]);
    expect(mockPlatform.__secure.has(SECRET('dev-1'))).toBe(false);
    expect(await publicHalfOf('new-2')).toBe(next.publicKey);
  });

  it('a later failure before the commit: the new account rolls back, the repair stays', async () => {
    const dev = standard('dev-1');
    await restoreAccounts([dev]);
    mockPlatform.__secure.delete(SECRET('dev-1'));
    mockPlatform.__failing.add(`secure:${SECRET('new-3')}`);

    await expect(
      restoreAccounts([asFileRecord(dev), standard('new-2'), standard('new-3')])
    ).rejects.toMatchObject({ code: 'RESTORE_FAILED' });

    expect(mockPlatform.__secure.has(SECRET('new-2'))).toBe(false);
    expect(await publicHalfOf('dev-1')).toBe(dev.publicKey);
  });

  it('the vault locks between the report read and the repair: AUTHENTICATION_REQUIRED, the slot stays empty', async () => {
    const dev = standard('dev-1');
    await restoreAccounts([dev]);
    await AccountSecureStorage.setupPin(PIN, 'pin');
    SessionKeyVault.set(PIN, 'pin');
    mockPlatform.__secure.delete(SECRET('dev-1'));
    const original =
      AccountSecureStorage.inspectSlotForRestoreReport.bind(
        AccountSecureStorage
      );
    jest
      .spyOn(AccountSecureStorage, 'inspectSlotForRestoreReport')
      .mockImplementation(async (...args) => {
        const slot = await original(...args);
        SessionKeyVault.clear();
        return slot;
      });

    await expect(restoreAccounts([asFileRecord(dev)])).rejects.toMatchObject({
      code: 'AUTHENTICATION_REQUIRED',
    });
    expect(mockPlatform.__secure.has(SECRET('dev-1'))).toBe(false);
  });
});

describe('TASK-505: after a repair', () => {
  it('restoring again: Already on this device', async () => {
    const dev = standard('dev-1');
    await restoreAccounts([dev]);
    mockPlatform.__secure.delete(SECRET('dev-1'));
    await restoreAccounts([{ ...dev }]);

    const again = await restoreAccounts([{ ...dev }]);
    expect(again.records[0].outcome).toBe('already-present');
  });

  it('two overlapping restores run one after the other (the restore chain): one slot write', async () => {
    const dev = standard('dev-1');
    await restoreAccounts([dev]);
    mockPlatform.__secure.delete(SECRET('dev-1'));
    mockPlatform.__writes.length = 0;

    const [first, second] = await Promise.all([
      restoreAccounts([asFileRecord(dev)]),
      restoreAccounts([asFileRecord(dev)]),
    ]);

    expect(first.records[0].outcome).toBe('key-repaired');
    expect(second.records[0].outcome).toBe('kept-device-record');
    expect(mockPlatform.__writes.filter((k) => k === SECRET('dev-1'))).toEqual([
      SECRET('dev-1'),
    ]);
  });

  it('the boot reconcile prunes nothing', async () => {
    const dev = standard('dev-1');
    const keep = standard('keep-1');
    await restoreAccounts([dev, keep]);
    mockPlatform.__secure.delete(SECRET('dev-1'));
    await restoreAccounts([asFileRecord(dev)]);
    const slot = mockPlatform.__secure.get(SECRET('dev-1'));

    SessionKeyVault.clear();
    AccountSecureStorage.clearPrivateKeyCache();
    const result = await reconcileCrossStoreHalfState();

    expect(result.phantomAccountsPruned).toEqual([]);
    expect(mockPlatform.__secure.get(SECRET('dev-1'))).toBe(slot);
    const blob = JSON.parse(mockPlatform.__kv.get(WALLET_BLOB)!);
    expect(blob.accounts.map((a: { id: string }) => a.id).sort()).toEqual([
      'dev-1',
      'keep-1',
    ]);
  });
});
