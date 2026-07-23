/**
 * TASK-45 / DR-10 — `backupVerified` metadata migration.
 *
 * Every account persisted before this field existed must read back as
 * `backupVerified: false`. It must NOT be derived from `hasBackup`, which means
 * "a mnemonic was supplied", not "the user proved they hold it" — deriving it
 * would silently mark every existing install as backed up and permanently
 * suppress the Home warning.
 *
 * The migration piggy-backs on getCurrentWallet()'s existing read-repair write,
 * so it must also be idempotent (no write on a second read) and safe on installs
 * whose blob is already migrated, partially migrated, or corrupted.
 *
 * SECURITY NOTE: no committed secret material — every key is generated fresh
 * in-process by algosdk and never leaves this file.
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

jest.mock('@/services/ledger/transport', () => ({
  ledgerTransportService: {},
}));
jest.mock('@/services/ledger/algorand', () => ({ ledgerAlgorandService: {} }));
jest.mock('@/services/network', () => ({ NetworkService: {} }));
jest.mock('../../secure/AccountSecureStorage', () => ({
  AccountSecureStorage: { getResetGeneration: () => 0 },
}));

import algosdk from 'algosdk';
import { Buffer } from 'buffer';
import { storage } from '@/platform';
import {
  AccountType,
  StandardAccountMetadata,
  isBackupVerified,
} from '@/types/wallet';
import { MultiAccountWalletService } from '../index';

const WALLET_KEY = 'voi_wallet_metadata';

/** A persisted account record as written by a build that predates the field. */
function legacyStandardAccount(id: string, hasBackup: boolean) {
  const account = algosdk.generateAccount();
  return {
    id,
    address: account.addr.toString(),
    publicKey: Buffer.from(account.sk.slice(32)).toString('hex'),
    type: AccountType.STANDARD,
    label: id,
    isHidden: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastUsed: '2026-01-01T00:00:00.000Z',
    mnemonic: '',
    hasBackup,
    // NOTE: no `backupVerified` — that is the whole point.
  };
}

function legacyWatchAccount(id: string) {
  const account = algosdk.generateAccount();
  return {
    id,
    address: account.addr.toString(),
    publicKey: Buffer.from(account.sk.slice(32)).toString('hex'),
    type: AccountType.WATCH,
    label: id,
    isHidden: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastUsed: '2026-01-01T00:00:00.000Z',
  };
}

function persistBlob(accounts: unknown[]): void {
  mockStore[WALLET_KEY] = JSON.stringify({
    id: 'wallet-1',
    version: '1.0',
    createdAt: '2026-01-01T00:00:00.000Z',
    accounts,
    activeAccountId: (accounts[0] as { id: string }).id,
    settings: {},
  });
}

function storedAccounts(): Record<string, unknown>[] {
  return JSON.parse(mockStore[WALLET_KEY]).accounts;
}

beforeEach(() => {
  mockStore = {};
  jest.clearAllMocks();
});

describe('backupVerified migration on existing installs', () => {
  it('defaults legacy standard accounts to false, regardless of hasBackup', () => {
    persistBlob([
      legacyStandardAccount('acc-untouched', false),
      // hasBackup: true is the common legacy state (any imported mnemonic set
      // it). It must NOT be read as "verified".
      legacyStandardAccount('acc-legacy-hasbackup', true),
    ]);

    return MultiAccountWalletService.getCurrentWallet().then((wallet) => {
      expect(wallet).not.toBeNull();
      const accounts = wallet!.accounts as StandardAccountMetadata[];
      expect(accounts.map((a) => a.backupVerified)).toEqual([false, false]);
      expect(accounts.every((a) => !isBackupVerified(a))).toBe(true);
    });
  });

  it('persists the migrated value so it survives a restart', async () => {
    persistBlob([legacyStandardAccount('acc-1', true)]);

    await MultiAccountWalletService.getCurrentWallet();

    const persisted = storedAccounts();
    expect(persisted[0].backupVerified).toBe(false);
    // Legacy semantics preserved, not rewritten (DR-10).
    expect(persisted[0].hasBackup).toBe(true);
  });

  it('is idempotent — a second read performs no further write', async () => {
    persistBlob([legacyStandardAccount('acc-1', true)]);

    await MultiAccountWalletService.getCurrentWallet();
    const writesAfterMigration = (storage.setItem as jest.Mock).mock.calls
      .length;
    const blobAfterMigration = mockStore[WALLET_KEY];

    // Force a cold re-read (the raw string changed, so the memo is bypassed).
    await MultiAccountWalletService.getCurrentWallet();
    await MultiAccountWalletService.getCurrentWallet();

    expect((storage.setItem as jest.Mock).mock.calls.length).toBe(
      writesAfterMigration
    );
    expect(mockStore[WALLET_KEY]).toBe(blobAfterMigration);
  });

  it('leaves an already-verified account verified', async () => {
    persistBlob([
      { ...legacyStandardAccount('acc-1', true), backupVerified: true },
    ]);

    const wallet = await MultiAccountWalletService.getCurrentWallet();
    const account = wallet!.accounts[0] as StandardAccountMetadata;
    expect(account.backupVerified).toBe(true);
    expect(isBackupVerified(account)).toBe(true);
  });

  it('coerces a non-boolean value to false rather than trusting it', async () => {
    persistBlob([
      {
        ...legacyStandardAccount('acc-1', true),
        backupVerified: 'yes' as unknown as boolean,
      },
    ]);

    const wallet = await MultiAccountWalletService.getCurrentWallet();
    expect(
      (wallet!.accounts[0] as StandardAccountMetadata).backupVerified
    ).toBe(false);
  });

  it('does not add the field to non-standard accounts', async () => {
    persistBlob([legacyWatchAccount('watch-1')]);

    await MultiAccountWalletService.getCurrentWallet();
    expect(storedAccounts()[0]).not.toHaveProperty('backupVerified');
  });

  it('migrates a mixed blob in one pass', async () => {
    persistBlob([
      legacyStandardAccount('acc-legacy', true),
      { ...legacyStandardAccount('acc-verified', true), backupVerified: true },
      legacyWatchAccount('watch-1'),
    ]);

    const wallet = await MultiAccountWalletService.getCurrentWallet();
    const byId = Object.fromEntries(wallet!.accounts.map((a) => [a.id, a]));
    expect((byId['acc-legacy'] as StandardAccountMetadata).backupVerified).toBe(
      false
    );
    expect(
      (byId['acc-verified'] as StandardAccountMetadata).backupVerified
    ).toBe(true);
    expect(byId['watch-1']).not.toHaveProperty('backupVerified');
  });
});

