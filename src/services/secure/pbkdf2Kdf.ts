/**
 * PBKDF2 backend — native-first with a self-validating CryptoJS fallback.
 *
 * WHY: `CryptoJS.PBKDF2` is pure JavaScript. At the PIN params (8000 iterations
 * of HMAC-SHA256) it costs ~1.2-1.36 SECONDS per derivation on Android Hermes
 * (measured on-device, TASK-311), and the unlock path runs it five times — once
 * per account plus the initial verification. That is ~6.3s of a ~7s window in
 * which the JS thread is pinned and the whole app is unresponsive.
 *
 * This is the same fix HT-138 applied to scrypt one layer over in `scryptKdf.ts`
 * (13-19s → 60-70ms). PBKDF2 sat on the SAME unlock path and was never migrated,
 * so it ended up costing ~20× the scrypt it runs next to. This module is
 * deliberately shaped like `scryptKdf.ts` so the two read as one pattern.
 *
 * SAFETY — the byte-parity gate: PBKDF2-HMAC-SHA256 is deterministic and
 * standard, so native output is BYTE-IDENTICAL to CryptoJS for the same
 * (password, salt, iterations, dkLen). Verified against both OpenSSL and
 * crypto-js while writing this. That makes it a pure backend swap: existing
 * stored hashes and wrapped blobs stay readable, with NO re-hash, NO re-wrap and
 * NO format change.
 *
 * Even so, a WRONG native backend (digest mismatch, encoding quirk, bad build)
 * used to WRITE a PIN hash would lock the user out of their own wallet. So
 * native is trusted ONLY after reproducing a hardcoded known-answer vector
 * exactly, once per session. On any mismatch, load failure or runtime error we
 * fall back to CryptoJS — always correct, just slow.
 *
 * FALLBACK CONTEXTS: jest (no native runtime) and any build without the native
 * module resolve to the CryptoJS path automatically.
 *
 * SECURITY: never logs the password, salt or derived bytes — only the backend
 * name and the parity result.
 */
import CryptoJS from 'crypto-js';
import 'crypto-js/pbkdf2';

export type Pbkdf2Backend = 'native' | 'js';

/**
 * Known-answer vector: PBKDF2-HMAC-SHA256(utf8(pw), hex(saltHex), 1000, 32).
 * Cross-checked to be identical under OpenSSL (`crypto.pbkdf2Sync`) and
 * `CryptoJS.PBKDF2` before being hardcoded here. Iterations are low so the
 * one-time parity check stays cheap even when it runs on the pure-JS backend.
 * Byte-parity is iteration-independent for correct PBKDF2, so a low-iteration
 * match proves the algorithm, digest and encoding all agree.
 */
export const PBKDF2_PARITY_KAT = {
  pw: 'voi-pbkdf2-parity-vector/v1',
  saltHex: '0123456789abcdef0123456789abcdef',
  iterations: 1000,
  dkLen: 32,
  expectedHex:
    '20457c536326859d20ce06a6422ecd283dab810e502acc2fd3abd689c916be66',
} as const;

/** Node-compatible native pbkdf2 signature (react-native-quick-crypto). */
type NativePbkdf2 = (
  password: Uint8Array,
  salt: Uint8Array,
  iterations: number,
  keylen: number,
  digest: string,
  callback: (err: Error | null, derivedKey: Uint8Array) => void
) => void;

let resolvedBackend: Pbkdf2Backend | undefined;
let backendResolution: Promise<Pbkdf2Backend> | undefined;
let nativeFn: NativePbkdf2 | null = null;

const hexToBytes = (hex: string): Uint8Array => {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
};

const bytesToHex = (bytes: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i].toString(16).padStart(2, '0');
  }
  return s;
};

/**
 * Static-literal require so Metro bundles the native module on device; throws in
 * jest / non-native contexts, where we transparently fall back to CryptoJS.
 */
function loadNativePbkdf2(): NativePbkdf2 | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const qc = require('react-native-quick-crypto');
    const fn = (qc?.pbkdf2 ?? qc?.default?.pbkdf2) as NativePbkdf2 | undefined;
    return typeof fn === 'function' ? fn : null;
  } catch {
    return null;
  }
}

