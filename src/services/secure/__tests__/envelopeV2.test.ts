// Unit tests for the Wave-2 at-rest key envelope (DOC-137 §2.3/§2.4, PR1).
//
// Covers: byte-exact round-trip of arbitrary-length key material (incl. the full
// 64-byte algosdk sk — never hardcode 32), encrypt-then-MAC binding of EVERY
// header field, the optional device post-mix, trial-decrypt fall-through on a
// wrong secret, param-cap validation BEFORE scrypt (DoS guard), and the
// 2-blob / <2048-byte payload budget.
//
// SECURITY NOTE: no real key material is used — plaintexts are synthetic byte
// patterns and secrets are throwaway test strings. The point is the crypto
// invariants.

// Provide platform crypto (getRandomBytes) via Node's CSPRNG so the envelope
// module runs under jest without the native/expo platform adapter.
jest.mock('@/platform', () => {
  const nodeCrypto = require('crypto');
  return {
    crypto: {
      getRandomBytes: async (byteCount: number): Promise<Uint8Array> =>
        Uint8Array.from(nodeCrypto.randomBytes(byteCount)),
    },
  };
});

import { randomBytes } from 'crypto';
import {
  KeyEnvelopeV2,
  encryptKeyEnvelopeV2,
  decryptKeyEnvelopeV2,
  deriveWrapKey,
  assertScryptParamsWithinCaps,
  assertValidKeyEnvelopeV2,
  assertPayloadSizeWithinLimit,
  MAX_KEY_BLOBS,
  SECURE_STORE_VALUE_LIMIT,
} from '../envelopeV2';
import type { ScryptKdfParams } from '../../backup/types';

// Small (but still power-of-two and within caps) scrypt params keep the test
// suite fast; production uses AT_REST_KDF_PARAMS (N=2^14).
const FAST_PARAMS: ScryptKdfParams = { N: 2 ** 12, r: 8, p: 1, dkLen: 32 };

const SECRET = '123456'; // throwaway 6-digit PIN-shaped secret
const DEVICE = 'test-device-idfv-0001';

/** Deterministic synthetic key bytes of a given length (NOT a real key). */
function fakeKey(length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, i) => (i * 7 + 3) & 0xff);
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

function randomHex(byteLength: number): string {
  return randomBytes(byteLength).toString('hex');
}

describe('envelopeV2 round-trip (byte-exact, length-agnostic)', () => {
  it('round-trips the full 64-byte algosdk sk byte-identically', async () => {
    const sk = fakeKey(64);
    const envelope = await encryptKeyEnvelopeV2({
      plaintext: sk,
      secret: SECRET,
      secretSource: 'pin',
      kdfParams: FAST_PARAMS,
    });

    expect(envelope.version).toBe(2);
    expect(envelope.kdf).toBe('scrypt');
    expect(envelope.secretSource).toBe('pin');
    expect(envelope.deviceBound).toBe(false);
    expect(envelope.salt).toMatch(/^[0-9a-f]{64}$/);
    expect(envelope.iv).toMatch(/^[0-9a-f]{32}$/);
    expect(envelope.mac).toMatch(/^[0-9a-f]{64}$/);
    // No plaintext leaks into the envelope.
    expect(envelope.ct).not.toContain(hex(sk));

    const out = await decryptKeyEnvelopeV2(envelope, SECRET);
    expect(out).not.toBeNull();
    expect(hex(out as Uint8Array)).toBe(hex(sk)); // byte-identical
    expect((out as Uint8Array).length).toBe(64);
  });

  it('round-trips a 32-byte seed too (never hardcodes 64 either)', async () => {
    const seed = fakeKey(32);
    const envelope = await encryptKeyEnvelopeV2({
      plaintext: seed,
      secret: SECRET,
      secretSource: 'passphrase',
      kdfParams: FAST_PARAMS,
    });
    const out = await decryptKeyEnvelopeV2(envelope, SECRET);
    expect(hex(out as Uint8Array)).toBe(hex(seed));
    expect(envelope.secretSource).toBe('passphrase');
  });

  it('returns null (falls through) on the wrong secret', async () => {
    const sk = fakeKey(64);
    const envelope = await encryptKeyEnvelopeV2({
      plaintext: sk,
      secret: SECRET,
      secretSource: 'pin',
      kdfParams: FAST_PARAMS,
    });
    const out = await decryptKeyEnvelopeV2(envelope, '000000');
    expect(out).toBeNull();
  });
});

