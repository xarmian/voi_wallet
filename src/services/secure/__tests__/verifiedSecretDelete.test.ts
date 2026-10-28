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

import { secureStorage } from '@/platform';
import { AccountSecureStorage } from '../AccountSecureStorage';

const SECRET_PREFIX = 'voi_account_secret_';
const LEGACY_PREFIX = 'voi_account_';
const WIPE_TOMBSTONE_KEY = 'voi_secure_wiped';
const PENDING_CREATES_KEY = 'voi_pending_account_creates';

beforeEach(() => {
  mockSecure.clear();
  mockKv.clear();
  jest.restoreAllMocks();
  jest.clearAllMocks();
  (secureStorage.deleteItem as jest.Mock).mockImplementation(
    async (key: string) => {
      mockSecure.delete(key);
    }
  );
});

jest.mock('@/services/secure', () =>
  jest.requireActual('../AccountSecureStorage')
);

jest.mock('@/services/wallet', () => ({
  MultiAccountWalletService: {
    getStandardAccountIdsStrict: jest.fn(async () => []),
    getBlobAccountIdsStrict: jest.fn(async () => ({
      standardIds: [],
      allIds: [],
    })),
    pruneStandardAccounts: jest.fn(async () => {}),
  },
}));

import { reconcileCrossStoreHalfState } from '@/services/wallet/crossStoreReconcile';
import { AccountStorageError } from '@/types/wallet';

const LIST = 'voi_account_list';
const META = 'voi_account_metadata_';
const PIN = 'voi_wallet_pin';
const SALT = 'voi_wallet_salt';

function seed(ids: string[]) {
  mockKv.set(LIST, JSON.stringify(ids));
  mockKv.set(
    PENDING_CREATES_KEY,
    JSON.stringify(Object.fromEntries(ids.map((id) => [id, `token-${id}`])))
  );
  for (const id of ids) {
    mockSecure.set(`${SECRET_PREFIX}${id}`, 'secret');
    mockKv.set(`${META}${id}`, 'metadata');
  }
}
function failDelete(keyToFail: string) {
  (secureStorage.deleteItem as jest.Mock).mockImplementation(
    async (key: string) => {
      if (key === keyToFail) throw new Error('disk I/O failure');
      mockSecure.delete(key);
    }
  );
}
async function expectIndexed(id: string) {
  expect(await AccountSecureStorage.getAllAccountIds()).toContain(id);
  expect(mockKv.get(`${META}${id}`)).toBe('metadata');
}