function callNative(
  fn: NativePbkdf2,
  pw: Uint8Array,
  salt: Uint8Array,
  iterations: number,
  keyLength: number
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    try {
      fn(pw, salt, iterations, keyLength, 'sha256', (err, derivedKey) => {
        if (err) reject(err);
        else resolve(Uint8Array.from(derivedKey));
      });
    } catch (syncErr) {
      reject(syncErr);
    }
  });
}

/** The original pure-JS path, kept verbatim as the fallback. */
function jsPbkdf2(
  password: string,
  saltHex: string,
  iterations: number,
  keyLength: number
): string {
  const saltWA = CryptoJS.enc.Hex.parse(saltHex);
  const derived = CryptoJS.PBKDF2(password, saltWA, {
    keySize: keyLength / 4, // CryptoJS keySize is in 32-bit words
    iterations,

    hasher: (CryptoJS.algo as any).SHA256,
  });
  return derived.toString(CryptoJS.enc.Hex);
}

/** Resolve (once per session) whether native pbkdf2 is present AND byte-correct. */
async function resolveBackend(): Promise<Pbkdf2Backend> {
  if (resolvedBackend) return resolvedBackend;
  if (backendResolution) return backendResolution;

  backendResolution = (async (): Promise<Pbkdf2Backend> => {
    const native = loadNativePbkdf2();
    if (!native) {
      resolvedBackend = 'js';
      return 'js';
    }
    try {
      const out = await callNative(
        native,
        new TextEncoder().encode(PBKDF2_PARITY_KAT.pw),
        hexToBytes(PBKDF2_PARITY_KAT.saltHex),
        PBKDF2_PARITY_KAT.iterations,
        PBKDF2_PARITY_KAT.dkLen
      );
      if (bytesToHex(out) === PBKDF2_PARITY_KAT.expectedHex) {
        nativeFn = native;
        resolvedBackend = 'native';
        if (__DEV__) console.log('[pbkdf2Kdf] backend=native (byte-parity OK)');
        return 'native';
      }
      // Present but WRONG — must never write a PIN hash with it.
      console.warn(
        '[pbkdf2Kdf] native pbkdf2 failed byte-parity; using CryptoJS fallback'
      );
    } catch (e) {
      if (__DEV__) {
        console.log(
          '[pbkdf2Kdf] native pbkdf2 unavailable; CryptoJS fallback',
          e
        );
      }
    }
    resolvedBackend = 'js';
    return 'js';
  })();

  return backendResolution;
}

/**
 * PBKDF2-HMAC-SHA256, returned as a lowercase hex string of `keyLength` bytes.
 * Byte-identical across backends, so callers cannot observe which one ran.
 */
export async function pbkdf2Hex(
  password: string,
  saltHex: string,
  iterations: number,
  keyLength: number
): Promise<string> {
  const backend = await resolveBackend();
  if (backend === 'native' && nativeFn) {
    try {
      const out = await callNative(
        nativeFn,
        new TextEncoder().encode(password),
        hexToBytes(saltHex),
        iterations,
        keyLength
      );
      return bytesToHex(out);
    } catch (e) {
      // Passed parity but failed at runtime — degrade to CryptoJS for THIS call
      // (correctness over speed). Never surface an unwrapped native error.
      if (__DEV__) {
        console.log(
          '[pbkdf2Kdf] native call failed; CryptoJS for this call',
          e
        );
      }
    }
  }
  return jsPbkdf2(password, saltHex, iterations, keyLength);
}

/** Which backend is active ('unresolved' before the first pbkdf2Hex). Dev/tests. */
export function getPbkdf2Backend(): Pbkdf2Backend | 'unresolved' {
  return resolvedBackend ?? 'unresolved';
}

/** Test-only: reset the memoized backend so a suite can re-resolve. */
export function __resetPbkdf2BackendForTests(): void {
  resolvedBackend = undefined;
  backendResolution = undefined;
  nativeFn = null;
}