describe('envelopeV2 device post-mix (deviceBound)', () => {
  it('round-trips a device-bound blob and requires the same device secret', async () => {
    const sk = fakeKey(64);
    const envelope = await encryptKeyEnvelopeV2({
      plaintext: sk,
      secret: SECRET,
      secretSource: 'pin',
      deviceSecret: DEVICE,
      kdfParams: FAST_PARAMS,
    });
    expect(envelope.deviceBound).toBe(true);

    // Correct device secret -> success.
    const ok = await decryptKeyEnvelopeV2(envelope, SECRET, DEVICE);
    expect(hex(ok as Uint8Array)).toBe(hex(sk));

    // Wrong device secret -> MAC fails -> null.
    const wrongDevice = await decryptKeyEnvelopeV2(
      envelope,
      SECRET,
      'a-different-device'
    );
    expect(wrongDevice).toBeNull();

    // Missing device secret on a device-bound blob -> null (never throws).
    const noDevice = await decryptKeyEnvelopeV2(envelope, SECRET);
    expect(noDevice).toBeNull();
  });

  it('deriveWrapKey device post-mix changes the wrap key', async () => {
    const salt = randomHex(32);
    const plain = await deriveWrapKey(SECRET, salt, FAST_PARAMS);
    const mixed = await deriveWrapKey(SECRET, salt, FAST_PARAMS, DEVICE);
    expect(plain.length).toBe(32);
    expect(mixed.length).toBe(32);
    expect(hex(mixed)).not.toBe(hex(plain));
  });
});

describe('envelopeV2 MAC binds every header field', () => {
  let base: KeyEnvelopeV2;
  let sk: Uint8Array;

  beforeAll(async () => {
    sk = fakeKey(64);
    base = await encryptKeyEnvelopeV2({
      plaintext: sk,
      secret: SECRET,
      secretSource: 'pin',
      kdfParams: FAST_PARAMS,
    });
  });

  it('sanity: the untampered envelope still decrypts', async () => {
    const out = await decryptKeyEnvelopeV2({ ...base }, SECRET);
    expect(hex(out as Uint8Array)).toBe(hex(sk));
  });

  // Each of these is authenticated via the canonical AAD, so tampering flips the
  // recomputed MAC and decryption returns null instead of forging a plaintext.
  it('rejects a tampered kdfParams.N (valid -> another valid power of two)', async () => {
    const tampered: KeyEnvelopeV2 = {
      ...base,
      kdfParams: { ...base.kdfParams, N: 2 ** 13 },
    };
    expect(await decryptKeyEnvelopeV2(tampered, SECRET)).toBeNull();
  });

  it('rejects a tampered secretSource', async () => {
    const tampered: KeyEnvelopeV2 = { ...base, secretSource: 'passphrase' };
    expect(await decryptKeyEnvelopeV2(tampered, SECRET)).toBeNull();
  });

  it('rejects a tampered deviceBound flag', async () => {
    const tampered: KeyEnvelopeV2 = { ...base, deviceBound: true };
    expect(await decryptKeyEnvelopeV2(tampered, SECRET, DEVICE)).toBeNull();
  });

  it('rejects a tampered salt', async () => {
    const tampered: KeyEnvelopeV2 = { ...base, salt: randomHex(32) };
    expect(await decryptKeyEnvelopeV2(tampered, SECRET)).toBeNull();
  });

  it('rejects a tampered iv (iv is authenticated only via AAD)', async () => {
    const tampered: KeyEnvelopeV2 = { ...base, iv: randomHex(16) };
    expect(await decryptKeyEnvelopeV2(tampered, SECRET)).toBeNull();
  });

  it('rejects a tampered version (structural + AAD-bound)', async () => {
    const tampered = { ...base, version: 3 } as unknown as KeyEnvelopeV2;
    await expect(decryptKeyEnvelopeV2(tampered, SECRET)).rejects.toThrow();
  });

  it('rejects a tampered ct (ciphertext is MACed)', async () => {
    const tampered: KeyEnvelopeV2 = {
      ...base,
      ct: Buffer.from(randomBytes(64)).toString('base64'),
    };
    expect(await decryptKeyEnvelopeV2(tampered, SECRET)).toBeNull();
  });
});

