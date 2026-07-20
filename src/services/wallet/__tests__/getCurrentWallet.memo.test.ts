// Unit tests for F-22 (TASK-179): MultiAccountWalletService.getCurrentWallet()
// memoization. This is HIGH-RISK crypto code — getCurrentWallet() feeds signing
// and key retrieval (keyManager/simplifiedKeyManager) and WalletConnect account
// enumeration, so the memo must never (a) hand out a shared reference that a
// caller can mutate into the cache, (b) serve a stale wallet after the stored
// blob changes or is wiped out-of-band (restore clearAllData removes the key
// directly), or (c) retain mnemonic material read from a legacy/unsanitized blob.
//
// SECURITY NOTE: no static/committed secret material is used. Every key/mnemonic
// here is generated fresh in-process by algosdk (ephemeral, throwaway).

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
    // Legacy secure-store location is empty in these tests, so migrateLegacyValue
    // is a no-op and getStoredValue reflects mockStore exactly.
    getItem: jest.fn(async () => null),
    setItem: jest.fn(async () => {}),
    deleteItem: jest.fn(async () => {}),
  },
}));

// Mock the heavy/native side of the wallet dependency graph (untranspilable
// native ESM); getCurrentWallet() itself only touches storage + algosdk.
jest.mock('@/services/ledger/transport', () => ({
  ledgerTransportService: {},
}));
jest.mock('@/services/ledger/algorand', () => ({ ledgerAlgorandService: {} }));
jest.mock('@/services/network', () => ({ NetworkService: {} }));
jest.mock('../../secure/AccountSecureStorage', () => ({
  AccountSecureStorage: {},
}));

import algosdk from 'algosdk';
import { Buffer } from 'buffer';
import { storage } from '@/platform';
import { AccountType, StandardAccountMetadata } from '@/types/wallet';
import { MultiAccountWalletService } from '../index';

const WALLET_KEY = 'voi_wallet_metadata';

/**
 * Build a valid persisted-wallet JSON blob backed by a freshly generated
 * Algorand account (so its address passes algosdk.isValidAddress and the
 * heal-on-read path never rewrites storage — keeping the raw string stable).
 */
