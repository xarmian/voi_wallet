/**
 * Backup Encryption Module
 *
 * Password-based encryption for wallet backups.
 *
 * Envelope versions (discriminated on `version`):
 *  - v1 (LEGACY, read-only): PBKDF2-SHA256 100k + AES-256-CTR + HMAC-SHA256.
 *    New backups are NO LONGER written as v1, but existing v1 files MUST still
 *    decrypt — the v1 path below is intentionally left untouched.
 *  - v2 (current): scrypt (memory-hard) + AES-256-CTR + encrypt-then-MAC, with
 *    the HMAC binding the envelope parameters (AAD) so N/r/p/salt/iv/version
 *    cannot be tampered without failing integrity verification.
 *
 * SECURITY: this module never logs the password, mnemonic, derived key, or any
 * plaintext. Derived key material is scrubbed in `finally` blocks.
 */

import CryptoJS from 'crypto-js';
import 'crypto-js/hmac-sha256';
import 'crypto-js/sha256';
import 'crypto-js/aes';
import 'crypto-js/mode-ctr';
import 'crypto-js/pad-nopadding';
import 'crypto-js/enc-hex';
import 'crypto-js/enc-base64';
import 'crypto-js/pbkdf2';
import { scryptAsync } from '@noble/hashes/scrypt';
import { Buffer } from 'buffer';
import { crypto as platformCrypto } from '@/platform';
import {
  EncryptedBackupFile,
  EncryptedBackupFileV1,
  EncryptedBackupFileV2,
  ScryptKdfParams,
  BackupError,
} from './types';

// --- Shared envelope parameters -------------------------------------------
const SALT_LENGTH = 32; // 256 bits
const IV_LENGTH = 16; // 128 bits for AES
const KEY_LENGTH = 32; // 256 bits for AES-256

// --- v1 (legacy PBKDF2) parameters ----------------------------------------
const PBKDF2_ITERATIONS = 100000;

// --- v2 (scrypt) writer parameters ----------------------------------------
// Chosen conservatively for pure-JS Hermes on low-end Android. Memory footprint
// is ~128 * N * r bytes = 32 MiB here. Benchmark (Node v24 / V8, scryptAsync):
//   N=2^14 -> ~31ms/16MiB, N=2^15 -> ~63ms/32MiB, N=2^16 -> ~125ms/64MiB,
//   N=2^17 -> ~250ms/128MiB. Backup is an occasional operation, so a memory-hard
//   KDF taking ~1s (Hermes is materially slower than V8) is an acceptable
//   trade-off. 32 MiB stays comfortably clear of OOM on low-end devices.
//   NOTE: real Hermes / low-end-Android timing is a follow-up device check.
const SCRYPT_N = 2 ** 15; // 32768
const SCRYPT_R = 8;
const SCRYPT_P = 1;

// --- v2 validation caps (DoS guard) ---------------------------------------
// A malicious/oversized v2 backup must be rejected BEFORE scrypt runs so it
// cannot force a huge memory allocation. N is additionally checked to be a
// power of two, and the combined 128*N*r footprint is bounded.
const V2_MAX_N = 2 ** 20; // 1,048,576
const V2_MAX_R = 32;
const V2_MAX_P = 4;
const V2_DK_LEN = 32;
const V2_MAX_KDF_MEMORY_BYTES = 128 * 1024 * 1024; // 128 MiB ceiling on 128*N*r

const HMAC_KEY_TWEAK = 'backup_hmac_salt';

/**
 * PBKDF2 key derivation using CryptoJS with SHA256 (v1 legacy path).
 */
function deriveKeyPbkdf2(password: string, saltHex: string): string {
  const saltWA = CryptoJS.enc.Hex.parse(saltHex);
  const derived = CryptoJS.PBKDF2(password, saltWA, {
    keySize: KEY_LENGTH / 4, // CryptoJS keySize is in 32-bit words
    iterations: PBKDF2_ITERATIONS,
    hasher: (CryptoJS.algo as any).SHA256,
  });
  return derived.toString(CryptoJS.enc.Hex);
}

/**
 * Best-effort scrub of a CryptoJS WordArray's backing words.
 *
 * SECURITY / defense-in-depth only: JS/Hermes strings are immutable and cannot
 * be reliably zeroed, so this reduces (does not eliminate) copies of key
 * material left in memory. WordArrays store their bytes in a plain number[],
 * which we CAN overwrite.
 */
