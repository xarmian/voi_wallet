// TASK-504 4.1 item 1, closed: a vault that locks, unlocks or is replaced WHILE a
// restore's slot check reads leaves a result no single vault state produced.
// It must never decide a write. Real storage; only the platform is in memory.

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
import { AccountType } from '@/types/wallet';
import { restoreAccounts } from '../restorers';
import type { BackupAccountData } from '../types';

const PIN = '123456';
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

function snapshot() {
  return {
    secure: [...mockPlatform.__secure.entries()].sort(),
    kv: [...mockPlatform.__kv.entries()].sort(),
  };
}

/** A PIN-wrapped orphan: the credential and the slot survive, the account list
 *  does not, and the vault is filled (as after a verified old PIN). */
async function pinOrphan() {
  const orphan = standard('orphan-1');
  await restoreAccounts([orphan]);
  await AccountSecureStorage.setupPin(PIN, 'pin');
  mockPlatform.__kv.clear();
  SessionKeyVault.set(PIN, 'pin');
  return orphan;
}

beforeEach(() => {
  mockPlatform.__reset();
  SessionKeyVault.clear();
  AccountSecureStorage.clearPrivateKeyCache();
  jest.restoreAllMocks();
});

type Change = [string, () => void];
const CHANGES: Change[] = [
  ['the vault locks', () => SessionKeyVault.clear()],
  [
    'the vault is replaced by another unlock',
    () => SessionKeyVault.set(PIN, 'pin'),
  ],
];

describe.each(CHANGES)(
  'TASK-504: %s while the slot check reads',
  (_name, change) => {
    it('a keyed record: the restore stops, nothing is written', async () => {
      const orphan = await pinOrphan();
      const original =
        AccountSecureStorage.inspectSecretSlot.bind(AccountSecureStorage);
      jest
        .spyOn(AccountSecureStorage, 'inspectSecretSlot')
        .mockImplementation(async (...args) => {
          const result = await original(...args);
          change();
          return result;
        });
      const before = snapshot();

      await expect(restoreAccounts([orphan])).rejects.toMatchObject({
        code: 'AUTHENTICATION_REQUIRED',
      });

      expect(snapshot()).toEqual(before);
    });

    it('a key-less record: the restore stops, nothing is written', async () => {
      const orphan = await pinOrphan();
      const keyless = {
        ...orphan,
        type: AccountType.WATCH,
        mnemonic: undefined,
      } as unknown as BackupAccountData;
      const original =
        AccountSecureStorage.inspectSecretSlot.bind(AccountSecureStorage);
      jest
        .spyOn(AccountSecureStorage, 'inspectSecretSlot')
        .mockImplementation(async (...args) => {
          const result = await original(...args);
          change();
          return result;
        });
      const before = snapshot();

      await expect(restoreAccounts([keyless])).rejects.toMatchObject({
        code: 'AUTHENTICATION_REQUIRED',
      });

      expect(snapshot()).toEqual(before);
    });
  }
);

it('a vault that does not change leaves the new-id route working: the locked-at-start case is not a change', async () => {
  const orphan = standard('orphan-3');
  await restoreAccounts([orphan]);
  await AccountSecureStorage.setupPin(PIN, 'pin');
  SessionKeyVault.clear();
  mockPlatform.__kv.clear();

  const result = await restoreAccounts([standard('orphan-3')]);

  expect(result.records[0].outcome).toBe('added-new-id');
});
