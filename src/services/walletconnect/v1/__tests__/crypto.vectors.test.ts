/**
 * Fixed-vector regression tests for the WalletConnect v1 session crypto path
 * (AES-256-CBC + HMAC-SHA256, `../crypto.ts`).
 *
 * These lock the EXACT byte output of the crypto primitives. The expected hex
 * literals below were CAPTURED from the pre-hoist implementation (three
 * per-function `require('crypto-js')` sites) on the parent commit and are
 * hardcoded here verbatim — they are NOT recomputed from the implementation.
 * The require->static-import hoist (TASK-235) must leave every one of these
 * bytes unchanged; if any literal below no longer matches, the hoist altered
 * crypto output and must be reverted.
 *
 * `encryptMessage` -> `aesEncrypt` + `computeHMAC` (payload.data / payload.hmac).
 * `decryptMessage` -> `computeHMAC` (verify) + `aesDecrypt` (round-trip).
 * A fixed IV is injected by mocking expo-crypto so encryption is deterministic.
 */

// 16-byte deterministic IV (hex a0a1..af) injected via the expo-crypto mock so
// `generateIV()` is reproducible and encrypt output is a fixed vector.
const FIXED_IV_BYTES = [
  0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xab, 0xac,
  0xad, 0xae, 0xaf,
];
const FIXED_IV_HEX = 'a0a1a2a3a4a5a6a7a8a9aaabacadaeaf';

jest.mock('expo-crypto', () => ({
  getRandomBytesAsync: jest.fn(
    async (n: number) => new Uint8Array(FIXED_IV_BYTES.slice(0, n))
  ),
}));

import { encryptMessage, decryptMessage } from '../crypto';

const KEY_A =
  '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const KEY_B =
  'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';

interface Vector {
  name: string;
  key: string;
  message: string;
  data: string; // expected AES-256-CBC ciphertext (hex)
  hmac: string; // expected HMAC-SHA256 over (ciphertext || iv) (hex)
}

// Captured verbatim from the pre-hoist implementation. IV is FIXED_IV_HEX for all.
const VECTORS: Vector[] = [
  {
    name: 'KEY_A / wc_sessionUpdate JSON-RPC',
    key: KEY_A,
    message: '{"id":1,"jsonrpc":"2.0","method":"wc_sessionUpdate"}',
    data: '5c504a3a30ffbf5b1cfe5426789ee9238806b2c5257b0dd51c4aa7bf7f388cd517973ac8f5fb9517ad1aa7646e4155394803c6eb85a25c2fc93b081a963f3cdc',
    hmac: '80edcac6193a4dce8be4cc14e64192e64f6fd09d52a955d1119583e5f195bcf8',
  },
  {
    name: 'KEY_A / short "hello world" (partial-block padding)',
    key: KEY_A,
    message: 'hello world',
    data: 'dbe615888cba8369bc71d49b9cb64d92',
    hmac: 'cd73759e1d9e19cfeef584b178c1556a8bd9a6808c567d882e11b812b065e336',
  },
  {
    name: 'KEY_A / empty string (full padding block)',
    key: KEY_A,
    message: '',
    data: '600d07a3b9b2c4e4082153d6d1707aa6',
    hmac: '63985e44e18457af5cce55b50ea003303b224ef53322115300c3cb987177c61b',
  },
  {
    name: 'KEY_A / exactly 16 bytes (extra full padding block)',
    key: KEY_A,
    message: '0123456789abcdef',
    data: 'ce1cf3a4e3b87b139ba3cff10ace35b606d96b2e184bf22b73d31ba4be14d8c9',
    hmac: 'f806e4dfc7a5c33e14666f0bbc16d2cd01c520b4366f169a15359168b371e39a',
  },
  {
    name: 'KEY_B / wc_sessionUpdate JSON-RPC',
    key: KEY_B,
    message: '{"id":1,"jsonrpc":"2.0","method":"wc_sessionUpdate"}',
    data: '91eb83f19a702bee84fc006306037e972d207a6dca1f36351db0b1eeb58b666b3fb4b03f6f4737cdd3c13f3602a28b24a72b27f3c0cc7f0f8ccc548248f10816',
    hmac: '8e42f45522451adbb6cf5cc79202a734132f5a6ff84af25e84811028cde88bed',
  },
  {
    name: 'KEY_B / short "hello world"',
    key: KEY_B,
    message: 'hello world',
    data: '1a547ce2dee52bcf3e8bccf4d2aa33bd',
    hmac: 'd39087e54c9e7e5f1c510d16447b0045545adfcbdb9ca84e48e750cfc20e1ca4',
  },
  {
    name: 'KEY_B / empty string',
    key: KEY_B,
    message: '',
    data: '129b478891f7e3ed8fbacc734badd003',
    hmac: 'e5a2d44dca8613f310243e1e884839f0eacfe2c10ffc93c5171d9c1ae0804398',
  },
  {
    name: 'KEY_B / exactly 16 bytes',
    key: KEY_B,
    message: '0123456789abcdef',
    data: 'af4511fef07832843d7549254d47d0c77a5254f587b63354e12c5f33e31f5131',
    hmac: '41ec14e19c32f984519a178fc54b089d8ca18140e55762f0b3f9a5b1cf784c89',
  },
];

describe('WalletConnect v1 crypto — fixed vectors (byte-identical lock)', () => {
  describe('encryptMessage produces the exact captured ciphertext + HMAC', () => {
    it.each(VECTORS)(
      'encrypts $name to the fixed vector',
      async ({ key, message, data, hmac }) => {
        const payload = await encryptMessage(message, key);
        expect(payload).toEqual({ data, hmac, iv: FIXED_IV_HEX });
      }
    );
  });

  describe('decryptMessage recovers the plaintext (HMAC verify + AES decrypt)', () => {
    it.each(VECTORS)(
      'decrypts $name back to the original message',
      async ({ key, message, data, hmac }) => {
        const plaintext = await decryptMessage(
          { data, hmac, iv: FIXED_IV_HEX },
          key
        );
        expect(plaintext).toBe(message);
      }
    );
  });

  describe('encrypt -> decrypt round-trips to the original message', () => {
    it.each(VECTORS)('round-trips $name', async ({ key, message }) => {
      const payload = await encryptMessage(message, key);
      const plaintext = await decryptMessage(payload, key);
      expect(plaintext).toBe(message);
    });
  });

  it('rejects a payload whose ciphertext was tampered (HMAC verify still enforced)', async () => {
    const { key, hmac } = VECTORS[0];
    // Flip the first byte of the ciphertext; HMAC no longer matches.
    const tampered = {
      data: 'ff' + VECTORS[0].data.slice(2),
      hmac,
      iv: FIXED_IV_HEX,
    };
    await expect(decryptMessage(tampered, key)).rejects.toThrow(
      /HMAC verification failed/
    );
  });
});
