// TASK-505: a restore puts the backup's key back into the empty secret slot of
// an account already on this device. The repair reads strictly first (every
// read bounded, any failure writes nothing), writes only the secret, and then
// reads the slot back: only a key that derives to the record's own address
// counts as repaired. Nothing it writes is ever deleted. Real
// AccountSecureStorage; only platform storage is in memory.

jest.mock('@/platform', () => {
  const nodeCrypto = require('crypto');
  const secure = new Map<string, string>();
  const kv = new Map<string, string>();
  const failing = new Set<string>();
  const hanging = new Set<string>();
  const reads: string[] = [];
  const writes: { key: string; value: string }[] = [];
  // How the NEXT secret-slot set behaves; it falls back to 'normal' after one.
  const nextSet = {
    mode: 'normal' as
      'normal' | 'hang' | 'substitute' | 'land-then-reject' | 'reject',
    substitute: '',
    held: [] as (() => void)[],
  };
  const read = (scope: string, map: Map<string, string>, k: string) => {
    reads.push(`${scope}:${k}`);
    if (failing.has(`${scope}:${k}`))
      return Promise.reject(new Error('read failed'));
    if (hanging.has(`${scope}:${k}`))
      return new Promise<string | null>(() => {});
    return Promise.resolve(map.has(k) ? map.get(k)! : null);
  };
  return {
    __secure: secure,
    __kv: kv,
    __failing: failing,
    __hanging: hanging,
    __reads: reads,
    __writes: writes,
    __nextSet: nextSet,
    __reset: () => {
      secure.clear();
      kv.clear();
      failing.clear();
      hanging.clear();
      reads.length = 0;
      writes.length = 0;
      nextSet.mode = 'normal';
      nextSet.substitute = '';
    },
    crypto: {
      getRandomBytes: async (n: number): Promise<Uint8Array> =>
        Uint8Array.from(nodeCrypto.randomBytes(n)),
      sha256: async (input: string): Promise<string> =>
        nodeCrypto.createHash('sha256').update(input).digest('hex'),
      randomUUID: () => nodeCrypto.randomUUID(),
    },
    secureStorage: {
      getItem: (k: string) => read('secure', secure, k),
      setItem: (k: string, v: string) => {
        writes.push({ key: k, value: v });
        const mode = k.startsWith('voi_account_secret_')
          ? nextSet.mode
          : 'normal';
        if (mode !== 'normal') nextSet.mode = 'normal';
        if (mode === 'hang') {
          return new Promise<void>((resolve) => {
            nextSet.held.push(() => {
              secure.set(k, v);
              resolve();
            });
          });
        }
        if (mode === 'substitute') secure.set(k, nextSet.substitute);
        else if (mode !== 'reject') secure.set(k, v);
        if (mode === 'land-then-reject' || mode === 'reject')
          return Promise.reject(new Error('keychain write failed'));
        return Promise.resolve();
      },
      deleteItem: async (k: string) => {
        secure.delete(k);
      },
      getItemWithAuth: async (k: string) =>
        secure.has(k) ? secure.get(k)! : null,
    },
    storage: {
      getItem: (k: string) => read('kv', kv, k),
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
    deviceId: { getDeviceId: async () => 'task505-device-idfv' },
  };
});

import algosdk from 'algosdk';
import * as platform from '@/platform';
import {
  AccountSecureStorage,
  VaultChangedDuringReadError,
} from '../AccountSecureStorage';
import { SessionKeyVault } from '../SessionKeyVault';
import { WriteOutcomeUnknownError } from '../boundedWrites';
import { AccountType, ResetRacedError } from '@/types/wallet';
import type { AccountMetadata } from '@/types/wallet';

const mockPlatform = platform as unknown as {
  __secure: Map<string, string>;
  __kv: Map<string, string>;
  __failing: Set<string>;
  __hanging: Set<string>;
  __reads: string[];
  __writes: { key: string; value: string }[];
  __nextSet: {
    mode: 'normal' | 'hang' | 'substitute' | 'land-then-reject' | 'reject';
    substitute: string;
    held: (() => void)[];
  };
  __reset: () => void;
};

const PIN = '123456';
const SECRET = (id: string) => `voi_account_secret_${id}`;
const LEGACY = (id: string) => `voi_account_${id}`;
const META = (id: string) => `voi_account_metadata_${id}`;
const LIST = 'voi_account_list';
const PENDING = 'voi_pending_account_creates';
const UNKNOWN = 'voi_unknown_secure_writes';
const TOMBSTONE = 'voi_secure_wiped';

const internals = AccountSecureStorage as unknown as {
  unknownJournalDesired: unknown;
  boundedSecureSet(
    key: string,
    value: string,
    verifier: 'nonce' | 'presence',
    attempt?: string
  ): Promise<void>;
};

let seq = 0;
function makeAccount(
  type: AccountType = AccountType.STANDARD,
  extra: Record<string, unknown> = {}
) {
  const id = `acct-${++seq}`;
  const kp = algosdk.generateAccount();
  const address = kp.addr.toString();
  const publicKey = Buffer.from(
    algosdk.decodeAddress(address).publicKey
  ).toString('hex');
  const now = new Date().toISOString();
  const meta = {
    id,
    address,
    publicKey,
    type,
    label: id,
    color: '#000000',
    isHidden: false,
    createdAt: now,
    importedAt: now,
    lastUsed: now,
    mnemonic: '',
    hasBackup: false,
    backupVerified: false,
    ...extra,
  } as unknown as AccountMetadata;
  return { id, address, publicKey, meta, sk: kp.sk };
}
type Acct = ReturnType<typeof makeAccount>;

const gen = () => AccountSecureStorage.getResetGeneration();

async function seedKeyed(a: Acct) {
  const token = await AccountSecureStorage.storeAccountForCreation(
    a.meta,
    Uint8Array.from(a.sk),
    gen()
  );
  await AccountSecureStorage.commitPendingCreate(a.id, token);
}

/** An account whose record, metadata and list entry exist but whose slot is empty. */
async function seedPhantom(a: Acct) {
  await seedKeyed(a);
  mockPlatform.__secure.delete(SECRET(a.id));
}

function repair(
  a: Acct,
  options: {
    sk?: Uint8Array;
    creationGen?: number;
    stillListed?: () => Promise<boolean>;
  } = {}
) {
  return AccountSecureStorage.repairMissingKeyForRestore(
    a.meta,
    options.sk ?? Uint8Array.from(a.sk),
    options.creationGen ?? gen(),
    options.stillListed ?? (async () => true)
  );
}

function snapshot() {
  return {
    secure: new Map(mockPlatform.__secure),
    kv: new Map(mockPlatform.__kv),
  };
}
function changedKeys(before: ReturnType<typeof snapshot>): string[] {
  const out: string[] = [];
  for (const [scope, was, now] of [
    ['secure', before.secure, mockPlatform.__secure],
    ['kv', before.kv, mockPlatform.__kv],
  ] as const) {
    for (const k of new Set([...was.keys(), ...now.keys()])) {
      if (was.get(k) !== now.get(k)) out.push(`${scope}:${k}`);
    }
  }
  return out.sort();
}
const slotWrites = (id: string) =>
  mockPlatform.__writes.filter((w) => w.key === SECRET(id));

async function publicHalfOf(id: string): Promise<string> {
  const key = await AccountSecureStorage.getPrivateKey(id);
  return Buffer.from(key.slice(32)).toString('hex');
}

beforeEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  mockPlatform.__reset();
  SessionKeyVault.clear();
  AccountSecureStorage.clearPrivateKeyCache();
  internals.unknownJournalDesired = undefined;
});

