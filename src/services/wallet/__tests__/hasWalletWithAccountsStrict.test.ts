// Unit tests for TASK-213: MultiAccountWalletService.hasWalletWithAccountsStrict().
//
// This STRICT, boot-only wallet-presence probe is what lets AuthContext fail
// CLOSED at boot. It MUST distinguish a genuine secure-storage read FAILURE
// (throw / propagate) from a genuine ABSENCE (resolve false), and it must be a
// pure read — no migration WRITE, no cache mutation, no key material returned.
//
// SECURITY NOTE: no secret material is used; blobs are minimal throwaway JSON.

// In-memory storage backing the platform mock. Prefixed `mock*` so jest's module
// factory hoist allows referencing it (babel-plugin-jest-hoist rule).
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

// Mock the heavy/native side of the wallet dependency graph; the strict probe
// only touches storage.
jest.mock('@/services/ledger/transport', () => ({
  ledgerTransportService: {},
}));
jest.mock('@/services/ledger/algorand', () => ({ ledgerAlgorandService: {} }));
jest.mock('@/services/network', () => ({ NetworkService: {} }));
jest.mock('../../secure/AccountSecureStorage', () => ({
  AccountSecureStorage: {},
}));

import { storage, secureStorage } from '@/platform';
import { MultiAccountWalletService } from '../index';

const WALLET_KEY = 'voi_wallet_metadata';

const mockStorageGet = storage.getItem as jest.Mock;
const mockStorageSet = storage.setItem as jest.Mock;
const mockSecureGet = secureStorage.getItem as jest.Mock;

beforeEach(() => {
  mockStore = {};
  jest.clearAllMocks();
  // Restore the default backed-by-mockStore implementations after clearAllMocks.
  mockStorageGet.mockImplementation(async (k: string) =>
    Object.prototype.hasOwnProperty.call(mockStore, k) ? mockStore[k] : null
  );
  mockStorageSet.mockImplementation(async (k: string, v: string) => {
    mockStore[k] = v;
  });
  mockSecureGet.mockImplementation(async () => null);
});

describe('hasWalletWithAccountsStrict — absence vs failure (TASK-213)', () => {
  it('resolves FALSE for genuine absence (no wallet blob anywhere)', async () => {
    await expect(
      MultiAccountWalletService.hasWalletWithAccountsStrict()
    ).resolves.toBe(false);
  });

  it('resolves TRUE when a wallet with ≥1 account is present', async () => {
    mockStore[WALLET_KEY] = JSON.stringify({ accounts: [{ id: 'a' }] });
    await expect(
      MultiAccountWalletService.hasWalletWithAccountsStrict()
    ).resolves.toBe(true);
  });

  it('resolves FALSE for a present wallet with ZERO accounts (absence-like)', async () => {
    mockStore[WALLET_KEY] = JSON.stringify({ accounts: [] });
    await expect(
      MultiAccountWalletService.hasWalletWithAccountsStrict()
    ).resolves.toBe(false);
  });

  it('THROWS (fails closed) when the primary storage read FAILS', async () => {
    mockStorageGet.mockImplementationOnce(async () => {
      throw new Error('AsyncStorage unavailable');
    });
    await expect(
      MultiAccountWalletService.hasWalletWithAccountsStrict()
    ).rejects.toThrow('AsyncStorage unavailable');
  });

  it('THROWS when the legacy secure-store read FAILS (primary empty)', async () => {
    // Primary returns null → probe consults the legacy secure-store location,
    // whose read throws. That is a genuine failure and must propagate.
    mockSecureGet.mockImplementationOnce(async () => {
      throw new Error('keychain unavailable');
    });
    await expect(
      MultiAccountWalletService.hasWalletWithAccountsStrict()
    ).rejects.toThrow('keychain unavailable');
  });

  it('THROWS (fails closed) on a present-but-corrupt/unparseable blob — never treated as absence', async () => {
    mockStore[WALLET_KEY] = '{not-valid-json';
    await expect(
      MultiAccountWalletService.hasWalletWithAccountsStrict()
    ).rejects.toBeInstanceOf(SyntaxError);
  });

  it('THROWS (fails closed) on valid JSON with a NON-array accounts field — corruption, not absence', async () => {
    // Regression for Codex P2: {"accounts":{}} is valid JSON but structurally
    // corrupt. It must NOT resolve false (absence ⇒ unlocked setup); it must
    // throw so the auth-init path fails closed into recovery.
    mockStore[WALLET_KEY] = JSON.stringify({ accounts: {} });
    await expect(
      MultiAccountWalletService.hasWalletWithAccountsStrict()
    ).rejects.toThrow(/not an array/);
  });

  it('is a PURE read — never writes (no migration/cache side effect)', async () => {
    mockStore[WALLET_KEY] = JSON.stringify({ accounts: [{ id: 'a' }] });
    await MultiAccountWalletService.hasWalletWithAccountsStrict();
    expect(mockStorageSet).not.toHaveBeenCalled();
  });

  it('resolves FALSE when the wipe tombstone is set even if a legacy secure-store copy survives (TASK-212)', async () => {
    // Wiped: primary absent, durable tombstone set, but a legacy secure-store copy
    // lingers (its best-effort delete failed). The strict probe must read it as
    // ABSENT — the tombstone gates the legacy fallback, so a wiped wallet never
    // boots as "present".
    mockStore['voi_wallet_wiped'] = '1';
    mockSecureGet.mockImplementation(async () =>
      JSON.stringify({ accounts: [{ id: 'a' }] })
    );
    await expect(
      MultiAccountWalletService.hasWalletWithAccountsStrict()
    ).resolves.toBe(false);
  });
});

