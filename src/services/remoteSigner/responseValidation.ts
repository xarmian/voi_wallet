/**
 * Strict remote-signer RESPONSE envelope validation — pure core (DR-6 step 1).
 *
 * This module is intentionally dependency-light (only the remote-signer type
 * constants) so it can be unit-tested as a Layer-1 utility without pulling in
 * the secure-storage / wallet / native service graph that `./index` drags in.
 * `RemoteSignerService.validateResponse` delegates here.
 *
 * The envelope is validated BEFORE any signed blob is mapped onto a request
 * transaction or decoded: the response must be a plain `res` object stamped with
 * the UNCHANGED protocol version and, for a success response, its signatures
 * must form an EXACT `0..n-1` permutation of bounded, canonical-base64 blobs.
 * Content-binding and signature verification are the separate concern of
 * `verifyRemoteSignerResponse` (`@/utils/signatureVerification`).
 */

import { REMOTE_SIGNER_CONSTANTS } from '@/types/remoteSigner';

/** True for a plain (Object.prototype / null-proto) object — rejects arrays & class instances. */
export function isPlainObject(x: unknown): x is Record<string, unknown> {
  if (typeof x !== 'object' || x === null) return false;
  if (Array.isArray(x)) return false;
  const proto = Object.getPrototypeOf(x);
  return proto === Object.prototype || proto === null;
}

/**
 * True iff `s` is a non-empty, bounded, canonical base64 string. Enforced during
 * strict envelope validation BEFORE any blob is decoded, so a hostile response
 * cannot force an unbounded allocation or slip a non-canonical encoding past the
 * downstream decode. The round-trip re-encode rejects sloppy padding / extra
 * bits / embedded whitespace.
 */
export function isBoundedStrictBase64(s: unknown, maxLen: number): boolean {
  if (typeof s !== 'string') return false;
  if (s.length === 0 || s.length > maxLen) return false;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return false;
  try {
    const buf = Buffer.from(s, 'base64');
    return Buffer.from(buf).toString('base64') === s;
  } catch {
    return false;
  }
}

/**
 * Strictly validate a response ENVELOPE against its (trusted) request id and
 * transaction count. Never trusts the wire.
 *
 * @param response  untrusted, freshly-parsed response payload
 * @param requestId the id of the request this response must answer
 * @param txnCount  the number of transactions in the request
 */
export function validateResponseEnvelope(
  response: unknown,
  requestId: string,
  txnCount: number
): { valid: boolean; error?: string } {
  const r = response;

  if (!isPlainObject(r)) {
    return { valid: false, error: 'Response is not a plain object' };
  }

  if (r.t !== 'res') {
    return { valid: false, error: 'Response type is not "res"' };
  }

  // Request ID must match.
  if (r.id !== requestId) {
    return { valid: false, error: 'Response ID does not match request' };
  }

  // Protocol version — UNCHANGED (must equal the shared PROTOCOL_VERSION).
  if (r.v !== REMOTE_SIGNER_CONSTANTS.PROTOCOL_VERSION) {
    return { valid: false, error: 'Protocol version mismatch' };
  }

  if (typeof r.ok !== 'boolean') {
    return { valid: false, error: 'Response ok flag is not a boolean' };
  }

  // Error responses are structurally valid (unsuccessful, not malformed).
  if (r.ok === false) {
    return { valid: true };
  }

  // --- success envelope: strict shape BEFORE any blob↔request mapping --------
  const sigs = r.sigs;
  if (!Array.isArray(sigs)) {
    return { valid: false, error: 'Response is missing the signatures array' };
  }

  if (sigs.length !== txnCount) {
    return {
      valid: false,
      error: 'Signature count does not match transaction count',
    };
  }

  // Each index must be an integer forming an EXACT 0..n-1 permutation, and each
  // blob a bounded, canonical base64 string.
  const seen = new Set<number>();
  for (const sig of sigs) {
    if (!isPlainObject(sig)) {
      return { valid: false, error: 'Signature entry is not a plain object' };
    }
    const idx = sig.i;
    if (
      typeof idx !== 'number' ||
      !Number.isInteger(idx) ||
      idx < 0 ||
      idx >= txnCount
    ) {
      return {
        valid: false,
        error: 'Signature index is out of range or not an integer',
      };
    }
    if (seen.has(idx)) {
      return { valid: false, error: 'Duplicate signature index' };
    }
    seen.add(idx);
    if (
      !isBoundedStrictBase64(
        sig.b,
        REMOTE_SIGNER_CONSTANTS.MAX_SIGNED_TXN_B64_LENGTH
      )
    ) {
      return {
        valid: false,
        error: 'Signature blob is not bounded, canonical base64',
      };
    }
  }
  // `seen` now holds txnCount distinct in-range integers => exact permutation.

  return { valid: true };
}
