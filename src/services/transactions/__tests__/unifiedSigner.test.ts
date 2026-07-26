/**
 * Unit tests for src/services/transactions/unifiedSigner.ts (TASK-154).
 *
 * Scope: the routing / callback-wiring / error-propagation contract of
 * `UnifiedTransactionSigner.signTransaction`. Every transaction `type` is routed
 * to a distinct private handler, and each handler forwards a fixed set of
 * progress callbacks and either resolves a `UnifiedSigningResult` or throws into
 * the single top-level catch. These tests pin all of that behaviour.
 *
 * SECURITY / DR-3 (non-negotiable): the SIGNING SURFACE is REAL. We never
 * fabricate a private key or a signature. The only things mocked are the LEAF
 * transports that a unit test cannot (and must not) exercise:
 *   - `TransactionService.*` — the network-submitting standard/rekey senders,
 *   - `NetworkService` — algod (suggested params / submit / confirm),
 *   - `SecureKeyManager.signTransaction` — the secure-storage + rekey-lookup +
 *     Ledger transport wrapper. Its mock signs with a REAL algosdk secret key
 *     drawn from the shared deterministic fixtures, so the bytes it returns are
 *     genuine Ed25519 signatures (verified below via algosdk/tweetnacl), NOT
 *     hand-rolled placeholder bytes. This mirrors the source's own
 *     `algosdk.signTransaction(txn, privateKey)` call at the point where the key
 *     leaves secure storage.
 *
 * No mnemonic / secret key from the fixtures is ever logged.
 */

import algosdk from 'algosdk';
import nacl from 'tweetnacl';
import { Buffer } from 'buffer';

import { makeAccount, paymentTxn } from '@/__tests__/fixtures/algorand';
import { AccountType } from '@/types/wallet';
import { NetworkId } from '@/types/network';
import { NETWORK_CONFIGURATIONS } from '@/services/network/config';
import { resolveV1Chain } from '@/services/walletconnect/v1/config';
import { createSignTxnResponse } from '@/services/walletconnect/v1/protocol';

// ---------------------------------------------------------------------------
// Leaf-transport mocks (see DR-3 note above). Declared before importing the
// module under test so jest's hoisting wires them in.
// ---------------------------------------------------------------------------

jest.mock('@/services/transactions', () => ({
  TransactionService: {
    sendTransaction: jest.fn(),
    sendRekeyTransaction: jest.fn(),
    sendRekeyReverseTransaction: jest.fn(),
    estimateTransactionCost: jest.fn(),
    validateTransaction: jest.fn(),
  },
}));

jest.mock('@/services/walletconnect', () => ({
  WalletConnectService: { getInstance: jest.fn(() => ({})) },
}));

jest.mock('@/services/secure/keyManager', () => ({
  SecureKeyManager: { signTransaction: jest.fn() },
}));

jest.mock('@/services/secure/AccountSecureStorage', () => ({
  AccountSecureStorage: { clearPrivateKeyCache: jest.fn() },
}));

jest.mock('@/services/network', () => ({
  NetworkService: { getInstance: jest.fn() },
}));

// Import AFTER the mocks are registered.
import {
  UnifiedTransactionSigner,
  RemoteSignerRequiredError,
  UnifiedSigningCallbacks,
  UnifiedTransactionRequest,
  WalletConnectSessionBinding,
} from '../unifiedSigner';
import { TransactionService } from '@/services/transactions';
import { SecureKeyManager } from '@/services/secure/keyManager';
import { AccountSecureStorage } from '@/services/secure/AccountSecureStorage';
import { NetworkService } from '@/services/network';

// Typed handles onto the mocks.
const mockTxService = TransactionService as unknown as {
  sendTransaction: jest.Mock;
  sendRekeyTransaction: jest.Mock;
  sendRekeyReverseTransaction: jest.Mock;
};
const mockSignTransaction =
  SecureKeyManager.signTransaction as unknown as jest.Mock;
const mockClearCache =
  AccountSecureStorage.clearPrivateKeyCache as unknown as jest.Mock;
const mockGetInstance = NetworkService.getInstance as unknown as jest.Mock;

// ---------------------------------------------------------------------------
// Real-crypto signing registry: maps an address -> its REAL algosdk secret key.
// The SecureKeyManager mock signs with the registered key via algosdk, so every
// signature these tests assert against is genuine (no fabricated bytes).
// ---------------------------------------------------------------------------

const keyRegistry = new Map<string, Uint8Array>();

// Models the on-chain rekey resolution that the REAL SecureKeyManager performs:
// maps a rekeyed account's address -> the authority address whose key actually
// signs. The signTransaction mock consults this so a test can prove the source
// passes the SENDER (and the authority key resolves internally), exactly as the
// production keyManager does via getAccountRekeyInfo.
const rekeyRegistry = new Map<string, string>();

/** Real single-sig signature over `txn` using the fixture key for `address`. */
function realSign(txn: algosdk.Transaction, address: string): Uint8Array {
  const sk = keyRegistry.get(address);
  if (!sk) {
    throw new Error(`test setup: no fixture key registered for ${address}`);
  }
  return algosdk.signTransaction(txn, sk).blob;
}

/** Independently verify a signed-txn blob really is signed by `address`. */
function blobIsSignedBy(blob: Uint8Array, address: string): boolean {
  const decoded = algosdk.decodeSignedTransaction(blob);
  const pk = algosdk.decodeAddress(address).publicKey;
  return nacl.sign.detached.verify(decoded.txn.bytesToSign(), decoded.sig!, pk);
}

/** Build a minimal account object of a given type from a fixture account. */
function accountOf(
  label: string,
  type: AccountType
): { address: string; type: AccountType; publicKey: Uint8Array } {
  const acct = makeAccount(label);
  keyRegistry.set(acct.addr, acct.sk);
  return { address: acct.addr, type, publicKey: acct.pk };
}

/** base64 of an unsigned transaction (the WalletConnect wire shape). */
function unsignedB64(txn: algosdk.Transaction): string {
  return Buffer.from(algosdk.encodeUnsignedTransaction(txn)).toString('base64');
}

// ---------------------------------------------------------------------------
// Chain-binding helpers (DR-7 / DR-14).
//
// The shared fixtures deliberately use an all-zero, obviously-fake genesis hash,
// which algosdk omits from the canonical encoding entirely — so a fixture txn
// decodes with `genesisHash: undefined` and belongs to no network. That is
// exactly right for the UNBOUND (in-app) tests, and exactly wrong for the bound
// ones, which need REAL network identities. These builders read them from
// `NETWORK_CONFIGURATIONS`, the same source the signer binds against.
// ---------------------------------------------------------------------------

function paramsFor(networkId: NetworkId): algosdk.SuggestedParams {
  const config = NETWORK_CONFIGURATIONS[networkId];
  return {
    fee: 1000,
    firstValid: 1,
    lastValid: 1001,
    genesisID: config.genesisId,
    genesisHash: new Uint8Array(Buffer.from(config.genesisHash, 'base64')),
    flatFee: true,
    minFee: 1000,
  };
}

/** Payment transaction carrying a REAL network identity. */
function payOn(
  networkId: NetworkId,
  sender: string,
  amount: number
): algosdk.Transaction {
  return algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender,
    receiver: sender,
    amount,
    suggestedParams: paramsFor(networkId),
  });
}

const chainIdOf = (networkId: NetworkId): string =>
  NETWORK_CONFIGURATIONS[networkId].chainId;

/** A session binding approving `addresses` on `networkId`'s chain (CAIP-10). */
function bindingFor(
  networkId: NetworkId,
  addresses: string[]
): WalletConnectSessionBinding {
  const chainId = chainIdOf(networkId);
  return {
    topic: 'topic-under-test',
    chainId,
    networkId,
    approvedAccounts: addresses.map((address) => `${chainId}:${address}`),
  };
}

/** Drain the microtask queue (and one macrotask tick) so awaited work settles. */
const flushMicrotasks = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

/** Fixture algod stub used by the keyreg / appl paths. */
function makeAlgod(overrides: Record<string, unknown> = {}) {
  return {
    getSuggestedParams: jest.fn().mockResolvedValue({
      fee: 1000,
      firstValid: 1,
      lastValid: 1001,
      genesisID: 'voi-test-v1',
      genesisHash: new Uint8Array(32),
      flatFee: true,
      minFee: 1000,
    }),
    sendRawTransaction: jest.fn().mockResolvedValue('TXID_NETWORK'),
    waitForConfirmation: jest.fn().mockResolvedValue({ confirmedRound: 1 }),
    ...overrides,
  };
}

