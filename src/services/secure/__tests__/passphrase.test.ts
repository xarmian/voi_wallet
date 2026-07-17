// PR7 (TASK-27, DOC-137 §7) — optional PASSPHRASE credential + §6.4 reader gate.
//
// Proves:
//   * validateSecret enforces the length-only passphrase policy (min 12, no
//     composition rules) and the 6-digit PIN policy;
//   * setupPin can create a PASSPHRASE credential and verifyPin unlocks it (the
//     old "passphrase not supported yet" guards are gone);
//   * a wrong-length passphrase is fast-rejected by verifyPin (no throttle spend);
//   * changePin switches PIN → passphrase, re-wrapping keys byte-identically so
//     the account still signs the SAME Algorand address afterward (AC8);
//   * the §6.4 reader gate: getPrivateKey(pin=undefined) succeeds under an
//     unlocked vault for a PIN-only/passphrase-only wallet (no biometrics), and
//     still throws when the vault is locked.
//
// SECURITY NOTE: throwaway Ed25519 keypair + throwaway secrets. Nothing logged.

jest.mock('@/platform', () => {
  const nodeCrypto = require('crypto');
  const secure = new Map<string, string>();
  const kv = new Map<string, string>();
  return {
    __secure: secure,
    __kv: kv,
    __reset: () => {
      secure.clear();
      kv.clear();
    },
    crypto: {
      getRandomBytes: async (n: number): Promise<Uint8Array> =>
        Uint8Array.from(nodeCrypto.randomBytes(n)),
      sha256: async (input: string): Promise<string> =>
        nodeCrypto.createHash('sha256').update(input).digest('hex'),
      randomUUID: () => nodeCrypto.randomUUID(),
    },
    secureStorage: {
      getItem: jest.fn(async (k: string) =>
        secure.has(k) ? secure.get(k)! : null
      ),
      setItem: jest.fn(async (k: string, v: string) => {
        secure.set(k, v);
      }),
      deleteItem: jest.fn(async (k: string) => {
        secure.delete(k);
      }),
      getItemWithAuth: jest.fn(async (k: string) =>
        secure.has(k) ? secure.get(k)! : null
      ),
      setItemWithAuth: jest.fn(async (k: string, v: string) => {
        secure.set(k, v);
      }),
    },
    storage: {
      getItem: jest.fn(async (k: string) => (kv.has(k) ? kv.get(k)! : null)),
      setItem: jest.fn(async (k: string, v: string) => {
        kv.set(k, v);
      }),
      removeItem: jest.fn(async (k: string) => {
        kv.delete(k);
      }),
      multiRemove: jest.fn(async (keys: string[]) => {
        keys.forEach((k) => kv.delete(k));
      }),
    },
    biometrics: {
      isAvailable: async () => false,
      isEnrolled: async () => false,
    },
    deviceId: {
      getDeviceId: async () => 'pr7-test-device-idfv',
    },
  };
});

import 'crypto-js';
import 'crypto-js/hmac-sha256';
import 'crypto-js/sha256';
import 'crypto-js/aes';
import 'crypto-js/mode-ctr';
import 'crypto-js/pad-nopadding';
import 'crypto-js/enc-hex';
import 'crypto-js/pbkdf2';
import { randomBytes } from 'crypto';
import nacl from 'tweetnacl';
import algosdk from 'algosdk';
import * as platform from '@/platform';
import { AccountSecureStorage } from '../AccountSecureStorage';
import { SessionKeyVault } from '../SessionKeyVault';
import { encryptKeyEnvelopeV2, KeyEnvelopeV2 } from '../envelopeV2';
import type { ScryptKdfParams } from '../../backup/types';

const DEVICE_ID = 'pr7-test-device-idfv';
const FAST_PARAMS: ScryptKdfParams = { N: 2 ** 12, r: 8, p: 1, dkLen: 32 };
const PIN = '246802';
const PASSPHRASE = 'correct horse battery staple'; // 28 chars, ≥ 12

const mockPlatform = platform as unknown as {
  __secure: Map<string, string>;
  __kv: Map<string, string>;
  __reset: () => void;
  secureStorage: { getItem: jest.Mock; setItem: jest.Mock };
};