function wipeWordArray(wa: CryptoJS.lib.WordArray | null | undefined): void {
  if (wa && Array.isArray(wa.words)) {
    wa.words.fill(0);
    wa.sigBytes = 0;
  }
}

/**
 * scrypt key derivation (v2). Returns the AES key and HMAC key as CryptoJS
 * WordArrays (which can be scrubbed) derived directly from the scrypt output,
 * avoiding an unnecessary hex-string copy of the key material.
 *
 * Uses the ASYNC variant which yields to the event loop during the multi-second
 * derivation so it doesn't freeze the RN UI thread.
 *
 * The caller MUST wipe both returned WordArrays in a `finally` (see
 * wipeWordArray for the defense-in-depth caveat).
 */
async function deriveV2KeyMaterial(
  password: string,
  saltHex: string,
  params: ScryptKdfParams
): Promise<{
  keyWordArray: CryptoJS.lib.WordArray;
  hmacKeyWordArray: CryptoJS.lib.WordArray;
}> {
  const saltBytes = Uint8Array.from(Buffer.from(saltHex, 'hex'));
  const derived = await scryptAsync(password, saltBytes, {
    N: params.N,
    r: params.r,
    p: params.p,
    dkLen: params.dkLen,
  });
  const keyWordArray = CryptoJS.lib.WordArray.create(derived);
  derived.fill(0); // scrub the raw scrypt bytes immediately

  // HMAC key = SHA256(key || tweak). `concat` mutates the receiver, so clone the
  // key first and wipe the throwaway input afterwards.
  const tweakWordArray = CryptoJS.enc.Utf8.parse(HMAC_KEY_TWEAK);
  const hmacKeyInput = keyWordArray.clone().concat(tweakWordArray);
  const hmacKeyWordArray = CryptoJS.SHA256(hmacKeyInput);
  wipeWordArray(hmacKeyInput);

  return { keyWordArray, hmacKeyWordArray };
}

/**
 * Generate cryptographically secure random bytes as hex string
 */
