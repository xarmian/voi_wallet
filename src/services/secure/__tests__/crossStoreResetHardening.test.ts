// TASK-220 — cross-store (secret ↔ wallet-metadata) reset hardening. These prove
// the secure-store half of the "no orphaned key / no phantom account / no
// resurrection after a delete-everything" invariant (see DOC-221):
//
//   * storeAccountForCreation writes the secret AND records an ownership token in
//     the durable pending-creation journal;
//   * a full reset racing an in-flight creation ABORTS it (ResetRacedError) and
//     the reset drains the journal + deletes the just-written secret (reset wins);
//   * a duplicate pending id is rejected so an earlier raced attempt can never
//     delete a later same-id attempt's secret;
//   * ownership-checked rollback deletes ONLY the attempt's own secret;
//   * the durable wipe tombstone is STICKY after a reset (never cleared, even by a
//     later commit) and permanently blocks legacy-blob resurrection.
//
// SECURITY NOTE: key material is throwaway random bytes; nothing real is used or
// logged. secureStorage / AsyncStorage are in-memory Map sinks.

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
      getItemWithAuth: jest.fn(async (k: string) =>
        mockSecure.has(k) ? mockSecure.get(k)! : null
      ),
      setItemWithAuth: jest.fn(async (k: string, v: string) => {
        mockSecure.set(k, v);
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
    deviceId: { getDeviceId: async () => 'task220-test-device' },
  };
});

import { AccountSecureStorage } from '../AccountSecureStorage';
import {
  AccountType,
  ResetRacedError,
  DuplicatePendingCreateError,
  StandardAccountMetadata,
} from '@/types/wallet';

const SECRET_PREFIX = 'voi_account_secret_';
const JOURNAL_KEY = 'voi_pending_account_creates';
const TOMBSTONE_KEY = 'voi_secure_wiped';
const LEGACY_PREFIX = 'voi_account_';
const METADATA_PREFIX = 'voi_account_metadata_';

const nodeCrypto = require('crypto');

function standardAccount(id: string): StandardAccountMetadata {
  return {
    id,
    address: `ADDR_${id}`,
    publicKey: 'aa'.repeat(32),
    type: AccountType.STANDARD,
    label: id,
    color: '#123456',
    isHidden: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    mnemonic: '',
    hasBackup: true,
  } as StandardAccountMetadata;
}

function freshSk(): Uint8Array {
  return Uint8Array.from(nodeCrypto.randomBytes(64));
}

const hasSecret = (id: string) => mockSecure.has(`${SECRET_PREFIX}${id}`);
const journal = (): Record<string, string> => {
  const raw = mockKv.get(JOURNAL_KEY);
  return raw ? (JSON.parse(raw) as Record<string, string>) : {};
};
const tombstoneSet = () => mockKv.get(TOMBSTONE_KEY) != null;

beforeEach(() => {
  mockSecure.clear();
  mockKv.clear();
  jest.clearAllMocks();
});

