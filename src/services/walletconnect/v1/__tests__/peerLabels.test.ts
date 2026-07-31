// Unit tests for peer-controlled log labels (PLAN-260, TASK-263).
//
// Raised by Codex review of the first log-hygiene pass: applying the shared
// SECRET-PATTERN redactor to arbitrary peer text is not sanitization. Bare
// 64-hex is deliberately preserved by that redactor (genesis hashes / txids),
// so a peer able to set a free-text field could have put the session key
// straight into the log.

import { describePeerMethod } from '../peerLabels';

// Throwaway vector — not a real session key.
const SESSION_KEY = 'a1b2c3d4'.repeat(8);

describe('describePeerMethod', () => {
  it('echoes known method names verbatim', () => {
    expect(describePeerMethod('algo_signTxn')).toBe('algo_signTxn');
    expect(describePeerMethod('wc_sessionRequest')).toBe('wc_sessionRequest');
    expect(describePeerMethod('personal_sign')).toBe('personal_sign');
  });

  it('NEVER echoes a session key sent as a method name', () => {
    const out = describePeerMethod(SESSION_KEY);
    expect(out).not.toContain(SESSION_KEY);
    expect(out).toBe('[unrecognized method, 64 chars]');
  });

  it('does not leak even a PREFIX of an unknown value', () => {
    const out = describePeerMethod(SESSION_KEY);
    // No run of the key survives — not even the first few characters, which a
    // truncating implementation would have kept.
    for (let n = 4; n <= 16; n += 4) {
      expect(out).not.toContain(SESSION_KEY.slice(0, n));
    }
  });

  it('reports length so an operator still learns something', () => {
    expect(describePeerMethod('x'.repeat(7))).toBe(
      '[unrecognized method, 7 chars]'
    );
    expect(describePeerMethod('')).toBe('[unrecognized method, 0 chars]');
  });

  it('does not echo a wc: URI or any other injected payload', () => {
    const uri = `wc:topic@1?bridge=https://b.example&key=${SESSION_KEY}`;
    const out = describePeerMethod(uri);
    expect(out).not.toContain(SESSION_KEY);
    expect(out).not.toContain('wc:');
    expect(out).not.toContain('b.example');
  });

  it('handles non-string input without throwing or echoing', () => {
    expect(describePeerMethod(undefined)).toBe(
      '[non-string method: undefined]'
    );
    expect(describePeerMethod(null)).toBe('[non-string method: object]');
    expect(describePeerMethod(42)).toBe('[non-string method: number]');
    expect(describePeerMethod({ secret: SESSION_KEY })).not.toContain(
      SESSION_KEY
    );
  });
});