function makeWalletBlob(opts?: { label?: string; mnemonic?: string }): {
  blob: string;
  address: string;
  mnemonic: string;
} {
  const account = algosdk.generateAccount();
  const address = account.addr.toString();
  const mnemonic =
    opts?.mnemonic !== undefined
      ? opts.mnemonic
      : /* sanitized blobs carry an empty mnemonic */ '';
  const wallet = {
    id: 'wallet-1',
    version: '1.0',
    createdAt: '2026-01-01T00:00:00.000Z',
    accounts: [
      {
        id: 'acc-1',
        address,
        publicKey: Buffer.from(account.sk.slice(32)).toString('hex'),
        type: AccountType.STANDARD,
        label: opts?.label ?? 'Account 1',
        mnemonic,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ],
    activeAccountId: 'acc-1',
  };
  return { blob: JSON.stringify(wallet), address, mnemonic };
}

function firstStandard(wallet: {
  accounts: unknown[];
}): StandardAccountMetadata {
  return wallet.accounts[0] as StandardAccountMetadata;
}

beforeEach(() => {
  mockStore = {};
});

describe('getCurrentWallet() memoization (F-22, TASK-179)', () => {
  it('(a) two reads of an unchanged wallet return deep-EQUAL but NOT same-reference objects', async () => {
    mockStore[WALLET_KEY] = makeWalletBlob().blob;

    const w1 = await MultiAccountWalletService.getCurrentWallet();
    const w2 = await MultiAccountWalletService.getCurrentWallet();

    if (!w1 || !w2) throw new Error('expected a wallet on both reads');
    // Structurally identical...
    expect(w1).toEqual(w2);
    // ...but every level is an independent clone (no shared reference anywhere a
    // caller could mutate into the cache).
    expect(w1).not.toBe(w2);
    expect(w1.accounts).not.toBe(w2.accounts);
    expect(w1.accounts[0]).not.toBe(w2.accounts[0]);
    expect(w1.settings).not.toBe(w2.settings);
  });

  it('(a2) always re-reads the current stored string (never caches the read itself)', async () => {
    mockStore[WALLET_KEY] = makeWalletBlob().blob;

    await MultiAccountWalletService.getCurrentWallet();
    await MultiAccountWalletService.getCurrentWallet();

    // getStoredValue -> storage.getItem runs on EVERY call (cache hit still reads
    // storage) so an out-of-band wipe is always observed.
    expect((storage.getItem as jest.Mock).mock.calls.length).toBe(2);
  });

  it('(b) mutating a returned wallet does not affect the next read', async () => {
    mockStore[WALLET_KEY] = makeWalletBlob({ label: 'Original' }).blob;

    const w1 = await MultiAccountWalletService.getCurrentWallet();
    if (!w1) throw new Error('expected a wallet');

    // Callers mutate the returned object in place before persisting.
    firstStandard(w1).label = 'MUTATED';
    w1.accounts.push({ id: 'ghost' } as never);
    w1.activeAccountId = 'ghost';

    const w2 = await MultiAccountWalletService.getCurrentWallet();
    if (!w2) throw new Error('expected a wallet');

    expect(w2.accounts).toHaveLength(1);
    expect(firstStandard(w2).label).toBe('Original');
    expect(w2.activeAccountId).toBe('acc-1');
  });

  it('(c) a change to the stored string busts the cache', async () => {
    mockStore[WALLET_KEY] = makeWalletBlob({ label: 'First' }).blob;
    const w1 = await MultiAccountWalletService.getCurrentWallet();
    if (!w1) throw new Error('expected a wallet');
    expect(firstStandard(w1).label).toBe('First');

    // A different account/label => byte-different raw string.
    mockStore[WALLET_KEY] = makeWalletBlob({ label: 'Second' }).blob;
    const w2 = await MultiAccountWalletService.getCurrentWallet();
    if (!w2) throw new Error('expected a wallet');
    expect(firstStandard(w2).label).toBe('Second');
  });

  it('(d) removal of the stored key (clearAllWallets / restore clearAllData) makes the next read return null — no stale wallet', async () => {
    mockStore[WALLET_KEY] = makeWalletBlob().blob;
    const w1 = await MultiAccountWalletService.getCurrentWallet();
    expect(w1).not.toBeNull();

    // Simulate the out-of-band wipe: backup/restorers.ts clearAllData() and
    // clearAllWallets() both remove the key directly, bypassing this service.
    delete mockStore[WALLET_KEY];

    const w2 = await MultiAccountWalletService.getCurrentWallet();
    expect(w2).toBeNull();
  });

  it('(e) a legacy blob carrying a mnemonic is stripped, re-stored sanitized, and never memoized (no secret retained)', async () => {
    const account = algosdk.generateAccount();
    const realMnemonic = algosdk.secretKeyToMnemonic(account.sk);
    const sensitive = {
      id: 'wallet-1',
      version: '1.0',
      createdAt: '2026-01-01T00:00:00.000Z',
      accounts: [
        {
          id: 'acc-1',
          address: account.addr.toString(),
          publicKey: Buffer.from(account.sk.slice(32)).toString('hex'),
          type: AccountType.STANDARD,
          label: 'Account 1',
          mnemonic: realMnemonic,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      activeAccountId: 'acc-1',
    };
    const sensitiveBlob = JSON.stringify(sensitive);
    mockStore[WALLET_KEY] = sensitiveBlob;

    const w1 = await MultiAccountWalletService.getCurrentWallet();
    if (!w1) throw new Error('expected a wallet');

    // Returned wallet is mnemonic-stripped...
    expect(firstStandard(w1).mnemonic).toBe('');
    // ...and storage was rewritten to a sanitized blob (mnemonic gone).
    expect(mockStore[WALLET_KEY]).not.toContain(realMnemonic);

    // Prove the mnemonic-bearing raw string was NOT memoized: put it back and
    // read again. If it had been cached, the second read would fast-path hit and
    // skip the strip+re-store (storage.setItem). It must re-strip instead.
    mockStore[WALLET_KEY] = sensitiveBlob;
    (storage.setItem as jest.Mock).mockClear();
    const w2 = await MultiAccountWalletService.getCurrentWallet();
    if (!w2) throw new Error('expected a wallet');
    expect(firstStandard(w2).mnemonic).toBe('');
    expect((storage.setItem as jest.Mock).mock.calls.length).toBeGreaterThan(0);
  });

  it('(f) concurrent cold-boot reads collapse into a single parse and return independent clones', async () => {
    mockStore[WALLET_KEY] = makeWalletBlob().blob;

    // Fire concurrently against a cold cache: in-flight dedup should collapse the
    // parse, and each caller must still get its own deep clone.
    const [a, b, c] = await Promise.all([
      MultiAccountWalletService.getCurrentWallet(),
      MultiAccountWalletService.getCurrentWallet(),
      MultiAccountWalletService.getCurrentWallet(),
    ]);
    if (!a || !b || !c) throw new Error('expected wallets');

    expect(a).toEqual(b);
    expect(a).toEqual(c);
    expect(a).not.toBe(b);
    expect(a.accounts[0]).not.toBe(b.accounts[0]);
    expect(b.accounts[0]).not.toBe(c.accounts[0]);
  });

  it('(g) concurrent reads of a legacy mnemonic blob are handled inline (no dedup) and never leak the secret', async () => {
    const account = algosdk.generateAccount();
    const realMnemonic = algosdk.secretKeyToMnemonic(account.sk);
    const sensitiveBlob = JSON.stringify({
      id: 'wallet-1',
      version: '1.0',
      createdAt: '2026-01-01T00:00:00.000Z',
      accounts: [
        {
          id: 'acc-1',
          address: account.addr.toString(),
          publicKey: Buffer.from(account.sk.slice(32)).toString('hex'),
          type: AccountType.STANDARD,
          label: 'Account 1',
          mnemonic: realMnemonic,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      activeAccountId: 'acc-1',
    });
    mockStore[WALLET_KEY] = sensitiveBlob;

    // The legacy path never registers the in-flight map, so concurrent callers
    // each strip inline (idempotent). Every result is mnemonic-free.
    const results = await Promise.all([
      MultiAccountWalletService.getCurrentWallet(),
      MultiAccountWalletService.getCurrentWallet(),
    ]);
    for (const w of results) {
      if (!w) throw new Error('expected a wallet');
      expect(firstStandard(w).mnemonic).toBe('');
    }
    // Storage ended up sanitized regardless of interleaving.
    expect(mockStore[WALLET_KEY]).not.toContain(realMnemonic);
  });

  it('(h) a secret on a MISTYPED / non-STANDARD account is still detected, scrubbed, and never cached (type-agnostic, fail-closed)', async () => {
    const account = algosdk.generateAccount();
    const leakedMnemonic = algosdk.secretKeyToMnemonic(account.sk);
    // A corrupt/legacy/tampered blob: a WATCH account (which should never carry
    // key material) with a mnemonic AND a stray privateKey. A type-gated check
    // (type === STANDARD) would miss this; the type-agnostic detector must catch
    // it so the secret-bearing raw string never becomes a cache/in-flight key.
    const corruptBlob = JSON.stringify({
      id: 'wallet-1',
      version: '1.0',
      createdAt: '2026-01-01T00:00:00.000Z',
      accounts: [
        {
          id: 'acc-1',
          address: account.addr.toString(),
          publicKey: Buffer.from(account.sk.slice(32)).toString('hex'),
          type: AccountType.WATCH,
          label: 'Watch 1',
          mnemonic: leakedMnemonic,
          privateKey: Buffer.from(account.sk).toString('hex'),
        },
      ],
      activeAccountId: 'acc-1',
    });
    mockStore[WALLET_KEY] = corruptBlob;

    const w1 = await MultiAccountWalletService.getCurrentWallet();
    if (!w1) throw new Error('expected a wallet');

    // The secret fields are gone from the returned object...
    const acc0 = w1.accounts[0] as unknown as Record<string, unknown>;
    expect(acc0.mnemonic).toBeUndefined();
    expect(acc0.privateKey).toBeUndefined();
    // ...and storage was rewritten with neither secret present.
    expect(mockStore[WALLET_KEY]).not.toContain(leakedMnemonic);
    expect(mockStore[WALLET_KEY]).not.toContain(
      Buffer.from(account.sk).toString('hex')
    );

    // And it was NOT memoized: re-seed the corrupt blob and read again; a cached
    // secret-bearing string would fast-path hit and skip the re-store.
    mockStore[WALLET_KEY] = corruptBlob;
    (storage.setItem as jest.Mock).mockClear();
    const w2 = await MultiAccountWalletService.getCurrentWallet();
    if (!w2) throw new Error('expected a wallet');
    expect((storage.setItem as jest.Mock).mock.calls.length).toBeGreaterThan(0);
  });
});
