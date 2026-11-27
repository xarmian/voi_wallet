// TASK-529: a key stored while the session vault holds a secret is upgraded to
// the user-secret v2 envelope right after the store is final, through the same
// migrateAccountToV2 call (and current-credential gate) the lazy read trigger
// uses. The store itself still writes the device-key envelope (Format A).
// Covered writers: storeAccount, storeAccountForCreation (on commit only) and
// repairMissingKeyForRestore (on `repaired` only). Restore batches its own ids
// (src/services/backup/__tests__/task529.restoreUpgrade.test.ts).
//
// SECURITY NOTE: key material is a throwaway algosdk keypair; PINs are
// throwaway test strings. Nothing real is used, and nothing is logged.

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
      getItem: jest.fn(async (k: string) =>
        secure.has(k) ? secure.get(k)! : null
      ),
      setItem: jest.fn(async (k: string, v: string) => {
        secure.set(k, v);
      }),
      deleteItem: jest.fn(async (k: string) => {
        secure.delete(k);
      }),
      getItemWithAuth: jest.fn(async (k: string) =>
        secure.has(k) ? secure.get(k)! : null
      ),
      setItemWithAuth: jest.fn(async (k: string, v: string) => {
        secure.set(k, v);
      }),
    },
    storage: {
      getItem: jest.fn(async (k: string) => (kv.has(k) ? kv.get(k)! : null)),
      setItem: jest.fn(async (k: string, v: string) => {
        kv.set(k, v);
      }),
      removeItem: jest.fn(async (k: string) => {
        kv.delete(k);
      }),
      multiRemove: jest.fn(async (keys: string[]) => {
        keys.forEach((k) => kv.delete(k));
      }),
    },
    biometrics: {
      isAvailable: async () => false,
      isEnrolled: async () => false,
    },
    deviceId: {
      getDeviceId: async () => 'task529-test-device-idfv',
    },
  };
});

import algosdk from 'algosdk';
import * as platform from '@/platform';
import { AccountSecureStorage } from '../AccountSecureStorage';
import { SessionKeyVault } from '../SessionKeyVault';
import { WriteOutcomeUnknownError } from '../boundedWrites';
import { decryptKeyEnvelopeV2, encryptKeyEnvelopeV2 } from '../envelopeV2';
import type { KeyEnvelopeV2 } from '../envelopeV2';
import type { ScryptKdfParams } from '../../backup/types';
import { AccountType } from '@/types/wallet';
import type { AccountMetadata } from '@/types/wallet';

const DEVICE_ID = 'task529-test-device-idfv';
const PIN_ITERATIONS = 8000;
const FAST_PARAMS: ScryptKdfParams = { N: 2 ** 12, r: 8, p: 1, dkLen: 32 };
const PIN = '246813';
const STALE = '975310';

const mockPlatform = platform as unknown as {
  __secure: Map<string, string>;
  __kv: Map<string, string>;
  __reset: () => void;
};

const asPriv = AccountSecureStorage as unknown as {
  encryptPrivateKeyV2: (
    keyBytes: Uint8Array,
    secret: string,
    secretSource: 'pin' | 'passphrase',
    options: { deviceBound: boolean }
  ) => Promise<KeyEnvelopeV2>;
  persistPinCredential: (data: {
    hash: string;
    iterations: number;
    salt: string;
    secretSource: 'pin' | 'passphrase';
  }) => Promise<void>;
  hashPin: (pin: string, salt: string, iterations: number) => string;
  unwrapKeyForRewrap: (
    payload: unknown,
    currentSecret: string | undefined,
    deviceSecret: string
  ) => Promise<{ plaintext: Uint8Array; keeperBlob?: KeyEnvelopeV2 } | null>;
  saveSecretV2Checked: (accountId: string, payload: unknown) => Promise<void>;
  throttleMirror: unknown;
  legacyCheckRequired: boolean | undefined;
};

interface Payload {
  accountId: string;
  encryptedPrivateKey: string;
  version?: number;
  blobs?: KeyEnvelopeV2[];
}

const secretKey = (id: string) => `voi_account_secret_${id}`;
const readPayload = (id: string): Payload =>
  JSON.parse(mockPlatform.__secure.get(secretKey(id))!);
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

