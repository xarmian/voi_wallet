/**
 * Shared Algorand / algosdk-v3 test fixtures (TASK-149).
 *
 * Purpose: give the P0 signing / transaction / state test tasks one place to get
 * (a) real deterministic accounts, (b) real algosdk-v3 Transaction fixtures, and
 * (c) a minimal zustand store harness — so parallel worktrees stop re-rolling
 * their own inline copies (and stop conflicting on them).
 *
 * SECURITY / DR-3 (non-negotiable): every key here is REAL crypto. Accounts are
 * derived entirely through algosdk itself — a deterministic 32-byte seed is turned
 * into a 25-word mnemonic (`algosdk.mnemonicFromSeed`) and then into the real
 * Ed25519 secret key / address (`algosdk.mnemonicToSecretKey`). There is NO
 * hardcoded/mocked private key or fabricated signature anywhere, and no undeclared
 * crypto dependency (only algosdk + Node's core `crypto` hash for the seed). The
 * seeds come from harmless fixture labels ("voi-test-fixture:<label>"), so no real
 * user key material exists to leak — but as a rule, callers must never log
 * `sk`/`mnemonic` from these fixtures either.
 *
 * These are throwaway keys for offline tests. The transactions are never
 * submitted, so the network identity (genesisHash) is intentionally a fixed,
 * obviously-fake value.
 */

import { createHash } from 'crypto';

import algosdk from 'algosdk';
import { Buffer } from 'buffer';
import { createStore } from 'zustand/vanilla';

// ---------------------------------------------------------------------------
// (a) Deterministic account factory
// ---------------------------------------------------------------------------

export interface TestAccount {
  /** 25-word Algorand mnemonic (algosdk-derived, Pera/MyAlgo compatible). */
  readonly mnemonic: string;
  /** 64-byte Ed25519 secret key: seed(32) || publicKey(32) — algosdk `sk` layout. */
  readonly sk: Uint8Array;
  /** 32-byte Ed25519 public key. */
  readonly pk: Uint8Array;
  /** Base32 Algorand address (checksummed), as a string. */
  readonly addr: string;
  /** algosdk Account (has `.addr` as an Address object and `.sk`). */
  readonly account: algosdk.Account;
}

/**
 * Deterministically derive a 32-byte seed from a human-readable label using a
 * real hash (SHA-512, truncated to 32 bytes). Same label -> same account, every
 * run; different labels -> independent accounts. Node's core `crypto` is used so
 * no extra crypto dependency is pulled in (this file only ever runs under jest).
 */
function seedFromLabel(label: string): Uint8Array {
  const digest = createHash('sha512')
    .update(`voi-test-fixture:${label}`)
    .digest();
  return new Uint8Array(digest.subarray(0, 32));
}

/**
 * Build a real, deterministic Algorand account from a label (or number).
 *
 * The 32-byte seed is turned into a 25-word mnemonic and then into a real
 * Ed25519 keypair entirely by algosdk (`mnemonicFromSeed` -> `mnemonicToSecretKey`),
 * yielding the exact seed(32) || publicKey(32) secret-key layout and the matching
 * address. This is byte-for-byte what importing the mnemonic in any Algorand
 * wallet would produce.
 */
export function makeAccount(label: string | number): TestAccount {
  const seed = seedFromLabel(String(label));
  const mnemonic = algosdk.mnemonicFromSeed(seed);
  const { addr, sk } = algosdk.mnemonicToSecretKey(mnemonic);
  const pk = sk.slice(32); // 64-byte sk is seed(32) || publicKey(32)

  return {
    mnemonic,
    sk,
    pk,
    addr: addr.toString(),
    account: { addr, sk },
  };
}

/** Convenience: just the address string for a labelled account. */
export function makeAddress(label: string | number): string {
  return makeAccount(label).addr;
}

// ---------------------------------------------------------------------------
// (b) algosdk-v3 Transaction fixture factory
// ---------------------------------------------------------------------------

/**
 * Deterministic suggested params. genesisHash is a fixed, obviously-fake 32-byte
 * value; these transactions are never submitted so the network identity is
 * irrelevant. flatFee keeps the fee stable across algosdk versions.
 */