/**
 * Install a signer leaf that suspends: each call parks until its release fn is
 * invoked, then resolves with a REAL signature. Lets a test observe how many
 * leaf calls are in-flight before any completes (parallel vs sequential proof).
 */
function installGatedSigner(): { releases: (() => void)[] } {
  const releases: (() => void)[] = [];
  mockSignTransaction.mockImplementation(
    (txn: algosdk.Transaction, address: string) =>
      new Promise<Uint8Array>((resolve) => {
        releases.push(() => resolve(realSign(txn, address)));
      })
  );
  return { releases };
}

/**
 * Callback recorder: every callback is a jest.fn AND appends its name to a
 * shared `order` array, so ordering assertions are possible.
 */
function makeCallbacks(): {
  cb: UnifiedSigningCallbacks;
  order: string[];
  fns: Record<string, jest.Mock>;
} {
  const order: string[] = [];
  const fns: Record<string, jest.Mock> = {};
  const names = [
    'onAuthStart',
    'onAuthSuccess',
    'onAuthError',
    'onSigningStart',
    'onLedgerPrompt',
    'onLedgerSigned',
    'onLedgerRejected',
    'onNetworkSubmit',
    'onNetworkConfirmed',
    'onNetworkError',
    'onError',
    'onComplete',
  ];
  const cb: Record<string, jest.Mock> = {};
  for (const name of names) {
    const fn = jest.fn(() => {
      order.push(name);
    });
    fns[name] = fn;
    cb[name] = fn;
  }
  return { cb: cb as UnifiedSigningCallbacks, order, fns };
}

let signer: UnifiedTransactionSigner;

beforeEach(() => {
  keyRegistry.clear();
  rekeyRegistry.clear();
  signer = new UnifiedTransactionSigner();

  // Default happy-path leaf behaviour (clearMocks resets call data each test).
  mockTxService.sendTransaction.mockResolvedValue({
    txId: 'TXID_STANDARD',
    confirmed: true,
  });
  mockTxService.sendRekeyTransaction.mockResolvedValue({
    txId: 'TXID_REKEY',
    confirmed: true,
  });
  mockTxService.sendRekeyReverseTransaction.mockResolvedValue({
    txId: 'TXID_REKEY_REV',
    confirmed: false,
  });

  // Real signing at the secure-storage boundary. Resolves rekey authority the
  // way the production SecureKeyManager does: if `address` is a rekeyed account,
  // sign with the mapped authority's key; otherwise sign with `address` itself.
  mockSignTransaction.mockImplementation(
    async (txn: algosdk.Transaction, address: string) =>
      realSign(txn, rekeyRegistry.get(address) ?? address)
  );

  // Default algod stub for keyreg / appl paths.
  mockGetInstance.mockReturnValue({
    getSuggestedParams: jest.fn().mockResolvedValue({
      fee: 1000,
      firstValid: 1,
      lastValid: 1001,
      genesisID: 'voi-test-v1',
      genesisHash: new Uint8Array(32),
      flatFee: true,
      minFee: 1000,
    }),
    sendRawTransaction: jest.fn().mockResolvedValue('TXID_NETWORK'),
    waitForConfirmation: jest.fn().mockResolvedValue({ confirmedRound: 42 }),
  });
});

// ===========================================================================
// Routing: standard transfers (voi/asa/arc200/arc72 -> TransactionService)
// ===========================================================================

describe('signTransaction — standard transfer routing', () => {
  const transferParams = {
    toAddress: 'ignored-by-mock',
    amount: 1000,
  } as unknown as UnifiedTransactionRequest['transferParams'];

  it.each([
    'voi_transfer',
    'asa_transfer',
    'arc200_transfer',
    'arc72_transfer',
  ] as const)(
    'routes %s to TransactionService.sendTransaction and returns its result',
    async (type) => {
      const account = accountOf(`std-${type}`, AccountType.STANDARD);
      const result = await signer.signTransaction({
        type,
        account,
        pin: '1234',
        transferParams,
      });

      expect(mockTxService.sendTransaction).toHaveBeenCalledTimes(1);
      // Only this handler was routed to — never the rekey senders.
      expect(mockTxService.sendRekeyTransaction).not.toHaveBeenCalled();
      expect(mockTxService.sendRekeyReverseTransaction).not.toHaveBeenCalled();

      // Params, account, and pin are forwarded verbatim.
      const [passedParams, passedAccount, passedPin] =
        mockTxService.sendTransaction.mock.calls[0];
      expect(passedParams).toBe(transferParams);
      expect(passedAccount).toBe(account);
      expect(passedPin).toBe('1234');

      expect(result).toEqual({
        success: true,
        transactionId: 'TXID_STANDARD',
        confirmed: true,
      });
    }
  );

  it('forwards progress callbacks to the underlying sender', async () => {
    const account = accountOf('std-cb', AccountType.STANDARD);
    const { cb, fns } = makeCallbacks();

    // Drive the callbacks the sender is expected to invoke.
    mockTxService.sendTransaction.mockImplementationOnce(
      async (_p, _a, _pin, senderCallbacks) => {
        senderCallbacks.onLedgerPrompt?.({ index: 1, total: 1 });
        senderCallbacks.onLedgerSigned?.({ index: 1, total: 1 });
        senderCallbacks.onNetworkSubmit?.();
        senderCallbacks.onNetworkConfirmed?.('TXID_STANDARD', true);
        return { txId: 'TXID_STANDARD', confirmed: true };
      }
    );

    await signer.signTransaction(
      { type: 'voi_transfer', account, transferParams },
      cb
    );

    expect(fns.onLedgerPrompt).toHaveBeenCalledWith({ index: 1, total: 1 });
    expect(fns.onLedgerSigned).toHaveBeenCalledWith({ index: 1, total: 1 });
    expect(fns.onNetworkSubmit).toHaveBeenCalledTimes(1);
    expect(fns.onNetworkConfirmed).toHaveBeenCalledWith('TXID_STANDARD', true);
    // onLedgerRejected is wired but not invoked on the happy path.
    expect(fns.onLedgerRejected).not.toHaveBeenCalled();
  });

  it('passes through `confirmed: false` (submitted-but-pending, not a failure)', async () => {
    const account = accountOf('std-pending', AccountType.STANDARD);
    mockTxService.sendTransaction.mockResolvedValueOnce({
      txId: 'TXID_PENDING',
      confirmed: false,
    });

    const result = await signer.signTransaction({
      type: 'voi_transfer',
      account,
      transferParams,
    });

    expect(result.success).toBe(true);
    expect(result.confirmed).toBe(false);
    expect(result.transactionId).toBe('TXID_PENDING');
  });

  it('propagates a sender failure into a failResult (no throw)', async () => {
    const account = accountOf('std-fail', AccountType.STANDARD);
    const boom = new Error('network down');
    mockTxService.sendTransaction.mockRejectedValueOnce(boom);
    const { cb, fns } = makeCallbacks();

    const result = await signer.signTransaction(
      { type: 'voi_transfer', account, transferParams },
      cb
    );

    expect(result).toEqual({ success: false, error: boom });
    expect(fns.onError).toHaveBeenCalledWith(boom);
    // onComplete still fires, with the failure result.
    expect(fns.onComplete).toHaveBeenCalledWith({
      success: false,
      error: boom,
    });
  });
});

// ===========================================================================
// Routing: rekey / reverse-rekey
// ===========================================================================

