/**
 * Unit tests for src/utils/signatureVerification.ts
 *
 * These tests generate REAL cryptographic vectors in-process:
 *   - create an algosdk account,
 *   - build + sign an Algorand transaction,
 *   - assert the verify* helpers return the SPECIFICATION-correct result,
 *   - then tamper the signature / bytes and assert rejection.
 *
 * Expected values are computed independently (via tweetnacl / algosdk) from the
 * INTENDED behaviour rather than read back from the function under test, so a
 * regression in the signing surface fails the suite instead of being codified.
 */

import algosdk from 'algosdk';
import nacl from 'tweetnacl';

import {
  verifySignedTransaction,
  extractTransactionComponents,
  verifyEd25519Signature,
  verifySignedTransactionBytes,
} from '../signatureVerification';

// Deterministic-enough suggested params. genesisHash is 32 zero bytes; we never
// submit these transactions so the network identity is irrelevant to signing.
const SUGGESTED_PARAMS = {
  fee: 1000,
  firstValid: 1,
  lastValid: 1001,
  genesisID: 'voi-test-v1',
  genesisHash: new Uint8Array(32),
  flatFee: true,
  minFee: 1000,
};

type Account = ReturnType<typeof algosdk.generateAccount>;

const addrOf = (acct: Account): string => acct.addr.toString();

function makePayment(
  sender: string,
  overrides: Record<string, unknown> = {}
): algosdk.Transaction {
  return algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender,
    receiver: sender,
    amount: 0,
    suggestedParams: SUGGESTED_PARAMS as algosdk.SuggestedParams,
    ...overrides,
  } as Parameters<
    typeof algosdk.makePaymentTxnWithSuggestedParamsFromObject
  >[0]);
}

/** Build a real, self-signed self-payment and its encodings. */
function signSelfPayment(overrides: Record<string, unknown> = {}) {
  const acct = algosdk.generateAccount();
  const address = addrOf(acct);
  const txn = makePayment(address, overrides);
  const signedBytes = txn.signTxn(acct.sk); // Uint8Array
  const signedBase64 = Buffer.from(signedBytes).toString('base64');
  return { acct, address, txn, signedBytes, signedBase64 };
}

/** Locate a msgpack marker (hex) and return the byte offset of the byte AFTER it. */
function offsetAfterMarker(bytes: Uint8Array, markerHex: string): number {
  const hex = Buffer.from(bytes).toString('hex');
  const idx = hex.indexOf(markerHex);
  if (idx === -1) throw new Error(`marker ${markerHex} not found`);
  return idx / 2 + markerHex.length / 2;
}

// msgpack keys: "sig" -> a3 73 69 67, value bin8(64) -> c4 40
const SIG_MARKER = 'a3736967c440';
// msgpack key "note" -> a4 6e6f7465, value bin8(4) -> c4 04
const NOTE_MARKER = 'a46e6f7465c404';

