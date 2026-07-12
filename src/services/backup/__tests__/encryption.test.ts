// Unit tests for TASK-30: backup encryption v2 (scrypt) envelope, v1 backward
// compatibility, AAD/MAC parameter binding, bounded pre-scrypt validation, and
// the length-based passphrase policy.
//
// SECURITY NOTE: no static/committed secret material is used. Passwords here are
// throwaway test strings and the "backup" payloads are synthetic JSON — never a
// real mnemonic. The point is the crypto invariants, not any real wallet.

// Provide platform crypto (getRandomBytes) via Node's CSPRNG so the encryption
// module runs under jest without the native/expo platform adapter.
jest.mock('@/platform', () => {
  const nodeCrypto = require('crypto');
  return {
    crypto: {
      getRandomBytes: async (byteCount: number): Promise<Uint8Array> =>
        Uint8Array.from(nodeCrypto.randomBytes(byteCount)),
    },
  };
});

import CryptoJS from 'crypto-js';
import { randomBytes } from 'crypto';
import {
  encryptBackup,
  decryptBackup,
  validateEncryptedBackupFile,
  validatePasswordStrength,
} from '../encryption';
import {
  EncryptedBackupFileV1,
  EncryptedBackupFileV2,
  BackupError,
} from '../types';

const PASSWORD = 'correct horse battery staple backup!';
const PAYLOAD = JSON.stringify({
  version: 1,
  hello: 'world',
  nested: { a: 1, b: [2, 3, 4] },
});

function randomHex(byteLength: number): string {
  return randomBytes(byteLength).toString('hex');
}

/**
 * Build a v1 (legacy PBKDF2) envelope exactly the way the old writer did, so we
 * can prove the retained v1 decrypt path still works.
 */
function makeLegacyV1Backup(
  plaintext: string,
  password: string
): EncryptedBackupFileV1 {
  const salt = randomHex(32);
  const iv = randomHex(16);

  const keyHex = CryptoJS.PBKDF2(password, CryptoJS.enc.Hex.parse(salt), {
    keySize: 32 / 4,
    iterations: 100000,
    hasher: (CryptoJS.algo as any).SHA256,
  }).toString(CryptoJS.enc.Hex);

  const encrypted = CryptoJS.AES.encrypt(
    plaintext,
    CryptoJS.enc.Hex.parse(keyHex),
    {
      iv: CryptoJS.enc.Hex.parse(iv),
      mode: CryptoJS.mode.CTR,
      padding: CryptoJS.pad.NoPadding,
    }
  );
  const ciphertext = encrypted.toString();

  const hmacKey = CryptoJS.SHA256(keyHex + 'backup_hmac_salt').toString();
  const hmac = CryptoJS.HmacSHA256(ciphertext, hmacKey).toString();

  return { format: 'voibackup', version: 1, salt, iv, ciphertext, hmac };
}

describe('backup encryption v2 (scrypt) round-trip', () => {
  it('encrypts as v2/scrypt and decrypts back to the original plaintext', async () => {
    const envelope = (await encryptBackup(
      PAYLOAD,
      PASSWORD
    )) as EncryptedBackupFileV2;

    expect(envelope.format).toBe('voibackup');
    expect(envelope.version).toBe(2);
    expect(envelope.kdf).toBe('scrypt');
    expect(envelope.kdfParams).toEqual({
      N: 2 ** 15,
      r: 8,
      p: 1,
      dkLen: 32,
    });
    // Salt (32 bytes) and IV (16 bytes) are hex of the expected length.
    expect(envelope.salt).toMatch(/^[0-9a-f]{64}$/);
    expect(envelope.iv).toMatch(/^[0-9a-f]{32}$/);
    // No plaintext leaks into the envelope.
    expect(envelope.ciphertext).not.toContain('world');

    const decrypted = await decryptBackup(envelope, PASSWORD);
    expect(decrypted).toBe(PAYLOAD);
  });

  it('fails to decrypt with the wrong password', async () => {
    const envelope = await encryptBackup(PAYLOAD, PASSWORD);
    await expect(
      decryptBackup(envelope, 'a different password entirely')
    ).rejects.toMatchObject({ code: 'INTEGRITY_CHECK_FAILED' });
  });
});

describe('v1 backward compatibility', () => {
  it('still decrypts a legacy v1 (PBKDF2) backup fixture', async () => {
    const legacy = makeLegacyV1Backup(PAYLOAD, PASSWORD);
    expect(legacy.version).toBe(1);

    const decrypted = await decryptBackup(legacy, PASSWORD);
    expect(decrypted).toBe(PAYLOAD);
  });

  it('rejects a legacy v1 backup with the wrong password', async () => {
    const legacy = makeLegacyV1Backup(PAYLOAD, PASSWORD);
    await expect(
      decryptBackup(legacy, 'wrong password wrong password')
    ).rejects.toMatchObject({ code: 'INTEGRITY_CHECK_FAILED' });
  });
});

