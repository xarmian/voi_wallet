// TASK-529: a restore commits every key it wrote first, then schedules the
// v2 upgrade for those ids in one batch, so the commit loop never waits behind
// one scrypt run per account. A metadata-only record has nothing to upgrade.
//
// SECURITY NOTE: every mnemonic below is generated fresh in-process by algosdk.
// Nothing is committed.

let mockStore: Record<string, string> = {};

jest.mock('@/platform', () => ({
  storage: {
    getItem: jest.fn(async (k: string) =>
      Object.prototype.hasOwnProperty.call(mockStore, k) ? mockStore[k] : null
    ),
    setItem: jest.fn(async (k: string, v: string) => {
      mockStore[k] = v;
    }),
    removeItem: jest.fn(async (k: string) => {
      delete mockStore[k];
    }),
  },
  secureStorage: {
    getItem: jest.fn(async () => null),
    setItem: jest.fn(async () => {}),
    deleteItem: jest.fn(async () => {}),
  },
}));

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async () => null),
    setItem: jest.fn(async () => {}),
    removeItem: jest.fn(async () => {}),
    multiRemove: jest.fn(async () => {}),
    getAllKeys: jest.fn(async () => []),
  },
}));

jest.mock('@/services/wallet', () => ({
  MultiAccountWalletService: {
    getCurrentWallet: jest.fn(async () => null),
    readWalletStrict: async () => null,
    mergeRestoredAccounts: async (accounts: { id: string }[]) => ({
      added: accounts.map((a) => a.id),
      skipped: [],
      hadAccounts: false,
    }),
  },
}));

jest.mock('@/services/secure/AccountSecureStorage', () => ({
  AccountSecureStorage: {
    getResetGeneration: () => 0,
    clearAll: jest.fn(),
    probeSecretPresenceStrict: jest.fn(async () => false),
    storeKeylessAccountForRestore: jest.fn(async (account: { id: string }) => ({
      id: account.id,
      reassigned: false,
    })),
    hasPinStrict: jest.fn(async () => true),
    removeAccountMetadataOnly: jest.fn(async () => {}),
    storeAccountForCreation: jest.fn(async () => 'token'),
    storeAccountForRestore: jest.fn(async (account: { id: string }) => ({
      kind: 'written' as const,
      id: account.id,
      token: `token-${account.id}`,
      reassigned: false,
    })),
    commitPendingCreate: jest.fn(async () => true),
    scheduleV2UpgradeAfterStore: jest.fn(),
    deleteAccountIfAttemptMatches: jest.fn(async () => {}),
  },
}));

jest.mock('@/services/secure/keyManager', () => ({
  SecureKeyManager: { getMnemonic: jest.fn(async () => '') },
}));

jest.mock('@/services/secure/pinSetupPending', () => ({
  markPinSetupPending: jest.fn(async () => {}),
}));

import algosdk from 'algosdk';
import { Buffer } from 'buffer';
import { AccountSecureStorage } from '@/services/secure/AccountSecureStorage';
import { AccountType } from '@/types/wallet';
import { restoreAccounts } from '../restorers';
import type { BackupAccountData } from '../types';

const secure = AccountSecureStorage as unknown as {
  commitPendingCreate: jest.Mock;
  scheduleV2UpgradeAfterStore: jest.Mock;
};

function standard(id: string): BackupAccountData {
  const kp = algosdk.generateAccount();
  return {
    id,
    address: kp.addr.toString(),
    publicKey: Buffer.from(kp.sk.slice(32)).toString('hex'),
    type: AccountType.STANDARD,
    mnemonic: algosdk.secretKeyToMnemonic(kp.sk),
    createdAt: '2026-01-01T00:00:00.000Z',
    isHidden: false,
  } as BackupAccountData;
}

function watch(id: string): BackupAccountData {
  const kp = algosdk.generateAccount();
  return {
    id,
    address: kp.addr.toString(),
    publicKey: Buffer.from(kp.sk.slice(32)).toString('hex'),
    type: AccountType.WATCH,
    createdAt: '2026-01-01T00:00:00.000Z',
    isHidden: false,
  } as BackupAccountData;
}

beforeEach(() => {
  mockStore = {};
  jest.clearAllMocks();
  secure.commitPendingCreate.mockImplementation(async () => true);
});

describe('TASK-529 restore schedules one upgrade batch after its commits', () => {
  it('commits each key without its own upgrade, then schedules all the ids once', async () => {
    await restoreAccounts([standard('s-1'), watch('w-1'), standard('s-2')]);

    expect(secure.commitPendingCreate.mock.calls).toEqual([
      ['s-1', 'token-s-1', { upgrade: false }],
      ['s-2', 'token-s-2', { upgrade: false }],
    ]);
    expect(secure.scheduleV2UpgradeAfterStore).toHaveBeenCalledTimes(1);
    expect(secure.scheduleV2UpgradeAfterStore).toHaveBeenCalledWith([
      's-1',
      's-2',
    ]);
    const lastCommit = Math.max(
      ...secure.commitPendingCreate.mock.invocationCallOrder
    );
    expect(
      secure.scheduleV2UpgradeAfterStore.mock.invocationCallOrder[0]
    ).toBeGreaterThan(lastCommit);
  });

  it('schedules only the ids whose commit removed their own token', async () => {
    secure.commitPendingCreate.mockImplementation(
      async (id: string) => id !== 's-1'
    );

    await restoreAccounts([standard('s-1'), standard('s-2')]);

    expect(secure.scheduleV2UpgradeAfterStore).toHaveBeenCalledWith(['s-2']);
  });

  it('still schedules the committed ids when a later commit fails', async () => {
    secure.commitPendingCreate
      .mockImplementationOnce(async () => true)
      .mockImplementationOnce(async () => {
        throw new Error('keychain write failed');
      });

    await expect(
      restoreAccounts([standard('s-1'), standard('s-2')])
    ).rejects.toThrow();

    expect(secure.scheduleV2UpgradeAfterStore).toHaveBeenCalledTimes(1);
    expect(secure.scheduleV2UpgradeAfterStore).toHaveBeenCalledWith(['s-1']);
  });

  it('a restore with no key written schedules nothing', async () => {
    await restoreAccounts([watch('w-1')]);

    expect(secure.commitPendingCreate).not.toHaveBeenCalled();
    expect(secure.scheduleV2UpgradeAfterStore).not.toHaveBeenCalled();
  });
});