describe('signTransaction — rekey routing', () => {
  it('routes `rekey` to sendRekeyTransaction with the target address', async () => {
    const account = accountOf('rekey', AccountType.STANDARD);
    const target = makeAccount('rekey-target').addr;

    const result = await signer.signTransaction({
      type: 'rekey',
      account,
      pin: '9999',
      rekeyParams: {
        fromAddress: account.address,
        rekeyToAddress: target,
        note: 'go',
      },
    });

    expect(mockTxService.sendRekeyTransaction).toHaveBeenCalledTimes(1);
    expect(mockTxService.sendRekeyReverseTransaction).not.toHaveBeenCalled();
    const [params, acct, pin] =
      mockTxService.sendRekeyTransaction.mock.calls[0];
    expect(params).toMatchObject({
      fromAddress: account.address,
      rekeyToAddress: target,
      note: 'go',
    });
    expect(acct).toEqual({ address: account.address });
    expect(pin).toBe('9999');
    expect(result).toEqual({
      success: true,
      transactionId: 'TXID_REKEY',
      confirmed: true,
    });
  });

  it('routes `rekey_reverse` to sendRekeyReverseTransaction', async () => {
    const account = accountOf('rekey-rev', AccountType.STANDARD);

    const result = await signer.signTransaction({
      type: 'rekey_reverse',
      account,
      rekeyParams: { fromAddress: account.address },
    });

    expect(mockTxService.sendRekeyReverseTransaction).toHaveBeenCalledTimes(1);
    expect(mockTxService.sendRekeyTransaction).not.toHaveBeenCalled();
    expect(result).toEqual({
      success: true,
      transactionId: 'TXID_REKEY_REV',
      confirmed: false,
    });
  });

  it('fails a `rekey` missing its target address (validation)', async () => {
    const account = accountOf('rekey-notarget', AccountType.STANDARD);

    const result = await signer.signTransaction({
      type: 'rekey',
      account,
      rekeyParams: { fromAddress: account.address },
    });

    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(/target rekey address required/i);
    expect(mockTxService.sendRekeyTransaction).not.toHaveBeenCalled();
  });

  it('propagates a rekey sender failure', async () => {
    const account = accountOf('rekey-fail', AccountType.STANDARD);
    const boom = new Error('rekey rejected');
    mockTxService.sendRekeyTransaction.mockRejectedValueOnce(boom);

    const result = await signer.signTransaction({
      type: 'rekey',
      account,
      rekeyParams: {
        fromAddress: account.address,
        rekeyToAddress: makeAccount('rekey-fail-target').addr,
      },
    });

    expect(result).toEqual({ success: false, error: boom });
  });
});

// ===========================================================================
// Routing: WalletConnect / batch — local (parallel) vs Ledger (sequential)
// ===========================================================================

