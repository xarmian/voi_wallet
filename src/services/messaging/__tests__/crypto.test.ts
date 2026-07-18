/**
 * P0 unit tests for the messaging crypto core (`src/services/messaging/crypto.ts`).
 *
 * Scope (TASK-158):
 *   - Ed25519 <-> Curve25519 conversion vectors
 *   - v1 (nacl.box) encrypt -> decrypt round-trip equality
 *   - v2 (ephemeral X25519 + secretbox) encrypt -> decrypt round-trip equality
 *   - tampered-ciphertext / tampered-nonce rejection (both versions)
 *   - wrong-sender verification failure + wrong-recipient decryption failure
 *
 * SECURITY / DR-3 (non-negotiable): every key here is REAL crypto. Accounts come
 * from the shared algosdk fixtures (`makeAccount`), which derive real Ed25519
 * keypairs from a 25-word mnemonic — there is NO fabricated/mocked key material
 * and no fake signature anywhere. The recipient's v2 X25519 messaging keypair is
 * produced by the production derivation (`deriveMessagingKeyPairFromSecret`), so
 * the encrypt/decrypt path is exercised end-to-end with genuine curve points.
 * As a rule these tests never log `sk`/`mnemonic`/`secretKey` bytes.
 *
 * This suite is TEST-ONLY: it does not (and must not) modify crypto.ts. If a case
 * ever shows a real crypto bug (tampered ciphertext accepted, wrong sender passing
 * verification), it is marked `it.failing` and reported rather than "fixed" here.
 */

import { randomBytes } from 'crypto';

import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64 } from 'tweetnacl-util';
import * as ed2curve from 'ed2curve';

import {
  ed25519SecretToCurve25519,
  ed25519PublicToCurve25519,
  extractPublicKeyFromSecret,
  getPublicKeyFromAddress,
  generateNonce,
  encryptMessage,
  decryptMessage,
  createMessageNote,
  parseMessageNote,
  parseMessageNoteAny,
  verifySender,
  encryptMessageV2,
  decryptMessageV2,
  createMessageNoteV2,
} from '../crypto';
import { deriveMessagingKeyPairFromSecret } from '../keyDerivation';
import {
  EncryptedMessagePayload,
  EncryptedMessagePayloadV2,
  MAX_MESSAGE_LENGTH,
  MESSAGE_NOTE_PREFIX,
} from '../types';
import { AppLockSignal } from '@/services/secure/appLockState';
import { crypto as platformCrypto } from '@/platform';
import { makeAccount } from '@/__tests__/fixtures/algorand';

// The jest-expo `expo-crypto` mock hands back ZERO-filled buffers, which would
// make every nonce identical and defeat the fresh-nonce assertions. Supply REAL
// randomness from Node's core `crypto` instead — this only replaces the entropy
// source; all keys/ciphertext are still produced by genuine tweetnacl (DR-3).
beforeAll(() => {
  jest
    .spyOn(platformCrypto, 'getRandomBytes')
    .mockImplementation(async (n: number) => new Uint8Array(randomBytes(n)));
});

afterAll(() => {
  jest.restoreAllMocks();
});

// Deterministic, real Ed25519 accounts (algosdk-derived; Pera-compatible).
const alice = makeAccount('msg-crypto-alice');
const bob = makeAccount('msg-crypto-bob');
const mallory = makeAccount('msg-crypto-mallory');

/** Flip one bit of a base64-encoded byte string and re-encode it. */
function tamperBase64(value: string, byteIndex = 0): string {
  const bytes = decodeBase64(value);
  bytes[byteIndex] ^= 0x01;
  return encodeBase64(bytes);
}

