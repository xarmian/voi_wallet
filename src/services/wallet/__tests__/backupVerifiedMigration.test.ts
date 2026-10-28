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
  AccountSecureStorage: {
    getResetGeneration: () => 0,
    probeSecretPresenceStrict: jest.fn(),
  },
}));

import algosdk from 'algosdk';
import { Buffer } from 'buffer';
import { storage } from '@/platform';
import { AccountSecureStorage } from '@/services/secure/AccountSecureStorage';
import {
  AccountType,
  StandardAccountMetadata,
  RekeyedAccountMetadata,
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

  it('does not add the field to WATCH accounts', async () => {
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

function rekeyedAccount(id: string): RekeyedAccountMetadata {
  return {
    ...legacyWatchAccount(id),
    type: AccountType.REKEYED,
    authAddress: algosdk.generateAccount().addr.toString(),
    canSign: true,
  };
}

describe('REKEYED backup metadata', () => {
  it('round-trips each account’s own flags without changing STANDARD bytes', async () => {
    const standard = {
      ...legacyStandardAccount('standard', true),
      backupVerified: true,
      backupCreatedAt: '2026-01-02T00:00:00.000Z',
    };
    const accounts: RekeyedAccountMetadata[] = [
      {
        ...rekeyedAccount('verified'),
        hasBackup: false,
        backupVerified: true,
        backupCreatedAt: '2026-02-01T00:00:00.000Z',
      },
      {
        ...rekeyedAccount('unverified'),
        hasBackup: true,
        backupVerified: false,
      },
    ];
    // The existing sanitizer removes and reinserts mnemonic at the end.
    delete (standard as Partial<StandardAccountMetadata>).mnemonic;
    standard.mnemonic = '';
    persistBlob([standard, ...accounts, rekeyedAccount('legacy')]);
    const wallet = await MultiAccountWalletService.getCurrentWallet();
    expect(wallet!.accounts.slice(1, 3)).toEqual(accounts);
    expect(JSON.stringify(storedAccounts()[0])).toBe(JSON.stringify(standard));
    expect(storedAccounts().slice(1, 3)).toEqual(accounts);
    // Exercise the normal persistence path as well as read-repair.
    await MultiAccountWalletService.persistRestoredWallet(wallet!);
    expect(
      (await MultiAccountWalletService.getCurrentWallet())!.accounts.slice(1, 3)
    ).toEqual(accounts);
  });

  it.each([undefined, null, 'true', 'false', 1, 0, {}, []])(
    'normalizes missing/invalid verification %p without inventing other flags',
    async (backupVerified) => {
      const account = rekeyedAccount('legacy-rekeyed');
      persistBlob([{ ...account, backupVerified }]);
      const wallet = await MultiAccountWalletService.getCurrentWallet();
      expect(wallet!.accounts[0]).toEqual({
        ...account,
        backupVerified: false,
      });
      expect(storedAccounts()[0]).toEqual({
        ...account,
        backupVerified: false,
      });
      const writes = (storage.setItem as jest.Mock).mock.calls.length;
      await MultiAccountWalletService.getCurrentWallet();
      await MultiAccountWalletService.getCurrentWallet();
      expect(storage.setItem).toHaveBeenCalledTimes(writes);
    }
  );

  it('never derives verification from hasBackup or a verified auth account', async () => {
    const signer = { ...rekeyedAccount('signer'), backupVerified: true };
    const delegated = {
      ...rekeyedAccount('delegated'),
      authAddress: signer.address,
      hasBackup: true,
    };
    persistBlob([signer, delegated]);
    await MultiAccountWalletService.getCurrentWallet();
    expect(storedAccounts()[0].backupVerified).toBe(true);
    expect(storedAccounts()[1]).toEqual({
      ...delegated,
      backupVerified: false,
    });
  });
});

describe('markBackupVerified', () => {
  it('flips the flag to true and persists it', async () => {
    persistBlob([legacyStandardAccount('acc-1', true)]);

    const updated = await MultiAccountWalletService.markBackupVerified(
      'acc-1',
      String(storedAccounts()[0].address)
    );
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

    const updated = await MultiAccountWalletService.markBackupVerified(
      'acc-1',
      String(storedAccounts()[0].address)
    );
    expect(updated.backupVerified).toBe(true);
    expect((storage.setItem as jest.Mock).mock.calls.length).toBe(writesBefore);
  });

  it('refuses a non-standard account', async () => {
    persistBlob([legacyWatchAccount('watch-1')]);
    await expect(
      MultiAccountWalletService.markBackupVerified(
        'watch-1',
        String(storedAccounts()[0].address)
      )
    ).rejects.toThrow(/recovery phrase/i);
  });

  it('throws for an unknown account id', async () => {
    persistBlob([legacyStandardAccount('acc-1', true)]);
    await expect(
      MultiAccountWalletService.markBackupVerified('nope', 'missing')
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

    await MultiAccountWalletService.markBackupVerified(
      'acc-1',
      String(storedAccounts()[0].address)
    );
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
      MultiAccountWalletService.markBackupVerified(
        'acc-1',
        String(storedAccounts()[0].address)
      )
    ).rejects.toThrow(/could not record/i);
    realGetItem.mockImplementation(originalImpl);

    // No blob was written back.
    expect(mockStore[WALLET_KEY]).toBeUndefined();
  });
});

describe('local-key verification eligibility', () => {
  const probe = AccountSecureStorage.probeSecretPresenceStrict as jest.Mock;

  async function seed(originalOwner = false) {
    const target = {
      ...rekeyedAccount('target'),
      originalOwner,
      backupVerified: false,
    };
    const signer = {
      ...legacyStandardAccount('signer', true),
      backupVerified: false,
    };
    target.authAddress = signer.address;
    persistBlob([target, signer]);
    await MultiAccountWalletService.getCurrentWallet();
    jest.clearAllMocks();
    probe.mockReset().mockResolvedValue(true);
    return target;
  }

  it.each([true, false])(
    'verifies only the REKEYED target (originalOwner=%s)',
    async (owner) => {
      const target = await seed(owner);
      const before = storedAccounts();
      const result = await MultiAccountWalletService.markBackupVerified(
        target.id,
        target.address
      );
      expect(result).toMatchObject({
        id: target.id,
        type: AccountType.REKEYED,
        backupVerified: true,
      });
      expect(storedAccounts()[0]).toEqual({
        ...before[0],
        backupVerified: true,
        backupCreatedAt: result.backupCreatedAt,
      });
      expect(storedAccounts()[1]).toEqual(before[1]);
      if (owner) expect(probe).not.toHaveBeenCalled();
      else expect(probe.mock.calls).toEqual([[target.id], [target.id]]);
      const writes = (storage.setItem as jest.Mock).mock.calls.length;
      await MultiAccountWalletService.markBackupVerified(
        target.id,
        target.address
      );
      expect(storage.setItem).toHaveBeenCalledTimes(writes);
    }
  );

  it.each(['absent', 'error'])(
    'rejects initial probe %s even if already verified',
    async (state) => {
      const target = await seed();
      if (state === 'error')
        probe.mockRejectedValue(new Error('vault unavailable'));
      else probe.mockResolvedValue(false);
      for (const verified of [false, true]) {
        const accounts = storedAccounts();
        accounts[0].backupVerified = verified;
        persistBlob(accounts);
        await expect(
          MultiAccountWalletService.markBackupVerified(
            target.id,
            target.address
          )
        ).rejects.toThrow();
      }
      expect(storage.setItem).not.toHaveBeenCalled();
    }
  );

  it.each(['absent', 'error'])(
    'rejects serialized probe %s after initial presence',
    async (state) => {
      const target = await seed();
      probe.mockReset().mockResolvedValueOnce(true);
      if (state === 'error')
        probe.mockRejectedValueOnce(new Error('vault unavailable'));
      else probe.mockResolvedValueOnce(false);
      await expect(
        MultiAccountWalletService.markBackupVerified(target.id, target.address)
      ).rejects.toThrow(/could not record/i);
      expect(storage.setItem).not.toHaveBeenCalled();
      expect(storedAccounts()[0].backupVerified).toBe(false);
    }
  );

  it('returns the committed record when a conversion lands between the reads', async () => {
    const target = await seed();
    // A rekey back to self converts the account to STANDARD after the initial
    // read but before the serialized write.
    probe.mockImplementationOnce(async () => {
      const accounts = storedAccounts();
      const { authAddress: _auth, canSign: _canSign, ...rest } = accounts[0];
      accounts[0] = { ...rest, type: AccountType.STANDARD };
      persistBlob(accounts);
      return true;
    });
    const result = await MultiAccountWalletService.markBackupVerified(
      target.id,
      target.address
    );
    expect(result).toMatchObject({
      id: target.id,
      type: AccountType.STANDARD,
      backupVerified: true,
    });
    expect(result).not.toHaveProperty('authAddress');
    expect(storedAccounts()[0]).toMatchObject({
      type: AccountType.STANDARD,
      backupVerified: true,
    });
  });

  it('rejects an expected-address mismatch before writing', async () => {
    const target = await seed();
    await expect(
      MultiAccountWalletService.markBackupVerified(target.id, 'different')
    ).rejects.toThrow();
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
  });

  it.each([
    'address',
    'id',
    AccountType.WATCH,
    AccountType.LEDGER,
    AccountType.REMOTE_SIGNER,
  ])('rejects a concurrent identity/type change: %s', async (change) => {
    const target = await seed();
    probe.mockImplementationOnce(async () => {
      const accounts = storedAccounts();
      if (change === 'address') accounts[0].address = accounts[1].address;
      else if (change === 'id') accounts[0].id = 'replacement';
      else accounts[0].type = change;
      persistBlob(accounts);
      return true;
    });
    await expect(
      MultiAccountWalletService.markBackupVerified(target.id, target.address)
    ).rejects.toThrow(/could not record/i);
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storedAccounts()[0].backupVerified).toBe(false);
  });

  it.each([AccountType.WATCH, AccountType.LEDGER, AccountType.REMOTE_SIGNER])(
    'rejects %s initially',
    async (type) => {
      const target = await seed();
      const accounts = storedAccounts();
      accounts[0].type = type;
      persistBlob(accounts);
      await expect(
        MultiAccountWalletService.markBackupVerified(target.id, target.address)
      ).rejects.toThrow();
      expect(storage.setItem).not.toHaveBeenCalled();
    }
  );

  it.each([1, 2])(
    'rejects a reset during eligibility check %s',
    async (check) => {
      const target = await seed();
      let reset: Promise<void> | undefined;
      if (check === 2) probe.mockResolvedValueOnce(true);
      probe.mockImplementationOnce(async () => {
        reset = MultiAccountWalletService.clearAllWallets();
        return true;
      });
      await expect(
        MultiAccountWalletService.markBackupVerified(target.id, target.address)
      ).rejects.toThrow();
      await reset;
      expect(mockStore[WALLET_KEY]).toBeUndefined();
      expect(
        (storage.setItem as jest.Mock).mock.calls.filter(
          ([key]) => key === WALLET_KEY
        )
      ).toEqual([]);
    }
  );
});
