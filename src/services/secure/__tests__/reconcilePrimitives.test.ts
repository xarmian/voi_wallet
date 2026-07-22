// TASK-222: the secure-store strict primitives the boot reconcile leans on —
// probeSecretPresenceStrict (fail-closed per-secret presence probe, no legacy
// migration WRITE), readPendingCreatesStrict (public strict journal read), and
// dropPendingCreateEntries (unconditional mutex-guarded journal prune). The
// presence probe is the load-bearing fail-closed primitive: it must PROPAGATE a
// read failure/timeout rather than reporting a hiccup as "absent", or the
// reconcile would mass-prune live accounts.
//
// SECURITY NOTE: secureStorage / AsyncStorage are in-memory Map sinks; no key
// material is used.

const mockSecure = new Map<string, string>();
const mockKv = new Map<string, string>();

jest.mock('@/platform', () => {
  const nodeCrypto = require('crypto');
  return {
    crypto: {
      getRandomBytes: async (n: number): Promise<Uint8Array> =>
        Uint8Array.from(nodeCrypto.randomBytes(n)),
      sha256: async (input: string): Promise<string> =>
        nodeCrypto.createHash('sha256').update(input).digest('hex'),
      randomUUID: () => nodeCrypto.randomUUID(),
    },
    secureStorage: {
      getItem: jest.fn(async (k: string) =>
        mockSecure.has(k) ? mockSecure.get(k)! : null
      ),
      setItem: jest.fn(async (k: string, v: string) => {
        mockSecure.set(k, v);
      }),
      deleteItem: jest.fn(async (k: string) => {
        mockSecure.delete(k);
      }),
    },
    storage: {
      getItem: jest.fn(async (k: string) =>
        mockKv.has(k) ? mockKv.get(k)! : null
      ),
      setItem: jest.fn(async (k: string, v: string) => {
        mockKv.set(k, v);
      }),
      removeItem: jest.fn(async (k: string) => {
        mockKv.delete(k);
      }),
      multiRemove: jest.fn(async (keys: string[]) => {
        keys.forEach((k) => mockKv.delete(k));
      }),
    },
    biometrics: {
      isAvailable: async () => false,
      isEnrolled: async () => false,
    },
    deviceId: { getDeviceId: async () => 'task222-test-device' },
  };
});

import { secureStorage, storage } from '@/platform';
import { AccountSecureStorage } from '../AccountSecureStorage';

const SECRET_PREFIX = 'voi_account_secret_';
const PENDING_CREATES_KEY = 'voi_pending_account_creates';
const mockSecureGet = secureStorage.getItem as jest.Mock;

beforeEach(() => {
  mockSecure.clear();
  mockKv.clear();
  jest.clearAllMocks();
});

describe('probeSecretPresenceStrict', () => {
  it('resolves true when the primary secret is present', async () => {
    mockSecure.set(`${SECRET_PREFIX}acc1`, JSON.stringify({ any: 'payload' }));
    await expect(
      AccountSecureStorage.probeSecretPresenceStrict('acc1')
    ).resolves.toBe(true);
  });

  it('resolves false for a genuinely absent secret', async () => {
    await expect(
      AccountSecureStorage.probeSecretPresenceStrict('missing')
    ).resolves.toBe(false);
  });

  it('PROPAGATES a read failure (fail closed, not false)', async () => {
    mockSecureGet.mockRejectedValueOnce(new Error('keystore wedged'));
    await expect(
      AccountSecureStorage.probeSecretPresenceStrict('acc1')
    ).rejects.toThrow('keystore wedged');
  });

  it('rejects on timeout when the read hangs (bounded)', async () => {
    // A getItem that never settles must become a rejection, not hang boot.
    mockSecureGet.mockImplementationOnce(() => new Promise(() => {}));
    await expect(
      AccountSecureStorage.probeSecretPresenceStrict('acc1', 20)
    ).rejects.toThrow('timed out');
  });

  it('reads ONLY the primary key — no legacy fallback / migration write', async () => {
    await AccountSecureStorage.probeSecretPresenceStrict('acc1');
    // Exactly one getItem, for the primary secret key; no write anywhere.
    expect(mockSecureGet).toHaveBeenCalledTimes(1);
    expect(mockSecureGet).toHaveBeenCalledWith(`${SECRET_PREFIX}acc1`);
    expect(secureStorage.setItem).not.toHaveBeenCalled();
  });
});

describe('readPendingCreatesStrict', () => {
  it('returns the journal contents', async () => {
    mockKv.set(PENDING_CREATES_KEY, JSON.stringify({ a: 't1', b: 't2' }));
    await expect(
      AccountSecureStorage.readPendingCreatesStrict()
    ).resolves.toEqual({ a: 't1', b: 't2' });
  });

  it('returns {} when the journal is absent', async () => {
    await expect(
      AccountSecureStorage.readPendingCreatesStrict()
    ).resolves.toEqual({});
  });

  it('PROPAGATES a storage read failure', async () => {
    (storage.getItem as jest.Mock).mockRejectedValueOnce(
      new Error('kv read failed')
    );
    await expect(
      AccountSecureStorage.readPendingCreatesStrict()
    ).rejects.toThrow('kv read failed');
  });
});

describe('dropPendingCreateEntries', () => {
  it('removes only the listed ids and leaves the rest', async () => {
    mockKv.set(
      PENDING_CREATES_KEY,
      JSON.stringify({ a: 't1', b: 't2', c: 't3' })
    );
    await AccountSecureStorage.dropPendingCreateEntries(['a', 'c']);
    await expect(
      AccountSecureStorage.readPendingCreatesStrict()
    ).resolves.toEqual({ b: 't2' });
  });

  it('clears the journal key entirely when the last entry is dropped', async () => {
    mockKv.set(PENDING_CREATES_KEY, JSON.stringify({ only: 't1' }));
    await AccountSecureStorage.dropPendingCreateEntries(['only']);
    expect(mockKv.has(PENDING_CREATES_KEY)).toBe(false);
  });

  it('is a no-op for an empty id list (no write)', async () => {
    mockKv.set(PENDING_CREATES_KEY, JSON.stringify({ a: 't1' }));
    await AccountSecureStorage.dropPendingCreateEntries([]);
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.removeItem).not.toHaveBeenCalled();
  });

  it('is a no-op when no id matches (no write)', async () => {
    mockKv.set(PENDING_CREATES_KEY, JSON.stringify({ a: 't1' }));
    await AccountSecureStorage.dropPendingCreateEntries(['x', 'y']);
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.removeItem).not.toHaveBeenCalled();
    await expect(
      AccountSecureStorage.readPendingCreatesStrict()
    ).resolves.toEqual({ a: 't1' });
  });
});
