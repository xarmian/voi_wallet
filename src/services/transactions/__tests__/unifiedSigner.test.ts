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

  it('passes through a transaction whose sender is NOT our signer (unsigned)', async () => {
    const account = accountOf('batch-owner', AccountType.STANDARD);
    const foreign = makeAccount('batch-foreign').addr;
    const foreignTxn = paymentTxn(foreign, { amount: 5 });
    const wireTxn = unsignedB64(foreignTxn);

    // Our signer is `account`, but the txn's sender is `foreign` and no
    // signers/authAddr override points back at `foreign` — so the entry does
    // NOT match our signer and must be passed through unsigned.
    const result = await signer.signTransaction({
      type: 'batch_transaction',
      account,
      walletConnectParams: {
        transactions: [{ txn: wireTxn }],
        accountAddress: account.address,
      },
    });

    expect(result.success).toBe(true);
    // Passed through verbatim (still the unsigned wire bytes) and never signed.
    expect((result.signedTransactions as string[])[0]).toBe(wireTxn);
    expect(mockSignTransaction).not.toHaveBeenCalled();
  });

  // Characterization of the caller-controlled signer-selection branch
  // (unifiedSigner.ts ~L493): `wtxn.signers[0]` OVERRIDES the request's
  // `accountAddress`. So a batch whose request is scoped to account A, but whose
  // entry declares `signers: [B]` for a B-sender txn, is signed with B's key
  // (whenever B is resolvable in the wallet) — NOT skipped. This pins that
  // routing precisely: a regression that ignored `signers` would sign as A (and
  // fail sender-match → pass through), flipping these assertions.
  it('honors the wtxn.signers[0] override to select the signing key', async () => {
    const selected = accountOf('wc-selected', AccountType.STANDARD); // A (request)
    const signerB = accountOf('wc-signer-b', AccountType.STANDARD); // B (override)
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
      },
    });

    expect(result.success).toBe(true);
    // The leaf was invoked as B (the override), not A (the request account).
    expect(mockSignTransaction).toHaveBeenCalledTimes(1);
    expect(mockSignTransaction.mock.calls[0][1]).toBe(signerB.address);
    // And the produced blob is a real signature by B over B's transaction.
    const blob = new Uint8Array(
      Buffer.from((result.signedTransactions as string[])[0], 'base64')
    );
    expect(blobIsSignedBy(blob, signerB.address)).toBe(true);
    expect(algosdk.decodeSignedTransaction(blob).txn.txID()).toBe(
      txnFromB.txID()
    );
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

  it('passes through an already-signed / undecodable entry unchanged', async () => {
    const account = accountOf('batch-logicsig', AccountType.STANDARD);
    // Bytes that are NOT a decodable unsigned transaction.
    const opaque = Buffer.from([0x01, 0x02, 0x03, 0x04]).toString('base64');

    const result = await signer.signTransaction({
      type: 'batch_transaction',
      account,
      walletConnectParams: {
        transactions: [{ txn: opaque }],
        accountAddress: account.address,
      },
    });

    expect(result.success).toBe(true);
    expect((result.signedTransactions as string[])[0]).toBe(opaque);
    expect(mockSignTransaction).not.toHaveBeenCalled();
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
