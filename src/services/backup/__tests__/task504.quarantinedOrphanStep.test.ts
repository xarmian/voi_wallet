// TASK-504 (dev lead 356ede6e, TASK-508 trail): the removed-last-account state
// with an orphan that boot reconcile quarantined.
//   Test 1: the forgotten-PIN step runs over it, and the quarantined slot (and
//           the registry that indexes it) is byte-identical afterwards, through
//           B and through an add-only restore of the file.
//   Test 2: records what the recovery wipe (AccountSecureStorage.clearAll, the
//           erase behind "Reset") then does to that slot. No code change is
//           ruled: a wipe is a typed user action, not the step.
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
import { removeOldPinForRestore, restoreAccounts } from '../restorers';
import type { BackupAccountData } from '../types';

const OLD_PIN = '123456';
const GONE_SLOT = 'voi_account_secret_gone-1';
const ORPHAN_SLOT = 'voi_account_secret_orphan-1';
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

/** The removed-last-account state: the PIN kept, the wallet holding no account,
 *  a leftover key (gone-1) that boot reconcile has quarantined, and a second,
 *  unlisted PIN-wrapped orphan (orphan-1) that no index names. */
async function removedLastAccountDevice() {
  await restoreAccounts([standard('orphan-1')]);
  await AccountSecureStorage.setupPin(OLD_PIN, 'pin');
  // The orphan loses its index (a reinstall); only its slot remains.
  await AccountSecureStorage.removeAccountMetadataOnly('orphan-1');
  mockPlatform.__kv.clear();

  await restoreAccounts([standard('gone-1')]);
  // The last account is removed from the wallet; its key is left behind.
  await MultiAccountWalletService.clearAllWallets();
  SessionKeyVault.clear();
  AccountSecureStorage.clearPrivateKeyCache();

  const result = await reconcileCrossStoreHalfState();
  return result;
}

/** The removal also dropped the key's index (account list entry and metadata);
 *  the registry written by the earlier boot reconcile still names the slot. */
async function dropIndexOfGone() {
  await AccountSecureStorage.removeAccountMetadataOnly('gone-1');
}

const snapshot = () => new Map(mockPlatform.__secure);

beforeEach(() => {
  mockPlatform.__reset();
  SessionKeyVault.clear();
  AccountSecureStorage.clearPrivateKeyCache();
  jest.restoreAllMocks();
});

describe('TASK-504 removed-last-account: an orphan quarantined by boot reconcile', () => {
  it('the state: reconcile quarantines gone-1, the PIN is kept, the wallet holds no account', async () => {
    const result = await removedLastAccountDevice();

    expect(result.orphanSecretsQuarantined).toEqual(['gone-1']);
    expect(await AccountSecureStorage.readQuarantinedIdsStrict()).toEqual([
      'gone-1',
    ]);
    expect(await AccountSecureStorage.hasPinStrict()).toBe(true);
    expect(await MultiAccountWalletService.hasWalletWithAccountsStrict()).toBe(
      false
    );
    expect(typeof mockPlatform.__secure.get(GONE_SLOT)).toBe('string');
  });

  it('while the account list still names the key the step is refused, nothing changed', async () => {
    await removedLastAccountDevice();
    const before = snapshot();
    await expect(removeOldPinForRestore([standard('file-1')])).rejects.toThrow(
      /accounts are listed/
    );
    expect(snapshot()).toEqual(before);
  });

  it('the step runs over it: the quarantined slot, the registry and the unlisted orphan are byte-identical through B and an add-only restore', async () => {
    await removedLastAccountDevice();
    await dropIndexOfGone();
    const before = snapshot();
    const registryBefore =
      await AccountSecureStorage.readQuarantinedIdsStrict();
    const file = [standard('file-1')];

    await removeOldPinForRestore(file);
    expect(await AccountSecureStorage.hasPinStrict()).toBe(false);
    expect(mockPlatform.__secure.get(GONE_SLOT)).toBe(before.get(GONE_SLOT));
    expect(mockPlatform.__secure.get(ORPHAN_SLOT)).toBe(
      before.get(ORPHAN_SLOT)
    );
    expect(await AccountSecureStorage.readQuarantinedIdsStrict()).toEqual(
      registryBefore
    );

    const result = await restoreAccounts(file);
    expect(result.records.map((r) => r.outcome)).toEqual(['added']);
    expect(mockPlatform.__secure.get(GONE_SLOT)).toBe(before.get(GONE_SLOT));
    expect(mockPlatform.__secure.get(ORPHAN_SLOT)).toBe(
      before.get(ORPHAN_SLOT)
    );
    expect(await AccountSecureStorage.readQuarantinedIdsStrict()).toEqual(
      registryBefore
    );
  });

  it('RECORDS the recovery wipe: it deletes the quarantined slot (the registry is its only index) and the restored accounts, and leaves the unindexed orphan', async () => {
    await removedLastAccountDevice();
    await dropIndexOfGone();
    const before = snapshot();
    const file = [standard('file-1')];
    await removeOldPinForRestore(file);
    await restoreAccounts(file);
    expect(typeof mockPlatform.__secure.get(GONE_SLOT)).toBe('string');

    await AccountSecureStorage.clearAll();

    // What the wipe does to each slot, stated as the behaviour today:
    expect(mockPlatform.__secure.has(GONE_SLOT)).toBe(false); // quarantined: deleted
    expect(mockPlatform.__secure.has('voi_account_secret_file-1')).toBe(false); // listed: deleted
    expect(mockPlatform.__secure.get(ORPHAN_SLOT)).toBe(
      before.get(ORPHAN_SLOT) // no index names it: survives
    );
    expect(await AccountSecureStorage.readQuarantinedIdsSalvaged()).toEqual([]);
  });
});