describe('envelopeV2 param-cap validation (DoS guard, before scrypt)', () => {
  it('assertScryptParamsWithinCaps rejects an oversized N synchronously', () => {
    expect(() =>
      assertScryptParamsWithinCaps({ N: 2 ** 21, r: 8, p: 1, dkLen: 32 })
    ).toThrow(/safe limits/);
  });

  it('rejects a non-power-of-two N', () => {
    expect(() =>
      assertScryptParamsWithinCaps({ N: 30000, r: 8, p: 1, dkLen: 32 })
    ).toThrow(/safe limits/);
  });

  it('rejects an oversized r and a combined memory footprint over the ceiling', () => {
    expect(() =>
      assertScryptParamsWithinCaps({ N: 2 ** 12, r: 64, p: 1, dkLen: 32 })
    ).toThrow(/safe limits/);
    // N=2^20, r=32 -> 128*N*r = 4 GiB, well over the 128 MiB cap.
    expect(() =>
      assertScryptParamsWithinCaps({ N: 2 ** 20, r: 32, p: 1, dkLen: 32 })
    ).toThrow(/safe limits/);
  });

  it('rejects a wrong dkLen', () => {
    expect(() =>
      assertScryptParamsWithinCaps({ N: 2 ** 12, r: 8, p: 1, dkLen: 64 })
    ).toThrow(/safe limits/);
  });

  it('decryptKeyEnvelopeV2 rejects an out-of-cap N before running scrypt', async () => {
    const sk = fakeKey(64);
    const envelope = await encryptKeyEnvelopeV2({
      plaintext: sk,
      secret: SECRET,
      secretSource: 'pin',
      kdfParams: FAST_PARAMS,
    });
    // Oversized N would force a huge scrypt allocation; the validator must throw
    // first. (Also proves no scrypt ran: assertValidKeyEnvelopeV2 has no KDF.)
    const evil: KeyEnvelopeV2 = {
      ...envelope,
      kdfParams: { ...envelope.kdfParams, N: 2 ** 21 },
    };
    await expect(decryptKeyEnvelopeV2(evil, SECRET)).rejects.toThrow(
      /safe limits/
    );
  });

  it('assertValidKeyEnvelopeV2 rejects structurally malformed envelopes', () => {
    expect(() => assertValidKeyEnvelopeV2(null)).toThrow();
    expect(() =>
      assertValidKeyEnvelopeV2({ version: 1, kdf: 'scrypt' })
    ).toThrow(/version/);
  });
});

describe('multi-blob payload budget (2 blobs, <2048 bytes)', () => {
  it('a realistic 2-blob payload (64-byte sk) is well under 2048 bytes', async () => {
    const sk = fakeKey(64);
    // Two blobs = the transient dual-slot state, worst case for size.
    const blobA = await encryptKeyEnvelopeV2({
      plaintext: sk,
      secret: SECRET,
      secretSource: 'pin',
      // production-realistic params (bigger numbers => longer JSON) to be honest
      kdfParams: { N: 2 ** 14, r: 8, p: 1, dkLen: 32 },
    });
    const blobB = await encryptKeyEnvelopeV2({
      plaintext: sk,
      secret: '654321',
      secretSource: 'passphrase',
      deviceSecret: DEVICE,
      kdfParams: { N: 2 ** 14, r: 8, p: 1, dkLen: 32 },
    });

    const payload = {
      accountId: 'acct-1234567890abcdef',
      encryptedPrivateKey: '',
      authMethod: 'pin' as const,
      version: 2 as const,
      blobs: [blobA, blobB],
    };
    const serialized = JSON.stringify(payload);
    const byteLength = Buffer.byteLength(serialized, 'utf8');

    // Well under the 2048-byte SecureStore value limit.
    expect(byteLength).toBeLessThan(SECURE_STORE_VALUE_LIMIT);
    expect(byteLength).toBeLessThan(1200); // comfortable headroom
    expect(() =>
      assertPayloadSizeWithinLimit(serialized, payload.blobs.length)
    ).not.toThrow();
  });

  it('rejects more than MAX_KEY_BLOBS blobs', () => {
    expect(MAX_KEY_BLOBS).toBe(2);
    expect(() => assertPayloadSizeWithinLimit('{}', 3)).toThrow(
      /Too many key blobs/
    );
  });

  it('rejects a serialized payload at/over the 2048-byte limit', () => {
    const tooBig = 'x'.repeat(SECURE_STORE_VALUE_LIMIT);
    expect(() => assertPayloadSizeWithinLimit(tooBig, 1)).toThrow(/too large/);
  });
});
