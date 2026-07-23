/**
 * TASK-45 / DR-11 — the `backupVerified` carrier contract at the importer.
 *
 * Both onboarding paths converge on `importStandardAccount`:
 *   1. first-wallet onboarding → `SecuritySetup` route param → importer
 *   2. add-account → `MnemonicBackupFlow` result → `ImportAccountRequest` →
 *      importer (this flow does NOT pass through SecuritySetup)
 *
 * Everything else — plain import, private-key import, QR import — must persist
 * `false`, and `hasBackup` must keep its legacy "a mnemonic was supplied"
 * meaning untouched (DR-10).
 *
 * SECURITY NOTE: every mnemonic/key is generated fresh in-process by algosdk.
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
    storeAccountForCreation: jest.fn(async () => 'token'),
    commitPendingCreate: jest.fn(async () => {}),
    deleteAccountIfAttemptMatches: jest.fn(async () => {}),
  },
}));

import algosdk from 'algosdk';
import { Buffer } from 'buffer';
import { AccountType, StandardAccountMetadata } from '@/types/wallet';
import { MultiAccountWalletService } from '../index';

const WALLET_KEY = 'voi_wallet_metadata';

function persistedAccount(id: string): Record<string, unknown> {
  const wallet = JSON.parse(mockStore[WALLET_KEY]);
  return wallet.accounts.find((a: { id: string }) => a.id === id);
}

beforeEach(() => {
  mockStore = {};
  jest.clearAllMocks();
});

describe('importStandardAccount — backupVerified carrier', () => {
  it('persists true ONLY when the caller explicitly asserts it', async () => {
    const mnemonic = algosdk.secretKeyToMnemonic(algosdk.generateAccount().sk);

    const account = await MultiAccountWalletService.importStandardAccount({
      type: AccountType.STANDARD,
      mnemonic,
      label: 'Verified',
      backupVerified: true,
    });

    expect(account.backupVerified).toBe(true);
    expect(persistedAccount(account.id).backupVerified).toBe(true);
  });

  it('persists false when the field is omitted (plain / QR import)', async () => {
    const mnemonic = algosdk.secretKeyToMnemonic(algosdk.generateAccount().sk);

    const account = await MultiAccountWalletService.importStandardAccount({
      type: AccountType.STANDARD,
      mnemonic,
      label: 'Imported',
    });

    expect(account.backupVerified).toBe(false);
    expect(persistedAccount(account.id).backupVerified).toBe(false);
    // Legacy semantics untouched: a mnemonic WAS supplied.
    expect(account.hasBackup).toBe(true);
  });

  it('persists false for the skip path (explicit false)', async () => {
    const mnemonic = algosdk.secretKeyToMnemonic(algosdk.generateAccount().sk);

    const account = await MultiAccountWalletService.importStandardAccount({
      type: AccountType.STANDARD,
      mnemonic,
      label: 'Skipped',
      backupVerified: false,
    });

    expect(account.backupVerified).toBe(false);
  });

  it('does not accept a truthy non-boolean as verification', async () => {
    const mnemonic = algosdk.secretKeyToMnemonic(algosdk.generateAccount().sk);

    const account = await MultiAccountWalletService.importStandardAccount({
      type: AccountType.STANDARD,
      mnemonic,
      label: 'Sloppy',
      backupVerified: 'yes' as unknown as boolean,
    });

    expect(account.backupVerified).toBe(false);
  });

  it('persists false for a private-key import', async () => {
    const generated = algosdk.generateAccount();
    const privateKey = Buffer.from(generated.sk).toString('hex');

    const account = await MultiAccountWalletService.importStandardAccount({
      type: AccountType.STANDARD,
      privateKey,
      label: 'From key',
    });

    expect(account.backupVerified).toBe(false);
    // Legacy field: no mnemonic was supplied.
    expect(account.hasBackup).toBe(false);
  });

  it('REFUSES a private-key import that asserts backupVerified: true', async () => {
    // A raw key import never shows the user a phrase, so there is nothing they
    // could have confirmed. Asserting verification here must not be honoured —
    // otherwise the recovery warning would be suppressed for an account whose
    // phrase the user has never seen.
    const generated = algosdk.generateAccount();
    const privateKey = Buffer.from(generated.sk).toString('hex');

    const account = await MultiAccountWalletService.importStandardAccount({
      type: AccountType.STANDARD,
      privateKey,
      label: 'From key',
      backupVerified: true,
    });

    expect(account.backupVerified).toBe(false);
    expect(persistedAccount(account.id).backupVerified).toBe(false);
  });
});

describe('createStandardAccount', () => {
  it('always starts unverified', async () => {
    const account = await MultiAccountWalletService.createStandardAccount({
      type: AccountType.STANDARD,
      label: 'Generated',
    });

    expect(account.backupVerified).toBe(false);
    expect(account.hasBackup).toBe(false);
  });
});

describe('add-account carrier: verified import then read back', () => {
  it('survives a getCurrentWallet round trip without being reset by the migration', async () => {
    const mnemonic = algosdk.secretKeyToMnemonic(algosdk.generateAccount().sk);
    const account = await MultiAccountWalletService.importStandardAccount({
      type: AccountType.STANDARD,
      mnemonic,
      label: 'Verified',
      backupVerified: true,
    });

    const wallet = await MultiAccountWalletService.getCurrentWallet();
    const readBack = wallet!.accounts.find(
      (a) => a.id === account.id
    ) as StandardAccountMetadata;

    expect(readBack.backupVerified).toBe(true);
    // TASK-111: the phrase itself never reaches the persisted blob.
    expect(persistedAccount(account.id).mnemonic).toBe('');
  });
});
