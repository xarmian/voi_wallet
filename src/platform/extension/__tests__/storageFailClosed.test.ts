// Unit tests for TASK-213 (Codex round-3 P0): the EXTENSION storage adapter must
// distinguish a genuine read FAILURE (throw) from genuine ABSENCE (resolve null),
// so the auth-init strict reads can fail CLOSED on the extension too. Previously
// a chrome.runtime.lastError read error was swallowed and resolved null —
// indistinguishable from "no value", letting a storage failure masquerade as
// absence (a fail-OPEN at auth init).
//
// SECURITY NOTE: no real secret material is used.

type GetCb = (result: Record<string, unknown>) => void;

// `hasChromeStorage` in storage.ts is captured at MODULE LOAD, so `chrome` must
// exist BEFORE the adapter is required. Install a mutable chrome shim first, then
// require the module (require, not import, so this ordering is guaranteed).
let currentGet: (keys: string[], cb: GetCb) => void = (_keys, cb) => cb({});
let currentLastError: { message: string } | undefined;

(globalThis as { chrome?: unknown }).chrome = {
  storage: {
    local: {
      get: (keys: string[], cb: GetCb) => currentGet(keys, cb),
    },
  },
  runtime: {
    get lastError() {
      return currentLastError;
    },
  },
};

const { ExtensionStorageAdapter } = require('../storage');

describe('ExtensionStorageAdapter.getItem — failure vs absence (TASK-213)', () => {
  let adapter: InstanceType<typeof ExtensionStorageAdapter>;

  beforeEach(() => {
    adapter = new ExtensionStorageAdapter();
    currentLastError = undefined;
    currentGet = (_keys, cb) => cb({});
  });

  it('resolves the stored VALUE when present (no error)', async () => {
    currentGet = (keys, cb) => cb({ [keys[0]]: 'stored-value' });
    await expect(adapter.getItem('k')).resolves.toBe('stored-value');
  });

  it('resolves NULL for genuine absence (key missing, no error)', async () => {
    currentGet = (_keys, cb) => cb({});
    await expect(adapter.getItem('k')).resolves.toBeNull();
  });

  it('THROWS (fails closed) when chrome.runtime.lastError is set — a read FAILURE, not absence', async () => {
    currentLastError = { message: 'chrome storage read failed' };
    currentGet = (_keys, cb) => cb({});
    await expect(adapter.getItem('k')).rejects.toThrow(
      'chrome storage read failed'
    );
  });
});