afterEach(async () => {
  for (const land of mockPlatform.__nextSet.held.splice(0)) land();
  for (let i = 0; i < 5; i++) await Promise.resolve();
  jest.useRealTimers();
});

describe('TASK-505 repairMissingKeyForRestore: the repair', () => {
  it.each([
    ['STANDARD', AccountType.STANDARD, {}],
    [
      'REKEYED with originalOwner',
      AccountType.REKEYED,
      { originalOwner: true, canSign: false },
    ],
  ] as const)(
    'an empty %s slot is repaired: only the slot changes and the key reads back',
    async (_name, type, extra) => {
      const a = makeAccount(type, {
        ...extra,
        ...(type === AccountType.REKEYED
          ? { authAddress: algosdk.generateAccount().addr.toString() }
          : {}),
      });
      await seedPhantom(a);
      const before = snapshot();

      await expect(repair(a)).resolves.toEqual({ kind: 'repaired' });

      expect(changedKeys(before)).toEqual([`secure:${SECRET(a.id)}`]);
      const stored = JSON.parse(mockPlatform.__secure.get(SECRET(a.id))!);
      expect(stored.accountId).toBe(a.id);
      expect(typeof stored.encryptedPrivateKey).toBe('string');
      expect(stored.encryptedPrivateKey.split(':')).toHaveLength(4);
      expect(stored.blobs).toBeUndefined();
      expect(stored.authMethod).toBe('biometric');
      expect(await publicHalfOf(a.id)).toBe(a.publicKey);
    }
  );

  it('with a PIN and the vault unlocked: repaired, and the key reads under the vault', async () => {
    const a = makeAccount();
    await seedKeyed(a);
    await AccountSecureStorage.setupPin(PIN, 'pin');
    SessionKeyVault.set(PIN, 'pin');
    mockPlatform.__secure.delete(SECRET(a.id));

    await expect(repair(a)).resolves.toEqual({ kind: 'repaired' });

    expect(
      JSON.parse(mockPlatform.__secure.get(SECRET(a.id))!).authMethod
    ).toBe('pin');
    await expect(
      AccountSecureStorage.inspectSecretSlot(a.id, a.address)
    ).resolves.toMatchObject({ state: 'key-matches' });
  });

  it('with a PIN and the vault locked: throws, nothing written', async () => {
    const a = makeAccount();
    await seedKeyed(a);
    await AccountSecureStorage.setupPin(PIN, 'pin');
    SessionKeyVault.clear();
    mockPlatform.__secure.delete(SECRET(a.id));
    const before = snapshot();
    mockPlatform.__writes.length = 0;

    await expect(repair(a)).rejects.toBeInstanceOf(VaultChangedDuringReadError);

    expect(changedKeys(before)).toEqual([]);
    expect(mockPlatform.__writes).toEqual([]);
  });
});

