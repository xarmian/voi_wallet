// Unit tests for the in-memory account-secret store in accountQRParser.
//
// SECURITY NOTE: these tests use OBVIOUSLY-FAKE placeholder secrets only — never
// a real mnemonic or private key. They pin the observable lifecycle contract of
// the secret store (store -> read -> clear) and the best-effort reference-drop
// that clearAccountSecret performs before deleting the entry.
//
// LIMITATION being documented (this is a real limitation, not a test bug):
// JavaScript strings are immutable, so their backing memory CANNOT be zeroed in
// place. clearAccountSecret can only DROP references so the GC can reclaim the
// strings. These tests therefore assert reference-dropping + entry-removal —
// NOT an in-memory wipe, which is impossible in JS.

// Mock the heavy wallet/ARC-0300 dependency graph so importing accountQRParser
// stays lightweight and deterministic. The mocked validator/importer let a
// fake 25-"word" phrase flow through the public parse path and store a secret,
// with no real crypto and no real key material involved.
jest.mock('@/services/wallet', () => ({
  MultiAccountWalletService: {
    validateMnemonic: jest.fn(() => true),
    importFromMnemonic: jest.fn(() => ({ address: 'FAKEADDRESSNOTREAL' })),
    validateAddress: jest.fn(() => false),
    importFromPrivateKey: jest.fn(),
  },
}));

jest.mock('@/utils/arc0300', () => ({
  isArc0300AccountImportUri: jest.fn(() => false),
  parseArc0300AccountImportUri: jest.fn(() => null),
  normalizeBase64ToHex: jest.fn((v: string) => v),
}));

import {
  AccountQRParser,
  getAccountSecret,
  clearAccountSecret,
  clearAllAccountSecrets,
  type AccountSecret,
} from '../accountQRParser';

// Obviously-fake 25-"word" phrase — never a real mnemonic.
const FAKE_MNEMONIC = Array(25).fill('fake-word-not-real').join(' ');

/** Stores a fake secret via the public parse flow and returns its secret id. */
const storeFakeSecret = async (): Promise<string> => {
  const result = await AccountQRParser.parseQRContent(FAKE_MNEMONIC, []);
  const secretId = result.accounts[0]?.secretId;
  if (!secretId) {
    throw new Error(
      'expected the parse flow to store a secret and return an id'
    );
  }
  return secretId;
};

describe('accountQRParser secret store', () => {
  afterEach(() => {
    // Ensure no fake secret leaks between tests.
    clearAllAccountSecrets();
  });

  it('stores a secret that can be read back before clearing', async () => {
    const id = await storeFakeSecret();
    expect(getAccountSecret(id)).toEqual({ mnemonic: FAKE_MNEMONIC });
  });

  it('getAccountSecret returns an independent COPY, not the stored reference', async () => {
    const id = await storeFakeSecret();
    const a = getAccountSecret(id);
    const b = getAccountSecret(id);
    expect(a).toEqual(b);
    expect(a).not.toBe(b); // distinct copies — copy semantics intentionally unchanged
  });

  it('clearAccountSecret drops secret references on the stored object and removes the entry', async () => {
    // Capture the exact object the store places in its Map. getAccountSecret
    // intentionally returns a COPY (contract unchanged), so the stored object's
    // field state is otherwise unobservable; spy on Map.set to grab the ref.
    const setSpy = jest.spyOn(Map.prototype, 'set');
    const id = await storeFakeSecret();
    const storeCall = setSpy.mock.calls.find(
      ([, value]) =>
        value != null &&
        typeof value === 'object' &&
        'mnemonic' in (value as object)
    );
    setSpy.mockRestore();

    const storedObject = storeCall?.[1] as AccountSecret | undefined;
    expect(storedObject).toBeDefined();
    // Sanity: the stored object holds the fake secret before clearing.
    expect(storedObject?.mnemonic).toBe(FAKE_MNEMONIC);

    clearAccountSecret(id);

    // Best-effort: references dropped so the GC can reclaim the secret strings.
    // NOTE: this pins REFERENCE-DROPPING, not a memory wipe — JS strings are
    // immutable and their backing bytes cannot be zeroed in place.
    expect(storedObject?.mnemonic).toBeUndefined();
    expect(storedObject?.privateKey).toBeUndefined();

    // Observable contract: the entry is gone.
    expect(getAccountSecret(id)).toBeUndefined();
  });

  it('clearAccountSecret is a safe no-op for undefined or unknown ids', () => {
    expect(() => clearAccountSecret(undefined)).not.toThrow();
    expect(() => clearAccountSecret('does-not-exist')).not.toThrow();
    expect(getAccountSecret('does-not-exist')).toBeUndefined();
  });
});