describe('messaging crypto: Ed25519 <-> Curve25519 conversion', () => {
  it('converts a 64-byte Ed25519 secret to a 32-byte Curve25519 secret', () => {
    const curveSecret = ed25519SecretToCurve25519(alice.sk);

    expect(curveSecret).toBeInstanceOf(Uint8Array);
    expect(curveSecret.length).toBe(32);
    // A real conversion is not the all-zero key.
    expect(curveSecret.some((b) => b !== 0)).toBe(true);
  });

  it('converts a 32-byte Ed25519 public to a 32-byte Curve25519 public', () => {
    const curvePublic = ed25519PublicToCurve25519(alice.pk);

    expect(curvePublic).toBeInstanceOf(Uint8Array);
    expect(curvePublic.length).toBe(32);
    expect(curvePublic.some((b) => b !== 0)).toBe(true);
  });

  it('is deterministic: same input -> identical converted key', () => {
    expect(Array.from(ed25519SecretToCurve25519(alice.sk))).toEqual(
      Array.from(ed25519SecretToCurve25519(alice.sk))
    );
    expect(Array.from(ed25519PublicToCurve25519(alice.pk))).toEqual(
      Array.from(ed25519PublicToCurve25519(alice.pk))
    );
  });

  it('is internally consistent: base(convertSecret(sk)) === convertPublic(pk)', () => {
    // The defining correctness vector for the two conversions: the Curve25519
    // public point derived from the converted secret key must equal the directly
    // converted Ed25519 public key. If either conversion were wrong, box() /
    // box.open() between two parties could not agree on a shared secret.
    const curveSecret = ed25519SecretToCurve25519(alice.sk);
    const derivedCurvePublic = nacl.scalarMult.base(curveSecret);
    const convertedCurvePublic = ed25519PublicToCurve25519(alice.pk);

    expect(Array.from(derivedCurvePublic)).toEqual(
      Array.from(convertedCurvePublic)
    );
  });

  it('matches the reference ed2curve implementation exactly', () => {
    // Cross-check against ed2curve directly (the library crypto.ts wraps), so a
    // silent swap of the conversion under the hood would fail here.
    expect(Array.from(ed25519SecretToCurve25519(bob.sk))).toEqual(
      Array.from(ed2curve.convertSecretKey(bob.sk) as Uint8Array)
    );
    expect(Array.from(ed25519PublicToCurve25519(bob.pk))).toEqual(
      Array.from(ed2curve.convertPublicKey(bob.pk) as Uint8Array)
    );
  });

  it('rejects a wrong-length Ed25519 secret key', () => {
    expect(() => ed25519SecretToCurve25519(new Uint8Array(32))).toThrow(
      /expected 64 bytes/
    );
    expect(() => ed25519SecretToCurve25519(new Uint8Array(65))).toThrow(
      /expected 64 bytes/
    );
  });

  it('rejects a wrong-length Ed25519 public key', () => {
    expect(() => ed25519PublicToCurve25519(new Uint8Array(31))).toThrow(
      /expected 32 bytes/
    );
    expect(() => ed25519PublicToCurve25519(new Uint8Array(64))).toThrow(
      /expected 32 bytes/
    );
  });
});

describe('messaging crypto: key/address helpers', () => {
  it('extracts the trailing 32-byte public key from a 64-byte secret', () => {
    const pk = extractPublicKeyFromSecret(alice.sk);
    expect(pk.length).toBe(32);
    expect(Array.from(pk)).toEqual(Array.from(alice.sk.slice(32)));
    expect(Array.from(pk)).toEqual(Array.from(alice.pk));
  });

  it('rejects a wrong-length secret in extractPublicKeyFromSecret', () => {
    expect(() => extractPublicKeyFromSecret(new Uint8Array(32))).toThrow(
      /expected 64 bytes/
    );
  });

  it('derives the Ed25519 public key from an address (== algosdk pk)', () => {
    expect(Array.from(getPublicKeyFromAddress(alice.addr))).toEqual(
      Array.from(alice.pk)
    );
  });

  it('generates a fresh 24-byte nonce each call', async () => {
    const a = await generateNonce();
    const b = await generateNonce();
    expect(a.length).toBe(nacl.box.nonceLength);
    expect(a.length).toBe(24);
    // Two random nonces must not collide (probability ~2^-192 otherwise).
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });
});

