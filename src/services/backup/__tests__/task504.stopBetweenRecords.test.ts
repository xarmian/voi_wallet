// TASK-504 DOC-507 5.4 Decision (dev lead d6ca72b9, condition 3): a typed stop
// thrown between records, here VaultChangedDuringReadError at a record boundary
// on the old-PIN screen. The attempt stops with nothing of it left: the device's
// old slots are byte-identical, the journal holds none of this attempt's ids,
// this attempt's new slots are deleted, and a slot an earlier record bound or
// matched in place is byte-identical too. Real storage + wallet service; only
// the platform is in memory.

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
import { restoreAccounts } from '../restorers';
import type { BackupAccountData } from '../types';

const PIN = '123456';
const ORPHAN_ID = 'orphan-1';
const SLOT_PREFIX = 'voi_account_secret_';
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

function slots(): Record<string, string> {
  return Object.fromEntries(
    [...mockPlatform.__secure.entries()].filter(([k]) =>
      k.startsWith(SLOT_PREFIX)
    )
  );
}

function journalIds(): string[] {
  const raw = mockPlatform.__kv.get(JOURNAL_KEY);
  return raw ? Object.keys(JSON.parse(raw) as Record<string, string>) : [];
}

/** Everything outside the secret slots that names the id, in either store:
 *  its metadata record and its account-list entry. */
function leftovers(id: string): string[] {
  return [...mockPlatform.__kv.entries(), ...mockPlatform.__secure.entries()]
    .filter(([k]) => !k.startsWith(SLOT_PREFIX))
    .filter(([k, v]) => k.includes(id) || v.includes(id))
    .map(([k]) => k);
}

async function ids(): Promise<string[]> {
  const wallet = await MultiAccountWalletService.getCurrentWallet();
  return (wallet?.accounts ?? []).map((a) => a.id);
}

beforeEach(() => {
  mockPlatform.__reset();
  SessionKeyVault.clear();
  AccountSecureStorage.clearPrivateKeyCache();
  jest.restoreAllMocks();
});

describe('TASK-504 5.4 Decision: a typed stop between records leaves nothing of the attempt', () => {
  it('stop after a bound record: new slots deleted, journal empty, the bound slot and the old slots byte-identical', async () => {
    const orphan = await oldPinDevice();
    const before = slots();
    expect(Object.keys(before)).toEqual([`${SLOT_PREFIX}${ORPHAN_ID}`]);
    const epoch = SessionKeyVault.currentEpoch();

    // After the bound record is added in place, the vault moves (another
    // unlock): the next record boundary raises the stop.
    const real =
      AccountSecureStorage.storeKeylessAccountForRestore.bind(
        AccountSecureStorage
      );
    jest
      .spyOn(AccountSecureStorage, 'storeKeylessAccountForRestore')
      .mockImplementation(async (...args) => {
        const result = await real(...args);
        if (result.bound) SessionKeyVault.set(PIN, 'pin');
        return result;
      });

    await expect(
      restoreAccounts(
        [
          standard('new-1'),
          keylessRekeyed(ORPHAN_ID, orphan.address, orphan.publicKey),
          standard('new-2'),
        ],
        { oldPinSession: { epoch } }
      )
    ).rejects.toMatchObject({ code: 'AUTHENTICATION_REQUIRED' });

    expect(slots()).toEqual(before);
    expect(mockPlatform.__secure.has(`${SLOT_PREFIX}new-1`)).toBe(false);
    expect(mockPlatform.__secure.has(`${SLOT_PREFIX}new-2`)).toBe(false);
    expect(journalIds()).toEqual([]);
    expect(await ids()).toEqual([]);
    expect(leftovers(ORPHAN_ID)).toEqual([]);
  });

  it('stop after a key-matches add: new slots deleted, journal empty, the matched slot and the old slots byte-identical', async () => {
    const orphan = await oldPinDevice();
    const before = slots();
    const epoch = SessionKeyVault.currentEpoch();

    const real =
      AccountSecureStorage.storeAccountForRestore.bind(AccountSecureStorage);
    jest
      .spyOn(AccountSecureStorage, 'storeAccountForRestore')
      .mockImplementation(async (...args) => {
        const result = await real(...args);
        if (result.kind === 'in-place') SessionKeyVault.set(PIN, 'pin');
        return result;
      });

    await expect(
      restoreAccounts([standard('new-1'), orphan, standard('new-2')], {
        oldPinSession: { epoch },
      })
    ).rejects.toMatchObject({ code: 'AUTHENTICATION_REQUIRED' });

    expect(slots()).toEqual(before);
    expect(mockPlatform.__secure.has(`${SLOT_PREFIX}new-1`)).toBe(false);
    expect(mockPlatform.__secure.has(`${SLOT_PREFIX}new-2`)).toBe(false);
    expect(journalIds()).toEqual([]);
    expect(await ids()).toEqual([]);
    expect(leftovers(ORPHAN_ID)).toEqual([]);
  });

  it('the stop is typed: the same restore with the vault unchanged completes and lists every record', async () => {
    const orphan = await oldPinDevice();
    const epoch = SessionKeyVault.currentEpoch();

    const result = await restoreAccounts(
      [
        standard('new-1'),
        keylessRekeyed(ORPHAN_ID, orphan.address, orphan.publicKey),
        standard('new-2'),
      ],
      { oldPinSession: { epoch } }
    );

    expect(result.records.map((r) => r.outcome)).toEqual([
      'added',
      'added-in-place',
      'added',
    ]);
    expect((await ids()).sort()).toEqual(['new-1', 'new-2', ORPHAN_ID].sort());
    expect(journalIds()).toEqual([]);
  });
});