describe('TASK-220 storeAccountForCreation — atomic guarded write', () => {
  it('writes the secret and journals the ownership token', async () => {
    const acct = standardAccount('a1');
    const gen = AccountSecureStorage.getResetGeneration();
    const token = await AccountSecureStorage.storeAccountForCreation(
      acct,
      freshSk(),
      gen
    );
    expect(hasSecret('a1')).toBe(true);
    expect(journal()['a1']).toBe(token);
  });

  it('ABORTS (ResetRacedError) and writes NOTHING when a reset advanced the generation', async () => {
    const acct = standardAccount('a2');
    const staleGen = AccountSecureStorage.getResetGeneration();
    // A full reset bumps the secure generation (synchronously, at clearAll entry).
    await AccountSecureStorage.clearAll();
    await expect(
      AccountSecureStorage.storeAccountForCreation(acct, freshSk(), staleGen)
    ).rejects.toBeInstanceOf(ResetRacedError);
    expect(hasSecret('a2')).toBe(false);
    expect(journal()['a2']).toBeUndefined();
  });

  it('rejects a DUPLICATE pending id (ownership collision) without touching the first attempt', async () => {
    const gen = AccountSecureStorage.getResetGeneration();
    const first = await AccountSecureStorage.storeAccountForCreation(
      standardAccount('dup'),
      freshSk(),
      gen
    );
    await expect(
      AccountSecureStorage.storeAccountForCreation(
        standardAccount('dup'),
        freshSk(),
        gen
      )
    ).rejects.toBeInstanceOf(DuplicatePendingCreateError);
    // First attempt's ownership is intact.
    expect(journal()['dup']).toBe(first);
    expect(hasSecret('dup')).toBe(true);
  });

  it('post-reset new wallet STILL persists (P2a not regressed): a creation whose generation matches succeeds even with the tombstone set', async () => {
    await AccountSecureStorage.clearAll(); // tombstone set, generation bumped
    const gen = AccountSecureStorage.getResetGeneration();
    const token = await AccountSecureStorage.storeAccountForCreation(
      standardAccount('post'),
      freshSk(),
      gen
    );
    expect(hasSecret('post')).toBe(true);
    expect(journal()['post']).toBe(token);
  });
});