async function generateRandomHex(byteLength: number): Promise<string> {
  const randomBytes = await platformCrypto.getRandomBytes(byteLength);
  return Array.from(randomBytes, (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');
}

/**
 * Canonical serialization of the v2 envelope parameters used as AAD for the
 * HMAC. Building the object with a fixed key order makes JSON.stringify a
 * deterministic canonical form. The MAC is computed over this string
 * concatenated with the ciphertext, so version/kdf/N/r/p/dkLen/salt/iv are all
 * authenticated and cannot be tampered without failing verification.
 */
function canonicalV2Aad(params: {
  version: 2;
  kdf: 'scrypt';
  kdfParams: ScryptKdfParams;
  salt: string;
  iv: string;
}): string {
  return JSON.stringify({
    version: params.version,
    kdf: params.kdf,
    kdfParams: {
      N: params.kdfParams.N,
      r: params.kdfParams.r,
      p: params.kdfParams.p,
      dkLen: params.kdfParams.dkLen,
    },
    salt: params.salt,
    iv: params.iv,
  });
}

/**
 * Constant-time comparison for equal-length hex strings (v2 MAC check).
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

/**
 * True for integers > 1 that are an exact power of two.
 */
function isPowerOfTwo(n: number): boolean {
  return Number.isInteger(n) && n > 1 && (n & (n - 1)) === 0;
}

/**
 * True when `value` is a hex string of exactly `byteLength` bytes.
 */
function isHexOfBytes(value: unknown, byteLength: number): value is string {
  return (
    typeof value === 'string' &&
    value.length === byteLength * 2 &&
    /^[0-9a-fA-F]+$/.test(value)
  );
}

/**
 * Strictly validate a parsed (untrusted) backup envelope and normalize it to a
 * typed EncryptedBackupFile.
 *
 * For v2 this CAPS the KDF parameters BEFORE any scrypt work happens, so a
 * malicious backup cannot force a huge/slow memory allocation (DoS). Both the
 * import and validation paths parse untrusted JSON, so this runs on both, and
 * decryptBackup re-runs it as a final gate before deriving the key.
 */
export function validateEncryptedBackupFile(
  parsed: unknown
): EncryptedBackupFile {
  if (typeof parsed !== 'object' || parsed === null) {
    throw new BackupError('Invalid backup file format', 'INVALID_FILE_FORMAT');
  }
  const obj = parsed as Record<string, unknown>;

  if (obj.format !== 'voibackup') {
    throw new BackupError(
      'Not a valid Voi Wallet backup file',
      'INVALID_FILE_FORMAT'
    );
  }

  // Fields common to every version.
  if (typeof obj.ciphertext !== 'string' || obj.ciphertext.length === 0) {
    throw new BackupError('Invalid backup file format', 'INVALID_FILE_FORMAT');
  }
  if (typeof obj.hmac !== 'string' || obj.hmac.length === 0) {
    throw new BackupError('Invalid backup file format', 'INVALID_FILE_FORMAT');
  }
  if (!isHexOfBytes(obj.iv, IV_LENGTH)) {
    throw new BackupError('Invalid backup file format', 'INVALID_FILE_FORMAT');
  }
  if (!isHexOfBytes(obj.salt, SALT_LENGTH)) {
    throw new BackupError('Invalid backup file format', 'INVALID_FILE_FORMAT');
  }

  if (obj.version === 1) {
    const v1: EncryptedBackupFileV1 = {
      format: 'voibackup',
      version: 1,
      salt: obj.salt as string,
      iv: obj.iv as string,
      ciphertext: obj.ciphertext,
      hmac: obj.hmac,
    };
    return v1;
  }

  if (obj.version === 2) {
    if (obj.kdf !== 'scrypt') {
      throw new BackupError('Unsupported backup KDF', 'VERSION_MISMATCH');
    }
    // v2 writes the HMAC as exactly 32 bytes of lowercase hex. Reject a
    // malformed/short hmac up front so it never reaches the length-dependent
    // constant-time compare. (v1 hmac format is intentionally left unchecked.)
    if (!/^[0-9a-f]{64}$/.test(obj.hmac)) {
      throw new BackupError(
        'Invalid backup file format',
        'INVALID_FILE_FORMAT'
      );
    }
    const rawParams = obj.kdfParams;
    if (typeof rawParams !== 'object' || rawParams === null) {
      throw new BackupError(
        'Invalid backup KDF parameters',
        'INVALID_FILE_FORMAT'
      );
    }
    const { N, r, p, dkLen } = rawParams as Record<string, unknown>;
    if (
      typeof N !== 'number' ||
      typeof r !== 'number' ||
      typeof p !== 'number' ||
      typeof dkLen !== 'number'
    ) {
      throw new BackupError(
        'Invalid backup KDF parameters',
        'INVALID_FILE_FORMAT'
      );
    }
    // Cap the KDF parameters BEFORE scrypt runs (DoS guard).
    if (!isPowerOfTwo(N) || N > V2_MAX_N) {
      throw new BackupError(
        'Backup KDF parameters exceed safe limits',
        'INVALID_FILE_FORMAT'
      );
    }
    if (!Number.isInteger(r) || r < 1 || r > V2_MAX_R) {
      throw new BackupError(
        'Backup KDF parameters exceed safe limits',
        'INVALID_FILE_FORMAT'
      );
    }
    if (!Number.isInteger(p) || p < 1 || p > V2_MAX_P) {
      throw new BackupError(
        'Backup KDF parameters exceed safe limits',
        'INVALID_FILE_FORMAT'
      );
    }
    if (dkLen !== V2_DK_LEN) {
      throw new BackupError(
        'Backup KDF parameters exceed safe limits',
        'INVALID_FILE_FORMAT'
      );
    }
    // Bound the combined memory footprint (~128 * N * r bytes).
    if (128 * N * r > V2_MAX_KDF_MEMORY_BYTES) {
      throw new BackupError(
        'Backup KDF parameters exceed safe limits',
        'INVALID_FILE_FORMAT'
      );
    }

    const v2: EncryptedBackupFileV2 = {
      format: 'voibackup',
      version: 2,
      kdf: 'scrypt',
      kdfParams: { N, r, p, dkLen },
      salt: obj.salt as string,
      iv: obj.iv as string,
      ciphertext: obj.ciphertext,
      hmac: obj.hmac,
    };
    return v2;
  }

  throw new BackupError(
    `Unsupported backup version: ${String(obj.version)}`,
    'VERSION_MISMATCH'
  );
}

/**
 * Encrypt backup data with a user-provided password.
 *
 * New backups are written as v2 (scrypt + AES-256-CTR + encrypt-then-MAC).
 *
 * @param data - JSON string of backup data to encrypt
 * @param password - User's chosen password
 * @returns Encrypted backup file structure (v2)
 */
export async function encryptBackup(
  data: string,
  password: string
): Promise<EncryptedBackupFile> {
  let keyWordArray: CryptoJS.lib.WordArray | null = null;
  let hmacKeyWordArray: CryptoJS.lib.WordArray | null = null;

  try {
    // Generate random salt and IV
    const salt = await generateRandomHex(SALT_LENGTH);
    const iv = await generateRandomHex(IV_LENGTH);

    const kdfParams: ScryptKdfParams = {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      dkLen: KEY_LENGTH,
    };

    // Derive encryption + MAC keys from password (memory-hard scrypt)
    ({ keyWordArray, hmacKeyWordArray } = await deriveV2KeyMaterial(
      password,
      salt,
      kdfParams
    ));

    const ivWordArray = CryptoJS.enc.Hex.parse(iv);

    // Encrypt with AES-256-CTR (matches the existing cipher; the change is the
    // KDF + envelope, not the cipher)
    const encrypted = CryptoJS.AES.encrypt(data, keyWordArray, {
      iv: ivWordArray,
      mode: CryptoJS.mode.CTR,
      padding: CryptoJS.pad.NoPadding,
    });

    // Ciphertext as base64
    const ciphertext = encrypted.toString();

    // Encrypt-then-MAC. The MAC covers the canonical envelope params (AAD) plus
    // the ciphertext, binding N/r/p/dkLen/salt/iv/version to the ciphertext.
    const aad = canonicalV2Aad({
      version: 2,
      kdf: 'scrypt',
      kdfParams,
      salt,
      iv,
    });
    const hmac = CryptoJS.HmacSHA256(
      aad + ciphertext,
      hmacKeyWordArray
    ).toString();

    return {
      format: 'voibackup',
      version: 2,
      kdf: 'scrypt',
      kdfParams,
      salt,
      iv,
      ciphertext,
      hmac,
    };
  } catch (error) {
    throw new BackupError(
      `Encryption failed: ${error instanceof Error ? error.message : String(error)}`,
      'ENCRYPTION_FAILED'
    );
  } finally {
    // Scrub derived key material from memory (defense-in-depth)
    wipeWordArray(keyWordArray);
    wipeWordArray(hmacKeyWordArray);
  }
}

/**
 * Decrypt a v1 (legacy PBKDF2) backup envelope.
 *
 * LEGACY: kept intact for backward compatibility — do not change.
 */
async function decryptBackupV1(
  encrypted: EncryptedBackupFileV1,
  password: string
): Promise<string> {
  let keyMaterial: string | null = null;

  try {
    // Derive encryption key from password
    keyMaterial = deriveKeyPbkdf2(password, encrypted.salt);

    // Verify HMAC first (authenticate before decrypt)
    const hmacKey = CryptoJS.SHA256(keyMaterial + HMAC_KEY_TWEAK).toString();
    const computedHmac = CryptoJS.HmacSHA256(
      encrypted.ciphertext,
      hmacKey
    ).toString();

    if (computedHmac !== encrypted.hmac) {
      throw new BackupError(
        'Integrity check failed - wrong password or corrupted file',
        'INTEGRITY_CHECK_FAILED'
      );
    }

    // Prepare key and IV as WordArrays
    const keyWordArray = CryptoJS.enc.Hex.parse(keyMaterial);
    const ivWordArray = CryptoJS.enc.Hex.parse(encrypted.iv);

    // Decrypt
    const decrypted = CryptoJS.AES.decrypt(encrypted.ciphertext, keyWordArray, {
      iv: ivWordArray,
      mode: CryptoJS.mode.CTR,
      padding: CryptoJS.pad.NoPadding,
    });

    const plaintext = decrypted.toString(CryptoJS.enc.Utf8);

    if (!plaintext || plaintext.length === 0) {
      throw new BackupError(
        'Decryption failed - invalid result',
        'DECRYPTION_FAILED'
      );
    }

    return plaintext;
  } finally {
    if (keyMaterial) {
      keyMaterial = '0'.repeat(keyMaterial.length);
    }
  }
}

/**
 * Decrypt a v2 (scrypt) backup envelope.
 */
async function decryptBackupV2(
  encrypted: EncryptedBackupFileV2,
  password: string
): Promise<string> {
  let keyWordArray: CryptoJS.lib.WordArray | null = null;
  let hmacKeyWordArray: CryptoJS.lib.WordArray | null = null;

  try {
    // Derive encryption + MAC keys from password (memory-hard scrypt)
    ({ keyWordArray, hmacKeyWordArray } = await deriveV2KeyMaterial(
      password,
      encrypted.salt,
      encrypted.kdfParams
    ));

    // Verify the MAC over the canonical envelope params + ciphertext. Any
    // tampering with version/kdf/N/r/p/dkLen/salt/iv changes the recomputed AAD
    // and fails this check (in addition to salt/N/r/p already feeding scrypt).
    const aad = canonicalV2Aad(encrypted);
    const computedHmac = CryptoJS.HmacSHA256(
      aad + encrypted.ciphertext,
      hmacKeyWordArray
    ).toString();

    if (!constantTimeEqualHex(computedHmac, encrypted.hmac)) {
      throw new BackupError(
        'Integrity check failed - wrong password or corrupted file',
        'INTEGRITY_CHECK_FAILED'
      );
    }

    // Prepare IV as WordArray
    const ivWordArray = CryptoJS.enc.Hex.parse(encrypted.iv);

    // Decrypt
    const decrypted = CryptoJS.AES.decrypt(encrypted.ciphertext, keyWordArray, {
      iv: ivWordArray,
      mode: CryptoJS.mode.CTR,
      padding: CryptoJS.pad.NoPadding,
    });

    const plaintext = decrypted.toString(CryptoJS.enc.Utf8);

    if (!plaintext || plaintext.length === 0) {
      throw new BackupError(
        'Decryption failed - invalid result',
        'DECRYPTION_FAILED'
      );
    }

    return plaintext;
  } finally {
    // Scrub derived key material from memory (defense-in-depth)
    wipeWordArray(keyWordArray);
    wipeWordArray(hmacKeyWordArray);
  }
}

/**
 * Decrypt backup data with a user-provided password.
 *
 * Dispatches on the envelope `version`: v1 -> legacy PBKDF2, v2 -> scrypt.
 * Validates + caps the (untrusted) envelope first, so v2 parameter caps are
 * enforced before scrypt runs even when called directly.
 *
 * @param encrypted - Encrypted backup file structure
 * @param password - User's password
 * @returns Decrypted JSON string of backup data
 */
export async function decryptBackup(
  encrypted: EncryptedBackupFile,
  password: string
): Promise<string> {
  try {
    const envelope = validateEncryptedBackupFile(encrypted);

    if (envelope.version === 1) {
      return await decryptBackupV1(envelope, password);
    }
    return await decryptBackupV2(envelope, password);
  } catch (error) {
    if (error instanceof BackupError) {
      throw error;
    }
    throw new BackupError(
      `Decryption failed: ${error instanceof Error ? error.message : String(error)}`,
      'DECRYPTION_FAILED'
    );
  }
}

// --- Passphrase policy -----------------------------------------------------

/** Minimum passphrase length for a NEW backup. */
const MIN_PASSPHRASE_LENGTH = 12;

/**
 * A small denylist of obviously-weak passphrases (compared lowercased/trimmed).
 * This is a lightweight guard, not an exhaustive list — the goal is to reject
 * the most predictable choices, not to replace a full strength estimator.
 */
const COMMON_PASSWORD_DENYLIST = new Set([
  'password',
  'passw0rd',
  'password1',
  'password12',
  'password123',
  'password1234',
  'passwordpassword',
  'letmein',
  'letmein12345',
  'welcome',
  'welcome12345',
  'iloveyou',
  'iloveyou1234',
  'trustno1',
  'adminadmin',
  'administrator',
  'qwertyuiop',
  'qwerty123456',
  '1234567890',
  '123456789012',
  'voipassword',
  'voiwallet123',
  'voiwalletvoi',
  'changeme1234',
]);

/**
 * Base tokens that, once trailing digits/symbols are stripped, mark a
 * passphrase as predictable (e.g. "password1234", "qwerty!!!").
 */
const COMMON_BASE_TOKENS = new Set([
  'password',
  'passw0rd',
  'qwerty',
  'qwertyuiop',
  'letmein',
  'welcome',
  'iloveyou',
  'trustno',
  'monkey',
  'dragon',
  'admin',
  'changeme',
  'voiwallet',
  'voipassword',
]);

// Ordered character runs used to detect purely-sequential passphrases.
const SEQUENCES = [
  '0123456789',
  'abcdefghijklmnopqrstuvwxyz',
  'qwertyuiopasdfghjklzxcvbnm',
];

/**
 * True when the whole (lowercased) string is a contiguous run of one of the
 * known sequences (ascending or descending), e.g. "abcdefghijkl",
 * "123456789012", "qwertyuiopas".
 */
function isSequentialRun(lower: string): boolean {
  for (const seq of SEQUENCES) {
    const doubled = seq + seq; // covers digit "wrap" like ...9012
    const reversed = [...doubled].reverse().join('');
    if (doubled.includes(lower) || reversed.includes(lower)) {
      return true;
    }
  }
  return false;
}

/**
 * Lightweight weak-passphrase check (no heavy deps like zxcvbn). Rejects the
 * obviously-predictable inputs while deliberately NOT requiring character
 * composition, so strong multi-word passphrases still pass.
 */
function isWeakPassphrase(password: string): boolean {
  const lower = password.toLowerCase().trim();

  // Exact common passwords.
  if (COMMON_PASSWORD_DENYLIST.has(lower)) {
    return true;
  }

  // Common base word padded with a trailing digit/symbol run.
  const base = lower.replace(/[0-9!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?`~ ]+$/, '');
  if (base.length > 0 && COMMON_BASE_TOKENS.has(base)) {
    return true;
  }

  // Too little variety (e.g. "aaaaaaaaaaaa", "abababababab").
  if (new Set(lower).size < 5) {
    return true;
  }

  // Purely sequential runs (keyboard / alphabet / digits).
  if (isSequentialRun(lower)) {
    return true;
  }

  return false;
}

/**
 * Validate passphrase strength for a NEW backup.
 *
 * Policy (length-based, not composition rules):
 *  - `isValid` requires a minimum length of 12 AND rejects obviously-weak
 *    inputs (common-password denylist + lightweight entropy/sequence checks).
 *  - It intentionally does NOT mandate upper/lower/digit/symbol composition,
 *    which would reject strong passphrases like "correct horse battery staple".
 *  - The complexity `score` (0-4) is retained for the strength METER only and
 *    does not gate `isValid`.
 *
 * NOTE: import/restore validates against the backup file, not this policy, so
 * old backups created under the weaker rules are never blocked from importing.
 *
 * @param password - Password to validate
 * @returns Object with isValid boolean, meter score, and feedback messages
 */
export function validatePasswordStrength(password: string): {
  isValid: boolean;
  score: number; // 0-4
  feedback: string[];
} {
  const feedback: string[] = [];

  // --- Policy (gates isValid) ---
  let isValid = true;
  if (password.length < MIN_PASSPHRASE_LENGTH) {
    feedback.push(`Use at least ${MIN_PASSPHRASE_LENGTH} characters`);
    isValid = false;
  } else if (isWeakPassphrase(password)) {
    feedback.push('This password is too common or predictable');
    isValid = false;
  }

  // --- Strength meter score (hint only; does NOT gate isValid) ---
  let score = 0;
  if (password.length >= 8) score++;
  if (password.length >= 12) score++;
  if (password.length >= 16) score++;

  let classes = 0;
  if (/[a-z]/.test(password)) classes++;
  if (/[A-Z]/.test(password)) classes++;
  if (/\d/.test(password)) classes++;
  if (/[^a-zA-Z0-9]/.test(password)) classes++;
  if (classes >= 3) score++;

  score = Math.min(score, 4);
  // A passphrase that fails the policy should never read as strong.
  if (!isValid) {
    score = Math.min(score, 1);
  }

  return {
    isValid,
    score,
    feedback,
  };
}

/**
 * Get password strength label
 */
export function getPasswordStrengthLabel(score: number): string {
  switch (score) {
    case 0:
      return 'Very Weak';
    case 1:
      return 'Weak';
    case 2:
      return 'Fair';
    case 3:
      return 'Good';
    case 4:
      return 'Strong';
    default:
      return 'Unknown';
  }
}

/**
 * Get password strength color
 */
export function getPasswordStrengthColor(score: number): string {
  switch (score) {
    case 0:
      return '#EF4444'; // Red
    case 1:
      return '#F97316'; // Orange
    case 2:
      return '#EAB308'; // Yellow
    case 3:
      return '#22C55E'; // Green
    case 4:
      return '#10B981'; // Emerald
    default:
      return '#6B7280'; // Gray
  }
}
