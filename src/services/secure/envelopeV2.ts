/**
 * At-Rest Key Envelope (v2)
 *
 * A memory-hard scrypt + AES-256-CTR + encrypt-then-MAC envelope for wrapping
 * account private keys at rest under a USER-SECRET-derived key (Wave-2, DR-2).
 * This is the per-blob unit of `AccountSecretPayload.blobs[]` (see DOC-137 §2.3).
 *
 * The recipe is the same audited memory-hard construction already shipped for
 * backups in `src/services/backup/encryption.ts` (scrypt via @noble/hashes,
 * encrypt-then-MAC with the HMAC binding the whole canonical header/AAD, a
 * constant-time MAC compare, and a DoS param-cap validator that runs BEFORE
 * scrypt). It is re-implemented here with AT-REST-SPECIFIC domain separation
 * (distinct HMAC tweak + optional device post-mix) so the at-rest and backup
 * envelopes cannot be confused.
 *
 * TODO(wave2): unify with the backup envelope. This module deliberately does NOT
 * refactor `backup/encryption.ts` in PR1 — byte-for-byte back-compat of existing
 * `.voibackup` files is non-negotiable, and the safest guarantee that every
 * backup test passes unchanged and backup ciphertext is identical is to leave the
 * audited backup module untouched. The two envelopes differ in plaintext shape
 * (backup encrypts a UTF-8 JSON string; at-rest encrypts the raw key bytes) and
 * in AAD/KDF (at-rest binds `secretSource`/`deviceBound` and applies a device
 * post-mix), so a shared core is a follow-up PR with dedicated golden-vector
 * byte-identity tests.
 *
 * SECURITY: this module never logs the secret, the derived wrap key, or the
 * plaintext key. Derived CryptoJS WordArrays are scrubbed in `finally` blocks
 * (defense-in-depth; JS strings/typed arrays cannot be reliably zeroed).
 *
 * Byte-oriented plaintext: unlike the legacy Format-A at-rest blob (which
 * encrypts a HEX STRING of the key — `AccountSecureStorage.encryptPrivateKey`),
 * this envelope encrypts and returns the EXACT raw key bytes (the full 64-byte
 * algosdk `sk`, or whatever length is stored — never hardcode 32; see DOC-137 §0
 * P1-A). This round-trips the stored bytes byte-identically and is more
 * size-efficient (no hex doubling), which helps the 2-blob / 2048-byte payload
 * budget (§2.4). v2 is a fresh format with no on-disk history, so there is no
 * back-compat cost to this choice.
 */

import CryptoJS from 'crypto-js';
import 'crypto-js/hmac-sha256';
import 'crypto-js/sha256';
import 'crypto-js/aes';
import 'crypto-js/mode-ctr';
import 'crypto-js/pad-nopadding';
import 'crypto-js/enc-hex';
import 'crypto-js/enc-utf8';
import { scryptRaw } from './scryptKdf';
import { Buffer } from 'buffer';
import { crypto as platformCrypto } from '@/platform';
import type { ScryptKdfParams } from '../backup/types';

// --- Envelope shape ---------------------------------------------------------

/**
 * The canonical per-blob at-rest key envelope (DOC-137 §2.3).
 *
 * The MAC binds the WHOLE header (version/kdf/kdfParams/secretSource/deviceBound
 * /salt/iv) plus the ciphertext, so the version marker and every parameter are
 * authenticated but never trusted for control flow (trial-decrypt: only the
 * correct derived key reproduces the stored MAC).
 */
export interface KeyEnvelopeV2 {
  /** Envelope format version. */
  version: 2;
  /** Key derivation function identifier. */
  kdf: 'scrypt';
  /** scrypt parameters (validated + capped before use). Reuses ScryptKdfParams. */
  kdfParams: ScryptKdfParams;
  /** UX hint ONLY — never a security gate (DOC-137 R3). */
  secretSource: 'pin' | 'passphrase';
  /** Whether the device post-mix (§2.2) was applied when deriving the wrap key. */
  deviceBound: boolean;
  /** Salt for scrypt, hex, 32 bytes, per-blob (platformCrypto.getRandomBytes). */
  salt: string;
  /** AES-CTR initialization vector, hex, 16 bytes. */
  iv: string;
  /** AES-256-CTR ciphertext of the raw key bytes, base64. */
  ct: string;
  /** HMAC-SHA256 over canonicalAtRestAad(header) + ct, hex (64 lowercase). */
  mac: string;
}

