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

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {},
}));

// Keep native transports out of this caller/rollback integration test.
jest.mock('@/services/ledger/transport', () => ({
  ledgerTransportService: {},
}));
jest.mock('@/services/ledger/algorand', () => ({ ledgerAlgorandService: {} }));
jest.mock('@/services/network', () => ({ NetworkService: {} }));

import algosdk from 'algosdk';
import { MultiAccountWalletService } from '@/services/wallet';
import { restoreAccounts } from '@/services/backup/restorers';
import { AccountType, ResetRacedError } from '@/types/wallet';
import type { BackupAccountData } from '@/services/backup/types';

const LIST = 'voi_account_list';
const JOURNAL = 'voi_pending_account_creates';
const rollbackMessage = `delete failed for ${'A'.repeat(58)}`;

// Seed the state at the creation boundary without exercising key encryption.
// The rollback itself uses the real secure-storage list/journal/delete methods.
function seedCreation() {
  return jest
    .spyOn(AccountSecureStorage, 'storeAccountForCreation')
    .mockImplementation(async (account) => {
      const ids = JSON.parse(mockKv.get(LIST) || '[]');
      ids.push(account.id);
      mockKv.set(LIST, JSON.stringify(ids));
      const journal = JSON.parse(mockKv.get(JOURNAL) || '{}');
      journal[account.id] = `token-${account.id}`;
      mockKv.set(JOURNAL, JSON.stringify(journal));
      mockKv.set(`voi_account_metadata_${account.id}`, 'metadata');
      mockSecure.set(`${SECRET_PREFIX}${account.id}`, 'secret');
      return journal[account.id];
    });
}
function failRollback(id: string) {
  (secureStorage.deleteItem as jest.Mock).mockImplementation(
    async (key: string) => {
      if (key === `${SECRET_PREFIX}${id}`) throw new Error(rollbackMessage);
      mockSecure.delete(key);
    }
  );
}

it.each(['create', 'import'] as const)(
  '%s preserves the original ResetRacedError and indexed journal when rollback throws',
  async (operation) => {
    const writes = seedCreation();
    const original = new ResetRacedError();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest
      .spyOn(MultiAccountWalletService as any, 'addAccountToWallet')
      .mockImplementation(async () => {
        failRollback(writes.mock.calls[0][0].id);
        throw original;
      });
    const mnemonic = algosdk.secretKeyToMnemonic(algosdk.generateAccount().sk);
    const result =
      operation === 'create'
        ? MultiAccountWalletService.createStandardAccount({
            type: AccountType.STANDARD,
          })
        : MultiAccountWalletService.importStandardAccount({
            type: AccountType.STANDARD,
            mnemonic,
          });
    await expect(result).rejects.toBe(original);
    const id = writes.mock.calls[0][0].id;
    expect(await AccountSecureStorage.readAccountListStrict()).toEqual([id]);
    expect(await AccountSecureStorage.readPendingCreatesStrict()).toEqual({
      [id]: `token-${id}`,
    });
    expect(mockSecure.has(`${SECRET_PREFIX}${id}`)).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      'Account rollback failed:',
      expect.any(String)
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('A'.repeat(58));
  }
);

it('restore rolls back all three accounts despite the second failure and preserves the original error', async () => {
  seedCreation();
  const original = new ResetRacedError();
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest
    .spyOn(MultiAccountWalletService, 'persistRestoredWallet')
    .mockRejectedValueOnce(original);
  const rollback = jest.spyOn(
    AccountSecureStorage,
    'deleteAccountIfAttemptMatches'
  );
  failRollback('second');
  const accounts = ['first', 'second', 'third'].map((id) => ({
    id,
    type: AccountType.STANDARD,
    mnemonic: algosdk.secretKeyToMnemonic(algosdk.generateAccount().sk),
    label: id,
    createdAt: new Date().toISOString(),
  })) as BackupAccountData[];
  await expect(restoreAccounts(accounts)).rejects.toBe(original);
  expect(rollback.mock.calls).toEqual(
    accounts.map(({ id }) => [id, `token-${id}`])
  );
  expect(await AccountSecureStorage.readAccountListStrict()).toEqual([
    'second',
  ]);
  expect(await AccountSecureStorage.readPendingCreatesStrict()).toEqual({
    second: 'token-second',
  });
  expect(mockSecure.has(`${SECRET_PREFIX}first`)).toBe(false);
  expect(mockSecure.has(`${SECRET_PREFIX}third`)).toBe(false);
  expect(warn).toHaveBeenCalledWith(
    'Restore rollback failed:',
    expect.any(String)
  );
  expect(JSON.stringify(warn.mock.calls)).not.toContain('A'.repeat(58));
});
