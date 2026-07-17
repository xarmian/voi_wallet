/**
 * Unit tests for the GENERAL remote-signer signed-response verifier (DR-6 /
 * TASK-143). These are Layer-1 pure tests: they build REAL algosdk transactions
 * and REAL Ed25519 signatures in-process, then drive
 * `verifyRemoteSignerResponse` with an injected (mock) network-scoped auth
 * lookup + paired-signer predicate so the suite stays pure.
 *
 * Coverage mirrors the acceptance criteria:
 *  - ACCEPTS a correctly-signed response that content-matches the request
 *  - REJECTS a validly-signed but DIFFERENT transaction (content-binding)
 *  - REJECTS a wrong-key signature
 *  - REJECTS bad envelopes (wrong count, dup/gap/non-integer index, msig/lsig,
 *    undecodable blob)
 *  - REKEYED account: expected signer = auth address (sgnr) verifies; a
 *    mismatched / missing sgnr rejects
 *  - FAIL CLOSED when the resolved signer is not a paired remote signer
 */

import algosdk from 'algosdk';
import nacl from 'tweetnacl';

import {
  verifyRemoteSignerResponse,
  RemoteSignerResponseVerificationDeps,
} from '../signatureVerification';

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

interface TestAccount {
  addr: string;
  sk: Uint8Array; // 64-byte ed25519 secret key (nacl / algosdk compatible)
}

/** Deterministic account from a fixed 32-byte seed (reproducible addresses). */
function seededAccount(seedByte: number): TestAccount {
  const seed = new Uint8Array(32).fill(seedByte);
  const kp = nacl.sign.keyPair.fromSeed(seed);
  return { addr: algosdk.encodeAddress(kp.publicKey), sk: kp.secretKey };
}

const GENESIS_HASH = new Uint8Array(32).fill(42);

function suggestedParams(): algosdk.SuggestedParams {
  return {
    fee: 1000,
    minFee: 1000,
    firstValid: 1000,
    lastValid: 2000,
    genesisID: 'voi-test-v1',
    genesisHash: GENESIS_HASH,
    flatFee: true,
  };
}

function payment(
  sender: string,
  receiver: string,
  amount: number
): algosdk.Transaction {
  return algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender,
    receiver,
    amount,
    suggestedParams: suggestedParams(),
  });
}

const b64 = (u: Uint8Array): string => Buffer.from(u).toString('base64');

function encodeUnsignedB64(txn: algosdk.Transaction): string {
  return b64(algosdk.encodeUnsignedTransaction(txn));
}

/** Minimal request shape the verifier consumes (`Pick<..., 'txns'>`). */
function buildRequest(txns: algosdk.Transaction[]) {
  return {
    txns: txns.map((t, i) => ({
      i,
      b: encodeUnsignedB64(t),
      s: t.sender.toString(),
    })),
  };
}

/** Minimal success response shape (`Pick<..., 'ok' | 'sigs'>`). */
function buildResponse(blobs: Uint8Array[]) {
  return {
    ok: true as const,
    sigs: blobs.map((blob, i) => ({ i, b: b64(blob) })),
  };
}

/** A deps object where `paired` are paired remote signers and `authMap` maps a
 * (rekeyed) sender to its network-correct auth address. */
function makeDeps(
  paired: string[],
  authMap: Record<string, string> = {}
): RemoteSignerResponseVerificationDeps {
  const pairedSet = new Set(paired);
  return {
    resolveExpectedSigner: (sender: string) => authMap[sender] ?? sender,
    isPairedRemoteSigner: (address: string) => pairedSet.has(address),
  };
}

// Shared accounts
const X = seededAccount(1); // paired remote signer (self-signing)
const Y = seededAccount(8); // receiver
const R = seededAccount(2); // rekeyed account (sender)
const A = seededAccount(3); // auth address / paired remote signer
const B = seededAccount(4); // a different auth address
const W = seededAccount(9); // a wrong key

// ---------------------------------------------------------------------------
// Happy paths
// ---------------------------------------------------------------------------