describe('TASK-505 repairMissingKeyForRestore: an occupied slot is never written', () => {
  const other = () => makeAccount();
  it.each([
    ['key-matches', 'key-matches', async (_a: Acct) => {}],
    [
      'key-other',
      'key-other',
      async (a: Acct) => {
        const b = other();
        await seedKeyed(b);
        mockPlatform.__secure.set(
          SECRET(a.id),
          mockPlatform.__secure.get(SECRET(b.id))!
        );
      },
    ],
    [
      'corrupt JSON',
      'occupied-unreadable',
      async (a: Acct) => {
        mockPlatform.__secure.set(SECRET(a.id), 'not json');
      },
    ],
    [
      'a legacy blob, no tombstone',
      'occupied-unreadable',
      async (a: Acct) => {
        mockPlatform.__secure.delete(SECRET(a.id));
        mockPlatform.__secure.set(LEGACY(a.id), '{"legacy":true}');
      },
    ],
    [
      'a legacy blob behind a wipe tombstone',
      'occupied-unreadable',
      async (a: Acct) => {
        mockPlatform.__secure.delete(SECRET(a.id));
        mockPlatform.__secure.set(LEGACY(a.id), '{"legacy":true}');
        mockPlatform.__kv.set(TOMBSTONE, '1');
      },
    ],
    [
      'a v2 payload that does not open',
      'occupied-unreadable',
      async (a: Acct) => {
        mockPlatform.__secure.set(
          SECRET(a.id),
          JSON.stringify({
            accountId: a.id,
            encryptedPrivateKey: '',
            authMethod: 'pin',
            version: 2,
            blobs: [{ v: 2, bogus: true }],
          })
        );
      },
    ],
  ] as const)(
    '%s: not-empty, storage byte-identical',
    async (_n, state, arrange) => {
      const a = makeAccount();
      await seedKeyed(a);
      await arrange(a);
      const before = snapshot();
      mockPlatform.__writes.length = 0;

      await expect(repair(a)).resolves.toEqual({ kind: 'not-empty', state });

      expect(changedKeys(before)).toEqual([]);
      expect(mockPlatform.__writes).toEqual([]);
    }
  );
});

