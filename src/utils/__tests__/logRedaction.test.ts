// Unit tests for the shared log redactor (PLAN-260, TASK-263).
//
// This is a pure util on the crypto-adjacent surface, so it carries its own
// tests per the project's pure-util rule. The v1 `key=` rule is the one added by
// PLAN-260; the rest are hoisted behavior that must not regress.

import { redactSensitiveForLog, redactError } from '../logRedaction';

// Throwaway vectors — not real keys or accounts.
const V1_KEY = 'a1b2c3d4'.repeat(8); // 64 hex chars
const SYM_KEY = 'f'.repeat(64);
const ADDRESS = 'A'.repeat(58);

describe('WalletConnect v1 session key (`key=`)', () => {
  it('redacts a bare key= token carrying a long hex run', () => {
    const out = redactSensitiveForLog(`bridge failed for key=${V1_KEY} oops`);
    expect(out).not.toContain(V1_KEY);
    expect(out).toContain('key=[redacted]');
  });

  it('redacts the percent-encoded form', () => {
    const out = redactSensitiveForLog(`params key%3D${V1_KEY}`);
    expect(out).not.toContain(V1_KEY);
    expect(out).toContain('key=[redacted]');
  });

  it('is case-insensitive on both token and hex', () => {
    const upper = V1_KEY.toUpperCase();
    const out = redactSensitiveForLog(`KEY=${upper}`);
    expect(out).not.toContain(upper);
  });

  it('does NOT blanket-redact ordinary short key= params', () => {
    const out = redactSensitiveForLog('api_key=abc123&sort_key=name');
    expect(out).toContain('abc123');
    expect(out).toContain('name');
  });
});

describe('a v1 pairing URI is redacted whole', () => {
  it('removes the key from a wc: URI', () => {
    const uri = `wc:topic-1@1?bridge=https%3A%2F%2Fb.example&key=${V1_KEY}`;
    const out = redactSensitiveForLog(`failed to parse ${uri}`);
    expect(out).not.toContain(V1_KEY);
    expect(out).toContain('wc:[redacted]');
  });

  it('removes the symKey from a v2 wc: URI', () => {
    const uri = `wc:topic-2@2?relay-protocol=irn&symKey=${SYM_KEY}`;
    const out = redactSensitiveForLog(uri);
    expect(out).not.toContain(SYM_KEY);
  });

  it('handles the percent-encoded wc%3A form', () => {
    const out = redactSensitiveForLog(`wc%3Atopic%401%3Fkey%3D${V1_KEY}`);
    expect(out).not.toContain(V1_KEY);
  });
});

describe('hoisted behavior must not regress', () => {
  it('redacts a stray symKey token outside a URI', () => {
    const out = redactSensitiveForLog(`symKey=${SYM_KEY}`);
    expect(out).toBe('symKey=[redacted]');
  });

  it('redacts any scheme://… URL whole', () => {
    const out = redactSensitiveForLog('open https://example.com/a?b=c now');
    expect(out).toContain('https://[redacted]');
    expect(out).not.toContain('example.com');
  });

  it('redacts a full Algorand address, keeping only a short prefix', () => {
    const out = redactSensitiveForLog(`from ${ADDRESS} to somewhere`);
    expect(out).not.toContain(ADDRESS);
    expect(out).toContain('AAAAAA…[redacted]');
  });

  it('redacts an address used as a pseudo-scheme', () => {
    const out = redactSensitiveForLog(`${ADDRESS}://path`);
    expect(out).not.toContain(ADDRESS);
  });
});

describe('a bare 64-hex run is deliberately preserved', () => {
  // Genesis hashes and transaction IDs are also 64 hex chars. Blanket-redacting
  // them would gut diagnosability; the control for a bare v1 key is that the v1
  // key-handling paths log fixed messages and never error text.
  it('leaves an unprefixed hex run intact', () => {
    const txid = 'c'.repeat(64);
    expect(redactSensitiveForLog(`confirmed ${txid}`)).toContain(txid);
  });
});

describe('redactError', () => {
  it('redacts the message of an Error', () => {
    const out = redactError(new Error(`connect failed key=${V1_KEY}`));
    expect(out).not.toContain(V1_KEY);
    expect(out).toContain('key=[redacted]');
  });

  it('stringifies and redacts a non-Error', () => {
    expect(redactError(`key=${V1_KEY}`)).toContain('key=[redacted]');
    expect(redactError(null)).toBe('null');
    expect(redactError(undefined)).toBe('undefined');
  });

  it('returns a string, never the error object', () => {
    expect(typeof redactError(new Error('boom'))).toBe('string');
  });
});
