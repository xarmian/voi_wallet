/**
 * TASK-45 / DR-11 — `backupVerified` must stay OUT of the backup format.
 *
 * Recovery-phrase verification is a property of the user of THIS device, not of
 * an encrypted payload that can be moved anywhere. If it travelled in the
 * backup, restoring onto a fresh device would inherit "already backed up" for a
 * user who has never seen the phrase, permanently suppressing the Home warning.
 *
 * Also pins the folded-in defect fix: `restorers.ts` read
 * `backupAccount.hasBackup || true`, which is unconditionally truthy, so every
 * restored account was marked backed up regardless of the payload.
 *
 * SECURITY NOTE: every mnemonic below is generated fresh in-process by algosdk.
 * Nothing is committed.
 */

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

const mockPersistRestoredWallet = jest.fn(async () => {});
const mockGetCurrentWallet = jest.fn();

jest.mock('@/services/wallet', () => ({
  MultiAccountWalletService: {
    getCurrentWallet: (...args: unknown[]) => mockGetCurrentWallet(...args),
    persistRestoredWallet: (...args: unknown[]) =>
      mockPersistRestoredWallet(...(args as [])),
  },
}));

jest.mock('@/services/secure/AccountSecureStorage', () => ({
  AccountSecureStorage: {
    getResetGeneration: () => 0,
    storeAccountForCreation: jest.fn(async () => 'token'),
    commitPendingCreate: jest.fn(async () => {}),
    deleteAccountIfAttemptMatches: jest.fn(async () => {}),
  },
}));

jest.mock('@/services/secure/keyManager', () => ({
  SecureKeyManager: {
    getMnemonic: jest.fn(async () => mockMnemonicForCollect),
  },
}));

jest.mock('@/services/secure/pinSetupPending', () => ({
  markPinSetupPending: jest.fn(async () => {}),
}));

let mockMnemonicForCollect = '';

import algosdk from 'algosdk';
import { Buffer } from 'buffer';
import { AccountType, StandardAccountMetadata } from '@/types/wallet';
import { collectAccounts } from '../collectors';
import { restoreAccounts } from '../restorers';
import type { BackupAccountData } from '../types';

function freshAccount() {
  const account = algosdk.generateAccount();
  return {
    address: account.addr.toString(),
    publicKey: Buffer.from(account.sk.slice(32)).toString('hex'),
    mnemonic: algosdk.secretKeyToMnemonic(account.sk),
  };
}

beforeEach(() => {
  mockStore = {};
  jest.clearAllMocks();
});

describe('collectAccounts — backupVerified is not collected', () => {
  it('omits the field even when the account is verified', async () => {
    const fresh = freshAccount();
    mockMnemonicForCollect = fresh.mnemonic;

    const account: StandardAccountMetadata = {
      id: 'acc-1',
      address: fresh.address,
      publicKey: fresh.publicKey,
      type: AccountType.STANDARD,
      label: 'Main',
      isHidden: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      lastUsed: '2026-01-01T00:00:00.000Z',
      mnemonic: '',
      hasBackup: true,
      backupVerified: true,
    };

    mockGetCurrentWallet.mockResolvedValue({
      id: 'w',
      version: '1.0',
      createdAt: '',
      accounts: [account],
      activeAccountId: 'acc-1',
      settings: {},
    });

    const collected = await collectAccounts();

    expect(collected).toHaveLength(1);
    expect(collected[0]).not.toHaveProperty('backupVerified');
    // Legacy field still travels, unchanged.
    expect(collected[0].hasBackup).toBe(true);
    // Sanity: the payload really is the phrase-bearing record.
    expect(collected[0].mnemonic).toBe(fresh.mnemonic);
  });
});

describe('restoreAccounts — backupVerified always resets to false', () => {
  async function restoreOne(
    overrides: Partial<BackupAccountData> = {}
  ): Promise<StandardAccountMetadata> {
    const fresh = freshAccount();
    const payload: BackupAccountData = {
      id: 'acc-1',
      address: fresh.address,
      type: AccountType.STANDARD,
      publicKey: fresh.publicKey,
      createdAt: '2026-01-01T00:00:00.000Z',
      isHidden: false,
      mnemonic: fresh.mnemonic,
      ...overrides,
    };

    await restoreAccounts([payload]);

    expect(mockPersistRestoredWallet).toHaveBeenCalledTimes(1);
    const wallet = (
      mockPersistRestoredWallet.mock.calls[0] as unknown[]
    )[0] as {
      accounts: StandardAccountMetadata[];
    };
    return wallet.accounts[0];
  }

  it('restores as UNVERIFIED for a plain payload', async () => {
    const restored = await restoreOne();
    expect(restored.backupVerified).toBe(false);
  });

  it('ignores a backupVerified field smuggled into the payload', async () => {
    // A hand-edited or hostile backup must not be able to grant verified state.
    const restored = await restoreOne({
      backupVerified: true,
    } as Partial<BackupAccountData>);
    expect(restored.backupVerified).toBe(false);
  });

  it('honours hasBackup: false instead of forcing it true (|| true defect)', async () => {
    const restored = await restoreOne({ hasBackup: false });
    expect(restored.hasBackup).toBe(false);
  });

  it('honours hasBackup: true', async () => {
    const restored = await restoreOne({ hasBackup: true });
    expect(restored.hasBackup).toBe(true);
  });

  it('defaults hasBackup to false for an older payload that omits it', async () => {
    const restored = await restoreOne();
    expect(restored.hasBackup).toBe(false);
  });
});

describe('round trip against an existing (pre-TASK-45) payload shape', () => {
  it('collect -> restore preserves the legacy fields and never revives verification', async () => {
    const fresh = freshAccount();
    mockMnemonicForCollect = fresh.mnemonic;

    mockGetCurrentWallet.mockResolvedValue({
      id: 'w',
      version: '1.0',
      createdAt: '',
      accounts: [
        {
          id: 'acc-1',
          address: fresh.address,
          publicKey: fresh.publicKey,
          type: AccountType.STANDARD,
          label: 'Main',
          color: '#123456',
          isHidden: false,
          createdAt: '2026-01-01T00:00:00.000Z',
          lastUsed: '2026-01-01T00:00:00.000Z',
          mnemonic: '',
          hasBackup: true,
          backupVerified: true,
        } as StandardAccountMetadata,
      ],
      activeAccountId: 'acc-1',
      settings: {},
    });

    const collected = await collectAccounts();

    // Simulate the wire hop exactly as the encrypted payload does.
    const wire: BackupAccountData[] = JSON.parse(JSON.stringify(collected));
    expect(wire[0]).not.toHaveProperty('backupVerified');

    await restoreAccounts(wire);

    const wallet = (
      mockPersistRestoredWallet.mock.calls[0] as unknown[]
    )[0] as {
      accounts: StandardAccountMetadata[];
    };
    const restored = wallet.accounts[0];

    expect(restored.address).toBe(fresh.address);
    expect(restored.label).toBe('Main');
    expect(restored.color).toBe('#123456');
    expect(restored.hasBackup).toBe(true);
    // The verified state does NOT survive the trip — by design.
    expect(restored.backupVerified).toBe(false);
    // TASK-111: the phrase is never persisted into the metadata blob.
    expect(restored.mnemonic).toBe('');
  });
});
