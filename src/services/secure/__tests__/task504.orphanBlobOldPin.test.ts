// TASK-504 design note section 5: an unlisted (orphan) key blob still opens from
// the OLD PIN, the device id and the blob alone, after the PIN credential is
// removed and a NEW PIN is set. Real AccountSecureStorage + SessionKeyVault +
// envelope crypto; only the platform storage is an in-memory mock. Keys are
// generated in-process by algosdk and never leave this test.

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

import algosdk from 'algosdk';
import * as platform from '@/platform';
import { AccountSecureStorage } from '../AccountSecureStorage';
import { SessionKeyVault } from '../SessionKeyVault';

const OLD_PIN = '123456';
const NEW_PIN = '654321';
const mockPlatform = platform as unknown as {
  __secure: Map<string, string>;
  __kv: Map<string, string>;
  __reset: () => void;
};

function makeAccount(id: string) {
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
  return { meta: meta as never, sk: kp.sk };
}

describe('TASK-504 section 5: orphan blob and the old PIN', () => {
  beforeEach(() => {
    mockPlatform.__reset();
    SessionKeyVault.clear();
    AccountSecureStorage.clearPrivateKeyCache();
  });

  it('an unlisted blob opens from the old PIN after the credential is removed and a new PIN is set', async () => {
    const A = makeAccount('acct-orphan');
    await AccountSecureStorage.storeAccountForCreation(
      A.meta,
      A.sk,
      AccountSecureStorage.getResetGeneration()
    );
    await AccountSecureStorage.setupPin(OLD_PIN, 'pin');
    // The vault is empty, so the key is still stored as written at creation
    // plus the PIN-wrapped blob setupPin added.
    const slot = 'voi_account_secret_acct-orphan';
    const blobBefore = mockPlatform.__secure.get(slot);
    expect(blobBefore).toBeDefined();

    // iOS reinstall: app storage (account list, metadata, flags) is gone;
    // keychain items (the secret slot) survive.
    mockPlatform.__kv.clear();
    expect(await AccountSecureStorage.getAllAccountIds()).toEqual([]);

    // The removal step: the PIN credential item is deleted, nothing else.
    mockPlatform.__secure.delete('voi_wallet_pin');
    expect(await AccountSecureStorage.hasPin()).toBe(false);

    // A new PIN is established. The orphan is not in the account list, so
    // setupPin does not rewrap it.
    SessionKeyVault.clear();
    await AccountSecureStorage.setupPin(NEW_PIN, 'pin');
    expect(await AccountSecureStorage.hasPin()).toBe(true);
    expect(mockPlatform.__secure.get(slot)).toBe(blobBefore);

    // Control: the NEW PIN cannot open the orphan.
    SessionKeyVault.set(NEW_PIN, 'pin');
    AccountSecureStorage.clearPrivateKeyCache();
    await expect(
      AccountSecureStorage.getPrivateKey('acct-orphan')
    ).rejects.toBeDefined();
    expect(mockPlatform.__secure.get(slot)).toBe(blobBefore);

    // The OLD PIN, the device id and the blob open it.
    SessionKeyVault.clear();
    SessionKeyVault.set(OLD_PIN, 'pin');
    AccountSecureStorage.clearPrivateKeyCache();
    const key = await AccountSecureStorage.getPrivateKey('acct-orphan');
    expect(Buffer.from(key).equals(Buffer.from(A.sk))).toBe(true);
  });
  it('a device-key orphan: occupied-unreadable while the PIN exists and the vault is empty, readable by the slot check once the credential is gone', async () => {
    const A = makeAccount('acct-A');
    const B = makeAccount('acct-devkey'); // added after the PIN: device-key copy only
    await AccountSecureStorage.storeAccountForCreation(
      A.meta,
      A.sk,
      AccountSecureStorage.getResetGeneration()
    );
    await AccountSecureStorage.setupPin(OLD_PIN, 'pin');
    await AccountSecureStorage.storeAccountForCreation(
      B.meta,
      B.sk,
      AccountSecureStorage.getResetGeneration()
    );
    const addrB = (B.meta as unknown as { address: string }).address;
    const slot = 'voi_account_secret_acct-devkey';
    const before = mockPlatform.__secure.get(slot);
    expect(JSON.parse(before as string).encryptedPrivateKey).toBeTruthy();

    // iOS reinstall: app storage gone, keychain kept; vault empty; PIN item present.
    mockPlatform.__kv.clear();
    SessionKeyVault.clear();
    expect(await AccountSecureStorage.hasPinStrict()).toBe(true);
    expect(
      await AccountSecureStorage.inspectSecretSlot('acct-devkey', addrB)
    ).toEqual({ state: 'occupied-unreadable', vault: 'locked' });

    // The removal step's effect: the PIN credential item is gone.
    mockPlatform.__secure.delete('voi_wallet_pin');
    expect(await AccountSecureStorage.hasPinStrict()).toBe(false);
    expect(
      await AccountSecureStorage.inspectSecretSlot('acct-devkey', addrB)
    ).toEqual({ state: 'key-matches', vault: 'locked' });
    // The check wrote nothing.
    expect(mockPlatform.__secure.get(slot)).toBe(before);
  });
  it('the full wipe (the recovery screen Reset path) leaves unlisted slots in place', async () => {
    const A = makeAccount('acct-listed');
    const O = makeAccount('acct-unlisted');
    for (const x of [A, O]) {
      await AccountSecureStorage.storeAccountForCreation(
        x.meta,
        x.sk,
        AccountSecureStorage.getResetGeneration()
      );
    }
    await AccountSecureStorage.setupPin(OLD_PIN, 'pin');
    const unlistedSlot = 'voi_account_secret_acct-unlisted';
    const before = mockPlatform.__secure.get(unlistedSlot);
    expect(before).toBeDefined();
    // Make the second account unlisted and unjournaled, as after an iOS
    // reinstall (app storage, including the pending-create journal, is gone),
    // while the first stays listed.
    mockPlatform.__kv.clear();
    mockPlatform.__kv.set('voi_account_list', JSON.stringify(['acct-listed']));

    await AccountSecureStorage.clearAll();

    expect(mockPlatform.__secure.has('voi_account_secret_acct-listed')).toBe(
      false
    );
    expect(mockPlatform.__secure.get(unlistedSlot)).toBe(before);
  });
});