describe('verifySignedTransaction', () => {
  it('accepts a genuinely self-signed self-payment (happy path)', () => {
    const { address, signedBytes, signedBase64 } = signSelfPayment();

    // Independently prove the vector really is valid before trusting the assert.
    const decoded = algosdk.decodeSignedTransaction(signedBytes);
    const pk = algosdk.decodeAddress(address).publicKey;
    expect(
      nacl.sign.detached.verify(decoded.txn.bytesToSign(), decoded.sig!, pk)
    ).toBe(true);

    const result = verifySignedTransaction(signedBase64, address);
    expect(result).toEqual({ valid: true });
    expect(result.error).toBeUndefined();
  });

  it('rejects when the expected signer is a DIFFERENT valid address', () => {
    const { signedBase64 } = signSelfPayment();
    const other = addrOf(algosdk.generateAccount());

    const result = verifySignedTransaction(signedBase64, other);

    expect(result.valid).toBe(false);
    // Sender-mismatch is detected before the crypto step.
    expect(result.error).toMatch(/does not match expected signer/i);
  });

  it('rejects a signature produced by the wrong key (sender still matches)', () => {
    // sender = A, but the blob carries a signature made with B's secret key.
    const a = algosdk.generateAccount();
    const b = algosdk.generateAccount();
    const address = addrOf(a);
    const txn = makePayment(address);
    const foreignSigned = txn.signTxn(b.sk);

    // Sanity: sender is A, but the Ed25519 sig does NOT verify under A's key.
    const decoded = algosdk.decodeSignedTransaction(foreignSigned);
    expect(decoded.txn.sender.toString()).toBe(address);
    const pkA = algosdk.decodeAddress(address).publicKey;
    expect(
      nacl.sign.detached.verify(decoded.txn.bytesToSign(), decoded.sig!, pkA)
    ).toBe(false);

    const result = verifySignedTransaction(
      Buffer.from(foreignSigned).toString('base64'),
      address
    );
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/Signature verification failed/i);
  });

  it('rejects a bit-flipped signature (corrupted sig bytes)', () => {
    const { address, signedBytes } = signSelfPayment();
    const tampered = new Uint8Array(signedBytes);
    const sigOffset = offsetAfterMarker(tampered, SIG_MARKER);
    tampered[sigOffset] ^= 0xff; // corrupt the first signature byte

    // Still decodes with the same sender, but the sig no longer verifies.
    const decoded = algosdk.decodeSignedTransaction(tampered);
    expect(decoded.txn.sender.toString()).toBe(address);
    const pk = algosdk.decodeAddress(address).publicKey;
    expect(
      nacl.sign.detached.verify(decoded.txn.bytesToSign(), decoded.sig!, pk)
    ).toBe(false);

    const result = verifySignedTransaction(
      Buffer.from(tampered).toString('base64'),
      address
    );
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/Signature verification failed/i);
  });

  it('rejects a tampered transaction body (note mutated after signing)', () => {
    // Note is arbitrary data, so flipping a byte keeps the blob decodable while
    // changing bytesToSign -> the original signature no longer matches.
    const { address, signedBytes } = signSelfPayment({
      note: new Uint8Array([9, 9, 9, 9]),
    });
    const tampered = new Uint8Array(signedBytes);
    const noteOffset = offsetAfterMarker(tampered, NOTE_MARKER);
    tampered[noteOffset] ^= 0xff;

    const result = verifySignedTransaction(
      Buffer.from(tampered).toString('base64'),
      address
    );
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/Signature verification failed/i);
  });

  it('rejects a transaction that contains a rekey field (security guard)', () => {
    // Even a correctly self-signed txn must be rejected if it rekeys the account.
    const acct = algosdk.generateAccount();
    const address = addrOf(acct);
    const rekeyTarget = addrOf(algosdk.generateAccount());
    const txn = makePayment(address, { rekeyTo: rekeyTarget });
    const signedBytes = txn.signTxn(acct.sk);

    // The signature itself is perfectly valid — rejection is policy, not crypto.
    const decoded = algosdk.decodeSignedTransaction(signedBytes);
    const pk = algosdk.decodeAddress(address).publicKey;
    expect(
      nacl.sign.detached.verify(decoded.txn.bytesToSign(), decoded.sig!, pk)
    ).toBe(true);

    const result = verifySignedTransaction(
      Buffer.from(signedBytes).toString('base64'),
      address
    );
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/rekey/i);
  });

  it('rejects a multisig-signed transaction (no standard sig present)', () => {
    const a1 = algosdk.generateAccount();
    const a2 = algosdk.generateAccount();
    const mparams = {
      version: 1,
      threshold: 1,
      addrs: [addrOf(a1), addrOf(a2)],
    };
    const msigAddress = algosdk.multisigAddress(mparams).toString();
    const txn = makePayment(msigAddress);
    const { blob } = algosdk.signMultisigTransaction(txn, mparams, a1.sk);

    // Confirm the blob carries msig, not a plain sig.
    const decoded = algosdk.decodeSignedTransaction(blob);
    expect(decoded.sig).toBeUndefined();

    const result = verifySignedTransaction(
      Buffer.from(blob).toString('base64'),
      msigAddress
    );
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/does not contain a standard signature/i);
  });

  it('rejects malformed / non-decodable base64 input', () => {
    const address = addrOf(algosdk.generateAccount());
    const result = verifySignedTransaction('AAAA', address);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/Failed to verify signature/i);
  });

  it('rejects an empty string input', () => {
    const address = addrOf(algosdk.generateAccount());
    const result = verifySignedTransaction('', address);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/Failed to verify signature/i);
  });

  it('rejects a non-canonical (lowercased) expected address', () => {
    // The sender comparison is case-insensitive, but decodeAddress requires the
    // canonical uppercase base32, so a lowercased address is ultimately rejected.
    const { address, signedBase64 } = signSelfPayment();
    const result = verifySignedTransaction(signedBase64, address.toLowerCase());
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });

  // KNOWN GAP (flagged for human security review — signing path): the function's
  // inline docs say this verification flow expects a SELF-payment (sender ===
  // receiver === expectedSignerAddress) to prove the airgap device controls the
  // address, but the code only checks the sender. A payment A->B signed by A
  // (expected signer A) is currently ACCEPTED. it.failing asserts the CORRECT
  // per-doc behavior (reject non-self-payments) — it passes while the gap exists
  // and flips red once a receiver===sender check is added. Whether to enforce
  // the stricter invariant is a human security decision.
  it.failing('rejects a non-self-payment (self-payment invariant)', () => {
    const a = algosdk.generateAccount();
    const b = algosdk.generateAccount();
    const senderAddr = addrOf(a);
    const txn = makePayment(senderAddr, { receiver: addrOf(b), amount: 1000 });
    const signedBytes = txn.signTxn(a.sk);

    const result = verifySignedTransaction(
      Buffer.from(signedBytes).toString('base64'),
      senderAddr
    );
    expect(result.valid).toBe(false);
  });
});