let seq = 0;
function makeAccount() {
  const id = `t529-${++seq}`;
  const kp = algosdk.generateAccount();
  const address = kp.addr.toString();
  const now = new Date().toISOString();
  const meta = {
    id,
    address,
    publicKey: Buffer.from(algosdk.decodeAddress(address).publicKey).toString(
      'hex'
    ),
    type: AccountType.STANDARD,
    label: id,
    color: '#000000',
    isHidden: false,
    createdAt: now,
    importedAt: now,
    lastUsed: now,
    mnemonic: '',
    hasBackup: false,
    backupVerified: false,
  } as unknown as AccountMetadata;
  return { id, meta, sk: kp.sk };
}

function useFastWriter(): void {
  jest
    .spyOn(asPriv, 'encryptPrivateKeyV2')
    .mockImplementation(async (keyBytes, secret, secretSource, options) =>
      encryptKeyEnvelopeV2({
        plaintext: keyBytes,
        secret,
        secretSource,
        deviceSecret: options.deviceBound ? DEVICE_ID : undefined,
        kdfParams: FAST_PARAMS,
      })
    );
}

async function seedCredential(pin: string): Promise<void> {
  const salt = 'b'.repeat(64);
  await asPriv.persistPinCredential({
    hash: await asPriv.hashPin(pin, salt, PIN_ITERATIONS),
    iterations: PIN_ITERATIONS,
    salt,
    secretSource: 'pin',
  });
}

// Track every migration the hook starts, so a test can wait for the
// fire-and-forget work to finish before it reads storage.
let pending: Promise<unknown>[] = [];
let migrate: jest.SpyInstance;
async function drain(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    const n = pending.length;
    await Promise.all(pending);
    await new Promise((r) => setTimeout(r, 0));
    if (pending.length === n) return;
  }
}

function expectFormatAOnly(id: string): void {
  const p = readPayload(id);
  expect(p.encryptedPrivateKey).not.toBe('');
  expect(p.blobs ?? []).toHaveLength(0);
}

async function expectV2OnlyUnder(
  id: string,
  secret: string,
  sk: Uint8Array
): Promise<void> {
  const p = readPayload(id);
  expect(p.encryptedPrivateKey).toBe('');
  expect(p.blobs).toHaveLength(1);
  const pt = await decryptKeyEnvelopeV2(p.blobs![0], secret, DEVICE_ID);
  expect(hex(pt!)).toBe(hex(sk));
}

beforeEach(async () => {
  mockPlatform.__reset();
  AccountSecureStorage.clearPrivateKeyCache();
  SessionKeyVault.clear();
  asPriv.throttleMirror = null;
  asPriv.legacyCheckRequired = undefined;
  pending = [];
  const real =
    AccountSecureStorage.migrateAccountToV2.bind(AccountSecureStorage);
  migrate = jest
    .spyOn(AccountSecureStorage, 'migrateAccountToV2')
    .mockImplementation((...args) => {
      const p = real(...args);
      pending.push(p);
      return p;
    });
  useFastWriter();
  await seedCredential(PIN);
});

afterEach(async () => {
  await drain();
  SessionKeyVault.clear();
  jest.restoreAllMocks();
});

