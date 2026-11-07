// TASK-424: AccountSecureStorage.deleteAccount(id, { requireNoSecret: true })
// re-checks custody INSIDE the key-mutation mutex, so a secret written by any
// writer that holds the mutex before the delete runs is never deleted with an
// account the caller confirmed as keyless.
//
// SECURITY NOTE: no secret material; stored values are opaque placeholders.

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
    deviceId: { getDeviceId: async () => 'task424-test-device' },
  };
});

import { secureStorage } from '@/platform';
import { AccountSecureStorage } from '../AccountSecureStorage';
import { AccountDeletionPreconditionError } from '@/types/wallet';

const SECRET_PREFIX = 'voi_account_secret_';
const LEGACY_PREFIX = 'voi_account_';
const LIST = 'voi_account_list';
const META = 'voi_account_metadata_';

function seedKeyless(id: string) {
  mockKv.set(LIST, JSON.stringify([id]));
  mockKv.set(`${META}${id}`, 'metadata');
}

function expectIndexed(id: string) {
  expect(JSON.parse(mockKv.get(LIST)!)).toContain(id);
  expect(mockKv.get(`${META}${id}`)).toBe('metadata');
}

// Test-only handle on the private mutex every secret writer takes.
const runExclusive = <T>(fn: () => Promise<T>): Promise<T> =>
  (
    AccountSecureStorage as unknown as {
      runKeyMutationExclusive: (f: () => Promise<T>) => Promise<T>;
    }
  ).runKeyMutationExclusive(fn);

beforeEach(() => {
  mockSecure.clear();
  mockKv.clear();
  jest.clearAllMocks();
});

describe('AccountSecureStorage.deleteAccount requireNoSecret (TASK-424)', () => {
  it('deletes a keyless account', async () => {
    seedKeyless('A');
    await AccountSecureStorage.deleteAccount('A', { requireNoSecret: true });
    expect(mockKv.has(`${META}A`)).toBe(false);
    expect(JSON.parse(mockKv.get(LIST)!)).not.toContain('A');
  });

  it('refuses, deleting nothing, when a primary secret is present', async () => {
    seedKeyless('A');
    mockSecure.set(`${SECRET_PREFIX}A`, 'secret');
    await expect(
      AccountSecureStorage.deleteAccount('A', { requireNoSecret: true })
    ).rejects.toBeInstanceOf(AccountDeletionPreconditionError);
    expect(mockSecure.get(`${SECRET_PREFIX}A`)).toBe('secret');
    expectIndexed('A');
    expect(secureStorage.deleteItem).not.toHaveBeenCalled();
  });

  it('refuses when only a live legacy blob holds the key', async () => {
    seedKeyless('A');
    mockSecure.set(`${LEGACY_PREFIX}A`, 'legacy');
    await expect(
      AccountSecureStorage.deleteAccount('A', { requireNoSecret: true })
    ).rejects.toBeInstanceOf(AccountDeletionPreconditionError);
    expect(mockSecure.get(`${LEGACY_PREFIX}A`)).toBe('legacy');
    expectIndexed('A');
  });

  it('refuses when custody cannot be read', async () => {
    seedKeyless('A');
    (secureStorage.getItem as jest.Mock).mockRejectedValueOnce(
      new Error('keychain unavailable')
    );
    await expect(
      AccountSecureStorage.deleteAccount('A', { requireNoSecret: true })
    ).rejects.toThrow('keychain unavailable');
    expectIndexed('A');
    expect(secureStorage.deleteItem).not.toHaveBeenCalled();
  });

  it('sees a secret written by a mutex holder that was ahead of it', async () => {
    seedKeyless('A');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // A writer that took the mutex first and writes the key in place under
    // the keyless account's id (the writeSecretV2/storeAccount shape).
    const writer = runExclusive(async () => {
      await gate;
      mockSecure.set(`${SECRET_PREFIX}A`, 'secret');
    });
    const deletion = AccountSecureStorage.deleteAccount('A', {
      requireNoSecret: true,
    });
    // Let the deletion run as far as it can before the writer finishes; a
    // probe outside the mutex would read absence here.
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    release();
    await writer;
    await expect(deletion).rejects.toBeInstanceOf(
      AccountDeletionPreconditionError
    );
    expect(mockSecure.get(`${SECRET_PREFIX}A`)).toBe('secret');
    expectIndexed('A');
  });

  it('without the option, deletes a key-holding account as before', async () => {
    seedKeyless('A');
    mockSecure.set(`${SECRET_PREFIX}A`, 'secret');
    await AccountSecureStorage.deleteAccount('A');
    expect(mockSecure.has(`${SECRET_PREFIX}A`)).toBe(false);
    expect(mockKv.has(`${META}A`)).toBe(false);
  });
});
