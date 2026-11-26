// TASK-504: the direct, read-only secret-slot check. Restore uses it to decide,
// per record, whether the id's slot is empty (write), holds the file's own key
// (add the record only), holds a different key, or holds something that will not
// open. It is built from the three reads the slot can hold (primary secret,
// legacy blob, wipe tombstone) and the key reader, and it never reads a failed
// read as empty. Real AccountSecureStorage; only platform storage is mocked.

jest.mock('@/platform', () => {
  const nodeCrypto = require('crypto');
  const secure = new Map<string, string>();
  const kv = new Map<string, string>();
  const failing = new Set<string>();
  return {
    __secure: secure,
    __kv: kv,
    __failing: failing,
    __reset: () => {
      secure.clear();
      kv.clear();
      failing.clear();
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
        if (failing.has(`secure:${k}`)) throw new Error('keychain read failed');
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
      getItem: async (k: string) => {
        if (failing.has(`kv:${k}`)) throw new Error('storage read failed');
        return kv.has(k) ? kv.get(k)! : null;
      },
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

const mockPlatform = platform as unknown as {
  __secure: Map<string, string>;
  __kv: Map<string, string>;
  __failing: Set<string>;
  __reset: () => void;
};

const SECRET = (id: string) => `voi_account_secret_${id}`;
const LEGACY = (id: string) => `voi_account_${id}`;
const TOMBSTONE = 'voi_secure_wiped';

type Slot = { state: string; vault: 'locked' | 'unlocked' };
const inspect = (id: string, address: string): Promise<Slot> =>
  (
    AccountSecureStorage as unknown as {
      inspectSecretSlot: (id: string, address: string) => Promise<Slot>;
    }
  ).inspectSecretSlot(id, address);

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
  return { meta: meta as never, sk: kp.sk, address };
}

async function store(a: ReturnType<typeof makeAccount>) {
  await AccountSecureStorage.storeAccountForCreation(
    a.meta,
    a.sk,
    AccountSecureStorage.getResetGeneration()
  );
}

describe('TASK-504 inspectSecretSlot', () => {
  beforeEach(() => {
    mockPlatform.__reset();
    SessionKeyVault.clear();
  });

  it('reports an untouched id as empty', async () => {
    const a = makeAccount('acct-empty');
    expect(await inspect('acct-empty', a.address)).toEqual({
      state: 'empty',
      vault: 'locked',
    });
  });

  it('reports the file own key as key-matches', async () => {
    const a = makeAccount('acct-own');
    await store(a);
    expect(await inspect('acct-own', a.address)).toEqual({
      state: 'key-matches',
      vault: 'locked',
    });
  });

  it('reports a different key under the id as key-other', async () => {
    const a = makeAccount('acct-diff');
    const b = makeAccount('acct-other');
    await store(a);
    // The file says address b.address belongs at id acct-diff.
    expect(await inspect('acct-diff', b.address)).toEqual({
      state: 'key-other',
      vault: 'locked',
    });
  });

  it('reports a payload that will not open as occupied-unreadable, never empty', async () => {
    const a = makeAccount('acct-junk');
    mockPlatform.__secure.set(SECRET('acct-junk'), '{"not":"a payload"}');
    expect(await inspect('acct-junk', a.address)).toEqual({
      state: 'occupied-unreadable',
      vault: 'locked',
    });
  });

  it('reports a non-JSON payload as occupied-unreadable', async () => {
    const a = makeAccount('acct-garbage');
    mockPlatform.__secure.set(SECRET('acct-garbage'), 'not json at all');
    expect(await inspect('acct-garbage', a.address)).toEqual({
      state: 'occupied-unreadable',
      vault: 'locked',
    });
  });

  it('reports a surviving legacy blob as occupied-unreadable, with or without a tombstone', async () => {
    const a = makeAccount('acct-legacy');
    mockPlatform.__secure.set(LEGACY('acct-legacy'), 'legacy-blob');
    expect(await inspect('acct-legacy', a.address)).toEqual({
      state: 'occupied-unreadable',
      vault: 'locked',
    });
    mockPlatform.__kv.set(TOMBSTONE, '1');
    expect(await inspect('acct-legacy', a.address)).toEqual({
      state: 'occupied-unreadable',
      vault: 'locked',
    });
  });

  it('reports empty when a tombstone is set and both slots are empty', async () => {
    const a = makeAccount('acct-tomb');
    mockPlatform.__kv.set(TOMBSTONE, '1');
    expect(await inspect('acct-tomb', a.address)).toEqual({
      state: 'empty',
      vault: 'locked',
    });
  });

  it('never reads a failed read as empty: each of the three reads', async () => {
    const a = makeAccount('acct-fail');
    for (const failKey of [
      `secure:${SECRET('acct-fail')}`,
      `kv:${TOMBSTONE}`,
      `secure:${LEGACY('acct-fail')}`,
    ]) {
      mockPlatform.__failing.clear();
      mockPlatform.__failing.add(failKey);
      await expect(inspect('acct-fail', a.address)).rejects.toThrow();
    }
  });

  it('does not report a failed key-bearing read as key-other', async () => {
    const a = makeAccount('acct-fail2');
    await store(a);
    mockPlatform.__failing.add(`secure:${SECRET('acct-fail2')}`);
    await expect(inspect('acct-fail2', a.address)).rejects.toThrow();
  });

  it('on a PIN device with the vault locked, a user-secret-wrapped key is occupied-unreadable, not key-other', async () => {
    const a = makeAccount('acct-pin');
    await store(a);
    await AccountSecureStorage.setupPin('123456', 'pin');
    SessionKeyVault.clear();
    const slot = await inspect('acct-pin', a.address);
    expect(slot.state).toBe('occupied-unreadable');
    SessionKeyVault.set('123456', 'pin');
    expect(await inspect('acct-pin', a.address)).toEqual({
      state: 'key-matches',
      vault: 'unlocked',
    });
  });

  it('with the vault unlocked, the check does not re-wrap a device-key account (no lazy migration, no lastAccessed write)', async () => {
    const a = makeAccount('acct-early');
    const b = makeAccount('acct-late'); // added after the PIN: device-key only
    await store(a);
    await AccountSecureStorage.setupPin('123456', 'pin');
    await store(b);
    SessionKeyVault.set('123456', 'pin');
    const snapshot = () =>
      JSON.stringify([
        [...mockPlatform.__secure.entries()].sort(),
        [...mockPlatform.__kv.entries()].sort(),
      ]);
    const before = snapshot();
    expect(await inspect('acct-late', b.address)).toEqual({
      state: 'key-matches',
      vault: 'unlocked',
    });
    // Let any fire-and-forget background write land before comparing.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(snapshot()).toBe(before);
  });

  it('CONTROL: the ordinary reader DOES write on the same setup, so the test above can go red', async () => {
    const a = makeAccount('acct-early2');
    const b = makeAccount('acct-late2');
    await store(a);
    await AccountSecureStorage.setupPin('123456', 'pin');
    await store(b);
    SessionKeyVault.set('123456', 'pin');
    const snapshot = () =>
      JSON.stringify([
        [...mockPlatform.__secure.entries()].sort(),
        [...mockPlatform.__kv.entries()].sort(),
      ]);
    const before = snapshot();
    const raw = JSON.parse(mockPlatform.__secure.get(SECRET('acct-late2'))!);
    expect(typeof raw.encryptedPrivateKey).toBe('string');
    expect(raw.encryptedPrivateKey.length).toBeGreaterThan(0);
    const key = await AccountSecureStorage.getPrivateKey('acct-late2');
    key.fill(0);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const after = snapshot();
    const rawAfter = JSON.parse(
      mockPlatform.__secure.get(SECRET('acct-late2'))!
    );

    console.log(
      'CONTROL getPrivateKey on unlocked vault: snapshot changed =',
      after !== before,
      '| device-key copy length before/after =',
      raw.encryptedPrivateKey.length,
      '/',
      String(rawAfter.encryptedPrivateKey ?? '').length,
      '| blobs after =',
      Array.isArray(rawAfter.blobs) ? rawAfter.blobs.length : 0
    );
    expect(after).not.toBe(before);
  });

  it('a failed PIN-state read propagates; it is not reported as unreadable', async () => {
    const a = makeAccount('acct-pinread');
    await store(a);
    await AccountSecureStorage.setupPin('123456', 'pin');
    SessionKeyVault.clear();
    mockPlatform.__failing.add('secure:voi_wallet_pin');
    await expect(inspect('acct-pinread', a.address)).rejects.toThrow();
  });

  it('writes nothing: storage is byte-identical before and after, for every state', async () => {
    const own = makeAccount('acct-ro-own');
    await store(own);
    mockPlatform.__secure.set(SECRET('acct-ro-junk'), 'junk');
    const snapshot = () =>
      JSON.stringify([
        [...mockPlatform.__secure.entries()].sort(),
        [...mockPlatform.__kv.entries()].sort(),
      ]);
    const before = snapshot();
    await inspect('acct-ro-own', own.address);
    await inspect('acct-ro-junk', own.address);
    await inspect('acct-ro-none', own.address);
    expect(snapshot()).toBe(before);
  });
});