describe('verifyRemoteSignerResponse — accepts valid responses', () => {
  it('accepts a correctly-signed response that content-matches the request', async () => {
    const txn = payment(X.addr, Y.addr, 1000);
    const request = buildRequest([txn]);
    const response = buildResponse([txn.signTxn(X.sk)]);

    const result = await verifyRemoteSignerResponse(
      request,
      response,
      makeDeps([X.addr])
    );
    expect(result.valid).toBe(true);
  });

  it('accepts a single-signer group (multiple txns, same paired signer)', async () => {
    const t0 = payment(X.addr, Y.addr, 1000);
    const t1 = payment(X.addr, Y.addr, 2000);
    const request = buildRequest([t0, t1]);
    const response = buildResponse([t0.signTxn(X.sk), t1.signTxn(X.sk)]);

    const result = await verifyRemoteSignerResponse(
      request,
      response,
      makeDeps([X.addr])
    );
    expect(result.valid).toBe(true);
  });

  it('accepts a rekeyed account signed by its auth address (sgnr = auth)', async () => {
    const txn = payment(R.addr, Y.addr, 1000);
    const request = buildRequest([txn]);
    // Signed by A (the auth key); algosdk sets sgnr = A because A !== sender R.
    const response = buildResponse([txn.signTxn(A.sk)]);

    const result = await verifyRemoteSignerResponse(
      request,
      response,
      makeDeps([A.addr], { [R.addr]: A.addr })
    );
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Content-binding
// ---------------------------------------------------------------------------

describe('verifyRemoteSignerResponse — content-binding', () => {
  it('rejects a validly-signed but DIFFERENT transaction', async () => {
    const requested = payment(X.addr, Y.addr, 1000);
    const different = payment(X.addr, Y.addr, 999999); // attacker-substituted
    const request = buildRequest([requested]);
    // A perfectly valid signature by X — but over the wrong transaction.
    const response = buildResponse([different.signTxn(X.sk)]);

    const result = await verifyRemoteSignerResponse(
      request,
      response,
      makeDeps([X.addr])
    );
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/content mismatch/i);
  });

  it('rejects a substituted rekey transaction (different receiver)', async () => {
    const requested = payment(X.addr, Y.addr, 1000);
    const attacker = seededAccount(99);
    const different = payment(X.addr, attacker.addr, 1000);
    const request = buildRequest([requested]);
    const response = buildResponse([different.signTxn(X.sk)]);

    const result = await verifyRemoteSignerResponse(
      request,
      response,
      makeDeps([X.addr])
    );
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/content mismatch/i);
  });
});

// ---------------------------------------------------------------------------
// Signature / signer identity
// ---------------------------------------------------------------------------

describe('verifyRemoteSignerResponse — signer identity', () => {
  it('rejects a wrong-key signature', async () => {
    const txn = payment(X.addr, Y.addr, 1000);
    const request = buildRequest([txn]);
    // Signed by W, not by the expected signer X.
    const response = buildResponse([txn.signTxn(W.sk)]);

    const result = await verifyRemoteSignerResponse(
      request,
      response,
      makeDeps([X.addr])
    );
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/does not verify/i);
  });

  it('fails closed when the resolved signer is not a paired remote signer', async () => {
    const txn = payment(X.addr, Y.addr, 1000);
    const request = buildRequest([txn]);
    const response = buildResponse([txn.signTxn(X.sk)]);

    // No paired remote signers at all.
    const result = await verifyRemoteSignerResponse(
      request,
      response,
      makeDeps([])
    );
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/not a paired remote signer/i);
  });

  it('fails closed for a mixed group where one sender is not a paired signer', async () => {
    const other = seededAccount(7);
    const t0 = payment(X.addr, Y.addr, 1000);
    const t1 = payment(other.addr, Y.addr, 1000);
    const request = buildRequest([t0, t1]);
    const response = buildResponse([t0.signTxn(X.sk), t1.signTxn(other.sk)]);

    // Only X is paired; `other` is not.
    const result = await verifyRemoteSignerResponse(
      request,
      response,
      makeDeps([X.addr])
    );
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/not a paired remote signer/i);
  });
});

// ---------------------------------------------------------------------------
// sgnr (auth-address) consistency for rekeyed signing
// ---------------------------------------------------------------------------

describe('verifyRemoteSignerResponse — sgnr consistency', () => {
  it('rejects a rekeyed txn whose sgnr does not match the expected auth address', async () => {
    const txn = payment(R.addr, Y.addr, 1000);
    const request = buildRequest([txn]);
    // Craft a blob with a VALID signature by A but sgnr set to B (B !== A).
    const validSigByA = txn.rawSignTxn(A.sk);
    const tamperedBlob = txn.attachSignature(B.addr, validSigByA);
    const response = buildResponse([tamperedBlob]);

    const result = await verifyRemoteSignerResponse(
      request,
      response,
      makeDeps([A.addr], { [R.addr]: A.addr })
    );
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/sgnr/i);
  });

  it('rejects a rekeyed txn missing the required sgnr auth-address', async () => {
    const txn = payment(R.addr, Y.addr, 1000);
    const request = buildRequest([txn]);
    // Valid signature by A, but attach with signerAddr === sender R so NO sgnr
    // is written (signer differs from expected auth, yet sgnr is absent).
    const validSigByA = txn.rawSignTxn(A.sk);
    const noSgnrBlob = txn.attachSignature(R.addr, validSigByA);
    const response = buildResponse([noSgnrBlob]);

    const result = await verifyRemoteSignerResponse(
      request,
      response,
      makeDeps([A.addr], { [R.addr]: A.addr })
    );
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/sgnr/i);
  });
});