const asPriv = AccountSecureStorage as unknown as {
  encryptPrivateKeyV2: (
    keyBytes: Uint8Array,
    secret: string,
    secretSource: 'pin' | 'passphrase',
    options: { deviceBound: boolean }
  ) => Promise<KeyEnvelopeV2>;
  validateSecret: (secret: string, source: 'pin' | 'passphrase') => void;
  throttleMirror: unknown;
  legacyCheckRequired: boolean | undefined;
};

function hex(b: Uint8Array): string {
  return Buffer.from(b).toString('hex');
}

function makeAlgoKey(): {
  sk: Uint8Array;
  pubkey: Uint8Array;
  address: string;
} {
  const kp = nacl.sign.keyPair();
  return {
    sk: kp.secretKey,
    pubkey: kp.publicKey,
    address: algosdk.encodeAddress(kp.publicKey),
  };
}

function addToList(id: string): void {
  const raw = mockPlatform.__kv.get('voi_account_list');
  const list: string[] = raw ? JSON.parse(raw) : [];
  if (!list.includes(id)) list.push(id);
  mockPlatform.__kv.set('voi_account_list', JSON.stringify(list));
}

async function seedV2(
  id: string,
  sk: Uint8Array,
  secret: string,
  source: 'pin' | 'passphrase'
): Promise<void> {
  const blob = await encryptKeyEnvelopeV2({
    plaintext: sk,
    secret,
    secretSource: source,
    deviceSecret: DEVICE_ID,
    kdfParams: FAST_PARAMS,
  });
  mockPlatform.__secure.set(
    `voi_account_secret_${id}`,
    JSON.stringify({
      accountId: id,
      encryptedPrivateKey: '',
      authMethod: 'pin',
      version: 2,
      blobs: [blob],
    })
  );
  addToList(id);
}

function useFastWriter(): void {
  jest
    .spyOn(asPriv, 'encryptPrivateKeyV2')
    .mockImplementation(async (keyBytes, secret, secretSource, options) =>
      encryptKeyEnvelopeV2({
        plaintext: keyBytes,
        secret,
        secretSource,
        deviceSecret: options.deviceBound ? DEVICE_ID : undefined,
        kdfParams: FAST_PARAMS,
      })
    );
}

function enableBiometrics(): void {
  mockPlatform.__kv.set('voi_biometric_enabled', 'true');
}

beforeEach(() => {
  mockPlatform.__reset();
  AccountSecureStorage.clearPrivateKeyCache();
  SessionKeyVault.clear();
  asPriv.throttleMirror = null;
  asPriv.legacyCheckRequired = undefined;
  mockPlatform.secureStorage.getItem.mockImplementation(async (k: string) =>
    mockPlatform.__secure.has(k) ? mockPlatform.__secure.get(k)! : null
  );
});

afterEach(() => {
  SessionKeyVault.clear();
  jest.restoreAllMocks();
});

describe('validateSecret / isSecretFormatValid — passphrase policy', () => {
  it('accepts a ≥12-char passphrase and rejects a shorter one', () => {
    expect(() => asPriv.validateSecret(PASSPHRASE, 'passphrase')).not.toThrow();
    expect(() => asPriv.validateSecret('short', 'passphrase')).toThrow(
      /at least 12/
    );
    expect(() =>
      asPriv.validateSecret('exactly12chr', 'passphrase')
    ).not.toThrow(); // 12
    expect(() => asPriv.validateSecret('elevenchars', 'passphrase')).toThrow(); // 11
  });

  it('does NOT enforce composition rules (length only)', () => {
    expect(() =>
      asPriv.validateSecret('aaaaaaaaaaaa', 'passphrase')
    ).not.toThrow();
  });

  it('still enforces exactly-6-digits for a PIN', () => {
    expect(() => asPriv.validateSecret('123456', 'pin')).not.toThrow();
    expect(() => asPriv.validateSecret('12345', 'pin')).toThrow(/6 digits/);
    expect(() => asPriv.validateSecret('12345a', 'pin')).toThrow(/6 digits/);
    expect(() =>
      asPriv.validateSecret('correct horse battery staple', 'pin')
    ).toThrow(/6 digits/);
  });

  it('isSecretFormatValid mirrors the policy without throwing', () => {
    expect(
      AccountSecureStorage.isSecretFormatValid(PASSPHRASE, 'passphrase')
    ).toBe(true);
    expect(
      AccountSecureStorage.isSecretFormatValid('short', 'passphrase')
    ).toBe(false);
    expect(AccountSecureStorage.isSecretFormatValid('123456', 'pin')).toBe(
      true
    );
    expect(AccountSecureStorage.isSecretFormatValid('123', 'pin')).toBe(false);
  });
});

