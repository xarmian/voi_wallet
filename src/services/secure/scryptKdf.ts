/**
 * At-rest scrypt KDF backend — native-first with a self-validating @noble fallback.
 *
 * WHY: pure-JS @noble/hashes scrypt at the at-rest params (N=2^14 / 16 MiB) takes
 * ~13-19 SECONDS per derivation on Android Hermes (measured on-device, HT-138),
 * which makes v2-at-rest unusable (first sign of a session pays it). A NATIVE
 * scrypt (react-native-quick-crypto, OpenSSL EVP_PBE_scrypt = RFC 7914) collapses
 * that to tens of ms. Because standard scrypt is deterministic, native output is
 * BYTE-IDENTICAL to @noble for the same (secret, salt, N, r, p, dkLen), so this is
 * a pure backend swap: existing v2 blobs stay decryptable, NO envelope change.
 *
 * SAFETY — the byte-parity gate: a WRONG native backend (param mismatch, encoding
 * quirk, a bad build) that we used to WRITE blobs would produce ciphertext neither
 * backend can read → key loss. So native is trusted ONLY after it reproduces a
 * hardcoded @noble known-answer vector (KAT) exactly, once per session. On any
 * mismatch, load failure, or runtime error we fall back to @noble — always correct,
 * just slow. The shim therefore can NEVER emit a blob under an unverified backend.
 *
 * FALLBACK CONTEXTS: jest (no native runtime; the module is mocked empty) and any
 * build without the native module resolve to @noble, as does a native backend
 * that throws or mismatches during the parity check. A native call that fails
 * after parity passed degrades to @noble for that call only. Every one of these
 * paths warns (see LOUD FALLBACK below), so they are expected noise under jest.
 *
 * SECURITY: never logs the secret or derived bytes (only the backend name, the
 * parity result and, on a native error, a fixed error-class label).
 *
 * LOUD FALLBACK (DR-7 / HT-377): every fallback path warns via `console.warn`,
 * which release bundles keep (babel.config.js strips only console.log), so a
 * release build that fell back to @noble is distinguishable from a native one.
 * The warnings carry ONLY the backend name and the error class name.
 * `backend=` is the backend SELECTED for the session; the per-call warning
 * (`backend=native: ... @noble for this call`) means that one call fell back.
 */
import { scryptAsync } from '@noble/hashes/scrypt';
import { utf8ToBytes, bytesToHex } from '@noble/hashes/utils';

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
  dkLen: number;
  maxmem?: number;
}

/** Default OpenSSL/noble memory ceiling (bytes). Comfortably above 128*N*r. */
const DEFAULT_MAXMEM = 256 * 1024 * 1024;

/**
 * Known-answer vector: scrypt(utf8(pw), utf8(salt), N=1024, r=8, p=1, dkLen=32)
 * computed with @noble/hashes 1.7.0. Native must reproduce `expectedHex` exactly
 * before it is trusted. N is small so the one-time parity check is cheap even if a
 * backend runs it in pure JS. (Byte-parity is param-independent for correct scrypt,
 * so a small-N match proves the algorithm/encoding agree.)
 */
export const SCRYPT_PARITY_KAT = {
  pw: 'voi-scrypt-parity-vector/v1',
  salt: 'voi-parity-salt-0123456789abcdef',
  params: { N: 1024, r: 8, p: 1, dkLen: 32 } as ScryptParams,
  expectedHex:
    '5679f6ba7791ebc92b0c092b6cf7e632de318fa3a0250dd8753a275bdc6cc6af',
} as const;

/** Node-compatible native scrypt signature (react-native-quick-crypto). */
type NativeScrypt = (
  password: Uint8Array,
  salt: Uint8Array,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem?: number },
  callback: (err: Error | null, derivedKey: Uint8Array) => void
) => void;

type Backend = 'native' | 'js';

let resolvedBackend: Backend | undefined;
let backendResolution: Promise<Backend> | undefined;
let nativeFn: NativeScrypt | null = null;

/**
 * Static-literal require so Metro bundles the native module on device; throws in
 * jest / non-native contexts, where we transparently fall back to @noble.
 */
function loadNativeScrypt(): NativeScrypt | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const qc = require('react-native-quick-crypto');
    const fn = (qc?.scrypt ?? qc?.default?.scrypt) as NativeScrypt | undefined;
    return typeof fn === 'function' ? fn : null;
  } catch {
    return null;
  }
}

