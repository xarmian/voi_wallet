// Regression tests for WalletConnect v1 log hygiene (PLAN-260, TASK-263).
//
// The headline case: `decryptRequest` used to echo the first 200 characters of
// the DECRYPTED payload into console.error when a request failed structure
// validation. That content is entirely peer-controlled, and the connected dApp
// shares the session key — so a malformed request was enough to push the key
// into device logs and crash reports.
//
// Injected-ERROR tests would never have caught this: nothing throws on that
// path. It needs a real decrypt of a real payload, which is what these do.

import { encryptMessage } from '../crypto';
import { decryptRequest, parseEncryptedPayload } from '../protocol';

// Throwaway 32-byte hex key — not a real session key.
const SESSION_KEY = 'a1b2c3d4'.repeat(8);

const captureConsole = () => {
  const calls: string[] = [];
  const push = (...args: unknown[]) => {
    calls.push(
      args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
    );
  };
  const spies = [
    jest.spyOn(console, 'error').mockImplementation(push),
    jest.spyOn(console, 'warn').mockImplementation(push),
    jest.spyOn(console, 'log').mockImplementation(push),
  ];
  return {
    text: () => calls.join('\n'),
    restore: () => spies.forEach((s) => s.mockRestore()),
  };
};

afterEach(() => {
  jest.restoreAllMocks();
});

describe('decryptRequest never logs peer-controlled payload', () => {
  it('does not echo the session key when the peer sends it inside a malformed request', async () => {
    // A structurally-invalid JSON-RPC request (no id/jsonrpc/method, and not a
    // response) whose body embeds the session key — exactly what a hostile or
    // buggy peer could send to get the key written to the log.
    const hostile = JSON.stringify({
      note: `here is your key ${SESSION_KEY}`,
      alsoThis: `key=${SESSION_KEY}`,
    });

    const encrypted = await encryptMessage(hostile, SESSION_KEY);
    const payload = parseEncryptedPayload(JSON.stringify(encrypted));
    expect(payload).not.toBeNull();

    const capture = captureConsole();
    const result = await decryptRequest(payload!, SESSION_KEY);
    const logged = capture.text();
    capture.restore();

    // The request is rejected...
    expect(result).toBeNull();
    // ...and it was the structure-validation path that rejected it.
    expect(logged).toContain('Invalid JSON-RPC request structure');

    // ...but nothing from the payload reached the log.
    expect(logged).not.toContain(SESSION_KEY);
    expect(logged).not.toContain('here is your key');
    expect(logged).not.toContain('alsoThis');
  });

  it('does not echo arbitrary peer content or object keys', async () => {
    const hostile = JSON.stringify({
      'peer-chosen-field-name': 'peer-chosen-value',
    });

    const encrypted = await encryptMessage(hostile, SESSION_KEY);
    const payload = parseEncryptedPayload(JSON.stringify(encrypted));

    const capture = captureConsole();
    await decryptRequest(payload!, SESSION_KEY);
    const logged = capture.text();
    capture.restore();

    expect(logged).not.toContain('peer-chosen-field-name');
    expect(logged).not.toContain('peer-chosen-value');
  });

  it('still logs the diagnostic shape flags', async () => {
    const encrypted = await encryptMessage(JSON.stringify({}), SESSION_KEY);
    const payload = parseEncryptedPayload(JSON.stringify(encrypted));

    const capture = captureConsole();
    await decryptRequest(payload!, SESSION_KEY);
    const logged = capture.text();
    capture.restore();

    expect(logged).toContain('hasId');
    expect(logged).toContain('hasJsonrpc');
    expect(logged).toContain('hasMethod');
  });

  it('does not log the key when decryption fails outright', async () => {
    const encrypted = await encryptMessage('{"a":1}', SESSION_KEY);
    const payload = parseEncryptedPayload(JSON.stringify(encrypted));

    // Decrypt with the WRONG key: the HMAC check fails.
    const wrongKey = 'f'.repeat(64);

    const capture = captureConsole();
    const result = await decryptRequest(payload!, wrongKey);
    const logged = capture.text();
    capture.restore();

    expect(result).toBeNull();
    expect(logged).not.toContain(SESSION_KEY);
    expect(logged).not.toContain(wrongKey);
    // Our own measurements survive — they distinguish a truncated payload from
    // a wrong-key HMAC failure.
    expect(logged).toContain('payloadDataLength');
  });

  it('a valid request is returned and logs nothing', async () => {
    const valid = JSON.stringify({
      id: 1,
      jsonrpc: '2.0',
      method: 'algo_signTxn',
      params: [[]],
    });

    const encrypted = await encryptMessage(valid, SESSION_KEY);
    const payload = parseEncryptedPayload(JSON.stringify(encrypted));

    const capture = captureConsole();
    const result = await decryptRequest(payload!, SESSION_KEY);
    const logged = capture.text();
    capture.restore();

    expect(result).not.toBeNull();
    expect(result!.method).toBe('algo_signTxn');
    expect(logged).toBe('');
  });
});
