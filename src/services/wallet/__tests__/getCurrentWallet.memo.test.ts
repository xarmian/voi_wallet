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
import { storage, secureStorage } from '@/platform';
import { AccountType, StandardAccountMetadata, Wallet } from '@/types/wallet';
import { MultiAccountWalletService } from '../index';

const WALLET_KEY = 'voi_wallet_metadata';
const WIPE_TOMBSTONE_KEY = 'voi_wallet_wiped';

/**
 * Build a persisted-wallet blob whose account has an INVALID address but a valid
 * hex publicKey, so getCurrentWallet()'s heal-on-read path re-derives the
 * address and performs a storeWallet() (the read-repair write TASK-212 guards).
 */
function makeHealTriggeringBlob(): string {
  const account = algosdk.generateAccount();
  return JSON.stringify({
    id: 'wallet-1',
    version: '1.0',
    createdAt: '2026-01-01T00:00:00.000Z',
    accounts: [
      {
        id: 'acc-1',
        address: 'INVALID_ADDRESS', // fails algosdk.isValidAddress -> heal-on-read
        publicKey: Buffer.from(account.sk.slice(32)).toString('hex'),
        type: AccountType.STANDARD,
        label: 'Account 1',
        mnemonic: '',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ],
    activeAccountId: 'acc-1',
  });
}

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

  // === TASK-212: write-vs-wipe serialization ===============================

  it('(i) a heal-on-read write does NOT resurrect metadata wiped concurrently by clearAllWallets', async () => {
    mockStore[WALLET_KEY] = makeHealTriggeringBlob();

    // The read triggers a heal-on-read storeWallet(); it races a wipe funneled
    // through the service (which bumps the reset epoch synchronously and
    // serializes the removal on the write chain). The wipe MUST win — the
    // in-flight repair must not re-persist the stale blob.
    const readP = MultiAccountWalletService.getCurrentWallet();
    const wipeP = MultiAccountWalletService.clearAllWallets();
    await Promise.all([readP, wipeP]);
    // Drain any trailing queued write.
    await new Promise((r) => setImmediate(r));

    expect(mockStore[WALLET_KEY]).toBeUndefined();
    // And the next read confirms no wallet survives.
    expect(await MultiAccountWalletService.getCurrentWallet()).toBeNull();
  });

  it('(i2) a heal-on-read write applied with NO concurrent wipe still persists the repair', async () => {
    mockStore[WALLET_KEY] = makeHealTriggeringBlob();

    const w1 = await MultiAccountWalletService.getCurrentWallet();
    if (!w1) throw new Error('expected a wallet');

    // No wipe raced this read, so the heal-on-read write is NOT skipped: the
    // stored blob is rewritten with a valid, re-derived address.
    expect(mockStore[WALLET_KEY]).toBeDefined();
    expect(mockStore[WALLET_KEY]).not.toContain('INVALID_ADDRESS');
    expect(algosdk.isValidAddress(firstStandard(w1).address)).toBe(true);
  });

  it('(j) sanitizeWalletForPersistence scrubs secrets on ALL account types on the write path (type-agnostic)', async () => {
    const account = algosdk.generateAccount();
    const leakedMnemonic = algosdk.secretKeyToMnemonic(account.sk);
    const leakedPrivateKey = Buffer.from(account.sk).toString('hex');
    // A WATCH account (which must never carry key material) with a stray mnemonic
    // AND privateKey. The old type-gated sanitizer (type === STANDARD) would have
    // persisted both; the type-agnostic one must scrub them on any type.
    const wallet = {
      id: 'wallet-1',
      version: '1.0',
      createdAt: '2026-01-01T00:00:00.000Z',
      accounts: [
        {
          id: 'acc-1',
          address: account.addr.toString(),
          publicKey: Buffer.from(account.sk.slice(32)).toString('hex'),
          type: AccountType.WATCH,
          label: 'Watch',
          mnemonic: leakedMnemonic,
          privateKey: leakedPrivateKey,
        },
      ],
      activeAccountId: 'acc-1',
    } as unknown as Wallet;

    // persistRestoredWallet() is the public write wrapper -> storeWallet ->
    // sanitizeWalletForPersistence.
    await MultiAccountWalletService.persistRestoredWallet(wallet);

    const persisted = mockStore[WALLET_KEY];
    expect(persisted).toBeDefined();
    expect(persisted).not.toContain(leakedMnemonic);
    expect(persisted).not.toContain(leakedPrivateKey);
  });

  it('(k) an intentional mutation (setActiveAccount) does NOT resurrect metadata wiped concurrently', async () => {
    mockStore[WALLET_KEY] = makeWalletBlob().blob; // valid, single account acc-1

    // setActiveAccount reads the wallet, mutates, then storeWallet(). A reset
    // funneled through the service races between that read and the write. Either
    // the read fails-closed (getCurrentWallet returns null once the epoch bumps →
    // "No wallet found" throw) OR the write is skipped (epoch advanced) — both
    // mean the wipe wins. Tolerate the throw; the point is NO resurrection.
    const mutateP = MultiAccountWalletService.setActiveAccount('acc-1').catch(
      () => {}
    );
    const wipeP = MultiAccountWalletService.clearAllWallets();
    await Promise.all([mutateP, wipeP]);
    await new Promise((r) => setImmediate(r));

    expect(mockStore[WALLET_KEY]).toBeUndefined();
    expect(await MultiAccountWalletService.getCurrentWallet()).toBeNull();
  });

  it('(k2) an intentional mutation with NO concurrent wipe still persists', async () => {
    mockStore[WALLET_KEY] = makeWalletBlob({ label: 'Before' }).blob;

    await MultiAccountWalletService.updateAccountLabel('acc-1', 'After');

    // No wipe raced, so the label update persisted.
    expect(mockStore[WALLET_KEY]).toBeDefined();
    const w = await MultiAccountWalletService.getCurrentWallet();
    if (!w) throw new Error('expected a wallet');
    expect(firstStandard(w).label).toBe('After');
  });

  it('(l) after a wipe, a surviving legacy copy is NOT re-migrated to resurrect the wallet (durable tombstone guards it regardless of the in-memory epoch)', async () => {
    mockStore[WALLET_KEY] = makeWalletBlob().blob;
    await MultiAccountWalletService.clearAllWallets();
    // Primary gone; the durable tombstone is persisted in general storage.
    expect(mockStore[WALLET_KEY]).toBeUndefined();
    expect(mockStore[WIPE_TOMBSTONE_KEY]).toBe('1');

    // A legacy secure-store copy survives (e.g. its best-effort delete failed).
    // getStoredValue sees the primary absent and falls back to migrateLegacyValue.
    const legacyBlob = makeWalletBlob({ label: 'Legacy' }).blob;
    (secureStorage.getItem as jest.Mock).mockResolvedValueOnce(legacyBlob);

    const result = await MultiAccountWalletService.getCurrentWallet();

    // The tombstone blocks migration — the wiped wallet is NOT resurrected. (The
    // reset epoch passes here since no wipe raced THIS read; the tombstone is the
    // effective guard, and it survives an app restart when the epoch resets.)
    expect(result).toBeNull();
    expect(mockStore[WALLET_KEY]).toBeUndefined();
  });

  it('(l2) a create/restore after a wipe clears the tombstone and persists the new wallet', async () => {
    mockStore[WALLET_KEY] = makeWalletBlob().blob;
    await MultiAccountWalletService.clearAllWallets();
    expect(mockStore[WIPE_TOMBSTONE_KEY]).toBe('1');

    // Restore/create writes a fresh primary — the wiped state is over.
    const fresh = JSON.parse(makeWalletBlob({ label: 'Fresh' }).blob) as Wallet;
    await MultiAccountWalletService.persistRestoredWallet(fresh);

    expect(mockStore[WALLET_KEY]).toBeDefined();
    // Tombstone cleared atomically with the write.
    expect(mockStore[WIPE_TOMBSTONE_KEY]).toBeUndefined();
    const w = await MultiAccountWalletService.getCurrentWallet();
    if (!w) throw new Error('expected the restored wallet');
    expect(firstStandard(w).label).toBe('Fresh');
  });

  it('(m) migrateLegacyValue fails CLOSED on a corrupt legacy wallet blob (never copies raw secrets to general storage)', async () => {
    const account = algosdk.generateAccount();
    const leakedMnemonic = algosdk.secretKeyToMnemonic(account.sk);
    // A corrupt (non-JSON) legacy secure-store blob that still contains a
    // mnemonic. Primary storage is empty, so getStoredValue falls back to
    // migrateLegacyValue.
    const corruptLegacy = '{not valid json ' + leakedMnemonic;
    (secureStorage.getItem as jest.Mock).mockResolvedValueOnce(corruptLegacy);
    (storage.setItem as jest.Mock).mockClear();

    const result = await MultiAccountWalletService.getCurrentWallet();

    // Nothing migrated: no wallet, and the raw secret-bearing payload was NOT
    // written to general storage.
    expect(result).toBeNull();
    expect(mockStore[WALLET_KEY]).toBeUndefined();
    const wroteSecret = (storage.setItem as jest.Mock).mock.calls.some(
      (c) => typeof c[1] === 'string' && c[1].includes(leakedMnemonic)
    );
    expect(wroteSecret).toBe(false);
  });

  it('(n) migrateLegacyValue does NOT clobber a primary blob written concurrently (re-checks absence in-chain)', async () => {
    const freshBlob = makeWalletBlob({ label: 'Fresh' }).blob;
    const legacyBlob = makeWalletBlob({ label: 'Legacy' }).blob;
    // getStoredValue sees the primary absent (triggers migration); by the time the
    // serialized migration task re-checks, a concurrent create/restore has written
    // a fresh primary blob. The migration must observe that and skip.
    (storage.getItem as jest.Mock)
      .mockResolvedValueOnce(null) // getStoredValue: primary absent -> migrate
      .mockResolvedValueOnce(freshBlob); // migration re-check: primary now present
    (secureStorage.getItem as jest.Mock).mockResolvedValueOnce(legacyBlob);
    (storage.setItem as jest.Mock).mockClear();

    await MultiAccountWalletService.getCurrentWallet();

    // Migration must NOT have written the stale legacy blob over the fresh primary.
    expect(storage.setItem as jest.Mock).not.toHaveBeenCalled();
  });

  it('(p) getCurrentWallet returns null (fail-closed) when a wipe races the in-flight read', async () => {
    mockStore[WALLET_KEY] = makeWalletBlob().blob;
    // Prime the memo so the wallet is fully loaded once.
    await MultiAccountWalletService.getCurrentWallet();

    // A read starts (captures the reset epoch) and a wipe bumps the epoch before
    // it returns. getCurrentWallet feeds signing, so it must NOT hand back the
    // stale pre-wipe wallet — it returns null.
    const readP = MultiAccountWalletService.getCurrentWallet();
    const wipeP = MultiAccountWalletService.clearAllWallets();
    const [read] = await Promise.all([readP, wipeP]);

    expect(read).toBeNull();
  });

  it('(q) a stuck tombstone beside a PRESENT primary does not disable mutations — the write proceeds and clears it', async () => {
    mockStore[WALLET_KEY] = makeWalletBlob({ label: 'Before' }).blob;
    // Simulate a stuck tombstone: set beside a still-present primary (a wipe's
    // removeItem failed, or a create's tombstone-clear failed, or a crash between
    // the two). A guarded mutation must NOT silently skip on it.
    mockStore[WIPE_TOMBSTONE_KEY] = '1';

    await MultiAccountWalletService.updateAccountLabel('acc-1', 'After');

    // The update persisted and the stale tombstone was cleared.
    expect(mockStore[WIPE_TOMBSTONE_KEY]).toBeUndefined();
    const w = await MultiAccountWalletService.getCurrentWallet();
    if (!w) throw new Error('expected wallet');
    expect(firstStandard(w).label).toBe('After');
  });
});