describe('setupPin + verifyPin — passphrase credential end-to-end', () => {
  it('creates a passphrase credential and verifyPin unlocks it', async () => {
    await AccountSecureStorage.setupPin(PASSPHRASE, 'passphrase');
    expect(await AccountSecureStorage.getCredentialSource()).toBe('passphrase');
    expect(await AccountSecureStorage.verifyPin(PASSPHRASE)).toBe(true);
    // A 6-digit PIN is NOT the credential → rejected.
    expect(await AccountSecureStorage.verifyPin('123456')).toBe(false);
  });

  it('rejects setting a too-short passphrase', async () => {
    await expect(
      AccountSecureStorage.setupPin('short', 'passphrase')
    ).rejects.toThrow(/Failed to set up PIN/);
    expect(await AccountSecureStorage.getCredentialSource()).toBeNull();
  });

  it('fast-rejects a wrong-length passphrase without spending a throttle attempt', async () => {
    await AccountSecureStorage.setupPin(PASSPHRASE, 'passphrase');
    const before = await AccountSecureStorage.getPinThrottleState();
    expect(await AccountSecureStorage.verifyPin('tooshort')).toBe(false);
    const after = await AccountSecureStorage.getPinThrottleState();
    // Malformed input is not counted as a failed attempt.
    expect(after.attemptsRemaining).toBe(before.attemptsRemaining);
  });
});

describe('changePin — PIN → passphrase switch re-wraps keys byte-identically', () => {
  it('switches to a passphrase and the account still signs the SAME address', async () => {
    const k = makeAlgoKey();
    // Start with a PIN credential + a v2 account under the PIN.
    await AccountSecureStorage.setupPin(PIN, 'pin');
    await seedV2('acct', k.sk, PIN, 'pin');
    useFastWriter();

    await AccountSecureStorage.changePin(PIN, PASSPHRASE, 'passphrase');

    // Credential is now a passphrase; the old PIN no longer verifies.
    expect(await AccountSecureStorage.getCredentialSource()).toBe('passphrase');
    expect(await AccountSecureStorage.verifyPin(PASSPHRASE)).toBe(true);
    expect(await AccountSecureStorage.verifyPin(PIN)).toBe(false);

    // The key round-trips byte-identically → same Algorand address + valid sign.
    const sk = await AccountSecureStorage.getPrivateKey('acct', PASSPHRASE);
    expect(hex(sk)).toBe(hex(k.sk));
    expect(algosdk.encodeAddress(sk.slice(32))).toBe(k.address);
    const msg = Uint8Array.from(randomBytes(32));
    expect(
      nacl.sign.detached.verify(msg, nacl.sign.detached(msg, sk), k.pubkey)
    ).toBe(true);
  });
});

describe('§6.4 reader gate — pin=undefined works under an unlocked vault', () => {
  it('reads a v2 account with pin=undefined when the vault is unlocked (no biometrics)', async () => {
    const k = makeAlgoKey();
    await AccountSecureStorage.setupPin(PASSPHRASE, 'passphrase');
    await seedV2('acct', k.sk, PASSPHRASE, 'passphrase');
    // No biometrics. Unlock the vault as AuthContext would.
    SessionKeyVault.set(PASSPHRASE, 'passphrase');

    const sk = await AccountSecureStorage.getPrivateKey('acct'); // pin=undefined
    expect(hex(sk)).toBe(hex(k.sk));
  });

  it('throws with pin=undefined when the vault is LOCKED and no biometrics', async () => {
    const k = makeAlgoKey();
    await AccountSecureStorage.setupPin(PASSPHRASE, 'passphrase');
    await seedV2('acct', k.sk, PASSPHRASE, 'passphrase');
    SessionKeyVault.clear(); // locked

    await expect(AccountSecureStorage.getPrivateKey('acct')).rejects.toThrow();
  });

  it('still allows pin=undefined when biometrics is enabled (unchanged path)', async () => {
    const k = makeAlgoKey();
    await AccountSecureStorage.setupPin(PIN, 'pin');
    await seedV2('acct', k.sk, PIN, 'pin');
    enableBiometrics();
    SessionKeyVault.set(PIN, 'pin');

    const sk = await AccountSecureStorage.getPrivateKey('acct');
    expect(hex(sk)).toBe(hex(k.sk));
  });
});