describe('TASK-529 storeAccount', () => {
  it('a key added with a PIN and an unlocked vault ends in v2', async () => {
    const a = makeAccount();
    SessionKeyVault.set(PIN, 'pin');
    const epoch = SessionKeyVault.currentEpoch();

    await AccountSecureStorage.storeAccount(a.meta, Uint8Array.from(a.sk));
    expect(migrate).toHaveBeenCalledTimes(1);
    expect(migrate).toHaveBeenCalledWith(a.id, PIN, 'pin', epoch);
    await drain();

    await expectV2OnlyUnder(a.id, PIN, a.sk);
    const read = await AccountSecureStorage.getPrivateKey(a.id, PIN);
    expect(hex(read)).toBe(hex(a.sk));
  });

  it('a stale vault secret is refused by the gate and the key stays readable on Format A', async () => {
    const a = makeAccount();
    SessionKeyVault.set(STALE, 'pin');

    await AccountSecureStorage.storeAccount(a.meta, Uint8Array.from(a.sk));
    expect(migrate).toHaveBeenCalledWith(
      a.id,
      STALE,
      'pin',
      expect.any(Number)
    );
    await drain();
    await expect(pending[0]).resolves.toBe('NOT_MIGRATED');

    expectFormatAOnly(a.id);
    SessionKeyVault.clear();
    const read = await AccountSecureStorage.getPrivateKey(a.id, PIN);
    expect(hex(read)).toBe(hex(a.sk));
  });

  it('a lock during the migration aborts cleanly: nothing written past the store', async () => {
    const a = makeAccount();
    SessionKeyVault.set(PIN, 'pin');
    const origUnwrap = asPriv.unwrapKeyForRewrap.bind(AccountSecureStorage);
    const unwrap = jest
      .spyOn(asPriv, 'unwrapKeyForRewrap')
      .mockImplementation(async (payload, secret, device) => {
        const r = await origUnwrap(payload, secret, device);
        SessionKeyVault.clear();
        return r;
      });

    await AccountSecureStorage.storeAccount(a.meta, Uint8Array.from(a.sk));
    const stored = mockPlatform.__secure.get(secretKey(a.id));
    await drain();

    expect(unwrap).toHaveBeenCalled();
    await expect(pending[0]).resolves.toBe('NOT_MIGRATED');
    expect(mockPlatform.__secure.get(secretKey(a.id))).toBe(stored);
    expectFormatAOnly(a.id);
    const read = await AccountSecureStorage.getPrivateKey(a.id, PIN);
    expect(hex(read)).toBe(hex(a.sk));
  });

  it('a crash between add-blob and drop-old leaves a readable key', async () => {
    const a = makeAccount();
    SessionKeyVault.set(PIN, 'pin');
    const realSave = asPriv.saveSecretV2Checked.bind(AccountSecureStorage);
    let saves = 0;
    jest
      .spyOn(asPriv, 'saveSecretV2Checked')
      .mockImplementation(async (id, payload) => {
        saves += 1;
        // The second v2 write is the finalize (drop-old): it never lands.
        if (saves === 2) throw new WriteOutcomeUnknownError(false);
        return realSave(id, payload);
      });

    await AccountSecureStorage.storeAccount(a.meta, Uint8Array.from(a.sk));
    await drain();
    await expect(pending[0]).resolves.toBe('NOT_MIGRATED');

    // The dual-blob state: the device-key copy and the proven v2 blob.
    const p = readPayload(a.id);
    expect(p.encryptedPrivateKey).not.toBe('');
    expect(p.blobs).toHaveLength(1);
    const pt = await decryptKeyEnvelopeV2(p.blobs![0], PIN, DEVICE_ID);
    expect(hex(pt!)).toBe(hex(a.sk));

    // After a restart (vault and cache gone) the key still reads.
    jest.mocked(asPriv.saveSecretV2Checked).mockImplementation(realSave);
    SessionKeyVault.clear();
    AccountSecureStorage.clearPrivateKeyCache();
    const read = await AccountSecureStorage.getPrivateKey(a.id, PIN);
    expect(hex(read)).toBe(hex(a.sk));
  });

  it('a store with no vault secret schedules nothing', async () => {
    const a = makeAccount();

    await AccountSecureStorage.storeAccount(a.meta, Uint8Array.from(a.sk));
    await drain();

    expect(migrate).not.toHaveBeenCalled();
    expectFormatAOnly(a.id);
  });

  it('a store with no key (watch record) schedules nothing', async () => {
    const a = makeAccount();
    SessionKeyVault.set(PIN, 'pin');

    await AccountSecureStorage.storeAccount({
      ...a.meta,
      type: AccountType.WATCH,
    } as AccountMetadata);
    await drain();

    expect(migrate).not.toHaveBeenCalled();
  });
});

describe('TASK-529 storeAccountForCreation', () => {
  it('migrates only after commitPendingCreate removes its own token', async () => {
    const a = makeAccount();
    SessionKeyVault.set(PIN, 'pin');

    const token = await AccountSecureStorage.storeAccountForCreation(
      a.meta,
      Uint8Array.from(a.sk),
      AccountSecureStorage.getResetGeneration()
    );
    await drain();
    expect(migrate).not.toHaveBeenCalled();
    expectFormatAOnly(a.id);

    // A token that is not this attempt's removes nothing and schedules nothing.
    await expect(
      AccountSecureStorage.commitPendingCreate(a.id, 'not-ours')
    ).resolves.toBe(false);
    await drain();
    expect(migrate).not.toHaveBeenCalled();

    await expect(
      AccountSecureStorage.commitPendingCreate(a.id, token)
    ).resolves.toBe(true);
    expect(migrate).toHaveBeenCalledWith(a.id, PIN, 'pin', expect.any(Number));
    await drain();
    await expectV2OnlyUnder(a.id, PIN, a.sk);
  });

  it('a rolled-back creation is never migrated', async () => {
    const a = makeAccount();
    SessionKeyVault.set(PIN, 'pin');

    const token = await AccountSecureStorage.storeAccountForCreation(
      a.meta,
      Uint8Array.from(a.sk),
      AccountSecureStorage.getResetGeneration()
    );
    await AccountSecureStorage.deleteAccountIfAttemptMatches(a.id, token);
    await drain();

    expect(migrate).not.toHaveBeenCalled();
    expect(mockPlatform.__secure.has(secretKey(a.id))).toBe(false);
  });

  it('a commit with upgrade:false leaves the scheduling to the caller', async () => {
    const a = makeAccount();
    SessionKeyVault.set(PIN, 'pin');

    const token = await AccountSecureStorage.storeAccountForCreation(
      a.meta,
      Uint8Array.from(a.sk),
      AccountSecureStorage.getResetGeneration()
    );
    await expect(
      AccountSecureStorage.commitPendingCreate(a.id, token, { upgrade: false })
    ).resolves.toBe(true);
    await drain();
    expect(migrate).not.toHaveBeenCalled();

    AccountSecureStorage.scheduleV2UpgradeAfterStore([a.id]);
    await drain();
    expect(migrate).toHaveBeenCalledTimes(1);
    await expectV2OnlyUnder(a.id, PIN, a.sk);
  });
});