export const SUGGESTED_PARAMS: algosdk.SuggestedParams = {
  fee: 1000,
  firstValid: 1,
  lastValid: 1001,
  genesisID: 'voi-test-v1',
  genesisHash: new Uint8Array(32),
  flatFee: true,
  minFee: 1000,
};

/** A fixed asset id used by the asset fixtures (arbitrary; never hits a network). */
export const FIXTURE_ASSET_ID = 12345;
/** A fixed application id used by the app-call fixtures. */
export const FIXTURE_APP_ID = 67890;

/**
 * Round-trip a built transaction through the EXACT production decode path:
 * encode -> base64 -> `algosdk.decodeUnsignedTransaction`. This is what
 * TransactionRequestScreen / UniversalTransactionSigningScreen feed to the
 * danger detector and signer, so fixtures decoded this way expose fields in the
 * same shape production sees (e.g. asset close-out lives under
 * `assetTransfer.closeRemainderTo`, app id under `applicationCall.appIndex`).
 */
export function roundTripTxn(txn: algosdk.Transaction): algosdk.Transaction {
  const bytes = algosdk.encodeUnsignedTransaction(txn);
  const base64 = Buffer.from(bytes).toString('base64');
  return algosdk.decodeUnsignedTransaction(Buffer.from(base64, 'base64'));
}

type PaymentParams = Parameters<
  typeof algosdk.makePaymentTxnWithSuggestedParamsFromObject
>[0];
type AssetTransferParams = Parameters<
  typeof algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject
>[0];
type AssetConfigParams = Parameters<
  typeof algosdk.makeAssetConfigTxnWithSuggestedParamsFromObject
>[0];
type AppNoOpParams = Parameters<
  typeof algosdk.makeApplicationNoOpTxnFromObject
>[0];

/**
 * Payment transaction. `overrides` can set `receiver`, `amount`,
 * `closeRemainderTo` (account-close / native-balance sweep) and `rekeyTo`.
 * Defaults to a harmless 0-amount self-payment.
 */
export function paymentTxn(
  sender: string,
  overrides: Partial<PaymentParams> = {}
): algosdk.Transaction {
  return algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender,
    receiver: sender,
    amount: 0,
    suggestedParams: SUGGESTED_PARAMS,
    ...overrides,
  } as PaymentParams);
}

/**
 * Asset-transfer (axfer) transaction. `overrides.closeRemainderTo` produces an
 * asset close-out (the S-01 asset-drain vector) — algosdk v3 stores that under
 * `assetTransfer.closeRemainderTo`, NOT a top-level `assetCloseTo`.
 * Defaults to a harmless 0-amount self-transfer of FIXTURE_ASSET_ID.
 */
export function assetTransferTxn(
  sender: string,
  overrides: Partial<AssetTransferParams> = {}
): algosdk.Transaction {
  return algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender,
    receiver: sender,
    amount: 0,
    assetIndex: FIXTURE_ASSET_ID,
    suggestedParams: SUGGESTED_PARAMS,
    ...overrides,
  } as AssetTransferParams);
}

/**
 * Asset-config (acfg) transaction — asset reconfiguration by default (mutates
 * manager/reserve/freeze/clawback of an existing asset). Pass `assetIndex: 0`
 * plus `total`/`decimals` via overrides to model a creation instead.
 */
export function assetConfigTxn(
  sender: string,
  overrides: Partial<AssetConfigParams> = {}
): algosdk.Transaction {
  return algosdk.makeAssetConfigTxnWithSuggestedParamsFromObject({
    sender,
    assetIndex: FIXTURE_ASSET_ID,
    manager: sender,
    reserve: sender,
    freeze: sender,
    clawback: sender,
    suggestedParams: SUGGESTED_PARAMS,
    ...overrides,
  } as AssetConfigParams);
}

/**
 * Generic application NoOp call (appl). Mirrors how production builds app calls
 * (`makeApplicationNoOpTxnFromObject`, e.g. unifiedSigner / arc72 / arc200).
 * Defaults to a bare call against FIXTURE_APP_ID with no args.
 */