// --- Shared parameters ------------------------------------------------------

const SALT_LENGTH = 32; // 256 bits
const IV_LENGTH = 16; // 128 bits for AES-CTR
const KEY_LENGTH = 32; // 256 bits for AES-256

/**
 * At-rest KDF domain separation (distinct from backup's 'backup_hmac_salt').
 * - HMAC tweak: hmacKey = SHA256(wrapKey || AT_REST_HMAC_TWEAK).
 * - Device post-mix: wrapKey = HMAC-SHA256(key=rawKey, AT_REST_DEVICE_TWEAK_PREFIX + deviceId).
 */
const AT_REST_HMAC_TWEAK = 'voi_atrest_hmac';
const AT_REST_DEVICE_TWEAK_PREFIX = 'voi_atrest_v2|';

/**
 * Default scrypt params for the AT-REST UNLOCK path (DOC-137 §2.2): 16 MiB /
 * derivation. Unlock is frequent, so this is lighter than backup's occasional
 * 2^15. The envelope self-describes `kdfParams`, so N can be raised for NEW
 * writes later with zero impact on existing ciphertext.
 *
 * HONEST ENTROPY NOTE: scrypt cannot manufacture entropy. A 6-digit PIN is
 * ~20 bits (10^6 candidates); memory-hard scrypt makes each guess expensive and
 * denies cheap GPU/ASIC parallelism, but 10^6 guesses remain exhaustible by a
 * motivated attacker who has extracted the blob. Raising N scales attacker cost
 * and user unlock latency by the same linear factor. The optional passphrase is
 * the only lever that changes the attacker/defender ratio.
 */
export const AT_REST_KDF_PARAMS: ScryptKdfParams = {
  N: 2 ** 14, // 16384
  r: 8,
  p: 1,
  dkLen: KEY_LENGTH,
};

// --- Multi-blob payload budget (DOC-137 §2.4) -------------------------------

/**
 * Hard cap on the number of v2 blobs in one `AccountSecretPayload`. During a
 * re-wrap the payload transiently holds two blobs (old + new = the "dual slot");
 * never more.
 */
export const MAX_KEY_BLOBS = 2;

/**
 * expo-secure-store rejects values >= 2048 bytes
 * (node_modules/expo-secure-store/src/SecureStore.ts). A full 2-blob payload
 * MUST serialize under this limit.
 */
export const SECURE_STORE_VALUE_LIMIT = 2048;

// --- v2 param caps (DoS guard, mirrors backup encryption.ts) ----------------

const V2_MAX_N = 2 ** 20; // 1,048,576
const V2_MAX_R = 32;
const V2_MAX_P = 4;
const V2_DK_LEN = KEY_LENGTH;
const V2_MAX_KDF_MEMORY_BYTES = 128 * 1024 * 1024; // 128 MiB ceiling on 128*N*r
// noble maxmem must sit comfortably above the largest allowed 128*N*r footprint
// so a future N bump for new writes never silently trips noble's guard.
const SCRYPT_MAXMEM = 2 * V2_MAX_KDF_MEMORY_BYTES; // 256 MiB

// --- Low-level helpers (audited lift from backup/encryption.ts) -------------

/**
 * Best-effort scrub of a CryptoJS WordArray's backing words (defense-in-depth).
 */
function wipeWordArray(wa: CryptoJS.lib.WordArray | null | undefined): void {
  if (wa && Array.isArray(wa.words)) {
    wa.words.fill(0);
    wa.sigBytes = 0;
  }
}

/**
 * Constant-time comparison for equal-length hex strings (MAC check).
 */
function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** True for integers > 1 that are an exact power of two. */
function isPowerOfTwo(n: number): boolean {
  return Number.isInteger(n) && n > 1 && (n & (n - 1)) === 0;
}

/** True when `value` is a hex string of exactly `byteLength` bytes. */
function isHexOfBytes(value: unknown, byteLength: number): value is string {
  return (
    typeof value === 'string' &&
    value.length === byteLength * 2 &&
    /^[0-9a-fA-F]+$/.test(value)
  );
}

/** Convert a CryptoJS WordArray to a byte-exact Uint8Array (sigBytes bytes). */
function wordArrayToUint8Array(wa: CryptoJS.lib.WordArray): Uint8Array {
  const { words, sigBytes } = wa;
  const out = new Uint8Array(sigBytes);
  for (let i = 0; i < sigBytes; i++) {
    out[i] = (words[i >>> 2] >>> (24 - (i % 4) * 8)) & 0xff;
  }
  return out;
}