describe('TASK-529 scheduleV2UpgradeAfterStore', () => {
  it('runs the ids one at a time and stops when the vault locks', async () => {
    const a = makeAccount();
    const b = makeAccount();
    for (const x of [a, b]) {
      const t = await AccountSecureStorage.storeAccountForCreation(
        x.meta,
        Uint8Array.from(x.sk),
        AccountSecureStorage.getResetGeneration()
      );
      await AccountSecureStorage.commitPendingCreate(x.id, t);
    }
    expect(migrate).not.toHaveBeenCalled();

    SessionKeyVault.set(PIN, 'pin');
    let inFlight = 0;
    let maxInFlight = 0;
    const real = migrate.getMockImplementation()!;
    migrate.mockImplementation((...args: unknown[]) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const p = (real as (...a: unknown[]) => Promise<unknown>)(...args);
      // Lock once the first account has finished.
      void p.finally(() => {
        inFlight -= 1;
        SessionKeyVault.clear();
      });
      return p;
    });

    AccountSecureStorage.scheduleV2UpgradeAfterStore([a.id, b.id]);
    await drain();

    expect(maxInFlight).toBe(1);
    expect(migrate).toHaveBeenCalledTimes(1);
    await expectV2OnlyUnder(a.id, PIN, a.sk);
    expectFormatAOnly(b.id);
  });
});

describe('TASK-529 repairMissingKeyForRestore', () => {
  async function seedPhantom(a: ReturnType<typeof makeAccount>) {
    const t = await AccountSecureStorage.storeAccountForCreation(
      a.meta,
      Uint8Array.from(a.sk),
      AccountSecureStorage.getResetGeneration()
    );
    await AccountSecureStorage.commitPendingCreate(a.id, t);
    mockPlatform.__secure.delete(secretKey(a.id));
  }
  const repair = (a: ReturnType<typeof makeAccount>, sk?: Uint8Array) =>
    AccountSecureStorage.repairMissingKeyForRestore(
      a.meta,
      sk ?? Uint8Array.from(a.sk),
      AccountSecureStorage.getResetGeneration(),
      async () => true
    );

  it('schedules the upgrade for a repaired key', async () => {
    const a = makeAccount();
    await seedPhantom(a);
    SessionKeyVault.set(PIN, 'pin');

    await expect(repair(a)).resolves.toEqual({ kind: 'repaired' });
    expect(migrate).toHaveBeenCalledTimes(1);
    expect(migrate).toHaveBeenCalledWith(a.id, PIN, 'pin', expect.any(Number));
    await drain();
    await expectV2OnlyUnder(a.id, PIN, a.sk);
  });

  it('schedules nothing when the slot is not empty', async () => {
    const a = makeAccount();
    const t = await AccountSecureStorage.storeAccountForCreation(
      a.meta,
      Uint8Array.from(a.sk),
      AccountSecureStorage.getResetGeneration()
    );
    await AccountSecureStorage.commitPendingCreate(a.id, t);
    SessionKeyVault.set(PIN, 'pin');

    const result = await repair(a);
    expect(result.kind).toBe('not-empty');
    await drain();
    expect(migrate).not.toHaveBeenCalled();
  });

  it('schedules nothing for a key that does not belong to the record', async () => {
    const a = makeAccount();
    await seedPhantom(a);
    SessionKeyVault.set(PIN, 'pin');

    const result = await repair(a, algosdk.generateAccount().sk);
    expect(result).toEqual({ kind: 'skipped' });
    await drain();
    expect(migrate).not.toHaveBeenCalled();
  });
});