describe('extractTransactionComponents', () => {
  it('extracts self-consistent components from a valid signed txn', () => {
    const { address, signedBytes } = signSelfPayment();

    const components = extractTransactionComponents(signedBytes);
    expect(components).not.toBeNull();

    // Compute the expected values independently from the decoded transaction.
    const decoded = algosdk.decodeSignedTransaction(signedBytes);
    const expectedTxnBytes = decoded.txn.bytesToSign();
    const expectedPublicKey = algosdk.decodeAddress(address).publicKey;

    expect(components!.signerAddress).toBe(address);
    expect(Array.from(components!.signerPublicKey)).toEqual(
      Array.from(expectedPublicKey)
    );
    expect(Array.from(components!.signature)).toEqual(Array.from(decoded.sig!));
    expect(Array.from(components!.txnBytes)).toEqual(
      Array.from(expectedTxnBytes)
    );

    // The signed bytes carry the "TX" domain-separation prefix.
    expect(components!.txnBytes[0]).toBe(0x54); // 'T'
    expect(components!.txnBytes[1]).toBe(0x58); // 'X'

    // The extracted components must verify against each other.
    expect(
      nacl.sign.detached.verify(
        components!.txnBytes,
        components!.signature,
        components!.signerPublicKey
      )
    ).toBe(true);
  });

  it('returns null for a multisig transaction (no standard sig)', () => {
    const a1 = algosdk.generateAccount();
    const a2 = algosdk.generateAccount();
    const mparams = {
      version: 1,
      threshold: 1,
      addrs: [addrOf(a1), addrOf(a2)],
    };
    const msigAddress = algosdk.multisigAddress(mparams).toString();
    const txn = makePayment(msigAddress);
    const { blob } = algosdk.signMultisigTransaction(txn, mparams, a1.sk);

    expect(extractTransactionComponents(blob)).toBeNull();
  });

  it('returns null for garbage bytes', () => {
    expect(
      extractTransactionComponents(new Uint8Array([1, 2, 3, 4]))
    ).toBeNull();
    expect(extractTransactionComponents(new Uint8Array(0))).toBeNull();
  });
});