describe('signTransaction — batch routing (local vs ledger)', () => {
  it('signs a standard-account batch in parallel with REAL signatures', async () => {
    const account = accountOf('batch-std', AccountType.STANDARD);
    const txns = [
      paymentTxn(account.address, { amount: 1 }),
      paymentTxn(account.address, { amount: 2 }),
    ];
    const { cb, fns } = makeCallbacks();

    // Gate the signer so we can observe dispatch concurrency before completion.
    const { releases } = installGatedSigner();

    const pending = signer.signTransaction(
      {
        type: 'batch_transaction',
        account,
        pin: '1234',
        walletConnectParams: {
          transactions: txns.map((t) => ({ txn: unsignedB64(t) })),
          accountAddress: account.address,
          sessionBinding: null,
        },
      },
      cb
    );

    // PARALLEL: both leaf calls are dispatched (in-flight) before EITHER resolves.
    // A serialized software signer would have started only the first call here.
    await flushMicrotasks();
    expect(mockSignTransaction).toHaveBeenCalledTimes(2);
    releases.forEach((release) => release());

    const result = await pending;
    expect(result.success).toBe(true);
    const signed = result.signedTransactions as string[];
    expect(signed).toHaveLength(2);

    // Each returned blob must be a genuine signature by the account AND wrap the
    // SAME transaction (by txID) at the SAME index as its input — this rejects a
    // signer that signs one txn twice, drops one, or reorders the outputs.
    expect(mockSignTransaction).toHaveBeenCalledTimes(2);
    signed.forEach((b64, i) => {
      const blob = new Uint8Array(Buffer.from(b64, 'base64'));
      expect(blobIsSignedBy(blob, account.address)).toBe(true);
      const decoded = algosdk.decodeSignedTransaction(blob);
      expect(decoded.txn.txID()).toBe(txns[i].txID());
    });
    // The two outputs are distinct transactions (not the same one signed twice).
    expect(new Set(signed).size).toBe(2);

    // Standard path = parallel: ONE aggregate prompt, ONE aggregate signed.
    expect(fns.onLedgerPrompt).toHaveBeenCalledTimes(1);
    expect(fns.onLedgerPrompt).toHaveBeenCalledWith({ index: 1, total: 2 });
    expect(fns.onLedgerSigned).toHaveBeenCalledTimes(1);
    expect(fns.onLedgerSigned).toHaveBeenCalledWith({ index: 2, total: 2 });
    expect(fns.onNetworkSubmit).toHaveBeenCalledTimes(1);

    // Cache is cleared for security once signing completes.
    expect(mockClearCache).toHaveBeenCalled();
  });

  it('signs a Ledger-account batch sequentially (per-index prompts)', async () => {
    const account = accountOf('batch-ledger', AccountType.LEDGER);
    const txns = [
      paymentTxn(account.address, { amount: 1 }),
      paymentTxn(account.address, { amount: 2 }),
    ];
    const { cb, fns } = makeCallbacks();

    // Gate the signer to prove strict sequencing (Ledger hardware constraint).
    const { releases } = installGatedSigner();

    // Ledger flow passes pin=undefined to the signer leaf.
    const pending = signer.signTransaction(
      {
        type: 'walletconnect_batch',
        account,
        walletConnectParams: {
          transactions: txns.map((t) => ({ txn: unsignedB64(t) })),
          accountAddress: account.address,
          sessionBinding: null,
        },
      },
      cb
    );

    // SEQUENTIAL: only the FIRST leaf call has started; the loop awaits it before
    // dispatching the second. A concurrent implementation would already show 2.
    await flushMicrotasks();
    expect(mockSignTransaction).toHaveBeenCalledTimes(1);
    releases[0]();
    await flushMicrotasks();
    expect(mockSignTransaction).toHaveBeenCalledTimes(2);
    releases[1]();

    const result = await pending;
    expect(result.success).toBe(true);
    const signed = result.signedTransactions as string[];
    expect(signed).toHaveLength(2);

    // The Ledger leaf is hit exactly once per transaction, in ARRAY ORDER, each
    // time for OUR signer address, with pin=undefined (Ledger supplies no PIN),
    // and carrying the matching input transaction.
    expect(mockSignTransaction).toHaveBeenCalledTimes(2);
    mockSignTransaction.mock.calls.forEach((call, i) => {
      const [txn, signerAddress, pin] = call;
      expect((txn as algosdk.Transaction).txID()).toBe(txns[i].txID());
      expect(signerAddress).toBe(account.address);
      expect(pin).toBeUndefined();
    });

    // Each returned blob must be a GENUINE signature by the account AND wrap the
    // matching input at the matching index (rejects fabricated/reordered bytes).
    signed.forEach((b64, i) => {
      const blob = new Uint8Array(Buffer.from(b64, 'base64'));
      expect(blobIsSignedBy(blob, account.address)).toBe(true);
      expect(algosdk.decodeSignedTransaction(blob).txn.txID()).toBe(
        txns[i].txID()
      );
    });

    // Sequential: prompt+signed fire once PER transaction, in order.
    expect(fns.onLedgerPrompt).toHaveBeenCalledTimes(2);
    expect(fns.onLedgerPrompt).toHaveBeenNthCalledWith(1, {
      index: 1,
      total: 2,
    });
    expect(fns.onLedgerPrompt).toHaveBeenNthCalledWith(2, {
      index: 2,
      total: 2,
    });
    expect(fns.onLedgerSigned).toHaveBeenCalledTimes(2);
    expect(fns.onLedgerSigned).toHaveBeenNthCalledWith(1, {
      index: 1,
      total: 2,
    });
    expect(fns.onLedgerSigned).toHaveBeenNthCalledWith(2, {
      index: 2,
      total: 2,
    });
  });

  // DR-1 — THE REGRESSION TEST FOR THE ORIGINAL `apaa` BUG.
  //
  // This slot used to come back holding the RAW UNSIGNED wire bytes. The dApp
  // reassembled its group from the response array, found a bare `Transaction`
  // where a `SignedTxn` belongs, submitted it, and algod died on the first
  // Transaction-only key — `apaa` (ApplicationArgs). ARC-0001 says a declined
  // entry is `null`. Note the assertion is on the exact POSITIONAL value, not
  // on array length: a length-only assertion passes for both behaviours and
  // would not catch the regression.
  it('returns null (never the unsigned bytes) for a transaction whose sender is NOT our signer', async () => {
    const account = accountOf('batch-owner', AccountType.STANDARD);
    const foreign = makeAccount('batch-foreign').addr;
    const foreignTxn = paymentTxn(foreign, { amount: 5 });
    const wireTxn = unsignedB64(foreignTxn);

    const result = await signer.signTransaction({
      type: 'batch_transaction',
      account,
      walletConnectParams: {
        transactions: [{ txn: wireTxn }],
        accountAddress: account.address,
        sessionBinding: null,
      },
    });

    expect(result.success).toBe(true);
    const signed = result.signedTransactions as (string | null)[];
    expect(signed).toHaveLength(1);
    expect(signed[0]).toBeNull();
    expect(signed[0]).not.toBe(wireTxn);
    expect(mockSignTransaction).not.toHaveBeenCalled();
  });

  // DR-13 — eligibility must not outrun the UI. The review screen names exactly
  // ONE account, so a `signers: [B]` entry whose sender is B is DECLINED when
  // the reviewed account is A. Previously `signers[0]` overrode the request's
  // account and B's key signed while the screen said "Sign with Account A".
  // TASK-259 widens this to true multi-account signing together with the
  // signer-list display; until then the honest answer is `null`.
  it('declines an entry whose sender is not the REVIEWED account, even when signers names it', async () => {
    const selected = accountOf('wc-selected', AccountType.STANDARD); // A (reviewed)
    const signerB = accountOf('wc-signer-b', AccountType.STANDARD); // B
    const txnFromB = paymentTxn(signerB.address, { amount: 7 });

    const result = await signer.signTransaction({
      type: 'batch_transaction',
      account: selected,
      pin: '1234',
      walletConnectParams: {
        transactions: [
          { txn: unsignedB64(txnFromB), signers: [signerB.address] },
        ],
        accountAddress: selected.address,
        sessionBinding: null,
      },
    });

    expect(result.success).toBe(true);
    expect((result.signedTransactions as (string | null)[])[0]).toBeNull();
    // B's key was never touched.
    expect(mockSignTransaction).not.toHaveBeenCalled();
  });

  // FIXED (TASK-163): a rekeyed account's WalletConnect txn carrying `authAddr`
  // used to be returned UNSIGNED yet reported success. The handler used the
  // dApp-supplied `authAddr`/`signers` to select the signing key, then the guard
  // `txnSender !== signerAddress` tripped (a rekeyed account's sender A and
  // authority B differ by design), so it was never handed to SecureKeyManager.
  // The fix decides eligibility from the sender and always passes the SENDER to
  // SecureKeyManager, which resolves the authority (B) from on-chain state and
  // signs with it — identical to the already-working non-authAddr rekey path.
  // The dApp-supplied authAddr/signers are advisory and never select the key.
  it('signs a rekeyed WalletConnect txn (authAddr set) with the on-chain authority key', async () => {
    const authority = accountOf('wc-authority', AccountType.STANDARD); // B
    const account = accountOf('wc-rekeyed', AccountType.STANDARD); // A (sender)
    const rekeyed = account.address;
    // A is rekeyed to B on-chain (what SecureKeyManager would resolve).
    rekeyRegistry.set(rekeyed, authority.address);
    const txn = paymentTxn(rekeyed, { amount: 1 });

    const result = await signer.signTransaction({
      type: 'batch_transaction',
      account,
      pin: '1234',
      walletConnectParams: {
        transactions: [{ txn: unsignedB64(txn), authAddr: authority.address }],
        accountAddress: rekeyed,
        sessionBinding: null,
      },
    });

    expect(result.success).toBe(true);
    // The SENDER (A) is routed through SecureKeyManager — NOT the dApp authAddr
    // (B). SecureKeyManager resolves A -> B from on-chain state and signs with B.
    expect(mockSignTransaction).toHaveBeenCalledTimes(1);
    expect(mockSignTransaction.mock.calls[0][1]).toBe(rekeyed);
    // The produced blob is a real signature by the authority B.
    const blob = new Uint8Array(
      Buffer.from((result.signedTransactions as string[])[0], 'base64')
    );
    expect(blobIsSignedBy(blob, authority.address)).toBe(true);
  });

  // Codex diff-review P1: the same bug reachable via `signers: [authority]`.
  // Some dApps mark a rekeyed account's WC txn with signers = [authAddr] (the
  // ARC-0001 "these addresses must sign" hint = the authority). The old code
  // used signers[0] as the KEY, so the guard txnSender(A) !== signers[0](B)
  // skipped it unsigned. Eligibility now comes from the sender, and the key is
  // always the sender (authority resolved on-chain) — so this signs correctly.
  it('signs a rekeyed WalletConnect txn when signers lists the authority (standard path)', async () => {
    const authority = accountOf('wc-auth-signers', AccountType.STANDARD); // B
    const account = accountOf('wc-rekeyed-signers', AccountType.STANDARD); // A
    const rekeyed = account.address;
    rekeyRegistry.set(rekeyed, authority.address); // A -> B on-chain
    const txn = paymentTxn(rekeyed, { amount: 1 });

    const result = await signer.signTransaction({
      type: 'batch_transaction',
      account,
      pin: '1234',
      walletConnectParams: {
        transactions: [
          {
            txn: unsignedB64(txn),
            authAddr: authority.address,
            signers: [authority.address],
          },
        ],
        accountAddress: rekeyed,
        sessionBinding: null,
      },
    });

    expect(result.success).toBe(true);
    expect(mockSignTransaction).toHaveBeenCalledTimes(1);
    expect(mockSignTransaction.mock.calls[0][1]).toBe(rekeyed); // sender, not B
    const blob = new Uint8Array(
      Buffer.from((result.signedTransactions as string[])[0], 'base64')
    );
    expect(blobIsSignedBy(blob, authority.address)).toBe(true);
  });

  it('signs a rekeyed WalletConnect txn when signers lists the authority (Ledger path)', async () => {
    const authority = accountOf('wc-auth-signers-l', AccountType.STANDARD); // B
    const account = accountOf('wc-rekeyed-signers-l', AccountType.LEDGER); // A
    const rekeyed = account.address;
    rekeyRegistry.set(rekeyed, authority.address); // A -> B on-chain
    const txn = paymentTxn(rekeyed, { amount: 1 });

    const result = await signer.signTransaction({
      type: 'batch_transaction',
      account,
      walletConnectParams: {
        transactions: [
          {
            txn: unsignedB64(txn),
            authAddr: authority.address,
            signers: [authority.address],
          },
        ],
        accountAddress: rekeyed,
        sessionBinding: null,
      },
    });

    expect(result.success).toBe(true);
    expect(mockSignTransaction).toHaveBeenCalledTimes(1);
    expect(mockSignTransaction.mock.calls[0][1]).toBe(rekeyed); // sender, not B
    const blob = new Uint8Array(
      Buffer.from((result.signedTransactions as string[])[0], 'base64')
    );
    expect(blobIsSignedBy(blob, authority.address)).toBe(true);
  });

  // DR-8 — REVERSED BEHAVIOUR. This used to assert that four arbitrary bytes
  // passed through unchanged, i.e. that the wallet would hand garbage back to a
  // dApp for it to submit. Classification now happens BEFORE pass-through:
  // only a genuine, validly-authorized signed transaction is echoed, and
  // undecodable bytes fail the whole request.
  it('REJECTS undecodable bytes instead of echoing them back (DR-8)', async () => {
    const account = accountOf('batch-logicsig', AccountType.STANDARD);
    // Bytes that are NOT a decodable unsigned transaction.
    const opaque = Buffer.from([0x01, 0x02, 0x03, 0x04]).toString('base64');

    const result = await signer.signTransaction({
      type: 'batch_transaction',
      account,
      walletConnectParams: {
        transactions: [{ txn: opaque }],
        accountAddress: account.address,
        sessionBinding: null,
      },
    });

    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(
      /neither a valid unsigned transaction nor a valid signed transaction/i
    );
    expect(result.signedTransactions).toBeUndefined();
    expect(mockSignTransaction).not.toHaveBeenCalled();
  });

  it('passes through a GENUINELY pre-signed entry unchanged', async () => {
    const account = accountOf('batch-presigned-owner', AccountType.STANDARD);
    const other = accountOf('batch-presigned-other', AccountType.STANDARD);
    const mine = paymentTxn(account.address, { amount: 1 });
    // A real, fully-signed transaction by a third party (real Ed25519 bytes —
    // nothing fabricated), of the kind an atomic group legitimately carries.
    const preSignedBlob = realSign(
      paymentTxn(other.address, { amount: 2 }),
      other.address
    );
    const preSigned = Buffer.from(preSignedBlob).toString('base64');

    const result = await signer.signTransaction({
      type: 'batch_transaction',
      account,
      pin: '1234',
      walletConnectParams: {
        transactions: [{ txn: preSigned }, { txn: unsignedB64(mine) }],
        accountAddress: account.address,
        sessionBinding: null,
      },
    });

    expect(result.success).toBe(true);
    const signed = result.signedTransactions as (string | null)[];
    expect(signed).toHaveLength(2);
    // Slot 0 is echoed byte-for-byte; slot 1 is really signed by us.
    expect(signed[0]).toBe(preSigned);
    expect(
      blobIsSignedBy(
        new Uint8Array(Buffer.from(signed[1] as string, 'base64')),
        account.address
      )
    ).toBe(true);
    // Only OUR entry reached the key manager.
    expect(mockSignTransaction).toHaveBeenCalledTimes(1);
  });

  it('reports a Ledger signing failure via onLedgerRejected and clears the cache', async () => {
    const account = accountOf('batch-reject', AccountType.LEDGER);
    const txn = paymentTxn(account.address, { amount: 1 });
    const rejection = new Error('user rejected on device');
    mockSignTransaction.mockRejectedValueOnce(rejection);
    const { cb, fns } = makeCallbacks();

    const result = await signer.signTransaction(
      {
        type: 'batch_transaction',
        account,
        walletConnectParams: {
          transactions: [{ txn: unsignedB64(txn) }],
          accountAddress: account.address,
          sessionBinding: null,
        },
      },
      cb
    );

    expect(result.success).toBe(false);
    expect(fns.onLedgerRejected).toHaveBeenCalledTimes(1);
    const rejCtx = fns.onLedgerRejected.mock.calls[0][0];
    expect(rejCtx).toMatchObject({ index: 1, total: 1 });
    expect(rejCtx.error).toBeInstanceOf(Error);
    // Cache is cleared on the error path too.
    expect(mockClearCache).toHaveBeenCalled();
  });
});