// TASK-213 Codex round-4: hasKeyBearingAccountStrict is the durable, keystore-
// independent corroborating signal that closes the residual Android swallow-to-
// null fail-open. It answers "does a persisted wallet hold ≥1 locally-key-bearing
// (STANDARD) account?" — a state that is IMPOSSIBLE without a configured PIN.
describe('hasKeyBearingAccountStrict — STANDARD-account signal (TASK-213)', () => {
  it('resolves FALSE for genuine absence (no wallet blob)', async () => {
    await expect(
      MultiAccountWalletService.hasKeyBearingAccountStrict()
    ).resolves.toBe(false);
  });

  it('resolves TRUE when a STANDARD (locally-key-bearing) account is present', async () => {
    mockStore[WALLET_KEY] = JSON.stringify({
      accounts: [{ id: 'a', type: 'standard' }],
    });
    await expect(
      MultiAccountWalletService.hasKeyBearingAccountStrict()
    ).resolves.toBe(true);
  });

  it('resolves FALSE for a watch-only / ledger / remote-signer wallet (no local key ⇒ PIN-less is legit)', async () => {
    mockStore[WALLET_KEY] = JSON.stringify({
      accounts: [
        { id: 'w', type: 'watch' },
        { id: 'l', type: 'ledger' },
        { id: 'r', type: 'remote_signer' },
      ],
    });
    await expect(
      MultiAccountWalletService.hasKeyBearingAccountStrict()
    ).resolves.toBe(false);
  });

  it('THROWS (fails closed) when the storage read FAILS — a read failure, not absence', async () => {
    mockStorageGet.mockImplementationOnce(async () => {
      throw new Error('AsyncStorage unavailable');
    });
    await expect(
      MultiAccountWalletService.hasKeyBearingAccountStrict()
    ).rejects.toThrow('AsyncStorage unavailable');
  });

  it('resolves FALSE (never a false positive) on an unparseable blob — corruption is owned by hasWalletWithAccountsStrict', async () => {
    mockStore[WALLET_KEY] = '{not-valid-json';
    await expect(
      MultiAccountWalletService.hasKeyBearingAccountStrict()
    ).resolves.toBe(false);
  });

  it('is a PURE read — never writes', async () => {
    mockStore[WALLET_KEY] = JSON.stringify({
      accounts: [{ id: 'a', type: 'standard' }],
    });
    await MultiAccountWalletService.hasKeyBearingAccountStrict();
    expect(mockStorageSet).not.toHaveBeenCalled();
  });
});
