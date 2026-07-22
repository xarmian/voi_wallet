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
const LEGACY_PREFIX = 'voi_account_';
const WIPE_TOMBSTONE_KEY = 'voi_secure_wiped';
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

  it('resolves false for a genuinely absent secret (no primary, no legacy)', async () => {
    await expect(
      AccountSecureStorage.probeSecretPresenceStrict('missing')
    ).resolves.toBe(false);
  });

  // Codex P2: match the reader's `if (stored)` truthiness — an empty-string
  // primary value is ABSENT to the reader, so the probe must fall through (here,
  // to legacy/tombstone, both empty → false), not report the empty as present.
  it('treats an empty-string primary value as absent (truthiness, not != null)', async () => {
    mockSecure.set(`${SECRET_PREFIX}acc1`, '');
    await expect(
      AccountSecureStorage.probeSecretPresenceStrict('acc1')
    ).resolves.toBe(false);
  });

  // Codex P1: a live account whose key is still in LEGACY format (not yet
  // migrated) has NO primary secret. The reader would migrate it on next access,
  // so the probe MUST count it as present — else the reconcile prunes a real,
  // fund-bearing account as a phantom.
  it('resolves true when only a LEGACY secret exists (migratable, no tombstone)', async () => {
    mockSecure.set(`${LEGACY_PREFIX}acc1`, JSON.stringify({ any: 'legacy' }));
    await expect(
      AccountSecureStorage.probeSecretPresenceStrict('acc1')
    ).resolves.toBe(true);
  });

  // Mirrors migrateLegacyAccountDataLocked: a set wipe tombstone means a
  // surviving legacy blob is intentionally dead and must NOT be resurrected.
  it('resolves false for a legacy-only secret when the wipe tombstone is set', async () => {
    mockSecure.set(`${LEGACY_PREFIX}acc1`, JSON.stringify({ any: 'legacy' }));
    mockKv.set(WIPE_TOMBSTONE_KEY, '1');
    await expect(
      AccountSecureStorage.probeSecretPresenceStrict('acc1')
    ).resolves.toBe(false);
  });

  it('short-circuits on a present primary — no legacy/tombstone read, no write', async () => {
    mockSecure.set(`${SECRET_PREFIX}acc1`, JSON.stringify({ any: 'payload' }));
    await AccountSecureStorage.probeSecretPresenceStrict('acc1');
    // Exactly one secure getItem (the primary); tombstone/legacy never consulted.
    expect(mockSecureGet).toHaveBeenCalledTimes(1);
    expect(mockSecureGet).toHaveBeenCalledWith(`${SECRET_PREFIX}acc1`);
    expect(storage.getItem).not.toHaveBeenCalled();
    expect(secureStorage.setItem).not.toHaveBeenCalled();
  });

  it('never migrates/writes even when it falls through to the legacy blob', async () => {
    mockSecure.set(`${LEGACY_PREFIX}acc1`, JSON.stringify({ any: 'legacy' }));
    await AccountSecureStorage.probeSecretPresenceStrict('acc1');
    // Read-only probe: no secret write, no legacy delete (no migration).
    expect(secureStorage.setItem).not.toHaveBeenCalled();
    expect(secureStorage.deleteItem).not.toHaveBeenCalled();
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

  // Codex P2: unlike the tolerant private reader, the STRICT read must fail
  // closed on corrupt content rather than degrade to {} (which would hide a
  // journal-only half-created secret from the reconcile).
  it('THROWS on unparseable journal content (fail closed, not {})', async () => {
    mockKv.set(PENDING_CREATES_KEY, '{not json');
    await expect(
      AccountSecureStorage.readPendingCreatesStrict()
    ).rejects.toThrow();
  });

  it('THROWS on structurally-invalid journal (non-object)', async () => {
    mockKv.set(PENDING_CREATES_KEY, JSON.stringify(['a', 'b']));
    await expect(
      AccountSecureStorage.readPendingCreatesStrict()
    ).rejects.toThrow('not an object');
  });
});

describe('readAccountListStrict', () => {
  const METADATA_LIST_KEY = 'voi_account_list';

  it('returns the primary list', async () => {
    mockKv.set(METADATA_LIST_KEY, JSON.stringify(['a', 'b']));
    await expect(AccountSecureStorage.readAccountListStrict()).resolves.toEqual(
      ['a', 'b']
    );
  });

  it('returns [] for genuine absence', async () => {
    await expect(AccountSecureStorage.readAccountListStrict()).resolves.toEqual(
      []
    );
  });

  it('reads the legacy list WITHOUT migrating (no write, no delete)', async () => {
    // Primary absent, legacy present: getAllAccountIds would migrate here; the
    // strict read-only sibling must NOT write the primary or delete the legacy.
    mockSecure.set(METADATA_LIST_KEY, JSON.stringify(['c']));
    await expect(AccountSecureStorage.readAccountListStrict()).resolves.toEqual(
      ['c']
    );
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(secureStorage.deleteItem).not.toHaveBeenCalled();
    // Legacy copy still there (untouched).
    expect(mockSecure.get(METADATA_LIST_KEY)).toBe(JSON.stringify(['c']));
  });

  it('PROPAGATES a storage read failure (fail closed)', async () => {
    (storage.getItem as jest.Mock).mockRejectedValueOnce(
      new Error('list read failed')
    );
    await expect(AccountSecureStorage.readAccountListStrict()).rejects.toThrow(
      'list read failed'
    );
  });

  it('THROWS on a corrupt (unparseable) primary list', async () => {
    mockKv.set(METADATA_LIST_KEY, '{not json');
    await expect(
      AccountSecureStorage.readAccountListStrict()
    ).rejects.toThrow();
  });

  // Codex P2: valid JSON that is not a string[] is corruption — returning it
  // would spread non-ids (a bare string spreads per-character) into the
  // reconcile's destructive classification. Must throw (fail closed).
  it('THROWS on valid JSON that is not an array (e.g. a bare string)', async () => {
    mockKv.set(METADATA_LIST_KEY, JSON.stringify('abc'));
    await expect(AccountSecureStorage.readAccountListStrict()).rejects.toThrow(
      'not an array of strings'
    );
  });

  it('THROWS on an array containing non-string entries', async () => {
    mockKv.set(METADATA_LIST_KEY, JSON.stringify(['a', 2, 'c']));
    await expect(AccountSecureStorage.readAccountListStrict()).rejects.toThrow(
      'not an array of strings'
    );
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