describe('verifyEd25519Signature', () => {
  it('returns true for a real signature over the signed message', () => {
    const kp = nacl.sign.keyPair();
    const message = new Uint8Array(Buffer.from('voi verification message'));
    const signature = nacl.sign.detached(message, kp.secretKey);

    expect(verifyEd25519Signature(message, signature, kp.publicKey)).toBe(true);
  });

  it('returns false when the message is tampered', () => {
    const kp = nacl.sign.keyPair();
    const message = new Uint8Array(Buffer.from('original'));
    const signature = nacl.sign.detached(message, kp.secretKey);
    const tampered = new Uint8Array(message);
    tampered[0] ^= 0xff;

    expect(verifyEd25519Signature(tampered, signature, kp.publicKey)).toBe(
      false
    );
  });

  it('returns false when verified against the wrong public key', () => {
    const kp = nacl.sign.keyPair();
    const other = nacl.sign.keyPair();
    const message = new Uint8Array(Buffer.from('hello'));
    const signature = nacl.sign.detached(message, kp.secretKey);

    expect(verifyEd25519Signature(message, signature, other.publicKey)).toBe(
      false
    );
  });

  it('returns false when the signature is corrupted', () => {
    const kp = nacl.sign.keyPair();
    const message = new Uint8Array(Buffer.from('hello'));
    const signature = nacl.sign.detached(message, kp.secretKey);
    const corrupted = new Uint8Array(signature);
    corrupted[0] ^= 0xff;

    expect(verifyEd25519Signature(message, corrupted, kp.publicKey)).toBe(
      false
    );
  });

  it('returns false (does not throw) for malformed key/signature lengths', () => {
    const kp = nacl.sign.keyPair();
    const message = new Uint8Array(Buffer.from('hello'));
    const signature = nacl.sign.detached(message, kp.secretKey);

    // Wrong signature length.
    expect(
      verifyEd25519Signature(message, signature.slice(0, 32), kp.publicKey)
    ).toBe(false);
    // Wrong public key length.
    expect(
      verifyEd25519Signature(message, signature, kp.publicKey.slice(0, 16))
    ).toBe(false);
    // Empty inputs.
    expect(
      verifyEd25519Signature(
        new Uint8Array(0),
        new Uint8Array(0),
        new Uint8Array(0)
      )
    ).toBe(false);
  });
});

describe('verifySignedTransactionBytes', () => {
  it('accepts valid signed bytes and matches the base64 entrypoint', () => {
    const { address, signedBytes, signedBase64 } = signSelfPayment();

    const fromBytes = verifySignedTransactionBytes(signedBytes, address);
    expect(fromBytes).toEqual({ valid: true });

    // Must be exactly equivalent to feeding the base64 form to the other fn.
    expect(fromBytes).toEqual(verifySignedTransaction(signedBase64, address));
  });

  it('rejects tampered signed bytes', () => {
    const { address, signedBytes } = signSelfPayment();
    const tampered = new Uint8Array(signedBytes);
    const sigOffset = offsetAfterMarker(tampered, SIG_MARKER);
    tampered[sigOffset] ^= 0xff;

    const result = verifySignedTransactionBytes(tampered, address);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/Signature verification failed/i);
  });

  it('rejects empty bytes', () => {
    const address = addrOf(algosdk.generateAccount());
    const result = verifySignedTransactionBytes(new Uint8Array(0), address);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/Failed to verify signature/i);
  });
});