/** Cryptographically secure random bytes as a hex string. */
async function generateRandomHex(byteLength: number): Promise<string> {
  const randomBytes = await platformCrypto.getRandomBytes(byteLength);
  return Array.from(randomBytes, (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');
}

// --- Param validation (runs BEFORE scrypt) ----------------------------------

/**
 * Cap the scrypt parameters BEFORE any scrypt work happens, so a malicious/
 * oversized blob cannot force a huge/slow memory allocation (DoS). Throws on any
 * violation. N is additionally required to be a power of two and the combined
 * 128*N*r footprint is bounded.
 */
export function assertScryptParamsWithinCaps(params: ScryptKdfParams): void {
  const { N, r, p, dkLen } = params;
  if (
    typeof N !== 'number' ||
    typeof r !== 'number' ||
    typeof p !== 'number' ||
    typeof dkLen !== 'number'
  ) {
    throw new Error('Invalid scrypt parameters');
  }
  if (!isPowerOfTwo(N) || N > V2_MAX_N) {
    throw new Error('scrypt parameters exceed safe limits');
  }
  if (!Number.isInteger(r) || r < 1 || r > V2_MAX_R) {
    throw new Error('scrypt parameters exceed safe limits');
  }
  if (!Number.isInteger(p) || p < 1 || p > V2_MAX_P) {
    throw new Error('scrypt parameters exceed safe limits');
  }
  if (dkLen !== V2_DK_LEN) {
    throw new Error('scrypt parameters exceed safe limits');
  }
  if (128 * N * r > V2_MAX_KDF_MEMORY_BYTES) {
    throw new Error('scrypt parameters exceed safe limits');
  }
}

/**
 * Strictly validate an (untrusted) parsed KeyEnvelopeV2 shape and CAP its KDF
 * params before scrypt. Throws on any structural or param violation. Defense in
 * depth even though the reader parses a self-written blob.
 */
export function assertValidKeyEnvelopeV2(
  envelope: unknown
): asserts envelope is KeyEnvelopeV2 {
  if (typeof envelope !== 'object' || envelope === null) {
    throw new Error('Invalid key envelope');
  }
  const e = envelope as Record<string, unknown>;
  if (e.version !== 2) {
    throw new Error('Unsupported key envelope version');
  }
  if (e.kdf !== 'scrypt') {
    throw new Error('Unsupported key envelope KDF');
  }
  if (e.secretSource !== 'pin' && e.secretSource !== 'passphrase') {
    throw new Error('Invalid key envelope secretSource');
  }
  if (typeof e.deviceBound !== 'boolean') {
    throw new Error('Invalid key envelope deviceBound');
  }
  if (!isHexOfBytes(e.salt, SALT_LENGTH)) {
    throw new Error('Invalid key envelope salt');
  }
  if (!isHexOfBytes(e.iv, IV_LENGTH)) {
    throw new Error('Invalid key envelope iv');
  }
  if (typeof e.ct !== 'string' || e.ct.length === 0) {
    throw new Error('Invalid key envelope ciphertext');
  }
  // The writer emits the HMAC as exactly 32 bytes of lowercase hex; reject a
  // malformed mac up front so it never reaches the length-dependent compare.
  if (typeof e.mac !== 'string' || !/^[0-9a-f]{64}$/.test(e.mac)) {
    throw new Error('Invalid key envelope mac');
  }
  const rawParams = e.kdfParams;
  if (typeof rawParams !== 'object' || rawParams === null) {
    throw new Error('Invalid key envelope kdfParams');
  }
  assertScryptParamsWithinCaps(rawParams as ScryptKdfParams);
}

/**
 * Guard the multi-blob payload budget (DOC-137 §2.4). Throws if the blob count
 * exceeds MAX_KEY_BLOBS or the serialized payload would not fit under the
 * expo-secure-store 2048-byte value limit. Callers pass the exact string they
 * intend to persist.
 */
export function assertPayloadSizeWithinLimit(
  serializedPayload: string,
  blobCount: number
): void {
  if (blobCount > MAX_KEY_BLOBS) {
    throw new Error(`Too many key blobs: ${blobCount} (max ${MAX_KEY_BLOBS})`);
  }
  // Byte length (SecureStore limits bytes, not UTF-16 code units).
  const byteLength = Buffer.byteLength(serializedPayload, 'utf8');
  if (byteLength >= SECURE_STORE_VALUE_LIMIT) {
    throw new Error(
      `Secret payload too large: ${byteLength} bytes (limit ${SECURE_STORE_VALUE_LIMIT})`
    );
  }
}

// --- Canonical AAD ----------------------------------------------------------

/**
 * Canonical, fixed-key-order serialization of the envelope header used as AAD
 * for the HMAC. The MAC is computed over this string concatenated with the
 * ciphertext, so version/kdf/N/r/p/dkLen/secretSource/deviceBound/salt/iv are
 * all authenticated and cannot be tampered without failing verification.
 */
function canonicalAtRestAad(header: {
  version: 2;
  kdf: 'scrypt';
  kdfParams: ScryptKdfParams;
  secretSource: 'pin' | 'passphrase';
  deviceBound: boolean;
  salt: string;
  iv: string;
}): string {
  return JSON.stringify({
    version: header.version,
    kdf: header.kdf,
    kdfParams: {
      N: header.kdfParams.N,
      r: header.kdfParams.r,
      p: header.kdfParams.p,
      dkLen: header.kdfParams.dkLen,
    },
    secretSource: header.secretSource,
    deviceBound: header.deviceBound,
    salt: header.salt,
    iv: header.iv,
  });
}

// --- KDF (the at-rest wrapping key, DOC-137 §2.2) ---------------------------

/**
 * Derive the 32-byte at-rest wrap key from a user secret (DOC-137 §2.2):
 *
 *   rawKey  = scrypt(utf8(secret), saltBytes, { N, r, p, dkLen: 32 })
 *   wrapKey = deviceSecret ? HMAC-SHA256(key=rawKey, "voi_atrest_v2|"+deviceSecret) : rawKey
 *
 * All memory-hardness is over the user secret — scrypt is the brute-force
 * barrier. The device post-mix is a single cheap HMAC (mild defense-in-depth,
 * NOT a strong second factor: the device id is IDFV/Android ID, not a secret).
 * Params are capped before scrypt runs.
 *
 * @param secret       UTF-8 user secret (PIN or passphrase).
 * @param saltHex      Per-blob salt, hex (32 bytes).
 * @param kdfParams    scrypt parameters (validated/capped here).
 * @param deviceSecret Optional device id; when present the post-mix is applied.
 */
export async function deriveWrapKey(
  secret: string,
  saltHex: string,
  kdfParams: ScryptKdfParams,
  deviceSecret?: string
): Promise<Uint8Array> {
  assertScryptParamsWithinCaps(kdfParams);
  const saltBytes = Uint8Array.from(Buffer.from(saltHex, 'hex'));
  // Native-first scrypt (byte-identical to @noble; falls back to @noble in
  // jest/non-native). See scryptKdf.ts — this is the ~16s→~tens-of-ms fix.
  const rawKey = await scryptRaw(secret, saltBytes, {
    N: kdfParams.N,
    r: kdfParams.r,
    p: kdfParams.p,
    dkLen: kdfParams.dkLen,
    maxmem: SCRYPT_MAXMEM,
  });

  if (!deviceSecret) {
    return rawKey;
  }

  // Device post-mix: HMAC-SHA256 keyed by rawKey over the device tweak.
  let rawKeyWA: CryptoJS.lib.WordArray | null = null;
  let mixedWA: CryptoJS.lib.WordArray | null = null;
  try {
    rawKeyWA = CryptoJS.lib.WordArray.create(rawKey);
    mixedWA = CryptoJS.HmacSHA256(
      AT_REST_DEVICE_TWEAK_PREFIX + deviceSecret,
      rawKeyWA
    );
    return wordArrayToUint8Array(mixedWA);
  } finally {
    rawKey.fill(0);
    wipeWordArray(rawKeyWA);
    wipeWordArray(mixedWA);
  }
}

/**
 * Derive the AES and HMAC key WordArrays from a 32-byte wrap key.
 *   aesKey  = wrapKey
 *   hmacKey = SHA256(wrapKey || AT_REST_HMAC_TWEAK)
 * The caller MUST wipe both returned WordArrays in a `finally`.
 */
function keyMaterialFromWrapKey(wrapKey: Uint8Array): {
  aesKeyWA: CryptoJS.lib.WordArray;
  hmacKeyWA: CryptoJS.lib.WordArray;
} {
  const aesKeyWA = CryptoJS.lib.WordArray.create(wrapKey);
  const tweakWA = CryptoJS.enc.Utf8.parse(AT_REST_HMAC_TWEAK);
  const hmacKeyInput = aesKeyWA.clone().concat(tweakWA);
  const hmacKeyWA = CryptoJS.SHA256(hmacKeyInput);
  wipeWordArray(hmacKeyInput);
  return { aesKeyWA, hmacKeyWA };
}

// --- Envelope encrypt / decrypt ---------------------------------------------

/**
 * Encrypt raw key bytes into a KeyEnvelopeV2 (scrypt + AES-256-CTR +
 * encrypt-then-MAC). Round-trips the EXACT input bytes, whatever their length.
 *
 * NOTE: no production code calls this in PR1 (no writer/migration lands here);
 * it exists for the future PR4 writer and to let tests construct v2 blobs.
 *
 * @param plaintext    Raw key bytes to wrap (e.g. the full 64-byte algosdk sk).
 * @param secret       UTF-8 user secret.
 * @param secretSource UX hint recorded in the header (not a security gate).
 * @param deviceSecret Optional device id; present => deviceBound = true.
 * @param kdfParams    scrypt params (defaults to AT_REST_KDF_PARAMS).
 * @param saltHex/ivHex Optional overrides for deterministic tests; random by default.
 */
export async function encryptKeyEnvelopeV2(input: {
  plaintext: Uint8Array;
  secret: string;
  secretSource: 'pin' | 'passphrase';
  deviceSecret?: string;
  kdfParams?: ScryptKdfParams;
  saltHex?: string;
  ivHex?: string;
}): Promise<KeyEnvelopeV2> {
  const kdfParams = input.kdfParams ?? AT_REST_KDF_PARAMS;
  const deviceBound = input.deviceSecret != null;

  let wrapKey: Uint8Array | null = null;
  let aesKeyWA: CryptoJS.lib.WordArray | null = null;
  let hmacKeyWA: CryptoJS.lib.WordArray | null = null;
  let plaintextWA: CryptoJS.lib.WordArray | null = null;

  try {
    const salt = input.saltHex ?? (await generateRandomHex(SALT_LENGTH));
    const iv = input.ivHex ?? (await generateRandomHex(IV_LENGTH));

    wrapKey = await deriveWrapKey(
      input.secret,
      salt,
      kdfParams,
      input.deviceSecret
    );
    ({ aesKeyWA, hmacKeyWA } = keyMaterialFromWrapKey(wrapKey));

    plaintextWA = CryptoJS.lib.WordArray.create(input.plaintext);
    const encrypted = CryptoJS.AES.encrypt(plaintextWA, aesKeyWA, {
      iv: CryptoJS.enc.Hex.parse(iv),
      mode: CryptoJS.mode.CTR,
      padding: CryptoJS.pad.NoPadding,
    });
    const ct = encrypted.toString();

    const header = {
      version: 2 as const,
      kdf: 'scrypt' as const,
      kdfParams: {
        N: kdfParams.N,
        r: kdfParams.r,
        p: kdfParams.p,
        dkLen: kdfParams.dkLen,
      },
      secretSource: input.secretSource,
      deviceBound,
      salt,
      iv,
    };
    const mac = CryptoJS.HmacSHA256(
      canonicalAtRestAad(header) + ct,
      hmacKeyWA
    ).toString();

    return { ...header, ct, mac };
  } finally {
    if (wrapKey) {
      wrapKey.fill(0);
    }
    wipeWordArray(aesKeyWA);
    wipeWordArray(hmacKeyWA);
    wipeWordArray(plaintextWA);
  }
}

/**
 * Trial-decrypt a KeyEnvelopeV2 under a candidate secret.
 *
 * Returns the exact wrapped key bytes on success, or `null` when the MAC does
 * not verify (wrong secret or tampered header — the safe "fall through to the
 * next candidate" signal). THROWS only on a structurally invalid envelope or
 * out-of-cap KDF params — and it validates/caps BEFORE running scrypt, so an
 * oversized N can never force a huge allocation.
 *
 * SECURITY: the MAC is keyed by the derived wrap key, so only the correct
 * derivation reproduces the stored MAC. A wrong key cannot forge it; a flipped
 * marker cannot make a wrong key verify.
 *
 * @param deviceSecret Device id; used only when `envelope.deviceBound` is true.
 */
export async function decryptKeyEnvelopeV2(
  envelope: KeyEnvelopeV2,
  secret: string,
  deviceSecret?: string
): Promise<Uint8Array | null> {
  // Structural + param-cap validation BEFORE any scrypt work.
  assertValidKeyEnvelopeV2(envelope);

  let wrapKey: Uint8Array | null = null;
  let aesKeyWA: CryptoJS.lib.WordArray | null = null;
  let hmacKeyWA: CryptoJS.lib.WordArray | null = null;
  let decryptedWA: CryptoJS.lib.WordArray | null = null;

  try {
    wrapKey = await deriveWrapKey(
      secret,
      envelope.salt,
      envelope.kdfParams,
      envelope.deviceBound ? deviceSecret : undefined
    );
    ({ aesKeyWA, hmacKeyWA } = keyMaterialFromWrapKey(wrapKey));

    const aad = canonicalAtRestAad(envelope);
    const computedMac = CryptoJS.HmacSHA256(
      aad + envelope.ct,
      hmacKeyWA
    ).toString();
    if (!constantTimeEqualHex(computedMac, envelope.mac)) {
      return null; // wrong key / tampered header -> fall through
    }

    decryptedWA = CryptoJS.AES.decrypt(envelope.ct, aesKeyWA, {
      iv: CryptoJS.enc.Hex.parse(envelope.iv),
      mode: CryptoJS.mode.CTR,
      padding: CryptoJS.pad.NoPadding,
    });
    return wordArrayToUint8Array(decryptedWA);
  } finally {
    if (wrapKey) {
      wrapKey.fill(0);
    }
    wipeWordArray(aesKeyWA);
    wipeWordArray(hmacKeyWA);
    wipeWordArray(decryptedWA);
  }
}

/**
 * Trial-decrypt a KeyEnvelopeV2 using a PRE-DERIVED 32-byte wrap key — e.g. the
 * SessionKeyVault's memoized `getWrapKey` output (DOC-137 §6.4). This is the
 * scrypt-free half of the reader: the caller (the vault) already paid the
 * memory-hard cost once per account/salt, so per-signature reads only run the
 * cheap MAC-verify + AES-CTR unwrap.
 *
 * Returns the exact wrapped key bytes on success, or `null` when the MAC does
 * not verify (wrong wrap key / tampered header). THROWS only on a structurally
 * invalid envelope or out-of-cap KDF params.
 *
 * CRITICAL: does NOT zero `wrapKey` — that buffer is OWNED by the vault (memoized
 * and reused across reads; the vault zeroes it on clear/rotate). Only the
 * derived AES/HMAC WordArrays created here are scrubbed.
 */
export async function decryptKeyEnvelopeV2WithWrapKey(
  envelope: KeyEnvelopeV2,
  wrapKey: Uint8Array
): Promise<Uint8Array | null> {
  // Structural + param-cap validation BEFORE any crypto work.
  assertValidKeyEnvelopeV2(envelope);

  let aesKeyWA: CryptoJS.lib.WordArray | null = null;
  let hmacKeyWA: CryptoJS.lib.WordArray | null = null;
  let decryptedWA: CryptoJS.lib.WordArray | null = null;

  try {
    ({ aesKeyWA, hmacKeyWA } = keyMaterialFromWrapKey(wrapKey));

    const aad = canonicalAtRestAad(envelope);
    const computedMac = CryptoJS.HmacSHA256(
      aad + envelope.ct,
      hmacKeyWA
    ).toString();
    if (!constantTimeEqualHex(computedMac, envelope.mac)) {
      return null; // wrong wrap key / tampered header -> fall through
    }

    decryptedWA = CryptoJS.AES.decrypt(envelope.ct, aesKeyWA, {
      iv: CryptoJS.enc.Hex.parse(envelope.iv),
      mode: CryptoJS.mode.CTR,
      padding: CryptoJS.pad.NoPadding,
    });
    return wordArrayToUint8Array(decryptedWA);
  } finally {
    // NOTE: `wrapKey` is intentionally NOT zeroed (vault-owned).
    wipeWordArray(aesKeyWA);
    wipeWordArray(hmacKeyWA);
    wipeWordArray(decryptedWA);
  }
}