describe('messaging crypto v1: encrypt -> decrypt round-trip', () => {
  it('round-trips plaintext (Alice -> Bob)', async () => {
    const plaintext = 'hello bob, this is alice';
    const payload = await encryptMessage(plaintext, alice.sk, bob.addr);

    expect(decryptMessage(payload, bob.sk)).toBe(plaintext);
  });

  it.each([
    ['empty string', ''],
    ['unicode + emoji', 'héllo 🌍 — Vøi ✅ 日本語'],
    ['whitespace only', '   \n\t  '],
    ['max length', 'x'.repeat(MAX_MESSAGE_LENGTH)],
  ])('round-trips %s', async (_label, plaintext) => {
    const payload = await encryptMessage(plaintext, alice.sk, bob.addr);
    expect(decryptMessage(payload, bob.sk)).toBe(plaintext);
  });

  it('embeds the sender public key and a 24-byte nonce', async () => {
    const payload = await encryptMessage('hi', alice.sk, bob.addr);

    expect(payload.senderPubKey).toBe(encodeBase64(alice.pk));
    expect(decodeBase64(payload.nonce).length).toBe(24);
    expect(typeof payload.timestamp).toBe('number');
    // Authenticated ciphertext carries the 16-byte poly1305 tag on top of the
    // 2-byte 'hi' plaintext.
    expect(decodeBase64(payload.ciphertext).length).toBe(2 + 16);
  });

  it('produces distinct ciphertext for identical plaintext (fresh nonce)', async () => {
    const a = await encryptMessage('same message', alice.sk, bob.addr);
    const b = await encryptMessage('same message', alice.sk, bob.addr);

    expect(a.nonce).not.toBe(b.nonce);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    // ...yet both decrypt to the same plaintext.
    expect(decryptMessage(a, bob.sk)).toBe('same message');
    expect(decryptMessage(b, bob.sk)).toBe('same message');
  });

  it('rejects a message longer than MAX_MESSAGE_LENGTH', async () => {
    await expect(
      encryptMessage('x'.repeat(MAX_MESSAGE_LENGTH + 1), alice.sk, bob.addr)
    ).rejects.toThrow(/too long/i);
  });

  it('round-trips through the ARC-2 note encoder/parser', async () => {
    const payload = await encryptMessage('note round-trip', alice.sk, bob.addr);
    const note = createMessageNote(payload);
    expect(note.startsWith(MESSAGE_NOTE_PREFIX)).toBe(true);

    // parseMessageNote reads a base64-encoded note (as it arrives from indexer).
    const noteBase64 = encodeBase64(new TextEncoder().encode(note));
    const parsed = parseMessageNote(noteBase64);
    expect(parsed).not.toBeNull();
    expect(decryptMessage(parsed as EncryptedMessagePayload, bob.sk)).toBe(
      'note round-trip'
    );
  });
});

describe('messaging crypto v1: tampered / wrong-key rejection', () => {
  let payload: EncryptedMessagePayload;

  beforeEach(async () => {
    payload = await encryptMessage('authenticated secret', alice.sk, bob.addr);
  });

  // Flip a byte in the Poly1305 tag (index 0) AND in the encrypted body
  // (index 16+, past the 16-byte tag) so a defect that checks the tag but not
  // the ciphertext body would still be caught.
  it.each([0, 20])('rejects a flipped ciphertext byte @%i', (i) => {
    const tampered = {
      ...payload,
      ciphertext: tamperBase64(payload.ciphertext, i),
    };
    expect(() => decryptMessage(tampered, bob.sk)).toThrow(
      /corrupted or tampered/
    );
  });

  it('rejects a flipped nonce byte', () => {
    const tampered = { ...payload, nonce: tamperBase64(payload.nonce) };
    expect(() => decryptMessage(tampered, bob.sk)).toThrow(
      /corrupted or tampered/
    );
  });

  it('rejects a swapped/forged sender public key', () => {
    // Attacker rewrites senderPubKey to Mallory's — the box MAC no longer
    // authenticates under that key, so decryption must fail (not silently
    // decrypt under the wrong identity).
    const forged = { ...payload, senderPubKey: encodeBase64(mallory.pk) };
    expect(() => decryptMessage(forged, bob.sk)).toThrow(
      /corrupted or tampered/
    );
  });

  it('rejects decryption by the wrong recipient', () => {
    // Mallory captured Bob's ciphertext but cannot open it with her own key.
    expect(() => decryptMessage(payload, mallory.sk)).toThrow(
      /corrupted or tampered/
    );
  });
});

