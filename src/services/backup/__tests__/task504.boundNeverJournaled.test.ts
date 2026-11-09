// TASK-504 DOC-507 5.6 item 1 (dev lead d6ca72b9, condition 1): a bound key-less
// record and a key-matches record added in place write NO secret slot, so
// they must never be journaled (no pending-creates entry, no ownership token),
// and undoing one removes the account list entry and metadata only.
// (a) a later record fails: the slot is byte-identical afterwards;
// (b) a kill during C after the add, then boot reconcile: the slot is
//     byte-identical.
// Real storage + wallet service + reconcile; only the platform is in memory.

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
import { reconcileCrossStoreHalfState } from '@/services/wallet/crossStoreReconcile';
import { AccountType } from '@/types/wallet';
import { restoreAccounts } from '../restorers';
import type { BackupAccountData } from '../types';

const PIN = '123456';
const ORPHAN_ID = 'orphan-1';
const SLOT = `voi_account_secret_${ORPHAN_ID}`;
const JOURNAL_KEY = 'voi_pending_account_creates';
const mockPlatform = platform as unknown as {
  __secure: Map<string, string>;
  __kv: Map<string, string>;
  __reset: () => void;
};

function standard(id: string) {
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

/** A key-less rekeyed record: the file's no-key-on-device entry. */
function keylessRekeyed(id: string, address: string, publicKey: string) {
  return {
    id,
    address,
    publicKey,
    type: AccountType.REKEYED,
    label: 'rekeyed',
    color: '#000000',
    isHidden: false,
    createdAt: new Date().toISOString(),
    authAddress: algosdk.generateAccount().addr.toString(),
    originalOwner: true,
    canSign: false,
  } as unknown as BackupAccountData;
}

/** After a reinstall with the PIN credential kept: a PIN-wrapped orphan under
 *  orphan-1, no account list, and the vault filled as by a verified old PIN. */
async function oldPinDevice() {
  const orphan = standard(ORPHAN_ID);
  await restoreAccounts([orphan]);
  await AccountSecureStorage.setupPin(PIN, 'pin');
  mockPlatform.__kv.clear();
  SessionKeyVault.set(PIN, 'pin');
  AccountSecureStorage.clearPrivateKeyCache();
  return orphan;
}

function journalIds(): string[] {
  const raw = mockPlatform.__kv.get(JOURNAL_KEY);
  return raw ? Object.keys(JSON.parse(raw) as Record<string, string>) : [];
}

async function ids(): Promise<string[]> {
  const wallet = await MultiAccountWalletService.getCurrentWallet();
  return (wallet?.accounts ?? []).map((a) => a.id);
}

/** Metadata of the orphan's account, as the writers see it (a stored record). */
function metadataKeysFor(id: string): string[] {
  return [...mockPlatform.__kv.keys(), ...mockPlatform.__secure.keys()].filter(
    (k) => k.includes(id) && !k.startsWith('voi_account_secret_')
  );
}

type Add = {
  name: string;
  /** The record that adds in place over the orphan's surviving key. */
  record: (orphan: BackupAccountData) => BackupAccountData;
  options: () => { oldPinSession?: { epoch: number } };
};

const ADDS: Add[] = [
  {
    name: 'a bound key-less rekeyed record',
    record: (o) => keylessRekeyed(ORPHAN_ID, o.address, o.publicKey),
    options: () => ({
      oldPinSession: { epoch: SessionKeyVault.currentEpoch() },
    }),
  },
  {
    name: 'a key-matches add (the file holds the phrase of the surviving key)',
    record: (o) => o,
    options: () => ({}),
  },
];

beforeEach(() => {
  mockPlatform.__reset();
  SessionKeyVault.clear();
  AccountSecureStorage.clearPrivateKeyCache();
  jest.restoreAllMocks();
});

describe.each(ADDS)(
  'TASK-504 5.6 item 1: $name writes no slot and is never journaled',
  (add) => {
    it('(a) a later record fails: never journaled, the slot is byte-identical, the metadata is undone by id', async () => {
      const orphan = await oldPinDevice();
      const slotBefore = mockPlatform.__secure.get(SLOT);
      expect(typeof slotBefore).toBe('string');

      const journalDuringLaterRecord: string[][] = [];
      const real =
        AccountSecureStorage.storeAccountForRestore.bind(AccountSecureStorage);
      jest
        .spyOn(AccountSecureStorage, 'storeAccountForRestore')
        .mockImplementation(async (account, key, gen, ctx) => {
          if (account.id === 'later') {
            // The first record is already added in place: nothing of it may be
            // in the journal now, and the slot has not moved.
            journalDuringLaterRecord.push(journalIds());
            expect(mockPlatform.__secure.get(SLOT)).toBe(slotBefore);
            throw new Error('later record failed');
          }
          return real(account, key, gen, ctx);
        });
      const deleteByToken = jest.spyOn(
        AccountSecureStorage,
        'deleteAccountIfAttemptMatches'
      );
      const metadataOnly = jest.spyOn(
        AccountSecureStorage,
        'removeAccountMetadataOnly'
      );

      await expect(
        restoreAccounts([add.record(orphan), standard('later')], add.options())
      ).rejects.toMatchObject({ code: 'RESTORE_FAILED' });

      expect(journalDuringLaterRecord).toEqual([[]]);
      expect(journalIds()).toEqual([]);
      expect(mockPlatform.__secure.get(SLOT)).toBe(slotBefore);
      expect(deleteByToken).not.toHaveBeenCalled();
      expect(metadataOnly).toHaveBeenCalledWith(ORPHAN_ID);
      expect(await ids()).toEqual([]);
      expect(metadataKeysFor(ORPHAN_ID)).toEqual([]);
      // The surviving key still opens with the vault filled.
      const key = await AccountSecureStorage.getPrivateKey(ORPHAN_ID);
      expect(Buffer.from(key.slice(32)).toString('hex')).toBe(orphan.publicKey);
    });

    it('(b) killed during C after the add, then boot reconcile: the slot is byte-identical and the add never reached the journal', async () => {
      const orphan = await oldPinDevice();
      const slotBefore = mockPlatform.__secure.get(SLOT);
      const gen = AccountSecureStorage.getResetGeneration();

      // Step C up to the kill: the in-place add, then a journaled new slot for
      // the next record, and no wallet blob.
      const record = add.record(orphan);
      if (record.type === AccountType.REKEYED) {
        const stored = await AccountSecureStorage.storeKeylessAccountForRestore(
          { ...record, lastUsed: new Date().toISOString() } as never,
          gen,
          'restore',
          add.options().oldPinSession
        );
        expect(stored.bound).toBe(true);
      } else {
        const sk = algosdk.mnemonicToSecretKey(record.mnemonic!).sk;
        const written = await AccountSecureStorage.storeAccountForRestore(
          {
            ...record,
            mnemonic: '',
            lastUsed: new Date().toISOString(),
          } as never,
          sk,
          gen
        );
        expect(written.kind).toBe('in-place');
      }
      const later = standard('new-1');
      const laterWritten = await AccountSecureStorage.storeAccountForRestore(
        { ...later, mnemonic: '' } as never,
        algosdk.mnemonicToSecretKey(later.mnemonic!).sk,
        gen
      );
      expect(laterWritten.kind).toBe('written');
      expect(journalIds()).toEqual(['new-1']);
      expect(mockPlatform.__secure.get(SLOT)).toBe(slotBefore);

      // The process dies: memory goes, storage stays. Boot.
      SessionKeyVault.clear();
      AccountSecureStorage.clearPrivateKeyCache();
      await reconcileCrossStoreHalfState();

      expect(mockPlatform.__secure.get(SLOT)).toBe(slotBefore);
      expect(journalIds()).not.toContain(ORPHAN_ID);
    });
  }
);
