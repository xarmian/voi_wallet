// Unit tests for the biometric-unlock orchestration (DOC-137 §3.3/§3.4, PR6) —
// THE fix that makes a biometric-unlocked session hold the vault secret:
//   - success: reads the convenience item + populates the SessionKeyVault;
//   - invalidation (getItemWithAuth resolves null): clears BIOMETRIC_ENABLED_KEY,
//     does NOT populate the vault, and does NOT throw (never routes to mnemonic);
//   - cancel (getItemWithAuth throws): keeps biometrics enabled, does NOT
//     populate the vault, and does NOT throw.
//
// SECURITY NOTE: throwaway strings stand in for the user secret; none is logged.

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
    },
    biometrics: {
      isAvailable: async () => false,
      isEnrolled: async () => false,
    },
    deviceId: {
      getDeviceId: async () => 'bio-unlock-test-device-idfv',
    },
  };
});

import * as platform from '@/platform';
import { unlockVaultWithBiometrics } from '../biometricUnlock';
import { SessionKeyVault } from '../SessionKeyVault';

const BIOMETRIC_SECRET_KEY = 'voi_biometric_secret';
const BIOMETRIC_ENABLED_KEY = 'voi_biometric_enabled';

const mockPlatform = platform as unknown as {
  __secure: Map<string, string>;
  __kv: Map<string, string>;
  __reset: () => void;
  secureStorage: { getItemWithAuth: jest.Mock };
};

beforeEach(() => {
  mockPlatform.__reset();
  SessionKeyVault.clear();
});

afterEach(() => {
  SessionKeyVault.clear();
});

describe('unlockVaultWithBiometrics — success populates the vault', () => {
  it('reads the convenience secret and sets the vault secret + source', async () => {
    mockPlatform.__secure.set(
      BIOMETRIC_SECRET_KEY,
      JSON.stringify({ secret: '123456', secretSource: 'pin' })
    );
    mockPlatform.__kv.set(BIOMETRIC_ENABLED_KEY, 'true');

    expect(SessionKeyVault.isUnlocked()).toBe(false);
    const outcome = await unlockVaultWithBiometrics('Unlock your wallet');

    expect(outcome).toEqual({ status: 'unlocked' });
    expect(SessionKeyVault.isUnlocked()).toBe(true);
    expect(SessionKeyVault.getSecret()).toBe('123456');
    expect(SessionKeyVault.getSecretSource()).toBe('pin');
    // Biometrics stays enabled on success.
    expect(mockPlatform.__kv.get(BIOMETRIC_ENABLED_KEY)).toBe('true');
  });

  it('preserves a passphrase secretSource into the vault', async () => {
    mockPlatform.__secure.set(
      BIOMETRIC_SECRET_KEY,
      JSON.stringify({
        secret: 'a-long-passphrase',
        secretSource: 'passphrase',
      })
    );
    const outcome = await unlockVaultWithBiometrics('Unlock');
    expect(outcome.status).toBe('unlocked');
    expect(SessionKeyVault.getSecretSource()).toBe('passphrase');
  });
});

describe('unlockVaultWithBiometrics — invalidation (null) clears the flag, never mnemonic', () => {
  it('when the item is invalidated/absent: clears BIOMETRIC_ENABLED_KEY, no vault, no throw', async () => {
    // Item absent => getItemWithAuth resolves null (enrollment change / absent).
    mockPlatform.__kv.set(BIOMETRIC_ENABLED_KEY, 'true');

    const outcome = await unlockVaultWithBiometrics('Unlock your wallet');

    // Falls back to PIN — NEVER the mnemonic. The invariant surfaces as: no throw.
    expect(outcome).toEqual({ status: 'invalidated' });
    // The stale enabled flag was cleared.
    expect(mockPlatform.__kv.get(BIOMETRIC_ENABLED_KEY)).toBe('false');
    // The vault was NOT populated.
    expect(SessionKeyVault.isUnlocked()).toBe(false);
    expect(SessionKeyVault.getSecret()).toBeNull();
  });
});

describe('unlockVaultWithBiometrics — cancel (throw) keeps biometrics enabled', () => {
  it('when getItemWithAuth throws (user cancelled / auth failed): cancelled, flag kept, no vault, no throw', async () => {
    mockPlatform.__kv.set(BIOMETRIC_ENABLED_KEY, 'true');
    mockPlatform.secureStorage.getItemWithAuth.mockImplementationOnce(
      async () => {
        throw new Error('User canceled the authentication');
      }
    );

    const outcome = await unlockVaultWithBiometrics('Unlock your wallet');

    expect(outcome).toEqual({ status: 'cancelled' });
    // Biometrics stays enabled on a cancel (the user can retry).
    expect(mockPlatform.__kv.get(BIOMETRIC_ENABLED_KEY)).toBe('true');
    // The vault was NOT populated, and no error propagated to the mnemonic path.
    expect(SessionKeyVault.isUnlocked()).toBe(false);
  });
});
