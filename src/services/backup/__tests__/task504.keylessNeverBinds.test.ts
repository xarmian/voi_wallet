// TASK-504 (dev lead 838d4850 item 2): a record with no phrase never binds to an
// occupied secret slot. An id in a file proves nothing; a key-less record that
// carries a device-key orphan's id and public address must not be listed
// against that slot, or after the PIN is gone the app could sign with a key the
// file never held. Real AccountSecureStorage + wallet service + restoreAccounts;
// only platform storage is in memory. Keys are generated in-process.

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

const OLD_PIN = '123456';
const mockPlatform = platform as unknown as {
  __secure: Map<string, string>;
  __kv: Map<string, string>;
  __reset: () => void;
};

function makeKeyed(id: string) {
  const kp = algosdk.generateAccount();
  const address = kp.addr.toString();
  const publicKey = Buffer.from(
    algosdk.decodeAddress(address).publicKey
  ).toString('hex');
  const meta = {
    id,
    address,
    publicKey,
    type: 'standard',
    label: id,
    color: '#000000',
    isHidden: false,
    createdAt: new Date().toISOString(),
    importedAt: new Date().toISOString(),
    lastUsed: new Date().toISOString(),
    mnemonic: '',
    hasBackup: false,
    backupVerified: false,
  };
  return { meta: meta as never, sk: kp.sk, address, publicKey };
}

describe('TASK-504: a record with no phrase never binds to an occupied slot', () => {
  const SLOT = 'voi_account_secret_orphan-devkey';

  async function deviceWithDeviceKeyOrphanAfterB() {
    mockPlatform.__reset();
    SessionKeyVault.clear();
    AccountSecureStorage.clearPrivateKeyCache();
    const A = makeKeyed('acct-A');
    const O = makeKeyed('orphan-devkey'); // added after the PIN: device-key copy only
    await AccountSecureStorage.storeAccountForCreation(
      A.meta,
      A.sk,
      AccountSecureStorage.getResetGeneration()
    );
    await AccountSecureStorage.setupPin(OLD_PIN, 'pin');
    await AccountSecureStorage.storeAccountForCreation(
      O.meta,
      O.sk,
      AccountSecureStorage.getResetGeneration()
    );
    // iOS reinstall: app storage gone, keychain kept; step B removed the PIN item.
    mockPlatform.__kv.clear();
    mockPlatform.__secure.delete('voi_wallet_pin');
    SessionKeyVault.clear();
    AccountSecureStorage.clearPrivateKeyCache();
    return O;
  }

  function keylessRekeyedRecord(O: { address: string; publicKey: string }) {
    return {
      id: 'orphan-devkey',
      address: O.address,
      publicKey: O.publicKey,
      type: AccountType.REKEYED,
      label: 'forged',
      color: '#000000',
      isHidden: false,
      createdAt: new Date().toISOString(),
      authAddress: algosdk.generateAccount().addr.toString(),
      canSign: false,
      hasBackup: false,
      // no mnemonic: a record with no phrase
    } as never;
  }

  it('no account is listed under the occupied id, the slot is byte-identical, and no key read succeeds through the new account', async () => {
    const O = await deviceWithDeviceKeyOrphanAfterB();
    const slotBefore = mockPlatform.__secure.get(SLOT);
    expect(slotBefore).toBeDefined();

    await restoreAccounts([keylessRekeyedRecord(O)]);

    // The slot is untouched.
    expect(mockPlatform.__secure.get(SLOT)).toBe(slotBefore);

    const wallet = await MultiAccountWalletService.getCurrentWallet();
    const accounts = wallet?.accounts ?? [];
    // No account is listed under the orphan's id.
    expect(accounts.map((a) => a.id)).not.toContain('orphan-devkey');
    // And no key read succeeds through any account the restore created.
    for (const account of accounts) {
      await expect(
        AccountSecureStorage.getPrivateKey(account.id)
      ).rejects.toBeDefined();
    }
  });

  it('restore never writes or deletes a secret slot for a key-less record', async () => {
    const O = await deviceWithDeviceKeyOrphanAfterB();
    const saveSecret = jest.spyOn(
      AccountSecureStorage as unknown as {
        saveSecret: (...args: unknown[]) => Promise<void>;
      },
      'saveSecret'
    );
    try {
      await restoreAccounts([keylessRekeyedRecord(O)]);
      expect(saveSecret).not.toHaveBeenCalled();
    } finally {
      saveSecret.mockRestore();
    }
  });

  it('a key-less record keeps its file id when that slot reads empty', async () => {
    mockPlatform.__reset();
    SessionKeyVault.clear();
    AccountSecureStorage.clearPrivateKeyCache();
    const O = makeKeyed('free-slot');
    await restoreAccounts([keylessRekeyedRecord({ ...O, address: O.address })]);
    const wallet = await MultiAccountWalletService.getCurrentWallet();
    expect((wallet?.accounts ?? []).map((a) => a.id)).toEqual([
      'orphan-devkey',
    ]);
    expect(mockPlatform.__secure.get(SLOT)).toBeUndefined();
  });
});