// ===========================================================================
// WalletConnect batch — ARC-0001 response contract, session binding (DR-5 /
// DR-14), chain binding (DR-7), signers semantics (DR-2) and the DR-13 narrow
// eligibility rule. Every test in this block goes through a SESSION-BOUND
// request, i.e. the real dApp path.
// ===========================================================================

describe('signWalletConnectBatch — session + chain binding', () => {
  const VOI = NetworkId.VOI_MAINNET;
  const ALGO = NetworkId.ALGORAND_MAINNET;

  it('returns positional null for the foreign slots of a mixed-sender group', async () => {
    const mine = accountOf('bind-mine', AccountType.STANDARD);
    const theirs = accountOf('bind-theirs', AccountType.STANDARD);

    const txnA = payOn(VOI, mine.address, 1);
    const txnB = payOn(VOI, theirs.address, 2);
    const txnC = payOn(VOI, mine.address, 3);
    const wireB = unsignedB64(txnB);

    const result = await signer.signTransaction({
      type: 'batch_transaction',
      account: mine,
      pin: '1234',
      walletConnectParams: {
        transactions: [txnA, txnB, txnC].map((t) => ({ txn: unsignedB64(t) })),
        accountAddress: mine.address,
        // BOTH accounts are session-approved; only the reviewed one may sign.
        sessionBinding: bindingFor(VOI, [mine.address, theirs.address]),
      },
    });

    expect(result.success).toBe(true);
    const signed = result.signedTransactions as (string | null)[];

    // Response length is invariant with the request...
    expect(signed).toHaveLength(3);
    // ...and the DECLINED slot holds exactly `null` — not the unsigned bytes,
    // which is the original apaa defect.
    expect(signed[1]).toBeNull();
    expect(signed[1]).not.toBe(wireB);

    // The two slots that ARE ours carry genuine signatures over the matching
    // transactions, still at the matching indexes.
    [0, 2].forEach((i) => {
      const blob = new Uint8Array(Buffer.from(signed[i] as string, 'base64'));
      expect(blobIsSignedBy(blob, mine.address)).toBe(true);
      expect(algosdk.decodeSignedTransaction(blob).txn.txID()).toBe(
        [txnA, txnB, txnC][i].txID()
      );
    });

    expect(mockSignTransaction).toHaveBeenCalledTimes(2);
  });

  it('never signs an entry marked `signers: []` (explicit do-not-sign)', async () => {
    const account = accountOf('bind-empty-signers', AccountType.STANDARD);
    const txn = payOn(VOI, account.address, 1);

    const result = await signer.signTransaction({
      type: 'batch_transaction',
      account,
      pin: '1234',
      walletConnectParams: {
        transactions: [{ txn: unsignedB64(txn), signers: [] }],
        accountAddress: account.address,
        sessionBinding: bindingFor(VOI, [account.address]),
      },
    });

    expect(result.success).toBe(true);
    expect((result.signedTransactions as (string | null)[])[0]).toBeNull();
    expect(mockSignTransaction).not.toHaveBeenCalled();
  });

  it('signs when `signers` is undefined and the sender is the reviewed account', async () => {
    const account = accountOf('bind-no-signers', AccountType.STANDARD);
    const txn = payOn(VOI, account.address, 1);

    const result = await signer.signTransaction({
      type: 'batch_transaction',
      account,
      pin: '1234',
      walletConnectParams: {
        transactions: [{ txn: unsignedB64(txn) }],
        accountAddress: account.address,
        sessionBinding: bindingFor(VOI, [account.address]),
      },
    });

    expect(result.success).toBe(true);
    const blob = new Uint8Array(
      Buffer.from((result.signedTransactions as string[])[0], 'base64')
    );
    expect(blobIsSignedBy(blob, account.address)).toBe(true);
  });

  it('declines an entry whose `signers` list excludes the sender', async () => {
    const account = accountOf('bind-excluded', AccountType.STANDARD);
    const someoneElse = makeAccount('bind-excluded-other').addr;
    const txn = payOn(VOI, account.address, 1);

    const result = await signer.signTransaction({
      type: 'batch_transaction',
      account,
      pin: '1234',
      walletConnectParams: {
        transactions: [{ txn: unsignedB64(txn), signers: [someoneElse] }],
        accountAddress: account.address,
        sessionBinding: bindingFor(VOI, [account.address]),
      },
    });

    expect(result.success).toBe(true);
    expect((result.signedTransactions as (string | null)[])[0]).toBeNull();
    expect(mockSignTransaction).not.toHaveBeenCalled();
  });

  // DR-5: a dApp used to be able to harvest a signature from ANY locally
  // controlled account simply by naming it. Eligibility is now anchored in what
  // the SESSION approved, and the wallet's own account list is never a
  // substitute for it.
  it('declines a locally-controlled sender the SESSION never approved', async () => {
    const account = accountOf('bind-unapproved', AccountType.STANDARD);
    const txn = payOn(VOI, account.address, 1);

    const result = await signer.signTransaction({
      type: 'batch_transaction',
      account,
      pin: '1234',
      walletConnectParams: {
        transactions: [{ txn: unsignedB64(txn) }],
        accountAddress: account.address,
        // Session approved a DIFFERENT account on this chain.
        sessionBinding: bindingFor(VOI, [makeAccount('bind-other').addr]),
      },
    });

    expect(result.success).toBe(true);
    expect((result.signedTransactions as (string | null)[])[0]).toBeNull();
    expect(mockSignTransaction).not.toHaveBeenCalled();
  });

  // DR-14: authorization is CHAIN-SCOPED. A session may approve address A on
  // Voi and not on Algorand; reducing the session to a bare address set would
  // let the Voi approval authorize an Algorand transaction from A.
  it('declines a sender approved on a DIFFERENT chain than the request', async () => {
    const account = accountOf('bind-wrong-chain', AccountType.STANDARD);
    const txn = payOn(ALGO, account.address, 1);

    // Request is on Algorand; the approved CAIP account is the Voi one.
    const binding = bindingFor(ALGO, []);
    binding.approvedAccounts = [`${chainIdOf(VOI)}:${account.address}`];

    const result = await signer.signTransaction({
      type: 'batch_transaction',
      account,
      pin: '1234',
      walletConnectParams: {
        transactions: [{ txn: unsignedB64(txn) }],
        accountAddress: account.address,
        sessionBinding: binding,
      },
    });

    expect(result.success).toBe(true);
    expect((result.signedTransactions as (string | null)[])[0]).toBeNull();
    expect(mockSignTransaction).not.toHaveBeenCalled();
  });

  it('rejects the whole request when the session approved nothing on this chain', async () => {
    const account = accountOf('bind-empty-session', AccountType.STANDARD);
    const txn = payOn(VOI, account.address, 1);

    const result = await signer.signTransaction({
      type: 'batch_transaction',
      account,
      pin: '1234',
      walletConnectParams: {
        transactions: [{ txn: unsignedB64(txn) }],
        accountAddress: account.address,
        sessionBinding: bindingFor(VOI, []),
      },
    });

    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(/no approved account/i);
    expect(mockSignTransaction).not.toHaveBeenCalled();
  });

  // DR-7 (TASK-251). A single mismatched entry fails the WHOLE batch: a
  // partially-signed group returned to a dApp is its own failure mode.
  it('fails the WHOLE batch on a genesis mismatch and never calls the signer', async () => {
    const account = accountOf('bind-genesis-mismatch', AccountType.STANDARD);
    const good = payOn(VOI, account.address, 1);
    const wrongChain = payOn(ALGO, account.address, 2);

    const result = await signer.signTransaction({
      type: 'batch_transaction',
      account,
      pin: '1234',
      walletConnectParams: {
        transactions: [good, wrongChain].map((t) => ({ txn: unsignedB64(t) })),
        accountAddress: account.address,
        sessionBinding: bindingFor(VOI, [account.address]),
      },
    });

    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(/mixed or invalid network batch/i);
    // The decisive assertion: NO key was used for ANY entry, not even the
    // well-formed first one.
    expect(mockSignTransaction).not.toHaveBeenCalled();
    expect(result.signedTransactions).toBeUndefined();
  });

  it('rejects a transaction carrying no recognized network identity', async () => {
    const account = accountOf('bind-no-genesis', AccountType.STANDARD);
    // The shared fixture's genesis hash is all-zero, which algosdk omits from
    // the encoding entirely — the decoded txn belongs to no known chain.
    const txn = paymentTxn(account.address, { amount: 1 });

    const result = await signer.signTransaction({
      type: 'batch_transaction',
      account,
      pin: '1234',
      walletConnectParams: {
        transactions: [{ txn: unsignedB64(txn) }],
        accountAddress: account.address,
        sessionBinding: bindingFor(VOI, [account.address]),
      },
    });

    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(
      /no recognized network identity|mixed or invalid network batch/i
    );
    expect(mockSignTransaction).not.toHaveBeenCalled();
  });

  it('rejects a transaction whose genesisID contradicts its chain', async () => {
    const account = accountOf('bind-genesis-id', AccountType.STANDARD);
    const params = paramsFor(VOI);
    const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
      sender: account.address,
      receiver: account.address,
      amount: 1,
      suggestedParams: { ...params, genesisID: 'not-voimain-v1.0' },
    });

    const result = await signer.signTransaction({
      type: 'batch_transaction',
      account,
      pin: '1234',
      walletConnectParams: {
        transactions: [{ txn: unsignedB64(txn) }],
        accountAddress: account.address,
        sessionBinding: bindingFor(VOI, [account.address]),
      },
    });

    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(/genesis id/i);
    expect(mockSignTransaction).not.toHaveBeenCalled();
  });

  // DR-7: the resolved NetworkId must reach SecureKeyManager, which otherwise
  // defaults to the ACTIVE network — so a Voi-active app reviewing an Algorand
  // rekeyed account would resolve the wrong signing authority.
  it('threads the resolved NetworkId into SecureKeyManager.signTransaction', async () => {
    const account = accountOf('bind-network-thread', AccountType.STANDARD);
    const txn = payOn(ALGO, account.address, 1);

    await signer.signTransaction({
      type: 'batch_transaction',
      account,
      pin: '1234',
      walletConnectParams: {
        transactions: [{ txn: unsignedB64(txn) }],
        accountAddress: account.address,
        sessionBinding: bindingFor(ALGO, [account.address]),
      },
    });

    expect(mockSignTransaction).toHaveBeenCalledTimes(1);
    expect(mockSignTransaction.mock.calls[0][3]).toBe(ALGO);
  });

  // DR-16: `decodeSignedTransaction` only proves a msgpack wrapper parsed. A
  // wrapper with a corrupted signature would still have "passed through" as an
  // invalid SignedTxn for the dApp to submit.
  it('rejects a pre-signed blob whose signature does not verify (DR-16)', async () => {
    const account = accountOf('bind-badsig-owner', AccountType.STANDARD);
    const other = accountOf('bind-badsig-other', AccountType.STANDARD);
    const blob = realSign(payOn(VOI, other.address, 2), other.address);
    // Corrupt one byte of the signature (the txn itself is untouched, so it
    // still decodes cleanly as a SignedTransaction).
    const decoded = algosdk.decodeSignedTransaction(blob);
    const tampered = new algosdk.SignedTransaction({
      txn: decoded.txn,
      sig: Uint8Array.from(decoded.sig!, (b, i) => (i === 0 ? b ^ 0xff : b)),
    });
    const tamperedB64 = Buffer.from(algosdk.encodeMsgpack(tampered)).toString(
      'base64'
    );

    const result = await signer.signTransaction({
      type: 'batch_transaction',
      account,
      pin: '1234',
      walletConnectParams: {
        transactions: [{ txn: tamperedB64 }],
        accountAddress: account.address,
        sessionBinding: bindingFor(VOI, [account.address]),
      },
    });

    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(/signature does not verify/i);
    expect(mockSignTransaction).not.toHaveBeenCalled();
  });

  it('accepts a genuinely pre-signed group member on the session-bound path', async () => {
    const account = accountOf('bind-presigned-owner', AccountType.STANDARD);
    const other = accountOf('bind-presigned-other', AccountType.STANDARD);
    const preSigned = Buffer.from(
      realSign(payOn(VOI, other.address, 2), other.address)
    ).toString('base64');
    const mine = payOn(VOI, account.address, 1);

    const result = await signer.signTransaction({
      type: 'batch_transaction',
      account,
      pin: '1234',
      walletConnectParams: {
        transactions: [{ txn: preSigned }, { txn: unsignedB64(mine) }],
        accountAddress: account.address,
        sessionBinding: bindingFor(VOI, [account.address]),
      },
    });

    expect(result.success).toBe(true);
    const signed = result.signedTransactions as (string | null)[];
    expect(signed).toHaveLength(2);
    expect(signed[0]).toBe(preSigned);
    expect(signed[1]).not.toBeNull();
  });

  it('preserves response length and positions on a Ledger (sequential) batch', async () => {
    const account = accountOf('bind-ledger', AccountType.LEDGER);
    const foreign = makeAccount('bind-ledger-foreign').addr;
    const txns = [
      payOn(VOI, account.address, 1),
      payOn(VOI, foreign, 2),
      payOn(VOI, account.address, 3),
    ];

    const result = await signer.signTransaction({
      type: 'batch_transaction',
      account,
      walletConnectParams: {
        transactions: txns.map((t) => ({ txn: unsignedB64(t) })),
        accountAddress: account.address,
        sessionBinding: bindingFor(VOI, [account.address]),
      },
    });

    expect(result.success).toBe(true);
    const signed = result.signedTransactions as (string | null)[];
    expect(signed).toHaveLength(3);
    expect(signed[1]).toBeNull();
    expect(signed[0]).not.toBeNull();
    expect(signed[2]).not.toBeNull();
    expect(mockSignTransaction).toHaveBeenCalledTimes(2);
  });
});

