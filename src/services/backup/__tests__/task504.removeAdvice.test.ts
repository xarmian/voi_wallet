// TASK-504 cb78f6f1 item 2 / product fcb05990 / dev lead 1626ff71: the removal
// checks behind the advice "remove this account from the wallet, then restore
// this backup again" on the rows `device-keyless` and `device-key-unreadable`.
// Real storage + wallet service; only the platform is in memory. Removal goes
// through the same two calls the Settings flow makes: isListDeletionProtected
// (key-holding or not) and MultiAccountWalletService.deleteAccount by id.

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
import { isListDeletionProtected } from '@/services/wallet/listDeletionProtection';
import * as wipe from '@/services/wipe';
import { AccountType } from '@/types/wallet';
import type { AccountMetadata } from '@/types/wallet';
import { restoreAccounts } from '../restorers';
import type { BackupAccountData } from '../types';

const PIN = '123456';
const SECRET = 'voi_account_secret_';
const WALLET_BLOB = 'voi_wallet_metadata';
const mockPlatform = platform as unknown as {
  __secure: Map<string, string>;
  __kv: Map<string, string>;
  __reset: () => void;
};

function keyedRecord(id: string, type = AccountType.STANDARD) {
  const kp = algosdk.generateAccount();
  const address = kp.addr.toString();
  const record = {
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
    mnemonic: algosdk.secretKeyToMnemonic(kp.sk),
    hasBackup: true,
    ...(type === AccountType.REKEYED
      ? {
          authAddress: algosdk.generateAccount().addr.toString(),
          originalOwner: true,
        }
      : {}),
  } as unknown as BackupAccountData;
  return { record, address, publicKey: record.publicKey };
}

function keylessRecord(id: string, address: string, type: AccountType) {
  return {
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
    ...(type === AccountType.LEDGER
      ? {
          deviceId: 'ledger-1',
          derivationIndex: 0,
          ledgerDerivationPath: "44'/283'/0'/0/0",
        }
      : {}),
  } as unknown as BackupAccountData;
}

/** The file's record for an address already on the device, under a new id. */
const fileRecordFor = (device: { record: BackupAccountData }) =>
  ({ ...device.record, id: 'file-9' }) as BackupAccountData;

async function deviceAccounts(): Promise<AccountMetadata[]> {
  const wallet = await MultiAccountWalletService.getCurrentWallet();
  return (wallet?.accounts ?? []) as AccountMetadata[];
}

/** What the Settings flow does: classify, then delete by id. */
async function removeById(id: string) {
  const account = (await deviceAccounts()).find((a) => a.id === id)!;
  const keyHolding = await isListDeletionProtected(account);
  await MultiAccountWalletService.deleteAccount(id, {
    address: account.address,
    type: account.type,
    keyless: !keyHolding,
  });
}

/** A second device entry at the same address (TASK-423 duplicates). */
function addDuplicateEntry(fromId: string, id: string, type?: AccountType) {
  const blob = JSON.parse(mockPlatform.__kv.get(WALLET_BLOB)!);
  const source = blob.accounts.find((a: { id: string }) => a.id === fromId);
  blob.accounts.push({ ...source, id, ...(type ? { type } : {}) });
  mockPlatform.__kv.set(WALLET_BLOB, JSON.stringify(blob));
  AccountSecureStorage.clearPrivateKeyCache();
}

async function restoreAgain(file: BackupAccountData) {
  const result = await restoreAccounts([file]);
  return result.records[0];
}

beforeEach(() => {
  mockPlatform.__reset();
  SessionKeyVault.clear();
  AccountSecureStorage.clearPrivateKeyCache();
  jest.restoreAllMocks();
});

