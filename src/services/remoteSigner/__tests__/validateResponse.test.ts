/**
 * Unit tests for the STRICT response-envelope validation (DR-6 step 1 /
 * TASK-143). This is the pure core that `RemoteSignerService.validateResponse`
 * delegates to; it runs BEFORE any signed blob is mapped to a request
 * transaction or decoded: it enforces a plain `res` object stamped with the
 * unchanged protocol version and, for a success response, an exact 0..n-1
 * signature permutation of bounded, canonical-base64 blobs. These tests
 * exercise those bounds with structurally-shaped payloads (no real signatures
 * are needed — signature/content checks live in the separate content-binding
 * verifier). Importing the pure module keeps the suite off the native service
 * graph, exactly like the pairing tests.
 */

import { validateResponseEnvelope } from '../responseValidation';
import {
  RemoteSignerRequest,
  RemoteSignerResponse,
  REMOTE_SIGNER_CONSTANTS,
} from '@/types/remoteSigner';

/** Mirror `RemoteSignerService.validateResponse`'s delegation. */
const validate = (
  response: RemoteSignerResponse,
  request: RemoteSignerRequest
): { valid: boolean; error?: string } =>
  validateResponseEnvelope(response, request.id, request.txns.length);

const REQUEST_ID = 'req-1234-5678';

function makeRequest(n: number): RemoteSignerRequest {
  return {
    v: REMOTE_SIGNER_CONSTANTS.PROTOCOL_VERSION,
    t: 'req',
    id: REQUEST_ID,
    ts: 1700000000000,
    net: 'voi-mainnet',
    gh: Buffer.from(new Uint8Array(32).fill(1)).toString('base64'),
    txns: Array.from({ length: n }, (_, i) => ({
      i,
      b: Buffer.from(new Uint8Array([i, i, i])).toString('base64'),
      s: 'SENDER',
    })),
  };
}

function makeResponse(
  sigs: { i: number; b: string }[] | undefined,
  overrides: Partial<RemoteSignerResponse> = {}
): RemoteSignerResponse {
  return {
    v: REMOTE_SIGNER_CONSTANTS.PROTOCOL_VERSION,
    t: 'res',
    id: REQUEST_ID,
    ts: 1700000000001,
    ok: true,
    sigs,
    ...overrides,
  } as RemoteSignerResponse;
}

/** Canonical base64 of arbitrary bytes (a stand-in for a signed blob). */
const blob = (seed: number): string =>
  Buffer.from(new Uint8Array(64).fill(seed)).toString('base64');

describe('RemoteSignerService.validateResponse — strict envelope', () => {
  it('accepts a well-formed success envelope (exact 0..n-1 permutation)', () => {
    const request = makeRequest(2);
    const response = makeResponse([
      { i: 1, b: blob(1) },
      { i: 0, b: blob(2) },
    ]);
    expect(validate(response, request)).toEqual({
      valid: true,
    });
  });

  it('treats an error response (ok:false) as structurally valid', () => {
    const request = makeRequest(1);
    const response = makeResponse(undefined, {
      ok: false,
      sigs: undefined,
      err: { c: 'REJECTED', m: 'user rejected' },
    });
    expect(validate(response, request).valid).toBe(true);
  });

  it('rejects a mismatched request id', () => {
    const request = makeRequest(1);
    const response = makeResponse([{ i: 0, b: blob(1) }], { id: 'other-id' });
    const result = validate(response, request);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/id/i);
  });

  it('rejects a protocol version mismatch (unchanged PROTOCOL_VERSION)', () => {
    const request = makeRequest(1);
    const response = makeResponse([{ i: 0, b: blob(1) }], {
      v: 2 as unknown as 1,
    });
    const result = validate(response, request);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/version/i);
  });

  it('rejects a wrong signature count', () => {
    const request = makeRequest(2);
    const response = makeResponse([{ i: 0, b: blob(1) }]);
    const result = validate(response, request);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/count/i);
  });

  it('rejects a duplicate signature index', () => {
    const request = makeRequest(2);
    const response = makeResponse([
      { i: 0, b: blob(1) },
      { i: 0, b: blob(2) },
    ]);
    const result = validate(response, request);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/duplicate/i);
  });

  it('rejects an out-of-range index (non-permutation)', () => {
    const request = makeRequest(2);
    const response = makeResponse([
      { i: 0, b: blob(1) },
      { i: 9, b: blob(2) },
    ]);
    const result = validate(response, request);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/out of range|integer/i);
  });

  it('rejects a non-integer index', () => {
    const request = makeRequest(1);
    const response = makeResponse([{ i: 0.5, b: blob(1) }]);
    const result = validate(response, request);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/out of range|integer/i);
  });

  it('rejects a non-canonical base64 blob', () => {
    const request = makeRequest(1);
    // 'AAAAA' passes the charset regex but fails the canonical round-trip
    // (decodes to 3 bytes → re-encodes to 'AAAA').
    const response = makeResponse([{ i: 0, b: 'AAAAA' }]);
    const result = validate(response, request);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/base64/i);
  });

  it('rejects a blob containing illegal base64 characters', () => {
    const request = makeRequest(1);
    const response = makeResponse([{ i: 0, b: 'not valid base64!!' }]);
    const result = validate(response, request);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/base64/i);
  });

  it('rejects an over-long blob (DoS bound)', () => {
    const request = makeRequest(1);
    const tooLong = 'A'.repeat(
      REMOTE_SIGNER_CONSTANTS.MAX_SIGNED_TXN_B64_LENGTH + 4
    );
    const response = makeResponse([{ i: 0, b: tooLong }]);
    const result = validate(response, request);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/base64/i);
  });

  it('rejects a missing signatures array on a success response', () => {
    const request = makeRequest(1);
    const response = makeResponse(undefined);
    const result = validate(response, request);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/signatures array/i);
  });

  it('rejects a wrong response type discriminator', () => {
    const request = makeRequest(1);
    const response = makeResponse([{ i: 0, b: blob(1) }], {
      t: 'req' as unknown as 'res',
    });
    const result = validate(response, request);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/type/i);
  });
});