describe('verified secret deletion', () => {
  it('headline: thrown primary delete rejects and stays indexed even if the adapter then reads absence', async () => {
    seed(['A']);
    (secureStorage.deleteItem as jest.Mock).mockImplementation(
      async (key: string) => {
        mockSecure.delete(key); // Android may clear its presence sentinel in finally.
        if (key === `${SECRET_PREFIX}A`) throw new Error('disk I/O failure');
      }
    );
    await expect(
      AccountSecureStorage.deleteAccount('A')
    ).rejects.toBeInstanceOf(AccountStorageError);
    await expectIndexed('A');
  });

  it('legacy delete failure rejects and stays indexed', async () => {
    seed(['A']);
    mockSecure.set(`${LEGACY_PREFIX}A`, 'legacy');
    failDelete(`${LEGACY_PREFIX}A`);
    await expect(AccountSecureStorage.deleteAccount('A')).rejects.toThrow();
    await expectIndexed('A');
    expect(mockSecure.has(`${LEGACY_PREFIX}A`)).toBe(true);
  });

  it('resolved delete with secret still present rejects and stays indexed', async () => {
    seed(['A']);
    (secureStorage.deleteItem as jest.Mock).mockResolvedValue(undefined);
    await expect(AccountSecureStorage.deleteAccount('A')).rejects.toThrow(
      'remains after deletion'
    );
    await expectIndexed('A');
  });

  it('probe failure rejects and stays indexed', async () => {
    seed(['A']);
    jest
      .spyOn(AccountSecureStorage, 'probeSecretPresenceStrict')
      .mockRejectedValueOnce(new Error('read failed'));
    await expect(AccountSecureStorage.deleteAccount('A')).rejects.toThrow(
      'read failed'
    );
    await expectIndexed('A');
  });

  it('absent secrets delete successfully and idempotently', async () => {
    seed(['A']);
    mockSecure.clear();
    await AccountSecureStorage.deleteAccount('A');
    await AccountSecureStorage.deleteAccount('A');
    expect(await AccountSecureStorage.getAllAccountIds()).toEqual([]);
    expect(mockKv.has(`${META}A`)).toBe(false);
  });

  it('clearAll continues after A fails: B is gone, A indexed, journal and PIN intact', async () => {
    seed(['A', 'B']);
    for (const map of [mockKv, mockSecure]) {
      map.set(PIN, 'pin');
      map.set(SALT, 'salt');
    }
    const journal = mockKv.get(PENDING_CREATES_KEY);
    failDelete(`${SECRET_PREFIX}A`);
    await expect(AccountSecureStorage.clearAll()).rejects.toThrow(
      '1 account(s)'
    );
    expect(mockSecure.has(`${SECRET_PREFIX}B`)).toBe(false);
    await expectIndexed('A');
    expect(await AccountSecureStorage.getAllAccountIds()).toEqual(['A']);
    expect(mockKv.get(PENDING_CREATES_KEY)).toBe(journal);
    for (const map of [mockKv, mockSecure]) {
      expect(map.get(PIN)).toBe('pin');
      expect(map.get(SALT)).toBe('salt');
    }
    expect(mockKv.get(WIPE_TOMBSTONE_KEY)).toBe('1');
    (secureStorage.deleteItem as jest.Mock).mockImplementation(
      async (key: string) => {
        mockSecure.delete(key);
      }
    );
    await AccountSecureStorage.clearAll();
    expect(mockSecure.has(`${SECRET_PREFIX}A`)).toBe(false);
    expect(mockKv.has(PENDING_CREATES_KEY)).toBe(false);
    expect(mockKv.has(PIN)).toBe(false);
  });

  it('reconcile retains failed id in BOTH list and journal and retries next run', async () => {
    seed(['A']);
    failDelete(`${SECRET_PREFIX}A`);
    const first = await reconcileCrossStoreHalfState();
    expect(first).toMatchObject({ ran: true, orphanSecretsDeleted: [] });
    await expectIndexed('A');
    expect(await AccountSecureStorage.readPendingCreatesStrict()).toEqual({
      A: 'token-A',
    });
    expect(mockSecure.has(`${SECRET_PREFIX}A`)).toBe(true);
    (secureStorage.deleteItem as jest.Mock).mockImplementation(
      async (key: string) => {
        mockSecure.delete(key);
      }
    );
    const second = await reconcileCrossStoreHalfState();
    expect(second).toMatchObject({ ran: true, orphanSecretsDeleted: ['A'] });
    expect(mockSecure.has(`${SECRET_PREFIX}A`)).toBe(false);
    expect(await AccountSecureStorage.readAccountListStrict()).toEqual([]);
    expect(await AccountSecureStorage.readPendingCreatesStrict()).toEqual({});
  });
});

it('ownership rollback preserves the index and journal on a failed delete', async () => {
  seed(['A']);
  failDelete(`${SECRET_PREFIX}A`);
  await expect(
    AccountSecureStorage.deleteAccountIfAttemptMatches('A', 'token-A')
  ).rejects.toThrow();
  await expectIndexed('A');
  expect(await AccountSecureStorage.readPendingCreatesStrict()).toEqual({
    A: 'token-A',
  });
});

it('no-key legacy read survives primary cleanup failure and retains the legacy blob', async () => {
  const id = 'watch';
  const legacy = JSON.stringify({
    accountId: id,
    address: 'WATCH',
    type: 'watch',
    authMethod: 'biometric',
    publicData: {
      publicKey: '',
      label: 'Watch',
      color: '#000',
      createdAt: '2026-01-01',
    },
  });
  mockSecure.set(`${LEGACY_PREFIX}${id}`, legacy);
  failDelete(`${SECRET_PREFIX}${id}`);
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  expect((await AccountSecureStorage.retrieveAccount(id)).id).toBe(id);
  expect(mockSecure.get(`${LEGACY_PREFIX}${id}`)).toBe(legacy);
  expect(await AccountSecureStorage.probeSecretPresenceStrict(id)).toBe(true);
  expect(warn).toHaveBeenCalled();
});