function callNative(
  fn: NativeScrypt,
  pw: Uint8Array,
  salt: Uint8Array,
  params: ScryptParams
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    try {
      fn(
        pw,
        salt,
        params.dkLen,
        {
          N: params.N,
          r: params.r,
          p: params.p,
          maxmem: params.maxmem ?? DEFAULT_MAXMEM,
        },
        (err, derivedKey) => {
          if (err) reject(err);
          else resolve(Uint8Array.from(derivedKey));
        }
      );
    } catch (syncErr) {
      reject(syncErr);
    }
  });
}

/** Standard ECMAScript error classes a fallback warning may name. */
const KNOWN_ERROR_CLASSES = [
  'Error',
  'TypeError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'EvalError',
  'URIError',
  'AggregateError',
] as const;

/**
 * The error's class, for the loud-fallback warnings. Deliberately NOT the
 * message, stack or the error object itself: a native error's text could echo
 * its inputs. `name` is runtime data too, so it is never passed through: the
 * result is always one of the constants below, chosen by equality.
 */
function errorClass(e: unknown): string {
  // Total: a hostile error (throwing `name` getter, Proxy traps) must never
  // stop the fallback from running.
  try {
    if (!(e instanceof Error)) return 'non-Error';
    const name: unknown = e.name;
    return KNOWN_ERROR_CLASSES.find((k) => k === name) ?? 'Error(custom)';
  } catch {
    return 'Error(unreadable)';
  }
}

async function nobleScrypt(
  pw: Uint8Array,
  salt: Uint8Array,
  params: ScryptParams
): Promise<Uint8Array> {
  return scryptAsync(pw, salt, {
    N: params.N,
    r: params.r,
    p: params.p,
    dkLen: params.dkLen,
    maxmem: params.maxmem ?? DEFAULT_MAXMEM,
  });
}

/** Resolve (once per session) whether native scrypt is present AND byte-correct. */
async function resolveBackend(): Promise<Backend> {
  if (resolvedBackend) return resolvedBackend;
  if (backendResolution) return backendResolution;

  backendResolution = (async (): Promise<Backend> => {
    const native = loadNativeScrypt();
    if (!native) {
      console.warn(
        '[scryptKdf] backend=js: native scrypt module unavailable; using @noble fallback'
      );
      resolvedBackend = 'js';
      return 'js';
    }
    try {
      const out = await callNative(
        native,
        utf8ToBytes(SCRYPT_PARITY_KAT.pw),
        utf8ToBytes(SCRYPT_PARITY_KAT.salt),
        SCRYPT_PARITY_KAT.params
      );
      if (bytesToHex(out) === SCRYPT_PARITY_KAT.expectedHex) {
        nativeFn = native;
        resolvedBackend = 'native';
        if (__DEV__) console.log('[scryptKdf] backend=native (byte-parity OK)');
        return 'native';
      }
      // Present but WRONG — must never write blobs with it.
      console.warn(
        '[scryptKdf] backend=js: native scrypt failed byte-parity; using @noble fallback'
      );
    } catch (e) {
      console.warn(
        '[scryptKdf] backend=js: native scrypt threw during parity check; using @noble fallback',
        errorClass(e)
      );
    }
    resolvedBackend = 'js';
    return 'js';
  })();

  return backendResolution;
}

/**
 * Derive raw scrypt output for the at-rest KDF. Byte-identical across backends.
 * `secret` is UTF-8 encoded (matching @noble's string handling) so output equals
 * the pre-existing @noble-written blobs.
 */
export async function scryptRaw(
  secret: string,
  saltBytes: Uint8Array,
  params: ScryptParams
): Promise<Uint8Array> {
  const pw = utf8ToBytes(secret);
  const backend = await resolveBackend();
  if (backend === 'native' && nativeFn) {
    try {
      return await callNative(nativeFn, pw, saltBytes, params);
    } catch (e) {
      // Passed parity but failed at runtime — degrade to @noble for THIS call
      // (correctness over speed). Never surface an unwrapped native error.
      console.warn(
        '[scryptKdf] backend=native: native call failed; @noble for this call',
        errorClass(e)
      );
    }
  }
  return nobleScrypt(pw, saltBytes, params);
}

/** Which backend is active ('unresolved' before the first scryptRaw). For dev logs/tests. */
export function getScryptBackend(): Backend | 'unresolved' {
  return resolvedBackend ?? 'unresolved';
}

/** Test-only: reset the memoized backend so a suite can re-resolve. */
export function __resetScryptBackendForTests(): void {
  resolvedBackend = undefined;
  backendResolution = undefined;
  nativeFn = null;
}