// ---------------------------------------------------------------------------
// Envelope rejections (defence-in-depth in the verifier itself)
// ---------------------------------------------------------------------------

describe('verifyRemoteSignerResponse — envelope rejections', () => {
  it('rejects a signature count that does not match the transaction count', async () => {
    const txn = payment(X.addr, Y.addr, 1000);
    const request = buildRequest([txn]);
    const response = {
      ok: true as const,
      sigs: [
        { i: 0, b: b64(txn.signTxn(X.sk)) },
        { i: 1, b: b64(txn.signTxn(X.sk)) },
      ],
    };

    const result = await verifyRemoteSignerResponse(
      request,
      response,
      makeDeps([X.addr])
    );
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/count/i);
  });

  it('rejects a duplicate signature index', async () => {
    const t0 = payment(X.addr, Y.addr, 1000);
    const t1 = payment(X.addr, Y.addr, 2000);
    const request = buildRequest([t0, t1]);
    const response = {
      ok: true as const,
      sigs: [
        { i: 0, b: b64(t0.signTxn(X.sk)) },
        { i: 0, b: b64(t0.signTxn(X.sk)) }, // dup index, missing index 1
      ],
    };

    const result = await verifyRemoteSignerResponse(
      request,
      response,
      makeDeps([X.addr])
    );
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/duplicate/i);
  });

  it('rejects an out-of-range / gap index (non-permutation)', async () => {
    const t0 = payment(X.addr, Y.addr, 1000);
    const t1 = payment(X.addr, Y.addr, 2000);
    const request = buildRequest([t0, t1]);
    const response = {
      ok: true as const,
      sigs: [
        { i: 0, b: b64(t0.signTxn(X.sk)) },
        { i: 5, b: b64(t1.signTxn(X.sk)) }, // out of 0..1 range
      ],
    };

    const result = await verifyRemoteSignerResponse(
      request,
      response,
      makeDeps([X.addr])
    );
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/out of range|integer/i);
  });

  it('rejects a non-integer index', async () => {
    const txn = payment(X.addr, Y.addr, 1000);
    const request = buildRequest([txn]);
    const response = {
      ok: true as const,
      sigs: [{ i: 0.5, b: b64(txn.signTxn(X.sk)) }],
    };

    const result = await verifyRemoteSignerResponse(
      request,
      response,
      makeDeps([X.addr])
    );
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/out of range|integer/i);
  });

  it('rejects a multisig-signed blob (single Ed25519 sig only)', async () => {
    const msigParams: algosdk.MultisigMetadata = {
      version: 1,
      threshold: 1,
      addrs: [X.addr],
    };
    const msigAddr = algosdk.multisigAddress(msigParams).toString();
    const txn = payment(msigAddr, Y.addr, 1000);
    const { blob } = algosdk.signMultisigTransaction(txn, msigParams, X.sk);
    const request = buildRequest([txn]);
    const response = buildResponse([blob]);

    const result = await verifyRemoteSignerResponse(
      request,
      response,
      makeDeps([msigAddr])
    );
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/multisig|logicsig/i);
  });

  it('rejects an undecodable / non-transaction blob', async () => {
    const txn = payment(X.addr, Y.addr, 1000);
    const request = buildRequest([txn]);
    const response = {
      ok: true as const,
      sigs: [{ i: 0, b: b64(new Uint8Array([1, 2, 3, 4, 5])) }],
    };

    const result = await verifyRemoteSignerResponse(
      request,
      response,
      makeDeps([X.addr])
    );
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/decode/i);
  });

  it('rejects a non-success response', async () => {
    const txn = payment(X.addr, Y.addr, 1000);
    const request = buildRequest([txn]);
    const result = await verifyRemoteSignerResponse(
      request,
      { ok: false, sigs: undefined },
      makeDeps([X.addr])
    );
    expect(result.valid).toBe(false);
  });
});