// ===========================================================================
// WalletConnect v1 boundary — DR-11 chain mapping, DR-12 null threading
// ===========================================================================

describe('WalletConnect v1 boundary', () => {
  it('maps the Algorand mainnet v1 chain ids and rejects everything else (DR-11)', () => {
    expect(resolveV1Chain(416001)).toEqual({
      chainId: NETWORK_CONFIGURATIONS[NetworkId.ALGORAND_MAINNET].chainId,
      networkId: NetworkId.ALGORAND_MAINNET,
    });
    expect(resolveV1Chain(4160)).toEqual({
      chainId: NETWORK_CONFIGURATIONS[NetworkId.ALGORAND_MAINNET].chainId,
      networkId: NetworkId.ALGORAND_MAINNET,
    });

    // Ambiguous / unsupported v1 chains resolve to nothing and must be
    // rejected. `416001` is NOT allowed to silently mean Voi, which is the
    // accepted v1-Voi session break.
    expect(resolveV1Chain(416002)).toBeNull(); // Algorand testnet
    expect(resolveV1Chain(416003)).toBeNull(); // Algorand betanet
    expect(resolveV1Chain(0)).toBeNull();
    expect(resolveV1Chain(undefined)).toBeNull();
    expect(resolveV1Chain(null)).toBeNull();
  });

  // DR-12: the v1 response path is the one place a null could be silently
  // filtered or stringified. It must survive encoding positionally.
  it('carries a positional null through the v1 sign-txn response (DR-12)', () => {
    const response = createSignTxnResponse(42, ['AAA', null, 'CCC']);

    expect(response.result).toEqual(['AAA', null, 'CCC']);

    // The wire form is JSON, which is where a filtered/stringified null would
    // show up. Round-trip it the way the v1 encryptResponse path does.
    const roundTripped = JSON.parse(JSON.stringify(response));
    expect(roundTripped.result).toHaveLength(3);
    expect(roundTripped.result[1]).toBeNull();
    expect(roundTripped.result[1]).not.toBe('null');
    expect(roundTripped.result[0]).toBe('AAA');
    expect(roundTripped.result[2]).toBe('CCC');
  });
});

