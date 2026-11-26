// TASK-504 rule 6 exercise: a key added on a device that already has a PIN
// (the shared writer storeAccountForCreation, used by import AND restore).
// Real AccountSecureStorage + SessionKeyVault + device-key crypto; only the
// platform storage is an in-memory mock. SECURITY NOTE: keys are generated
// in-process by algosdk and never leave this test.

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
import {
  AccountRetrievalError,
  AuthenticationRequiredError,
} from '@/types/wallet';

const PIN = '123456';
const mockPlatform = platform as unknown as {
  __secure: Map<string, string>;
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

function payload(id: string): Record<string, unknown> {
  const raw = mockPlatform.__secure.get(`voi_account_secret_${id}`);
  return raw ? JSON.parse(raw) : {};
}

describe('TASK-504 rule 6: protection of a key added on a device with a PIN', () => {
  beforeEach(() => {
    mockPlatform.__reset();
    SessionKeyVault.clear();
    // getPrivateKey caches a key per account id for 60 s; the two tests reuse
    // ids with different key pairs, so a stale entry would read as the wrong key.
    AccountSecureStorage.clearPrivateKeyCache();
  });

  const shape = (p: Record<string, unknown>) => ({
    deviceKeyCopyLength: String(p.encryptedPrivateKey ?? '').length,
    pinWrappedBlobs: Array.isArray(p.blobs) ? (p.blobs as unknown[]).length : 0,
  });

  async function setUpAAndLaterAddedB() {
    const A = makeAccount('acct-A'); // present when the PIN is set
    const B = makeAccount('acct-B'); // added after the PIN (import/restore writer)
    await AccountSecureStorage.storeAccountForCreation(
      A.meta,
      A.sk,
      AccountSecureStorage.getResetGeneration()
    );
    await AccountSecureStorage.setupPin(PIN, 'pin');
    expect(await AccountSecureStorage.hasPin()).toBe(true);
    await AccountSecureStorage.storeAccountForCreation(
      B.meta,
      B.sk,
      AccountSecureStorage.getResetGeneration()
    );
    return { A, B };
  }

  it('storage pin: a key present at PIN setup is PIN-wrapped; a later-added key is device-key only until the first unlocked read, then PIN-wrapped', async () => {
    await setUpAAndLaterAddedB();

    // Before any unlocked read.
    expect(shape(payload('acct-A'))).toEqual({
      deviceKeyCopyLength: 0,
      pinWrappedBlobs: 1,
    });
    expect(shape(payload('acct-B'))).toEqual({
      deviceKeyCopyLength: 335,
      pinWrappedBlobs: 0,
    });

    // After the first unlocked read of B (lazy re-wrap in the reader).
    SessionKeyVault.set(PIN, 'pin');
    await AccountSecureStorage.getPrivateKey('acct-B');
    // The re-wrap is fire-and-forget inside the reader: wait for it to land.
    for (
      let i = 0;
      i < 40 && shape(payload('acct-B')).pinWrappedBlobs === 0;
      i++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(shape(payload('acct-B'))).toEqual({
      deviceKeyCopyLength: 0,
      pinWrappedBlobs: 1,
    });
    // A is unchanged by reading B.
    expect(shape(payload('acct-A'))).toEqual({
      deviceKeyCopyLength: 0,
      pinWrappedBlobs: 1,
    });
  });

  it('reader: with the vault locked neither key reads; unlocked, both read back as stored', async () => {
    const { A, B } = await setUpAAndLaterAddedB();

    SessionKeyVault.clear();
    AccountSecureStorage.clearPrivateKeyCache();
    for (const id of ['acct-A', 'acct-B']) {
      const err = await AccountSecureStorage.getPrivateKey(id).then(
        () => null,
        (e: Error) => e
      );
      // The normal route to the PIN (callers re-auth on this class), not a key
      // failure: never AccountRetrievalError.
      expect(err).toBeInstanceOf(AuthenticationRequiredError);
      expect(err).not.toBeInstanceOf(AccountRetrievalError);
    }

    SessionKeyVault.set(PIN, 'pin');
    const readA = await AccountSecureStorage.getPrivateKey('acct-A');
    const readB = await AccountSecureStorage.getPrivateKey('acct-B');
    expect(Buffer.from(readA).equals(Buffer.from(A.sk))).toBe(true);
    expect(Buffer.from(readB).equals(Buffer.from(B.sk))).toBe(true);
  });

  it('backup-side read: a failing lazy migration neither fails the read nor changes the key returned', async () => {
    const { B } = await setUpAAndLaterAddedB();
    SessionKeyVault.set(PIN, 'pin');
    const spy = jest
      .spyOn(AccountSecureStorage, 'migrateAccountToV2')
      .mockRejectedValue(new Error('migration exploded'));
    try {
      const key = await AccountSecureStorage.getPrivateKey('acct-B');
      expect(Buffer.from(key).equals(Buffer.from(B.sk))).toBe(true);
      expect(spy).toHaveBeenCalledTimes(1);
      // Let the rejected fire-and-forget settle: no unhandled rejection.
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      spy.mockRestore();
    }
    // The stored form is untouched by the failed migration.
    expect(shape(payload('acct-B'))).toEqual({
      deviceKeyCopyLength: 335,
      pinWrappedBlobs: 0,
    });
  });

  it('the post-unlock sweep (what AuthContext.unlock fires) re-wraps a later-added key under the PIN', async () => {
    const A = makeAccount('acct-A');
    const B = makeAccount('acct-B'); // added after the PIN
    await AccountSecureStorage.storeAccountForCreation(
      A.meta,
      A.sk,
      AccountSecureStorage.getResetGeneration()
    );
    await AccountSecureStorage.setupPin(PIN, 'pin');
    await AccountSecureStorage.storeAccountForCreation(
      B.meta,
      B.sk,
      AccountSecureStorage.getResetGeneration()
    );
    const before = shape(payload('acct-B'));
    expect(before).toEqual({ deviceKeyCopyLength: 335, pinWrappedBlobs: 0 });

    // unlock(): verifyPin, then SessionKeyVault.set, then a fire-and-forget
    // migrateAllAccountsToV2() (AuthContext.tsx:871 to 900). Awaited here.
    expect(await AccountSecureStorage.verifyPin(PIN)).toBe(true);
    SessionKeyVault.set(PIN, 'pin');
    await AccountSecureStorage.migrateAllAccountsToV2();

    const after = shape(payload('acct-B'));

    expect(after).toEqual({ deviceKeyCopyLength: 0, pinWrappedBlobs: 1 });
    const key = await AccountSecureStorage.getPrivateKey('acct-B');
    expect(Buffer.from(key).equals(Buffer.from(B.sk))).toBe(true);
  });
});