describe('AAD / MAC parameter binding (v2)', () => {
  it('fails when the IV is tampered (IV is authenticated only via AAD)', async () => {
    const envelope = (await encryptBackup(
      PAYLOAD,
      PASSWORD
    )) as EncryptedBackupFileV2;

    const tampered: EncryptedBackupFileV2 = {
      ...envelope,
      iv: randomHex(16),
    };

    await expect(decryptBackup(tampered, PASSWORD)).rejects.toMatchObject({
      code: 'INTEGRITY_CHECK_FAILED',
    });
  });

  it('fails when kdfParams are tampered (N flipped to another valid value)', async () => {
    const envelope = (await encryptBackup(
      PAYLOAD,
      PASSWORD
    )) as EncryptedBackupFileV2;

    const tampered: EncryptedBackupFileV2 = {
      ...envelope,
      kdfParams: { ...envelope.kdfParams, N: 2 ** 14 },
    };

    await expect(decryptBackup(tampered, PASSWORD)).rejects.toBeInstanceOf(
      BackupError
    );
  });

  it('fails when the salt is tampered', async () => {
    const envelope = (await encryptBackup(
      PAYLOAD,
      PASSWORD
    )) as EncryptedBackupFileV2;

    const tampered: EncryptedBackupFileV2 = {
      ...envelope,
      salt: randomHex(32),
    };

    await expect(decryptBackup(tampered, PASSWORD)).rejects.toBeInstanceOf(
      BackupError
    );
  });

  it('fails when the version is downgraded to 1', async () => {
    const envelope = (await encryptBackup(
      PAYLOAD,
      PASSWORD
    )) as EncryptedBackupFileV2;

    // Route the (scrypt) ciphertext through the v1/PBKDF2 path — MAC must fail.
    const downgraded = {
      ...envelope,
      version: 1,
    } as unknown as EncryptedBackupFileV1;

    await expect(decryptBackup(downgraded, PASSWORD)).rejects.toBeInstanceOf(
      BackupError
    );
  });
});

describe('bounded validation before scrypt (DoS guard)', () => {
  function baseV2(): Record<string, unknown> {
    return {
      format: 'voibackup',
      version: 2,
      kdf: 'scrypt',
      kdfParams: { N: 2 ** 15, r: 8, p: 1, dkLen: 32 },
      salt: randomHex(32),
      iv: randomHex(16),
      ciphertext: 'AAAA',
      hmac: 'bb',
    };
  }

  it('accepts a well-formed v2 envelope', () => {
    expect(() => validateEncryptedBackupFile(baseV2())).not.toThrow();
  });

  it('rejects N over the cap (> 2^20) before deriving a key', () => {
    const bad = {
      ...baseV2(),
      kdfParams: { N: 2 ** 21, r: 8, p: 1, dkLen: 32 },
    };
    expect(() => validateEncryptedBackupFile(bad)).toThrow(BackupError);
  });

  it('rejects N that is not a power of two', () => {
    const bad = { ...baseV2(), kdfParams: { N: 30000, r: 8, p: 1, dkLen: 32 } };
    expect(() => validateEncryptedBackupFile(bad)).toThrow(BackupError);
  });

  it('rejects r over the cap', () => {
    const bad = {
      ...baseV2(),
      kdfParams: { N: 2 ** 15, r: 64, p: 1, dkLen: 32 },
    };
    expect(() => validateEncryptedBackupFile(bad)).toThrow(BackupError);
  });

  it('rejects a combined memory footprint over the ceiling', () => {
    // N=2^20, r=32 -> 128*N*r = 4 GiB, well over the 128 MiB cap.
    const bad = {
      ...baseV2(),
      kdfParams: { N: 2 ** 20, r: 32, p: 1, dkLen: 32 },
    };
    expect(() => validateEncryptedBackupFile(bad)).toThrow(BackupError);
  });

  it('rejects a wrong dkLen', () => {
    const bad = {
      ...baseV2(),
      kdfParams: { N: 2 ** 15, r: 8, p: 1, dkLen: 64 },
    };
    expect(() => validateEncryptedBackupFile(bad)).toThrow(BackupError);
  });

  it('rejects a malformed salt length', () => {
    const bad = { ...baseV2(), salt: 'deadbeef' };
    expect(() => validateEncryptedBackupFile(bad)).toThrow(BackupError);
  });

  it('rejects an unknown version with a clear error', () => {
    const bad = { ...baseV2(), version: 9 };
    expect(() => validateEncryptedBackupFile(bad)).toThrow(
      /Unsupported backup version/
    );
  });

  it('rejects a non-object / wrong format', () => {
    expect(() => validateEncryptedBackupFile(null)).toThrow(BackupError);
    expect(() =>
      validateEncryptedBackupFile({ format: 'nope', version: 2 })
    ).toThrow(BackupError);
  });
});

describe('passphrase policy (length-based, no composition rules)', () => {
  it('rejects passphrases shorter than 12 characters', () => {
    expect(validatePasswordStrength('short').isValid).toBe(false);
    expect(validatePasswordStrength('abc123!X').isValid).toBe(false); // 8 chars
    expect(validatePasswordStrength('elevenchars').isValid).toBe(false); // 11
  });

  it('accepts a strong 12+ passphrase without requiring composition', () => {
    const result = validatePasswordStrength('correct horse battery staple');
    expect(result.isValid).toBe(true);
    // All-lowercase + spaces still valid (no upper/digit/symbol required).
    expect(validatePasswordStrength('voyager tangerine mountain').isValid).toBe(
      true
    );
  });

  it('rejects common / predictable passphrases even at length >= 12', () => {
    expect(validatePasswordStrength('password1234').isValid).toBe(false);
    expect(validatePasswordStrength('123456789012').isValid).toBe(false);
    expect(validatePasswordStrength('aaaaaaaaaaaa').isValid).toBe(false);
    expect(validatePasswordStrength('abcdefghijkl').isValid).toBe(false);
    expect(validatePasswordStrength('qwertyuiopas').isValid).toBe(false);
  });

  it('keeps a 0-4 meter score for the strength UI', () => {
    const weak = validatePasswordStrength('short');
    expect(weak.score).toBeGreaterThanOrEqual(0);
    expect(weak.score).toBeLessThanOrEqual(1);

    const strong = validatePasswordStrength('Tr0ubador&3xplr!ng-w1nter');
    expect(strong.isValid).toBe(true);
    expect(strong.score).toBeGreaterThanOrEqual(3);
    expect(strong.score).toBeLessThanOrEqual(4);
  });
});