describe('TASK-220 reset drains the journal (reset wins)', () => {
  it('clearAll deletes an in-flight creation secret and clears the journal', async () => {
    const gen = AccountSecureStorage.getResetGeneration();
    await AccountSecureStorage.storeAccountForCreation(
      standardAccount('inflight'),
      freshSk(),
      gen
    );
    expect(hasSecret('inflight')).toBe(true);

    await AccountSecureStorage.clearAll();

    expect(hasSecret('inflight')).toBe(false);
    expect(Object.keys(journal())).toHaveLength(0);
  });

  it('clearAll zeroes the in-memory private-key cache (Codex diff-review P1)', async () => {
    const spy = jest.spyOn(AccountSecureStorage, 'clearPrivateKeyCache');
    await AccountSecureStorage.clearAll();
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

describe('TASK-220 ownership-safe rollback', () => {
  it('deleteAccountIfAttemptMatches is a NO-OP for a non-matching token', async () => {
    const gen = AccountSecureStorage.getResetGeneration();
    await AccountSecureStorage.storeAccountForCreation(
      standardAccount('own'),
      freshSk(),
      gen
    );
    await AccountSecureStorage.deleteAccountIfAttemptMatches('own', 'not-mine');
    expect(hasSecret('own')).toBe(true); // a later/other owner's secret is safe
  });

  it('deleteAccountIfAttemptMatches deletes the secret + journal entry for a matching token', async () => {
    const gen = AccountSecureStorage.getResetGeneration();
    const token = await AccountSecureStorage.storeAccountForCreation(
      standardAccount('own2'),
      freshSk(),
      gen
    );
    await AccountSecureStorage.deleteAccountIfAttemptMatches('own2', token);
    expect(hasSecret('own2')).toBe(false);
    expect(journal()['own2']).toBeUndefined();
  });
});

describe('TASK-220 wipe tombstone lifecycle', () => {
  it('is NOT cleared by a bare secret write (crash window stays closed)', async () => {
    await AccountSecureStorage.clearAll();
    expect(tombstoneSet()).toBe(true);
    const gen = AccountSecureStorage.getResetGeneration();
    await AccountSecureStorage.storeAccountForCreation(
      standardAccount('t1'),
      freshSk(),
      gen
    );
    // The secret is committed but the wallet metadata is not yet — the tombstone
    // must remain until the metadata commit (commitPendingCreate).
    expect(tombstoneSet()).toBe(true);
  });

  it('is STICKY: commitPendingCreate drops the journal entry but does NOT clear the tombstone (Codex diff-review P1)', async () => {
    await AccountSecureStorage.clearAll();
    const gen = AccountSecureStorage.getResetGeneration();
    const token = await AccountSecureStorage.storeAccountForCreation(
      standardAccount('t2'),
      freshSk(),
      gen
    );
    await AccountSecureStorage.commitPendingCreate('t2', token);
    // The tombstone stays set — a surviving legacy blob for ANY old id must
    // remain un-resurrectable after a reset.
    expect(tombstoneSet()).toBe(true);
    // The journal entry, however, is finalized.
    expect(journal()['t2']).toBeUndefined();
  });

  it('stays set across a later reset too (never clobbered / never cleared)', async () => {
    await AccountSecureStorage.clearAll();
    const gen = AccountSecureStorage.getResetGeneration();
    const token = await AccountSecureStorage.storeAccountForCreation(
      standardAccount('t3'),
      freshSk(),
      gen
    );
    await AccountSecureStorage.clearAll(); // a LATER reset re-sets it
    expect(tombstoneSet()).toBe(true);
    await AccountSecureStorage.commitPendingCreate('t3', token);
    expect(tombstoneSet()).toBe(true);
  });
});

describe('TASK-220 legacy resurrection block', () => {
  it('migration is BLOCKED while the wipe tombstone is set, and ALLOWED once cleared', async () => {
    const id = 'legacy1';
    const legacyBlob = JSON.stringify({
      accountId: id,
      address: `ADDR_${id}`,
      type: 'standard',
      publicData: {
        publicKey: 'bb'.repeat(32),
        label: id,
        color: '#000000',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      authMethod: 'biometric',
      lastAccessed: '2026-01-01T00:00:00.000Z',
      encryptedPrivateKey: { format: 'test-envelope' },
    });

    // A wipe happened: tombstone set, but a legacy secure-store copy survives.
    mockKv.set(TOMBSTONE_KEY, '1');
    mockSecure.set(`${LEGACY_PREFIX}${id}`, legacyBlob);

    // A read that misses the primary metadata must NOT resurrect the account.
    await expect(AccountSecureStorage.retrieveAccount(id)).rejects.toThrow();
    expect(mockKv.has(`${METADATA_PREFIX}${id}`)).toBe(false); // did not migrate

    // Clear the tombstone: migration is re-enabled and the legacy copy resurfaces.
    mockKv.delete(TOMBSTONE_KEY);
    const account = await AccountSecureStorage.retrieveAccount(id);
    expect(account.id).toBe(id);
    expect(mockKv.has(`${METADATA_PREFIX}${id}`)).toBe(true); // migrated
  });

  it('sticky tombstone still blocks a surviving legacy blob AFTER a new account is created + committed (Codex diff-review P1)', async () => {
    const oldId = 'old-legacy';
    const legacyBlob = JSON.stringify({
      accountId: oldId,
      address: `ADDR_${oldId}`,
      type: 'standard',
      publicData: {
        publicKey: 'cc'.repeat(32),
        label: oldId,
        color: '#000000',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      authMethod: 'biometric',
      lastAccessed: '2026-01-01T00:00:00.000Z',
      encryptedPrivateKey: { format: 'test-envelope' },
    });

    // Reset the device (sets the sticky tombstone) but a legacy blob for an OLD
    // id survives the best-effort legacy delete.
    await AccountSecureStorage.clearAll();
    mockSecure.set(`${LEGACY_PREFIX}${oldId}`, legacyBlob);

    // Create + commit a brand-new account after the reset.
    const gen = AccountSecureStorage.getResetGeneration();
    const token = await AccountSecureStorage.storeAccountForCreation(
      standardAccount('brand-new'),
      freshSk(),
      gen
    );
    await AccountSecureStorage.commitPendingCreate('brand-new', token);

    // The old legacy secret must STILL be un-resurrectable (tombstone sticky).
    await expect(AccountSecureStorage.retrieveAccount(oldId)).rejects.toThrow();
    expect(mockKv.has(`${METADATA_PREFIX}${oldId}`)).toBe(false);
    // ...while the new account is fully usable.
    const fresh = await AccountSecureStorage.retrieveAccount('brand-new');
    expect(fresh.id).toBe('brand-new');
  });
});