// ===========================================================================
// Routing: keyreg — builds a real txn, signs it, submits it
// ===========================================================================

describe('signTransaction — keyreg routing', () => {
  it('builds + signs an online keyreg with a REAL signature and submits it', async () => {
    const account = accountOf('keyreg-on', AccountType.STANDARD);
    let submittedBlob: Uint8Array | undefined;
    const sendRaw = jest.fn(async (blob: Uint8Array) => {
      submittedBlob = blob;
      return 'TXID_KEYREG';
    });
    const waitConfirm = jest.fn().mockResolvedValue({ confirmedRound: 7 });
    mockGetInstance.mockReturnValue({
      getSuggestedParams: jest.fn().mockResolvedValue({
        fee: 1000,
        firstValid: 1,
        lastValid: 1001,
        genesisID: 'voi-test-v1',
        genesisHash: new Uint8Array(32),
        flatFee: true,
        minFee: 1000,
      }),
      sendRawTransaction: sendRaw,
      waitForConfirmation: waitConfirm,
    });
    const { cb, fns } = makeCallbacks();

    const result = await signer.signTransaction(
      {
        type: 'keyreg',
        account,
        pin: '1234',
        keyregParams: {
          address: account.address,
          voteKey: new Uint8Array(32).fill(1),
          selectionKey: new Uint8Array(32).fill(2),
          stateProofKey: new Uint8Array(64).fill(3),
          voteFirst: 1,
          voteLast: 1000,
          voteKeyDilution: 100,
        },
      },
      cb
    );

    expect(result).toEqual({ success: true, transactionId: 'TXID_KEYREG' });
    expect(sendRaw).toHaveBeenCalledTimes(1);
    expect(waitConfirm).toHaveBeenCalledWith('TXID_KEYREG');
    expect(fns.onNetworkConfirmed).toHaveBeenCalledWith('TXID_KEYREG');

    // The submitted blob is a REAL keyreg signature by the account.
    expect(submittedBlob).toBeDefined();
    expect(blobIsSignedBy(submittedBlob!, account.address)).toBe(true);
    const decoded = algosdk.decodeSignedTransaction(submittedBlob!);
    expect(decoded.txn.type).toBe('keyreg');
  });

  it('builds an offline (nonParticipation) keyreg', async () => {
    const account = accountOf('keyreg-off', AccountType.STANDARD);
    let submittedBlob: Uint8Array | undefined;
    mockGetInstance.mockReturnValue({
      getSuggestedParams: jest.fn().mockResolvedValue({
        fee: 1000,
        firstValid: 1,
        lastValid: 1001,
        genesisID: 'voi-test-v1',
        genesisHash: new Uint8Array(32),
        flatFee: true,
        minFee: 1000,
      }),
      sendRawTransaction: jest.fn(async (blob: Uint8Array) => {
        submittedBlob = blob;
        return 'TXID_KEYREG_OFF';
      }),
      waitForConfirmation: jest.fn().mockResolvedValue({}),
    });

    const result = await signer.signTransaction({
      type: 'keyreg',
      account,
      keyregParams: { address: account.address, nonParticipation: true },
    });

    expect(result.success).toBe(true);
    expect(blobIsSignedBy(submittedBlob!, account.address)).toBe(true);
  });

  it('propagates a submit failure on the keyreg path', async () => {
    const account = accountOf('keyreg-fail', AccountType.STANDARD);
    const boom = new Error('algod rejected');
    mockGetInstance.mockReturnValue({
      getSuggestedParams: jest.fn().mockResolvedValue({
        fee: 1000,
        firstValid: 1,
        lastValid: 1001,
        genesisID: 'voi-test-v1',
        genesisHash: new Uint8Array(32),
        flatFee: true,
        minFee: 1000,
      }),
      sendRawTransaction: jest.fn().mockRejectedValue(boom),
      waitForConfirmation: jest.fn(),
    });

    const result = await signer.signTransaction({
      type: 'keyreg',
      account,
      keyregParams: { address: account.address, nonParticipation: true },
    });

    expect(result).toEqual({ success: false, error: boom });
  });

  it('propagates a confirmation failure (submitted, then wait rejects)', async () => {
    const account = accountOf('keyreg-confirm-fail', AccountType.STANDARD);
    const boom = new Error('confirmation timeout');
    const sendRaw = jest.fn().mockResolvedValue('TXID_KEYREG_PENDING');
    mockGetInstance.mockReturnValue({
      getSuggestedParams: jest.fn().mockResolvedValue({
        fee: 1000,
        firstValid: 1,
        lastValid: 1001,
        genesisID: 'voi-test-v1',
        genesisHash: new Uint8Array(32),
        flatFee: true,
        minFee: 1000,
      }),
      sendRawTransaction: sendRaw,
      waitForConfirmation: jest.fn().mockRejectedValue(boom),
    });
    const { cb, fns } = makeCallbacks();

    const result = await signer.signTransaction(
      {
        type: 'keyreg',
        account,
        keyregParams: { address: account.address, nonParticipation: true },
      },
      cb
    );

    // Submitted (onNetworkSubmit fired) but confirmation threw -> failResult.
    expect(sendRaw).toHaveBeenCalledTimes(1);
    expect(fns.onNetworkSubmit).toHaveBeenCalledTimes(1);
    expect(fns.onNetworkConfirmed).not.toHaveBeenCalled();
    expect(result).toEqual({ success: false, error: boom });
    expect(fns.onError).toHaveBeenCalledWith(boom);
  });

  it('propagates a signer rejection BEFORE any submit/confirm', async () => {
    const account = accountOf('keyreg-signer-reject', AccountType.STANDARD);
    const boom = new Error('device rejected keyreg');
    const algod = makeAlgod();
    mockGetInstance.mockReturnValue(algod);
    mockSignTransaction.mockRejectedValueOnce(boom);
    const { cb, fns } = makeCallbacks();

    const result = await signer.signTransaction(
      {
        type: 'keyreg',
        account,
        keyregParams: { address: account.address, nonParticipation: true },
      },
      cb
    );

    expect(result).toEqual({ success: false, error: boom });
    // Signing failed, so nothing is ever submitted or confirmed.
    expect(algod.sendRawTransaction).not.toHaveBeenCalled();
    expect(algod.waitForConfirmation).not.toHaveBeenCalled();
    expect(fns.onNetworkSubmit).not.toHaveBeenCalled();
    expect(fns.onNetworkConfirmed).not.toHaveBeenCalled();
    // keyreg routes signer failures through the generic catch -> onError; unlike
    // the batch path it does NOT emit onLedgerRejected.
    expect(fns.onError).toHaveBeenCalledWith(boom);
    expect(fns.onLedgerRejected).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// Routing: appl (application call)
// ===========================================================================

describe('signTransaction — appl routing', () => {
  it('builds + signs an app-call with a REAL signature and submits it', async () => {
    const account = accountOf('appl', AccountType.STANDARD);
    let submittedBlob: Uint8Array | undefined;
    const sendRaw = jest.fn(async (blob: Uint8Array) => {
      submittedBlob = blob;
      return 'TXID_APPL';
    });
    mockGetInstance.mockReturnValue({
      getSuggestedParams: jest.fn().mockResolvedValue({
        fee: 1000,
        firstValid: 1,
        lastValid: 1001,
        genesisID: 'voi-test-v1',
        genesisHash: new Uint8Array(32),
        flatFee: true,
        minFee: 1000,
      }),
      sendRawTransaction: sendRaw,
      waitForConfirmation: jest.fn().mockResolvedValue({}),
    });

    const result = await signer.signTransaction({
      type: 'appl',
      account,
      pin: '1234',
      applParams: {
        senderAddress: account.address,
        appId: 67890,
        appArgs: [new Uint8Array([1, 2, 3])],
      },
    });

    expect(result).toEqual({ success: true, transactionId: 'TXID_APPL' });
    expect(blobIsSignedBy(submittedBlob!, account.address)).toBe(true);
    const decoded = algosdk.decodeSignedTransaction(submittedBlob!);
    expect(decoded.txn.type).toBe('appl');
  });

  it('fails an app-call missing its appId (validation)', async () => {
    const account = accountOf('appl-noid', AccountType.STANDARD);

    const result = await signer.signTransaction({
      type: 'appl',
      account,
      applParams: {
        senderAddress: account.address,
        appId: 0,
      },
    });

    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(/application id required/i);
  });

  it('propagates a submit failure and routes it to onError (NOT onNetworkError)', async () => {
    const account = accountOf('appl-fail', AccountType.STANDARD);
    const boom = new Error('appl submit rejected');
    mockGetInstance.mockReturnValue({
      getSuggestedParams: jest.fn().mockResolvedValue({
        fee: 1000,
        firstValid: 1,
        lastValid: 1001,
        genesisID: 'voi-test-v1',
        genesisHash: new Uint8Array(32),
        flatFee: true,
        minFee: 1000,
      }),
      sendRawTransaction: jest.fn().mockRejectedValue(boom),
      waitForConfirmation: jest.fn(),
    });
    const { cb, fns } = makeCallbacks();

    const result = await signer.signTransaction(
      {
        type: 'appl',
        account,
        applParams: { senderAddress: account.address, appId: 67890 },
      },
      cb
    );

    expect(result).toEqual({ success: false, error: boom });
    // The unified contract funnels ALL failures through the single top-level
    // catch -> onError + onComplete(failResult). The phase-specific
    // onNetworkError / onAuthError hooks are declared but never invoked here.
    expect(fns.onError).toHaveBeenCalledWith(boom);
    expect(fns.onComplete).toHaveBeenCalledWith({
      success: false,
      error: boom,
    });
    expect(fns.onNetworkError).not.toHaveBeenCalled();
    expect(fns.onAuthError).not.toHaveBeenCalled();
  });

  it('propagates a signer rejection BEFORE any submit/confirm', async () => {
    const account = accountOf('appl-signer-reject', AccountType.STANDARD);
    const boom = new Error('device rejected appl');
    const algod = makeAlgod();
    mockGetInstance.mockReturnValue(algod);
    mockSignTransaction.mockRejectedValueOnce(boom);
    const { cb, fns } = makeCallbacks();

    const result = await signer.signTransaction(
      {
        type: 'appl',
        account,
        applParams: { senderAddress: account.address, appId: 67890 },
      },
      cb
    );

    expect(result).toEqual({ success: false, error: boom });
    expect(algod.sendRawTransaction).not.toHaveBeenCalled();
    expect(algod.waitForConfirmation).not.toHaveBeenCalled();
    expect(fns.onNetworkSubmit).not.toHaveBeenCalled();
    expect(fns.onNetworkConfirmed).not.toHaveBeenCalled();
    expect(fns.onError).toHaveBeenCalledWith(boom);
    expect(fns.onLedgerRejected).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// Account-type routing guards (local vs remote-signer vs watch)
// ===========================================================================

describe('signTransaction — account-type routing guards', () => {
  it('rejects a REMOTE_SIGNER account with RemoteSignerRequiredError', async () => {
    const account = accountOf('remote', AccountType.REMOTE_SIGNER);
    const { cb, fns } = makeCallbacks();

    const result = await signer.signTransaction(
      {
        type: 'voi_transfer',
        account,
        transferParams: { toAddress: 'x', amount: 1 } as never,
      },
      cb
    );

    expect(result.success).toBe(false);
    expect(result.error).toBeInstanceOf(RemoteSignerRequiredError);
    expect(result.error?.message).toMatch(/remote signing via qr/i);
    // Never reached the local sender.
    expect(mockTxService.sendTransaction).not.toHaveBeenCalled();
    expect(fns.onError).toHaveBeenCalledWith(result.error);
  });

  it('rejects a WATCH account (cannot sign)', async () => {
    const account = accountOf('watch', AccountType.WATCH);

    const result = await signer.signTransaction({
      type: 'voi_transfer',
      account,
      transferParams: { toAddress: 'x', amount: 1 } as never,
    });

    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(/watch accounts cannot sign/i);
    expect(mockTxService.sendTransaction).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// Validation + top-level error/callback contract
// ===========================================================================

describe('signTransaction — validation and callback contract', () => {
  it('rejects a missing account before any auth-success callback', async () => {
    const { cb, fns } = makeCallbacks();

    const result = await signer.signTransaction(
      { type: 'voi_transfer', account: undefined as never },
      cb
    );

    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(/account is required/i);
    // onAuthStart fired, but validation threw before success/signing callbacks.
    expect(fns.onAuthStart).toHaveBeenCalledTimes(1);
    expect(fns.onAuthSuccess).not.toHaveBeenCalled();
    expect(fns.onSigningStart).not.toHaveBeenCalled();
    expect(fns.onError).toHaveBeenCalledWith(result.error);
    expect(fns.onComplete).toHaveBeenCalledWith(result);
  });

  it('rejects a missing transaction type', async () => {
    const account = accountOf('notype', AccountType.STANDARD);
    const result = await signer.signTransaction({
      type: undefined as never,
      account,
    });
    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(/transaction type is required/i);
  });

  it.each([
    ['voi_transfer', /transfer parameters required/i],
    ['rekey', /rekey parameters required/i],
    ['batch_transaction', /batch parameters required/i],
    ['keyreg', /keyreg parameters required/i],
    ['appl', /application parameters required/i],
  ] as const)(
    'rejects %s when its required params are missing',
    async (type, pattern) => {
      const account = accountOf(`missing-${type}`, AccountType.STANDARD);
      const result = await signer.signTransaction({
        type,
        account,
      } as UnifiedTransactionRequest);
      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(pattern);
    }
  );

  it('rejects an unsupported transaction type at the router', async () => {
    const account = accountOf('bogus', AccountType.STANDARD);
    // A type that passes the (presence-only) validator but has no route.
    const result = await signer.signTransaction({
      type: 'not_a_real_type' as never,
      account,
    });
    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(/unsupported transaction type/i);
  });

  it('fires the success-phase callbacks in order on the happy path', async () => {
    const account = accountOf('order', AccountType.STANDARD);
    const { cb, order, fns } = makeCallbacks();

    await signer.signTransaction(
      {
        type: 'voi_transfer',
        account,
        transferParams: { toAddress: 'x', amount: 1 } as never,
      },
      cb
    );

    // Auth -> signing precede completion; onError never fires on success.
    expect(order.slice(0, 3)).toEqual([
      'onAuthStart',
      'onAuthSuccess',
      'onSigningStart',
    ]);
    expect(order[order.length - 1]).toBe('onComplete');
    expect(fns.onError).not.toHaveBeenCalled();
  });

  it('does not throw when called without any callbacks', async () => {
    const account = accountOf('nocb', AccountType.STANDARD);
    await expect(
      signer.signTransaction({
        type: 'voi_transfer',
        account,
        transferParams: { toAddress: 'x', amount: 1 } as never,
      })
    ).resolves.toMatchObject({ success: true });
  });
});