describe('messaging crypto: verifySender', () => {
  it('returns true when the address matches the v1 payload key', async () => {
    const payload = await encryptMessage('hi', alice.sk, bob.addr);
    expect(verifySender(alice.addr, payload)).toBe(true);
  });

  it('returns false for a wrong sender address (v1)', async () => {
    const payload = await encryptMessage('hi', alice.sk, bob.addr);
    // The transaction claims to be from Mallory, but the payload key is Alice's.
    expect(verifySender(mallory.addr, payload)).toBe(false);
    expect(verifySender(bob.addr, payload)).toBe(false);
  });

  it('returns true/false correctly for a real v2 payload (uses `from`)', async () => {
    AppLockSignal.setUnlocked(true);
    const bobKeys = deriveMessagingKeyPairFromSecret(bob.sk, bob.addr);
    const payload = await encryptMessageV2(
      'v2 sender check',
      alice.pk,
      bobKeys.publicKey
    );

    expect(payload.v).toBe(2);
    expect(verifySender(alice.addr, payload)).toBe(true);
    expect(verifySender(mallory.addr, payload)).toBe(false);
  });

  it('v2: rejects a note whose `from` was swapped away from the true sender', async () => {
    // Security boundary note: v2 does NOT bind `from` into the KDF/secretbox
    // (crypto.ts encryptMessageV2), so `from` is a self-asserted claim and
    // decryptMessageV2 will still open the ciphertext regardless of it. Sender
    // authenticity therefore rests entirely on verifySender comparing `from`
    // against the on-chain, signature-authenticated transaction sender.
    AppLockSignal.setUnlocked(true);
    const bobKeys = deriveMessagingKeyPairFromSecret(bob.sk, bob.addr);

    // Alice is the real (on-chain) sender of this transaction.
    const payload = await encryptMessageV2(
      'bind me',
      alice.pk,
      bobKeys.publicKey
    );
    // Attacker rewrites the self-asserted `from` to Mallory's key.
    const forged: EncryptedMessagePayloadV2 = {
      ...payload,
      from: encodeBase64(mallory.pk),
    };

    // The ciphertext is untouched, so it still opens (from is not authenticated
    // by the cipher) — this documents the boundary, it is not the defense.
    expect(decryptMessageV2(forged, bobKeys.secretKey)).toBe('bind me');

    // The defense: verifySender against Alice (the true tx sender) now FAILS,
    // because the note's `from` no longer matches the authenticated sender.
    expect(verifySender(alice.addr, forged)).toBe(false);
  });

  it('returns false for a malformed sender address rather than throwing', async () => {
    const payload = await encryptMessage('hi', alice.sk, bob.addr);
    expect(verifySender('not-a-valid-address', payload)).toBe(false);
  });

  it('returns false when the payload key length differs from the address key', async () => {
    const payload = await encryptMessage('hi', alice.sk, bob.addr);
    const shortKey = {
      ...payload,
      senderPubKey: encodeBase64(new Uint8Array(16)),
    };
    expect(verifySender(alice.addr, shortKey)).toBe(false);
  });
});