describe('TASK-505 repairMissingKeyForRestore: a read that fails or hangs writes nothing', () => {
  const reads: [string, (id: string) => string][] = [
    ['the PIN credential', () => 'secure:voi_wallet_pin'],
    ['the account metadata', (id) => `kv:${META(id)}`],
    ['the account list', () => `kv:${LIST}`],
    ['the pending-creates journal', () => `kv:${PENDING}`],
    ['the unknown-write journal', () => `kv:${UNKNOWN}`],
    ['the primary slot', (id) => `secure:${SECRET(id)}`],
    ['the wipe tombstone', () => `kv:${TOMBSTONE}`],
    ['the legacy slot', (id) => `secure:${LEGACY(id)}`],
  ];

  it.each(reads)('%s read fails: skipped', async (_n, keyOf) => {
    const a = makeAccount();
    await seedPhantom(a);
    const before = snapshot();
    mockPlatform.__writes.length = 0;
    mockPlatform.__failing.add(keyOf(a.id));

    await expect(repair(a)).resolves.toEqual({ kind: 'skipped' });

    expect(mockPlatform.__writes).toEqual([]);
    expect(changedKeys(before)).toEqual([]);
  });

  it.each(reads)(
    '%s read hangs: skipped once the bound fires',
    async (_n, keyOf) => {
      const a = makeAccount();
      await seedPhantom(a);
      mockPlatform.__writes.length = 0;
      jest.useFakeTimers();
      mockPlatform.__hanging.add(keyOf(a.id));

      const result = repair(a);
      await jest.advanceTimersByTimeAsync(20000);

      await expect(result).resolves.toEqual({ kind: 'skipped' });
      expect(mockPlatform.__writes).toEqual([]);
    }
  );

  it('the wallet re-read (stillListed) throws or hangs: skipped', async () => {
    const a = makeAccount();
    await seedPhantom(a);
    mockPlatform.__writes.length = 0;
    await expect(
      repair(a, {
        stillListed: async () => {
          throw new Error('blob read failed');
        },
      })
    ).resolves.toEqual({ kind: 'skipped' });

    jest.useFakeTimers();
    const hung = repair(a, { stillListed: () => new Promise(() => {}) });
    await jest.advanceTimersByTimeAsync(20000);
    await expect(hung).resolves.toEqual({ kind: 'skipped' });
    expect(mockPlatform.__writes).toEqual([]);
  });
});

describe('TASK-505 repairMissingKeyForRestore: an unresolved write for the slot', () => {
  const entry = (key: string) => ({
    key,
    op: 'set',
    verifier: 'nonce',
    attempt: 'a1',
    sessionId: 'an-earlier-session',
    at: 1,
  });

  it.each([
    ['the primary key', SECRET],
    ['the legacy key', LEGACY],
  ] as const)('an unknown-journal entry for %s: skipped', async (_n, keyOf) => {
    const a = makeAccount();
    await seedPhantom(a);
    mockPlatform.__kv.set(
      UNKNOWN,
      JSON.stringify({ [keyOf(a.id)]: entry(keyOf(a.id)) })
    );
    mockPlatform.__writes.length = 0;

    await expect(repair(a)).resolves.toEqual({ kind: 'skipped' });
    expect(mockPlatform.__writes).toEqual([]);
  });

  it('a hung set this process still tracks (journal entry gone): skipped', async () => {
    const a = makeAccount();
    await seedPhantom(a);
    jest.useFakeTimers();
    mockPlatform.__nextSet.mode = 'hang';
    const hung = internals.boundedSecureSet(SECRET(a.id), 'x', 'nonce', 'n1');
    const outcome = expect(hung).rejects.toBeInstanceOf(
      WriteOutcomeUnknownError
    );
    await jest.advanceTimersByTimeAsync(5001);
    await outcome;
    // Only the in-memory record is left to see.
    mockPlatform.__kv.delete(UNKNOWN);
    internals.unknownJournalDesired = undefined;
    mockPlatform.__writes.length = 0;

    const result = repair(a);
    await jest.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toEqual({ kind: 'skipped' });
    expect(mockPlatform.__writes).toEqual([]);
  });

  it('a pending-creates entry for the id: skipped', async () => {
    const a = makeAccount();
    await seedPhantom(a);
    mockPlatform.__kv.set(PENDING, JSON.stringify({ [a.id]: 't99' }));
    mockPlatform.__writes.length = 0;

    await expect(repair(a)).resolves.toEqual({ kind: 'skipped' });
    expect(mockPlatform.__writes).toEqual([]);
  });
});