export function appCallTxn(
  sender: string,
  overrides: Partial<AppNoOpParams> = {}
): algosdk.Transaction {
  return algosdk.makeApplicationNoOpTxnFromObject({
    sender,
    appIndex: FIXTURE_APP_ID,
    suggestedParams: SUGGESTED_PARAMS,
    ...overrides,
  } as AppNoOpParams);
}

/**
 * ARC-200 `arc200_transfer(address,uint256)bool` app call, built the SAME way
 * production does in services/transactions/arc200.ts: real ABI method selector
 * followed by ABI-encoded (address, uint256) app args. No fabricated bytes.
 */
export function arc200TransferTxn(
  sender: string,
  to: string,
  amount: bigint | number,
  overrides: Partial<AppNoOpParams> = {}
): algosdk.Transaction {
  const method = algosdk.ABIMethod.fromSignature(
    'arc200_transfer(address,uint256)bool'
  );
  const addressType = algosdk.ABIType.from('address');
  const uint256Type = algosdk.ABIType.from('uint256');

  const appArgs = [
    method.getSelector(),
    addressType.encode(to),
    uint256Type.encode(typeof amount === 'bigint' ? amount : BigInt(amount)),
  ];

  return appCallTxn(sender, { appArgs, ...overrides });
}

// ---------------------------------------------------------------------------
// (c) Minimal zustand store test harness
// ---------------------------------------------------------------------------

// Structural (non-React) view of a zustand store instance. Matches both a
// vanilla `createStore` and the `.getState/.setState/.subscribe` surface a
// React `create(...)` store exposes, without importing zustand's types (so the
// harness stays usable from any test regardless of middleware).
export interface MinimalStoreApi<T> {
  getState: () => T;
  setState: (
    partial: Partial<T> | ((state: T) => Partial<T>),
    replace?: boolean
  ) => void;
  subscribe: (listener: (state: T, prev: T) => void) => () => void;
}

export interface StoreHarness<T> {
  /** The underlying zustand store api (getState / setState / subscribe). */
  readonly store: MinimalStoreApi<T>;
  /** Current state snapshot. */
  getState: () => T;
  /** Patch state (partial or updater), same semantics as zustand setState. */
  setState: MinimalStoreApi<T>['setState'];
  /**
   * Reset the store back to the state captured when the harness was created.
   * Call in `beforeEach`/`afterEach` to isolate tests. Uses replace semantics
   * so keys added during a test are dropped.
   */
  reset: () => void;
}

/**
 * Wrap an existing zustand store (vanilla or React) in a test harness that can
 * snapshot-and-reset its state between tests. The snapshot is taken at wrap time.
 *
 *   import { walletStore } from '@/store/walletStore';
 *   const harness = harnessForStore(walletStore);
 *   beforeEach(() => harness.reset());
 */
export function harnessForStore<T>(store: MinimalStoreApi<T>): StoreHarness<T> {
  // Shallow-clone the initial state so later mutations don't corrupt the baseline.
  const initial = { ...(store.getState() as object) } as T;

  return {
    store,
    getState: () => store.getState(),
    setState: (partial, replace) => store.setState(partial, replace),
    reset: () => store.setState({ ...(initial as object) } as T, true),
  };
}

/**
 * Create a fresh in-memory zustand store from an initializer for tests that want
 * an isolated store rather than the app singleton. Returns a harness (see above).
 * Uses zustand's vanilla `createStore` so no React runtime is required.
 *
 *   const { getState, setState, reset } = createStoreHarness<{ n: number }>(
 *     (set) => ({ n: 0, inc: () => set((s) => ({ n: s.n + 1 })) })
 *   );
 */
export function createStoreHarness<T>(
  initializer: (set: MinimalStoreApi<T>['setState'], get: () => T) => T
): StoreHarness<T> {
  // Uses zustand's vanilla `createStore` (no React runtime required).
  const store = createStore<T>(
    initializer as never
  ) as unknown as MinimalStoreApi<T>;
  return harnessForStore(store);
}