describe('markBackupVerified', () => {
  it('flips the flag to true and persists it', async () => {
    persistBlob([legacyStandardAccount('acc-1', true)]);

    const updated = await MultiAccountWalletService.markBackupVerified('acc-1');
    expect(updated.backupVerified).toBe(true);
    expect(updated.backupCreatedAt).toBeDefined();
    expect(storedAccounts()[0].backupVerified).toBe(true);
  });

  it('is idempotent and performs no write when already verified', async () => {
    persistBlob([
      { ...legacyStandardAccount('acc-1', true), backupVerified: true },
    ]);
    // Prime the read so the migration pass (if any) is already done.
    await MultiAccountWalletService.getCurrentWallet();
    const writesBefore = (storage.setItem as jest.Mock).mock.calls.length;

    const updated = await MultiAccountWalletService.markBackupVerified('acc-1');
    expect(updated.backupVerified).toBe(true);
    expect((storage.setItem as jest.Mock).mock.calls.length).toBe(writesBefore);
  });

  it('refuses a non-standard account', async () => {
    persistBlob([legacyWatchAccount('watch-1')]);
    await expect(
      MultiAccountWalletService.markBackupVerified('watch-1')
    ).rejects.toThrow(/recovery phrase/i);
  });

  it('throws for an unknown account id', async () => {
    persistBlob([legacyStandardAccount('acc-1', true)]);
    await expect(
      MultiAccountWalletService.markBackupVerified('nope')
    ).rejects.toThrow(/not found/i);
  });

  it('does not clobber a concurrent mutation that landed after its read', async () => {
    // The lost-update hazard: markBackupVerified used to persist the whole
    // snapshot it read, so anything written in between (a label edit, an
    // active-account change) was silently reverted. The write is now a
    // serialized read-modify-write against the CURRENT blob.
    persistBlob([
      legacyStandardAccount('acc-1', true),
      legacyStandardAccount('acc-2', true),
    ]);
    await MultiAccountWalletService.getCurrentWallet();

    const realGetItem = storage.getItem as jest.Mock;
    const originalImpl = realGetItem.getMockImplementation()!;
    let injected = false;
    realGetItem.mockImplementation(async (key: string) => {
      const value = await originalImpl(key);
      // Simulate another mutation committing in the window between
      // markBackupVerified's read and its write.
      if (key === WALLET_KEY && !injected) {
        injected = true;
        const blob = JSON.parse(mockStore[WALLET_KEY]);
        blob.accounts[1].label = 'RENAMED BY SOMEONE ELSE';
        blob.activeAccountId = 'acc-2';
        mockStore[WALLET_KEY] = JSON.stringify(blob);
      }
      return value;
    });

    await MultiAccountWalletService.markBackupVerified('acc-1');
    realGetItem.mockImplementation(originalImpl);

    const persisted = JSON.parse(mockStore[WALLET_KEY]);
    expect(persisted.accounts[0].backupVerified).toBe(true);
    // The concurrent change survived.
    expect(persisted.accounts[1].label).toBe('RENAMED BY SOMEONE ELSE');
    expect(persisted.activeAccountId).toBe('acc-2');
  });

  it('fails closed instead of resurrecting a wallet wiped mid-flight', async () => {
    persistBlob([legacyStandardAccount('acc-1', true)]);
    await MultiAccountWalletService.getCurrentWallet();

    const realGetItem = storage.getItem as jest.Mock;
    const originalImpl = realGetItem.getMockImplementation()!;
    let wiped = false;
    realGetItem.mockImplementation(async (key: string) => {
      const value = await originalImpl(key);
      if (key === WALLET_KEY && !wiped) {
        wiped = true;
        delete mockStore[WALLET_KEY];
      }
      return value;
    });

    await expect(
      MultiAccountWalletService.markBackupVerified('acc-1')
    ).rejects.toThrow(/could not record/i);
    realGetItem.mockImplementation(originalImpl);

    // No blob was written back.
    expect(mockStore[WALLET_KEY]).toBeUndefined();
  });
});
