// TASK-504 DOC-507 5.6 item 2 (dev lead d6ca72b9, condition 2): a restore never
// calls saveSecret with null. A key-less record (watch, Ledger, remote signer,
// key-less rekeyed) takes the file id when its slot reads empty, and that slot
// must STAY empty: a null payload written there would read as "an account with
// no key" and block the id for a later real key. Real storage; only the
// platform is in memory.

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

const SLOT_PREFIX = 'voi_account_secret_';
const mockPlatform = platform as unknown as {
  __secure: Map<string, string>;
  __kv: Map<string, string>;
  __reset: () => void;
};

function base(id: string, type: AccountType) {
  const kp = algosdk.generateAccount();
  const address = kp.addr.toString();
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
  };
}

const KEYLESS_RECORDS = (): BackupAccountData[] =>
  [
    { ...base('w-1', AccountType.WATCH) },
    {
      ...base('l-1', AccountType.LEDGER),
      deviceId: 'ledger-device',
      derivationIndex: 0,
      ledgerDerivationPath: "44'/283'/0'/0/0",
    },
    {
      ...base('r-1', AccountType.REMOTE_SIGNER),
      signerDeviceId: 'signer-device',
      pairedAt: new Date().toISOString(),
    },
    {
      ...base('k-1', AccountType.REKEYED),
      authAddress: algosdk.generateAccount().addr.toString(),
      originalOwner: false,
      canSign: false,
    },
  ] as unknown as BackupAccountData[];

function slotKeys(): string[] {
  return [...mockPlatform.__secure.keys()].filter((k) =>
    k.startsWith(SLOT_PREFIX)
  );
}

beforeEach(() => {
  mockPlatform.__reset();
  SessionKeyVault.clear();
  AccountSecureStorage.clearPrivateKeyCache();
  jest.restoreAllMocks();
});

describe('TASK-504 5.6 item 2: a restore never calls saveSecret with null', () => {
  function spySaveSecret() {
    return jest.spyOn(
      AccountSecureStorage as unknown as {
        saveSecret: (...a: unknown[]) => Promise<void>;
      },
      'saveSecret'
    );
  }

  it('every key-less type with an empty slot keeps its file id, saveSecret is never called, and no slot appears', async () => {
    const saveSecret = spySaveSecret();
    const records = KEYLESS_RECORDS();

    const result = await restoreAccounts(records);

    expect(result.records.map((r) => r.outcome)).toEqual([
      'added',
      'added',
      'added',
      'added',
    ]);
    // The file-id case: every record kept its own id over an empty slot.
    expect(result.records.every((r) => r.storedId === undefined)).toBe(true);
    const wallet = await MultiAccountWalletService.getCurrentWallet();
    expect((wallet?.accounts ?? []).map((a) => a.id).sort()).toEqual(
      ['k-1', 'l-1', 'r-1', 'w-1'].sort()
    );
    expect(saveSecret).not.toHaveBeenCalled();
    expect(slotKeys()).toEqual([]);
  });

  it('a key-less record over an occupied slot takes a fresh id: still no saveSecret, the occupied slot untouched', async () => {
    const occupant = base('w-1', AccountType.STANDARD);
    const kp = algosdk.generateAccount();
    await AccountSecureStorage.storeAccountForCreation(
      {
        ...occupant,
        address: kp.addr.toString(),
        mnemonic: '',
        hasBackup: false,
        backupVerified: false,
      } as never,
      kp.sk,
      AccountSecureStorage.getResetGeneration()
    );
    mockPlatform.__kv.clear();
    AccountSecureStorage.clearPrivateKeyCache();
    const slotBefore = mockPlatform.__secure.get(`${SLOT_PREFIX}w-1`);
    expect(typeof slotBefore).toBe('string');

    const saveSecret = spySaveSecret();
    const result = await restoreAccounts(KEYLESS_RECORDS());

    expect(result.records[0].outcome).toBe('added-new-id');
    expect(saveSecret).not.toHaveBeenCalled();
    expect(mockPlatform.__secure.get(`${SLOT_PREFIX}w-1`)).toBe(slotBefore);
    expect(slotKeys()).toEqual([`${SLOT_PREFIX}w-1`]);
  });

  it('a record that carries a key never reaches a null payload either: its saveSecret call, if any, has a payload', async () => {
    const saveSecret = spySaveSecret();
    const kp = algosdk.generateAccount();
    const keyed = {
      ...base('s-1', AccountType.STANDARD),
      address: kp.addr.toString(),
      mnemonic: algosdk.secretKeyToMnemonic(kp.sk),
      hasBackup: true,
    } as unknown as BackupAccountData;

    await restoreAccounts([...KEYLESS_RECORDS(), keyed]);

    expect(saveSecret.mock.calls.length).toBe(1);
    for (const call of saveSecret.mock.calls) {
      expect(call[1]).not.toBeNull();
    }
    expect(slotKeys()).toEqual([`${SLOT_PREFIX}s-1`]);
  });
});
