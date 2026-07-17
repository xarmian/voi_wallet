/**
 * Signature Verification Utilities
 *
 * Provides local cryptographic verification of signed Algorand transactions
 * without requiring network submission. Used for airgap signer verification.
 */

import algosdk from 'algosdk';
import nacl from 'tweetnacl';
import type {
  RemoteSignerRequest,
  RemoteSignerResponse,
} from '@/types/remoteSigner';

export interface VerificationResult {
  valid: boolean;
  error?: string;
}

export interface TransactionComponents {
  txnBytes: Uint8Array;
  signature: Uint8Array;
  signerPublicKey: Uint8Array;
  signerAddress: string;
}

/**
 * Verify a signed transaction was signed by the expected address.
 * Does NOT submit to network - purely local cryptographic verification.
 *
 * @param signedTxnBase64 - Base64-encoded signed transaction blob
 * @param expectedSignerAddress - The Algorand address that should have signed
 * @returns Verification result with valid flag and optional error message
 */
export function verifySignedTransaction(
  signedTxnBase64: string,
  expectedSignerAddress: string
): VerificationResult {
  try {
    // Decode the signed transaction
    const signedTxnBytes = Buffer.from(signedTxnBase64, 'base64');
    const signedTxn = algosdk.decodeSignedTransaction(signedTxnBytes);

    // Extract signature - must have a sig (not msig or lsig)
    if (!signedTxn.sig) {
      return {
        valid: false,
        error: 'Transaction does not contain a standard signature',
      };
    }

    // Get the transaction object
    const txn = signedTxn.txn;

    // Handle both algosdk v2 and v3 field names
    const txnAny = txn as any;

    // SECURITY: Verify the transaction does NOT contain a rekey field
    // This prevents a malicious airgap device from returning a transaction
    // that would rekey the account to an attacker's address
    const rekeyField = txnAny.reKeyTo || txnAny.rekeyTo;
    if (rekeyField) {
      return {
        valid: false,
        error:
          'Security error: Verification transaction must not contain a rekey field',
      };
    }

    // For verification transactions, we expect a self-payment where
    // sender = receiver = expectedSignerAddress
    // This proves the airgap device controls the expected address
    const senderField = txnAny.from || txnAny.sender || txnAny.snd;
    const senderAddress = senderField?.publicKey
      ? algosdk.encodeAddress(senderField.publicKey)
      : String(senderField || '');

    // Verify the transaction sender matches the expected signer
    // For our verification flow, we create a self-payment so sender should be the signer
    if (senderAddress.toUpperCase() !== expectedSignerAddress.toUpperCase()) {
      return {
        valid: false,
        error: `Transaction sender ${senderAddress} does not match expected signer ${expectedSignerAddress}`,
      };
    }

    // SECURITY: Enforce the self-payment invariant (receiver === sender).
    // The verification flow proves the airgap device controls the expected
    // address by round-tripping a zero-amount SELF-payment. A missing receiver
    // (i.e. a non-payment transaction) or any receiver other than the sender
    // means the signed blob is NOT the self-payment we asked for, so we must
    // reject it even though the sender and signature already checked out.
    const receiverField = txnAny.to || txnAny.rcv || txnAny.payment?.receiver;
    const receiverAddress = receiverField?.publicKey
      ? algosdk.encodeAddress(receiverField.publicKey)
      : String(receiverField || '');

    if (
      !receiverAddress ||
      receiverAddress.toUpperCase() !== senderAddress.toUpperCase()
    ) {
      return {
        valid: false,
        error: `Transaction is not a self-payment: receiver ${
          receiverAddress || '(missing)'
        } does not match sender ${senderAddress}`,
      };
    }

    // Get the bytes that were signed (TX prefix + encoded transaction)
    const txnBytesToSign = txn.bytesToSign();

    // Decode the expected signer's public key from address
    const expectedPublicKey = algosdk.decodeAddress(
      expectedSignerAddress
    ).publicKey;

    // Verify the Ed25519 signature
    const isValid = nacl.sign.detached.verify(
      txnBytesToSign,
      signedTxn.sig,
      expectedPublicKey
    );

    if (!isValid) {
      return {
        valid: false,
        error:
          'Signature verification failed - signature does not match the expected signer',
      };
    }

    return { valid: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return {
      valid: false,
      error: `Failed to verify signature: ${message}`,
    };
  }
}

/**
 * Extract components from a signed transaction for manual verification.
 *
 * @param signedTxnBytes - Raw bytes of the signed transaction
 * @returns Transaction components or null if extraction fails
 */
export function extractTransactionComponents(
  signedTxnBytes: Uint8Array
): TransactionComponents | null {
  try {
    const signedTxn = algosdk.decodeSignedTransaction(signedTxnBytes);

    if (!signedTxn.sig) {
      return null;
    }

    const txn = signedTxn.txn;
    const txnBytesToSign = txn.bytesToSign();

    // Get signer public key from sender address
    // Handle both algosdk v2 and v3 field names
    const txnAny = txn as any;
    const senderField = txnAny.from || txnAny.sender || txnAny.snd;
    const signerPublicKey = senderField?.publicKey;
    if (!signerPublicKey) {
      return null;
    }

    const signerAddress = algosdk.encodeAddress(signerPublicKey);

    return {
      txnBytes: txnBytesToSign,
      signature: signedTxn.sig,
      signerPublicKey,
      signerAddress,
    };
  } catch {
    return null;
  }
}

/**
 * Verify an Ed25519 signature directly.
 * Useful when you already have the components separated.
 *
 * @param message - The message bytes that were signed
 * @param signature - The 64-byte Ed25519 signature
 * @param publicKey - The 32-byte Ed25519 public key
 * @returns true if signature is valid
 */
export function verifyEd25519Signature(
  message: Uint8Array,
  signature: Uint8Array,
  publicKey: Uint8Array
): boolean {
  try {
    return nacl.sign.detached.verify(message, signature, publicKey);
  } catch {
    return false;
  }
}

/**
 * Verify a signed transaction from raw bytes.
 *
 * @param signedTxnBytes - Raw bytes of the signed transaction
 * @param expectedSignerAddress - The Algorand address that should have signed
 * @returns Verification result
 */
export function verifySignedTransactionBytes(
  signedTxnBytes: Uint8Array,
  expectedSignerAddress: string
): VerificationResult {
  const base64 = Buffer.from(signedTxnBytes).toString('base64');
  return verifySignedTransaction(base64, expectedSignerAddress);
}

// ============================================================================
// Remote-signer signed-response verification (DR-6)
// ============================================================================
//
// `verifySignedTransaction` above is a SPECIALISED self-payment / no-rekey
// control-proof verifier used only by the airgap pairing-verification flow. It
// deliberately rejects rekeys and non-self-payments and derives the signer from
// the transaction SENDER — which is WRONG for a general remote-signer response
// (it would brick every real payment/ASA/app-call/rekey the signer returns, and
// mis-identifies the signer of a rekeyed account).
//
// The verifier below is the GENERAL, content-binding, sgnr-aware gate that every
// remote-signer signed response must pass BEFORE the wallet submits it. It never
// trusts the wire: the expected signer is resolved network-correctly by the
// caller (injected), the verification pubkey is derived from that address, and
// each returned transaction must byte-equal the exact unsigned transaction the
// wallet built.

/**
 * Dependencies injected into {@link verifyRemoteSignerResponse}.
 *
 * Both are supplied by the caller so the verifier is a PURE function of its
 * inputs (no network / store singletons reach in) — which keeps it fully
 * unit-testable in isolation. In production `transactionAuthController` wires:
 *  - `resolveExpectedSigner` → a NETWORK-SCOPED auth-address lookup
 *    (`NetworkService.getInstance(request.net).getAccountRekeyInfo`), NOT the
 *    single global `authAddress` on wallet metadata (which is overwritten by
 *    whichever network's balance loaded last).
 *  - `isPairedRemoteSigner` → a membership test over the wallet's paired
 *    REMOTE_SIGNER account addresses.
 */
export interface RemoteSignerResponseVerificationDeps {
  /**
   * Resolve the network-correct EXPECTED signer for a transaction sender: the
   * sender's on-chain auth address on the request network when rekeyed,
   * otherwise the sender itself. May be async (it typically queries the chain).
   */
  resolveExpectedSigner: (sender: string) => string | Promise<string>;
  /** True iff `address` is a paired REMOTE_SIGNER account in this wallet. */
  isPairedRemoteSigner: (address: string) => boolean;
}

/** Constant-shape byte-equality (length + element-wise). */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Verify a remote-signer signed RESPONSE against the exact request the wallet
 * built — fail-closed. Every returned signed transaction must:
 *   1. decode to a single Ed25519 `sig` (msig / lsig are rejected);
 *   2. CONTENT-BIND: its unsigned bytes byte-equal `request.txns[i].b` (defeats
 *      a malicious signer that returns a validly-signed but DIFFERENT txn);
 *   3. be signed by the NETWORK-CORRECT expected signer — resolved from the
 *      decoded sender via {@link RemoteSignerResponseVerificationDeps.resolveExpectedSigner},
 *      which MUST be a paired REMOTE_SIGNER account (fail-closed otherwise); the
 *      Ed25519 signature verifies against the pubkey DERIVED from that address;
 *   4. carry a consistent `sgnr` (auth-address) when the signer differs from the
 *      sender (rekeyed accounts), and no conflicting `sgnr` otherwise.
 *
 * Returns `{ valid: true }` only when EVERY transaction passes. Any failure —
 * including a sender whose signer cannot be confidently resolved to a paired
 * remote signer — rejects the whole response.
 *
 * Envelope shape (0..n-1 permutation, count, strict base64) is also enforced by
 * the caller's `validateResponse` before this runs; the redundant checks here
 * make this function a safe standalone crypto gate (defence-in-depth).
 */
export async function verifyRemoteSignerResponse(
  request: Pick<RemoteSignerRequest, 'txns'>,
  response: Pick<RemoteSignerResponse, 'ok' | 'sigs'>,
  deps: RemoteSignerResponseVerificationDeps
): Promise<VerificationResult> {
  try {
    const requestTxns = request.txns;
    if (!Array.isArray(requestTxns) || requestTxns.length === 0) {
      return { valid: false, error: 'Request has no transactions to verify' };
    }
    if (response.ok !== true) {
      return { valid: false, error: 'Response is not a success response' };
    }
    const sigs = response.sigs;
    if (!Array.isArray(sigs)) {
      return { valid: false, error: 'Response has no signatures array' };
    }
    if (sigs.length !== requestTxns.length) {
      return {
        valid: false,
        error: `Signature count ${sigs.length} does not match transaction count ${requestTxns.length}`,
      };
    }

    // Build index -> blob map, requiring an EXACT 0..n-1 permutation (integer,
    // in-range, no dup/gap) BEFORE mapping blobs onto request transactions.
    const n = requestTxns.length;
    const blobByIndex = new Map<number, string>();
    for (const sig of sigs) {
      const idx = (sig as { i?: unknown })?.i;
      if (
        typeof idx !== 'number' ||
        !Number.isInteger(idx) ||
        idx < 0 ||
        idx >= n
      ) {
        return {
          valid: false,
          error: 'Signature index is out of range or not an integer',
        };
      }
      if (blobByIndex.has(idx)) {
        return { valid: false, error: `Duplicate signature index ${idx}` };
      }
      const blob = (sig as { b?: unknown }).b;
      if (typeof blob !== 'string' || blob.length === 0) {
        return {
          valid: false,
          error: `Signature blob at index ${idx} is not a non-empty string`,
        };
      }
      blobByIndex.set(idx, blob);
    }

    for (let i = 0; i < n; i++) {
      const requestTxn = requestTxns[i];
      const blob = blobByIndex.get(i);
      if (blob === undefined) {
        return {
          valid: false,
          error: `Missing signature for transaction index ${i}`,
        };
      }
      if (typeof requestTxn?.b !== 'string' || requestTxn.b.length === 0) {
        return {
          valid: false,
          error: `Request transaction ${i} has no encoded body`,
        };
      }

      // The exact unsigned bytes the wallet built (source of truth).
      const requestedUnsignedBytes = new Uint8Array(
        Buffer.from(requestTxn.b, 'base64')
      );

      // Decode the returned signed transaction.
      let stxn: ReturnType<typeof algosdk.decodeSignedTransaction>;
      try {
        stxn = algosdk.decodeSignedTransaction(Buffer.from(blob, 'base64'));
      } catch (err) {
        const m = err instanceof Error ? err.message : 'decode error';
        return {
          valid: false,
          error: `Failed to decode signed transaction ${i}: ${m}`,
        };
      }

      // Exactly ONE signature form: a single 64-byte Ed25519 `sig`.
      if (stxn.msig || stxn.lsig) {
        return {
          valid: false,
          error: `Transaction ${i} uses a multisig/logicsig signature form (not allowed)`,
        };
      }
      if (!stxn.sig || stxn.sig.length !== 64) {
        return {
          valid: false,
          error: `Transaction ${i} does not contain a single Ed25519 signature`,
        };
      }

      // CONTENT-BIND: returned unsigned txn bytes must byte-equal the requested
      // unsigned txn. Defeats a signer that returns a validly-signed DIFFERENT
      // transaction (e.g. an attacker's rekey or payment).
      const returnedUnsignedBytes = algosdk.encodeUnsignedTransaction(stxn.txn);
      if (!bytesEqual(returnedUnsignedBytes, requestedUnsignedBytes)) {
        return {
          valid: false,
          error: `Signed transaction ${i} does not match the requested transaction (content mismatch)`,
        };
      }

      // Resolve the NETWORK-CORRECT expected signer from the DECODED sender.
      const sender = stxn.txn.sender.toString();
      let expected: string;
      try {
        expected = await deps.resolveExpectedSigner(sender);
      } catch (err) {
        const m = err instanceof Error ? err.message : 'lookup error';
        return {
          valid: false,
          error: `Failed to resolve expected signer for ${sender}: ${m}`,
        };
      }
      if (typeof expected !== 'string' || expected.length === 0) {
        return {
          valid: false,
          error: `Could not resolve an expected signer for ${sender}`,
        };
      }

      // FAIL CLOSED: the resolved signer must be a paired remote signer.
      if (!deps.isPairedRemoteSigner(expected)) {
        return {
          valid: false,
          error: `Expected signer ${expected} for transaction ${i} is not a paired remote signer`,
        };
      }

      // Verify the Ed25519 signature against the pubkey DERIVED from the
      // expected signer's address (never from the wire).
      let expectedPub: Uint8Array;
      try {
        expectedPub = algosdk.decodeAddress(expected).publicKey;
      } catch {
        return {
          valid: false,
          error: `Expected signer ${expected} is not a valid address`,
        };
      }
      const sigOk = verifyEd25519Signature(
        stxn.txn.bytesToSign(),
        stxn.sig,
        expectedPub
      );
      if (!sigOk) {
        return {
          valid: false,
          error: `Signature for transaction ${i} does not verify against expected signer ${expected}`,
        };
      }

      // sgnr (auth-address) consistency: required and matching when the signer
      // differs from the sender (rekeyed); when present it must equal expected.
      const sgnr = stxn.sgnr ? stxn.sgnr.toString() : undefined;
      if (sgnr !== undefined) {
        if (sgnr !== expected) {
          return {
            valid: false,
            error: `Signed transaction ${i} sgnr ${sgnr} does not match expected signer ${expected}`,
          };
        }
      } else if (expected !== sender) {
        return {
          valid: false,
          error: `Signed transaction ${i} is missing the required sgnr auth-address for rekeyed signer ${expected}`,
        };
      }
    }

    return { valid: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return {
      valid: false,
      error: `Remote signer response verification error: ${message}`,
    };
  }
}