describe('messaging crypto v2: ephemeral encrypt -> decrypt round-trip', () => {
  // Bob's real X25519 messaging keypair, derived the way production does.
  beforeEach(() => {
    AppLockSignal.setUnlocked(true);
  });

  function bobMessagingKeyPair() {
    return deriveMessagingKeyPairFromSecret(bob.sk, bob.addr);
  }

  it('round-trips plaintext via ephemeral X25519 + secretbox', async () => {
    const bobKeys = bobMessagingKeyPair();
    const plaintext = 'v2 forward-secret hello';

    const payload = await encryptMessageV2(
      plaintext,
      alice.pk,
      bobKeys.publicKey
    );

    expect(payload.v).toBe(2);
    expect(payload.from).toBe(encodeBase64(alice.pk));
    expect(decodeBase64(payload.epk).length).toBe(32);
    expect(decodeBase64(payload.n).length).toBe(nacl.secretbox.nonceLength);

    expect(decryptMessageV2(payload, bobKeys.secretKey)).toBe(plaintext);
  });

  it('uses a fresh ephemeral key per message (distinct epk + ciphertext)', async () => {
    const bobKeys = bobMessagingKeyPair();
    const a = await encryptMessageV2('same', alice.pk, bobKeys.publicKey);
    const b = await encryptMessageV2('same', alice.pk, bobKeys.publicKey);

    expect(a.epk).not.toBe(b.epk);
    expect(a.c).not.toBe(b.c);
    expect(decryptMessageV2(a, bobKeys.secretKey)).toBe('same');
    expect(decryptMessageV2(b, bobKeys.secretKey)).toBe('same');
  });

  it('round-trips through the v2 note encoder/parser', async () => {
    const bobKeys = bobMessagingKeyPair();
    const payload = await encryptMessageV2(
      'v2 note',
      alice.pk,
      bobKeys.publicKey
    );
    const note = createMessageNoteV2(payload);
    const noteBase64 = encodeBase64(new TextEncoder().encode(note));

    const parsed = parseMessageNoteAny(noteBase64);
    expect(parsed).not.toBeNull();
    expect(parsed?.version).toBe(2);
    if (parsed?.version === 2) {
      expect(decryptMessageV2(parsed.payload, bobKeys.secretKey)).toBe(
        'v2 note'
      );
    }
  });

  it('rejects a wrong-length recipient messaging public key on encrypt', async () => {
    await expect(
      encryptMessageV2('hi', alice.pk, new Uint8Array(31))
    ).rejects.toThrow(/expected 32 bytes/);
  });

  it('rejects a message longer than MAX_MESSAGE_LENGTH', async () => {
    const bobKeys = bobMessagingKeyPair();
    await expect(
      encryptMessageV2(
        'x'.repeat(MAX_MESSAGE_LENGTH + 1),
        alice.pk,
        bobKeys.publicKey
      )
    ).rejects.toThrow(/too long/i);
  });
});

describe('messaging crypto v2: tampered / wrong-key rejection', () => {
  let bobSecret: Uint8Array;
  let payload: EncryptedMessagePayloadV2;

  beforeEach(async () => {
    AppLockSignal.setUnlocked(true);
    const bobKeys = deriveMessagingKeyPairFromSecret(bob.sk, bob.addr);
    // Copy the secret: derivation may zero the cached original on later clears.
    bobSecret = new Uint8Array(bobKeys.secretKey);
    payload = await encryptMessageV2('v2 secret', alice.pk, bobKeys.publicKey);
  });

  // Tag byte (0) and encrypted-body byte (20, past the 16-byte tag).
  it.each([0, 20])('rejects a flipped ciphertext byte @%i', (i) => {
    const tampered = { ...payload, c: tamperBase64(payload.c, i) };
    expect(() => decryptMessageV2(tampered, bobSecret)).toThrow(
      /corrupted or tampered/
    );
  });

  it('rejects a flipped nonce byte', () => {
    const tampered = { ...payload, n: tamperBase64(payload.n) };
    expect(() => decryptMessageV2(tampered, bobSecret)).toThrow(
      /corrupted or tampered/
    );
  });

  it('rejects a tampered ephemeral public key (KDF binding)', () => {
    // epk feeds the KDF; changing it derives a different key -> MAC fails.
    const tampered = { ...payload, epk: tamperBase64(payload.epk) };
    expect(() => decryptMessageV2(tampered, bobSecret)).toThrow(
      /corrupted or tampered/
    );
  });

  it('rejects decryption with the wrong recipient secret key', () => {
    const malloryKeys = deriveMessagingKeyPairFromSecret(
      mallory.sk,
      mallory.addr
    );
    expect(() =>
      decryptMessageV2(payload, new Uint8Array(malloryKeys.secretKey))
    ).toThrow(/corrupted or tampered/);
  });

  it('rejects a payload with the wrong version tag', () => {
    const wrongVersion = { ...payload, v: 1 as unknown as 2 };
    expect(() => decryptMessageV2(wrongVersion, bobSecret)).toThrow(
      /expected 2/
    );
  });

  it('rejects a wrong-length recipient secret key', () => {
    expect(() => decryptMessageV2(payload, new Uint8Array(31))).toThrow(
      /expected 32 bytes/
    );
  });
});