describe('TASK-504 remove advice: one entry at the address, removed by id, one restore gets the key back', () => {
  it('device-keyless (Watch Only, Ledger): remove it, restore again, the key is added and reads', async () => {
    for (const type of [AccountType.WATCH, AccountType.LEDGER]) {
      mockPlatform.__reset();
      AccountSecureStorage.clearPrivateKeyCache();
      const other = keyedRecord('other');
      const incoming = keyedRecord('incoming');
      await restoreAccounts([
        other.record,
        keylessRecord('dev-k', incoming.address, type),
      ]);

      expect((await restoreAgain(fileRecordFor(incoming))).outcome).toBe(
        'device-keyless'
      );
      await removeById('dev-k');
      const row = await restoreAgain(fileRecordFor(incoming));

      expect(row.outcome).toBe('added');
      const key = await AccountSecureStorage.getPrivateKey('file-9');
      expect(Buffer.from(key.slice(32)).toString('hex')).toBe(
        incoming.publicKey
      );
      expect((await deviceAccounts()).map((a) => a.id).sort()).toEqual(
        ['file-9', 'other'].sort()
      );
    }
  });

  it('device-key-unreadable (a keyed entry whose slot is empty): remove it, restore again, the key is added and reads', async () => {
    const dev = keyedRecord('dev-1');
    await restoreAccounts([dev.record]);
    mockPlatform.__secure.delete(`${SECRET}dev-1`);

    expect((await restoreAgain(fileRecordFor(dev))).outcome).toBe(
      'device-key-unreadable'
    );
    await removeById('dev-1');
    const row = await restoreAgain(fileRecordFor(dev));

    expect(row.outcome).toBe('added');
    const key = await AccountSecureStorage.getPrivateKey('file-9');
    expect(Buffer.from(key.slice(32)).toString('hex')).toBe(dev.publicKey);
  });

  it('the classifyKeyHolding loop: a REKEYED entry that claims a retained key (originalOwner) with an empty slot is classified key-holding, its removal succeeds, and the restore is not refused', async () => {
    const dev = keyedRecord('dev-r', AccountType.REKEYED);
    await restoreAccounts([dev.record]);
    mockPlatform.__secure.delete(`${SECRET}dev-r`);
    const stored = (await deviceAccounts()).find((a) => a.id === 'dev-r')!;
    expect(await isListDeletionProtected(stored)).toBe(true);

    expect((await restoreAgain(fileRecordFor(dev))).outcome).toBe(
      'device-key-unreadable'
    );
    await removeById('dev-r');
    expect((await deviceAccounts()).map((a) => a.id)).toEqual([]);
    const row = await restoreAgain(fileRecordFor(dev));

    expect(row.outcome).toBe('added');
    expect(typeof mockPlatform.__secure.get(`${SECRET}file-9`)).toBe('string');
  });
});

describe('TASK-504 remove advice: duplicates at one address (TASK-423)', () => {
  it('two key-less entries: removing ONE leaves the row in place, so one pass does not get the key back; removing both does', async () => {
    const other = keyedRecord('other');
    const incoming = keyedRecord('incoming');
    await restoreAccounts([
      other.record,
      keylessRecord('dev-w', incoming.address, AccountType.WATCH),
    ]);
    addDuplicateEntry('dev-w', 'dev-l', AccountType.LEDGER);

    await removeById('dev-w');
    const afterOne = await restoreAgain(fileRecordFor(incoming));
    expect(afterOne.outcome).not.toBe('added');
    expect(afterOne.outcome).toBe('device-keyless');

    await removeById('dev-l');
    expect((await restoreAgain(fileRecordFor(incoming))).outcome).toBe('added');
  });

  it('the mixed case, a key-less entry and a keyed entry with an empty slot: removing ONE leaves a blocking row', async () => {
    const dev = keyedRecord('dev-1');
    await restoreAccounts([dev.record]);
    addDuplicateEntry('dev-1', 'dev-w', AccountType.WATCH);
    mockPlatform.__secure.delete(`${SECRET}dev-1`);

    await removeById('dev-w');
    const afterOne = await restoreAgain(fileRecordFor(dev));
    expect(afterOne.outcome).toBe('device-key-unreadable');

    await removeById('dev-1');
    expect((await restoreAgain(fileRecordFor(dev))).outcome).toBe('added');
  });
});

describe('TASK-504 remove advice: removing the last account', () => {
  it('reaches no reset or wipe, keeps the PIN and every other slot, and the restore then adds the key', async () => {
    const incoming = keyedRecord('incoming');
    await restoreAccounts([
      keylessRecord('dev-w', incoming.address, AccountType.WATCH),
    ]);
    await AccountSecureStorage.setupPin(PIN, 'pin');
    SessionKeyVault.clear();
    AccountSecureStorage.clearPrivateKeyCache();
    const clearAll = jest.spyOn(AccountSecureStorage, 'clearAll');
    const clearAllWallets = jest.spyOn(
      MultiAccountWalletService,
      'clearAllWallets'
    );
    const wipeData = jest.spyOn(wipe, 'wipeWalletData');
    const pinBefore = mockPlatform.__secure.get('voi_wallet_pin');

    await removeById('dev-w');

    expect(clearAll).not.toHaveBeenCalled();
    expect(clearAllWallets).not.toHaveBeenCalled();
    expect(wipeData).not.toHaveBeenCalled();
    expect(mockPlatform.__secure.get('voi_wallet_pin')).toBe(pinBefore);
    expect(await AccountSecureStorage.hasPinStrict()).toBe(true);
    expect(await MultiAccountWalletService.hasWalletWithAccountsStrict()).toBe(
      false
    );

    const row = await restoreAgain(fileRecordFor(incoming));
    expect(row.outcome).toBe('added');
    expect(typeof mockPlatform.__secure.get(`${SECRET}file-9`)).toBe('string');
  });
});
