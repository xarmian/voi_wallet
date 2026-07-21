// Unit tests for TASK-213 (Codex round-3 P0): ExtensionSecureStorageAdapter must
// THROW on a present-but-undecryptable item (a genuine decrypt FAILURE) and
// resolve null ONLY for genuine ABSENCE — so the auth-init strict reads can fail
// CLOSED on the extension. Previously a decrypt error was swallowed to null,
// indistinguishable from "no value" (a fail-OPEN at auth init).
//
// SECURITY NOTE: no real secret material is used; ciphertext is a throwaway blob.

jest.mock('../storage', () => ({
  extensionStorage: {
    getItem: jest.fn(),
    setItem: jest.fn(async () => {}),
    removeItem: jest.fn(async () => {}),
  },
}));

jest.mock('../crypto', () => ({
  extensionCrypto: {
    getRandomBytes: jest.fn(async (n: number) => new Uint8Array(n)),
  },
}));

import { extensionStorage } from '../storage';
import { ExtensionSecureStorageAdapter } from '../secureStorage';

const mockGet = extensionStorage.getItem as jest.Mock;

// Stub WebCrypto so key derivation succeeds but decrypt REJECTS (models a
// corrupt/undecryptable item) without depending on the env's real crypto.subtle.
const realCrypto = (globalThis as { crypto?: unknown }).crypto;

beforeAll(() => {
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: {
      subtle: {
        importKey: jest.fn(async () => ({})),
        deriveKey: jest.fn(async () => ({})),
        decrypt: jest.fn(async () => {
          throw new Error('AES-GCM authentication tag mismatch');
        }),
      },
    },
  });
});

afterAll(() => {
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: realCrypto,
  });
});

describe('ExtensionSecureStorageAdapter.getItem — decrypt failure vs absence (TASK-213)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('resolves NULL for genuine absence (no stored item) — no decrypt attempted', async () => {
    mockGet.mockResolvedValue(null);
    const adapter = new ExtensionSecureStorageAdapter();
    await expect(adapter.getItem('pin')).resolves.toBeNull();
  });

  it('THROWS (fails closed) when a PRESENT item cannot be decrypted — never coerced to null', async () => {
    // Truthy for every key: the encryption-key material read AND the secure item
    // read both return a value, so decrypt is reached and (stubbed) rejects.
    mockGet.mockResolvedValue('cipherblobcipherblob');
    const adapter = new ExtensionSecureStorageAdapter();
    await expect(adapter.getItem('pin')).rejects.toThrow(
      'Secure storage decrypt failed'
    );
  });

  it('propagates a THROW from the underlying store read (failure, not absence)', async () => {
    mockGet.mockRejectedValue(new Error('chrome storage read failed'));
    const adapter = new ExtensionSecureStorageAdapter();
    await expect(adapter.getItem('pin')).rejects.toThrow(
      'chrome storage read failed'
    );
  });
});