describe('TASK-505 repairMissingKeyForRestore: records it does not repair', () => {
  it.each([
    [
      'the metadata is missing',
      (a: Acct) => mockPlatform.__kv.delete(META(a.id)),
    ],
    [
      'the metadata names another address',
      (a: Acct) => {
        const meta = JSON.parse(mockPlatform.__kv.get(META(a.id))!);
        meta.address = algosdk.generateAccount().addr.toString();
        mockPlatform.__kv.set(META(a.id), JSON.stringify(meta));
      },
    ],
    [
      'the id is not in the account list',
      () => mockPlatform.__kv.set(LIST, JSON.stringify(['someone-else'])),
    ],
  ] as const)('%s: not-eligible', async (_n, arrange) => {
    const a = makeAccount();
    await seedPhantom(a);
    arrange(a);
    mockPlatform.__writes.length = 0;

    await expect(repair(a)).resolves.toEqual({ kind: 'not-eligible' });
    expect(mockPlatform.__writes).toEqual([]);
  });

  it('the wallet no longer lists it (stillListed false): not-eligible', async () => {
    const a = makeAccount();
    await seedPhantom(a);
    mockPlatform.__writes.length = 0;

    await expect(
      repair(a, { stillListed: async () => false })
    ).resolves.toEqual({ kind: 'not-eligible' });
    expect(mockPlatform.__writes).toEqual([]);
  });

  it.each([
    [AccountType.WATCH, {}],
    [
      AccountType.LEDGER,
      { deviceId: 'l1', derivationIndex: 0, derivationPath: "44'/283'/0'/0/0" },
    ],
    [
      AccountType.REMOTE_SIGNER,
      { signerDeviceId: 's1', pairedAt: new Date().toISOString() },
    ],
    [
      AccountType.REKEYED,
      { authAddress: 'AUTH', originalOwner: false, canSign: false },
    ],
  ] as const)(
    'a %s record: not-eligible, no slot read',
    async (type, extra) => {
      const a = makeAccount(type, extra);
      await AccountSecureStorage.storeAccountMetadataForCreation(a.meta, gen());
      const inspect = jest.spyOn(AccountSecureStorage, 'inspectSecretSlot');
      mockPlatform.__reads.length = 0;
      mockPlatform.__writes.length = 0;

      await expect(repair(a)).resolves.toEqual({ kind: 'not-eligible' });

      expect(inspect).not.toHaveBeenCalled();
      expect(mockPlatform.__reads).not.toContain(`secure:${SECRET(a.id)}`);
      expect(mockPlatform.__writes).toEqual([]);
    }
  );

  it("a key that is not the account's own: skipped, nothing written", async () => {
    const a = makeAccount();
    await seedPhantom(a);
    mockPlatform.__writes.length = 0;

    await expect(
      repair(a, { sk: algosdk.generateAccount().sk })
    ).resolves.toEqual({ kind: 'skipped' });
    expect(mockPlatform.__writes).toEqual([]);
  });

  it('a reset ran since the restore began: ResetRacedError, nothing written', async () => {
    const a = makeAccount();
    await seedPhantom(a);
    mockPlatform.__writes.length = 0;

    await expect(repair(a, { creationGen: gen() + 1 })).rejects.toBeInstanceOf(
      ResetRacedError
    );
    expect(mockPlatform.__writes).toEqual([]);
  });

  it('the vault epoch moves while the slot is read: VaultChangedDuringReadError, nothing written', async () => {
    const a = makeAccount();
    await seedKeyed(a);
    await AccountSecureStorage.setupPin(PIN, 'pin');
    SessionKeyVault.set(PIN, 'pin');
    mockPlatform.__secure.delete(SECRET(a.id));
    const original =
      AccountSecureStorage.inspectSecretSlot.bind(AccountSecureStorage);
    jest
      .spyOn(AccountSecureStorage, 'inspectSecretSlot')
      .mockImplementation(async (...args) => {
        const slot = await original(...args);
        SessionKeyVault.set(PIN, 'pin'); // unlocked again, a new epoch
        return slot;
      });
    mockPlatform.__writes.length = 0;

    await expect(repair(a)).rejects.toBeInstanceOf(VaultChangedDuringReadError);
    expect(mockPlatform.__writes).toEqual([]);
    expect(mockPlatform.__secure.has(SECRET(a.id))).toBe(false);
  });
});

