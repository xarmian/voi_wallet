// TASK-504: the report rows for a file record whose address is already on the
// device. Real AccountSecureStorage + wallet service + restoreAccounts; only
// platform storage is in memory. The read behind these rows is a report input
// only: it decides no write, so every case also pins storage byte-identical and
// shows no key read and no migration happened.

jest.mock('@/platform', () => {
  const nodeCrypto = require('crypto');
  const secure = new Map<string, string>();
  const kv = new Map<string, string>();
  const flags = { failKeysContaining: null as string | null };
  return {
    __secure: secure,
    __kv: kv,
    __flags: flags,
    __reset: () => {
      secure.clear();
      kv.clear();
      flags.failKeysContaining = null;
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
        if (flags.failKeysContaining && k.includes(flags.failKeysContaining)) {
          throw new Error('keychain read failed');
        }
        return secure.has(k) ? secure.get(k)! : null;
      },
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
      getDeviceId: async () => 'task504-device-idfv',
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
import { AccountType } from '@/types/wallet';
import { restoreAccounts } from '../restorers';
import {
  KEY_PROBLEM_TEXT,
  KEY_UNREADABLE_TEXT,
  OUTCOME_TEXT,
  REMOVE_ADVICE_SHOWN,
  buildRestoreReport,
  keylessDeviceText,
} from '../restoreReport';
import type { BackupAccountData, RestoreResult } from '../types';

const PIN = '123456';
const SECRET = 'voi_account_secret_';
const mockPlatform = platform as unknown as {
  __secure: Map<string, string>;
  __kv: Map<string, string>;
  __flags: { failKeysContaining: string | null };
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
  return { record, address };
}

function keyless(id: string, address: string, type: AccountType) {
  const base = {
    id,
    address,
    publicKey: Buffer.from(algosdk.decodeAddress(address).publicKey).toString(
      'hex'
    ),
    type,
    label: id,
    color: '#000000',
    isHidden: false,
    createdAt: new Date().toISOString(),
  };
  if (type === AccountType.LEDGER) {
    return {
      ...base,
      deviceId: 'ledger-1',
      derivationIndex: 0,
      derivationPath: "44'/283'/0'/0/0",
    } as unknown as BackupAccountData;
  }
  if (type === AccountType.REMOTE_SIGNER) {
    return {
      ...base,
      signerDeviceId: 'signer-1',
      pairedAt: new Date().toISOString(),
    } as unknown as BackupAccountData;
  }
  return base as unknown as BackupAccountData;
}

function snapshot(): { secure: [string, string][]; kv: [string, string][] } {
  return {
    secure: [...mockPlatform.__secure.entries()].sort(),
    kv: [...mockPlatform.__kv.entries()].sort(),
  };
}

/** A device that holds `record` with a readable key, then a file record for
 *  the same address under another id. */
async function deviceWith(record: BackupAccountData) {
  await restoreAccounts([record]);
  return { ...record, id: 'file-9' } as BackupAccountData;
}

let getPrivateKeySpy: jest.SpyInstance;
let migrateSpy: jest.SpyInstance;

beforeEach(() => {
  mockPlatform.__reset();
  SessionKeyVault.clear();
  AccountSecureStorage.clearPrivateKeyCache();
  jest.restoreAllMocks();
  getPrivateKeySpy = jest.spyOn(AccountSecureStorage, 'getPrivateKey');
  migrateSpy = jest.spyOn(
    AccountSecureStorage as unknown as { migrateAccountToV2: () => unknown },
    'migrateAccountToV2'
  );
});

async function restoreOne(file: BackupAccountData) {
  getPrivateKeySpy.mockClear();
  migrateSpy.mockClear();
  const before = snapshot();
  const result = await restoreAccounts([file]);
  expect(snapshot()).toEqual(before);
  expect(getPrivateKeySpy).not.toHaveBeenCalled();
  expect(migrateSpy).not.toHaveBeenCalled();
  expect(result.records).toHaveLength(1);
  return result.records[0];
}

describe('TASK-504: rows for a record the device already has, the file holds its key', () => {
  it('slot proven empty: "key can\'t be read here, this backup has the key"', async () => {
    const dev = keyed('dev-1');
    const file = await deviceWith(dev.record);
    mockPlatform.__secure.delete(`${SECRET}dev-1`);

    const row = await restoreOne(file);

    expect(row.outcome).toBe('device-key-unreadable');
    expect(OUTCOME_TEXT['device-key-unreadable']).toBe(
      REMOVE_ADVICE_SHOWN
        ? `${KEY_UNREADABLE_TEXT} To use it, remove this account from the wallet, then restore this backup again.`
        : KEY_UNREADABLE_TEXT
    );
  });

  it('the same id as the device record reads the same way', async () => {
    const dev = keyed('dev-1');
    await restoreAccounts([dev.record]);
    mockPlatform.__secure.delete(`${SECRET}dev-1`);

    const row = await restoreOne({ ...dev.record });

    expect(row.outcome).toBe('device-key-unreadable');
  });

  it('a readable key that derives to the address: still "Already on this device"', async () => {
    const dev = keyed('dev-1');
    const file = await deviceWith(dev.record);

    expect((await restoreOne(file)).outcome).toBe('kept-device-record');
    expect((await restoreOne({ ...dev.record })).outcome).toBe(
      'already-present'
    );
  });

  it("another account's key in the slot: the problem row", async () => {
    const dev = keyed('dev-1');
    const other = keyed('other-1');
    const file = await deviceWith(dev.record);
    await restoreAccounts([other.record]);
    mockPlatform.__secure.set(
      `${SECRET}dev-1`,
      mockPlatform.__secure.get(`${SECRET}other-1`)!
    );

    const row = await restoreOne(file);

    expect(row.outcome).toBe('device-key-problem');
    expect(OUTCOME_TEXT['device-key-problem']).toBe(KEY_PROBLEM_TEXT);
  });

  it('a payload no reader accepts: the problem row', async () => {
    const dev = keyed('dev-1');
    const file = await deviceWith(dev.record);
    mockPlatform.__secure.set(`${SECRET}dev-1`, 'not json');

    expect((await restoreOne(file)).outcome).toBe('device-key-problem');
  });

  it('a surviving legacy blob behind an absent primary, with the wipe tombstone set: the problem row, never empty', async () => {
    const dev = keyed('dev-1');
    const file = await deviceWith(dev.record);
    mockPlatform.__secure.delete(`${SECRET}dev-1`);
    mockPlatform.__secure.set('voi_account_dev-1', '{"legacy":true}');
    mockPlatform.__kv.set('voi_secure_wiped', '1');

    expect((await restoreOne(file)).outcome).toBe('device-key-problem');
  });

  it('a slot read that fails: the problem row, and the restore does not stop', async () => {
    const dev = keyed('dev-1');
    const file = await deviceWith(dev.record);
    mockPlatform.__flags.failKeysContaining = `${SECRET}dev-1`;

    const row = await restoreOne(file);

    expect(row.outcome).toBe('device-key-problem');
  });

  it('a read error on the report read does not weaken inspectSecretSlot: it still throws', async () => {
    const dev = keyed('dev-1');
    await restoreAccounts([dev.record]);
    mockPlatform.__flags.failKeysContaining = `${SECRET}dev-1`;

    await expect(
      AccountSecureStorage.inspectSecretSlot('dev-1', dev.address)
    ).rejects.toThrow('keychain read failed');
  });

  it.each([
    [AccountType.WATCH, 'Watch Only'],
    [AccountType.LEDGER, 'Ledger'],
    [AccountType.REMOTE_SIGNER, 'Airgap'],
  ] as const)(
    'a key-less device %s record: the row reads its type and no slot is read',
    async (type, name) => {
      const incoming = keyed('file-1');
      await restoreAccounts([keyless('dev-k', incoming.address, type)]);
      const slotRead = jest.spyOn(
        AccountSecureStorage,
        'inspectSlotForRestoreReport'
      );
      const secretRead = jest.spyOn(AccountSecureStorage, 'inspectSecretSlot');

      const row = await restoreOne(incoming.record);

      expect(row.outcome).toBe('device-keyless');
      expect(row.deviceType).toBe(type);
      expect(slotRead).not.toHaveBeenCalled();
      expect(secretRead).not.toHaveBeenCalled();
      expect(keylessDeviceText(type)).toBe(
        REMOVE_ADVICE_SHOWN
          ? `On this device as ${name}. The key in this backup wasn't added. To use it, remove this account from the wallet, then restore this backup again.`
          : `On this device as ${name}. The key in this backup wasn't added.`
      );
    }
  );

  it('a file record with no phrase (watch) on a device record keeps "Already on this device" and reads no slot', async () => {
    const dev = keyed('dev-1');
    await restoreAccounts([dev.record]);
    const slotRead = jest.spyOn(
      AccountSecureStorage,
      'inspectSlotForRestoreReport'
    );

    const row = await restoreOne(
      keyless('file-w', dev.address, AccountType.WATCH)
    );

    expect(row.outcome).toBe('kept-device-record');
    expect(slotRead).not.toHaveBeenCalled();
  });

  describe('duplicates at one address (TASK-423): every entry is read', () => {
    async function twoEntries(secondSlot: 'readable' | 'empty') {
      const dev = keyed('dev-1');
      await restoreAccounts([dev.record]);
      // A second device entry for the same address, with its own slot.
      const blob = JSON.parse(mockPlatform.__kv.get('voi_wallet_metadata')!);
      blob.accounts.push({ ...blob.accounts[0], id: 'dev-2' });
      mockPlatform.__kv.set('voi_wallet_metadata', JSON.stringify(blob));
      if (secondSlot === 'readable') {
        mockPlatform.__secure.set(
          `${SECRET}dev-2`,
          mockPlatform.__secure.get(`${SECRET}dev-1`)!
        );
      }
      // The first entry's slot is empty either way.
      mockPlatform.__secure.delete(`${SECRET}dev-1`);
      return { ...dev.record, id: 'file-9' } as BackupAccountData;
    }

    it('one entry with a readable key: "Already on this device"', async () => {
      const file = await twoEntries('readable');
      expect((await restoreOne(file)).outcome).toBe('kept-device-record');
    });

    it('every entry empty: the empty row', async () => {
      const file = await twoEntries('empty');
      expect((await restoreOne(file)).outcome).toBe('device-key-unreadable');
    });
  });
});

describe('TASK-504: the report read is only trusted under a stable vault', () => {
  async function pinDevice() {
    const dev = keyed('dev-1');
    await restoreAccounts([dev.record]);
    await AccountSecureStorage.setupPin(PIN, 'pin');
    SessionKeyVault.set(PIN, 'pin');
    AccountSecureStorage.clearPrivateKeyCache();
    return { ...dev.record, id: 'file-9' } as BackupAccountData;
  }

  it('a healthy PIN-wrapped key under an unlocked vault reads as readable', async () => {
    const file = await pinDevice();
    expect((await restoreOne(file)).outcome).toBe('kept-device-record');
  });

  it('the vault locks as the read starts: no row from that result, the restore stops, nothing written', async () => {
    const file = await pinDevice();
    const original =
      AccountSecureStorage.inspectSecretSlot.bind(AccountSecureStorage);
    jest
      .spyOn(AccountSecureStorage, 'inspectSecretSlot')
      .mockImplementation(async (...args) => {
        SessionKeyVault.clear();
        return original(...args);
      });
    const before = snapshot();

    await expect(restoreAccounts([file])).rejects.toMatchObject({
      code: 'AUTHENTICATION_REQUIRED',
    });

    expect(snapshot()).toEqual(before);
  });

  it('the vault epoch moves during the read: no row, the restore stops', async () => {
    const file = await pinDevice();
    const original =
      AccountSecureStorage.inspectSecretSlot.bind(AccountSecureStorage);
    jest
      .spyOn(AccountSecureStorage, 'inspectSecretSlot')
      .mockImplementation(async (...args) => {
        const result = await original(...args);
        SessionKeyVault.set(PIN, 'pin'); // unlocked again, but a new epoch
        return result;
      });
    const before = snapshot();

    await expect(restoreAccounts([file])).rejects.toMatchObject({
      code: 'AUTHENTICATION_REQUIRED',
    });

    expect(snapshot()).toEqual(before);
  });

  it('a device with no PIN needs no vault: the result counts', async () => {
    const dev = keyed('dev-1');
    const file = await deviceWith(dev.record);
    mockPlatform.__secure.delete(`${SECRET}dev-1`);
    expect(await AccountSecureStorage.hasPinStrict()).toBe(false);
    expect(SessionKeyVault.isUnlocked()).toBe(false);

    expect((await restoreOne(file)).outcome).toBe('device-key-unreadable');
  });
});

describe('TASK-504: the report text', () => {
  function result(records: RestoreResult['records']): RestoreResult {
    return {
      records,
      accountCount: 0,
      ledgerAccountCount: 0,
      standardAccountCount: 0,
      watchAccountCount: 0,
      rekeyedAccountCount: 0,
      remoteSignerAccountCount: 0,
      duplicateAccountsDropped: 0,
      settingsRestored: true,
      friendsCount: 0,
      remoteSignerSettingsRestored: true,
      pairedSignersNotRestored: 0,
    };
  }

  it('the three rows show in the report and count as not added', () => {
    const report = buildRestoreReport(
      result([
        {
          id: 'a',
          address: algosdk.generateAccount().addr.toString(),
          outcome: 'device-key-unreadable',
        },
        {
          id: 'b',
          address: algosdk.generateAccount().addr.toString(),
          outcome: 'device-key-problem',
        },
        {
          id: 'c',
          address: algosdk.generateAccount().addr.toString(),
          outcome: 'device-keyless',
          deviceType: AccountType.LEDGER,
        },
      ])
    );
    expect(report.title).toBe('Restore finished');
    expect(report.rows.map((r) => r.text)).toEqual([
      OUTCOME_TEXT['device-key-unreadable'],
      KEY_PROBLEM_TEXT,
      keylessDeviceText(AccountType.LEDGER),
    ]);
  });

  it('the remove advice is off until the removal checks are shown', () => {
    expect(REMOVE_ADVICE_SHOWN).toBe(false);
    expect(OUTCOME_TEXT['device-key-unreadable']).toBe(
      "On this device, but its key can't be read here. This backup has the key."
    );
    expect(OUTCOME_TEXT['device-key-problem']).toBe(
      "On this device, but its key can't be read here. There may be a problem with the stored key. This backup has the key."
    );
    expect(keylessDeviceText(AccountType.WATCH)).toBe(
      "On this device as Watch Only. The key in this backup wasn't added."
    );
  });
});