describe('TASK-505 repairMissingKeyForRestore: the write and its read-back', () => {
  it("the set hangs: WriteOutcomeUnknownError in the restore's context", async () => {
    const a = makeAccount();
    await seedPhantom(a);
    jest.useFakeTimers();
    mockPlatform.__nextSet.mode = 'hang';

    const caught = repair(a).catch((error: unknown) => error);
    await jest.advanceTimersByTimeAsync(5001);
    const error = await caught;

    expect(error).toBeInstanceOf(WriteOutcomeUnknownError);
    expect((error as WriteOutcomeUnknownError).context).toBe('restore');
  });

  it('the set stores something that does not open: unconfirmed, and it is not deleted', async () => {
    const a = makeAccount();
    await seedPhantom(a);
    mockPlatform.__nextSet.mode = 'substitute';
    mockPlatform.__nextSet.substitute = 'garbage';

    await expect(repair(a)).resolves.toEqual({ kind: 'unconfirmed' });
    expect(mockPlatform.__secure.get(SECRET(a.id))).toBe('garbage');
  });

  it("the set lands but reads back as another account's key: unconfirmed, and it is not deleted", async () => {
    const a = makeAccount();
    const b = makeAccount();
    await seedPhantom(a);
    await seedKeyed(b);
    const othersKey = mockPlatform.__secure.get(SECRET(b.id))!;
    mockPlatform.__nextSet.mode = 'substitute';
    mockPlatform.__nextSet.substitute = othersKey;

    await expect(repair(a)).resolves.toEqual({ kind: 'unconfirmed' });
    expect(mockPlatform.__secure.get(SECRET(a.id))).toBe(othersKey);
    await expect(
      AccountSecureStorage.inspectSecretSlot(a.id, a.address)
    ).resolves.toMatchObject({ state: 'key-other' });
  });

  it('the set lands and then rejects: the read-back finds the key, repaired', async () => {
    const a = makeAccount();
    await seedPhantom(a);
    mockPlatform.__nextSet.mode = 'land-then-reject';

    await expect(repair(a)).resolves.toEqual({ kind: 'repaired' });
    expect(await publicHalfOf(a.id)).toBe(a.publicKey);
  });

  it('the set rejects without landing: the slot reads empty, skipped', async () => {
    const a = makeAccount();
    await seedPhantom(a);
    mockPlatform.__nextSet.mode = 'reject';

    await expect(repair(a)).resolves.toEqual({ kind: 'skipped' });
    expect(mockPlatform.__secure.has(SECRET(a.id))).toBe(false);
  });
});

describe('TASK-505 repairMissingKeyForRestore: queued behind another key mutation', () => {
  it('behind a same-id storeAccount: key-matches, and that write is the one that stays', async () => {
    const a = makeAccount();
    await seedPhantom(a);
    mockPlatform.__writes.length = 0;

    const store = AccountSecureStorage.storeAccount(
      a.meta,
      Uint8Array.from(a.sk)
    );
    const repaired = repair(a);
    await store;

    await expect(repaired).resolves.toEqual({
      kind: 'not-empty',
      state: 'key-matches',
    });
    const writes = slotWrites(a.id);
    expect(writes).toHaveLength(1);
    expect(mockPlatform.__secure.get(SECRET(a.id))).toBe(writes[0].value);
    expect(JSON.parse(writes[0].value).writeNonce).toEqual(expect.any(String));
  });

  it('behind a deleteAccount: not-eligible, the slot stays empty', async () => {
    const a = makeAccount();
    await seedPhantom(a);

    const del = AccountSecureStorage.deleteAccount(a.id);
    const repaired = repair(a);
    await del;

    await expect(repaired).resolves.toEqual({ kind: 'not-eligible' });
    expect(mockPlatform.__secure.has(SECRET(a.id))).toBe(false);
    expect(slotWrites(a.id)).toHaveLength(1); // the seed only
  });
});
