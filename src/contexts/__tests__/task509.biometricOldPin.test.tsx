// TASK-509: biometric unlock on the onboarding old-PIN step. A reinstalled
// device keeps its PIN credential and the biometric-convenience item (the raw
// old PIN behind the OS biometric gate) but loses the account list and the
// biometric-enabled flag. The old-PIN step may read that item, on a tap, and
// feed its secret to the SAME verifier as PIN entry (unlockForRestore).
//
// Real AuthProvider, AccountSecureStorage (verifyPin, its throttle, the flag and
// item readers) and SessionKeyVault; only the platform is in memory, with an
// operation log so every write to the item or the flag is visible.
//
// SECURITY NOTE: the PINs below are throwaway test strings; no key material is
// used. The test asserts the secret never reaches any console call.

jest.mock('@/platform', () => {
  const nodeCrypto = require('crypto');
  const secure = new Map<string, string>();
  const kv = new Map<string, string>();
  const ops: string[] = [];
  const flags = {
    failReadOf: null as string | null,
    failWriteOf: null as string | null,
    authRead: 'normal' as 'normal' | 'throw',
    mobile: true,
    enrolled: true,
  };
  return {
    __secure: secure,
    __kv: kv,
    __ops: ops,
    __flags: flags,
    __reset: () => {
      secure.clear();
      kv.clear();
      ops.length = 0;
      flags.failReadOf = null;
      flags.failWriteOf = null;
      flags.authRead = 'normal';
      flags.mobile = true;
      flags.enrolled = true;
    },
    isMobile: () => flags.mobile,
    crypto: {
      getRandomBytes: async (n: number): Promise<Uint8Array> =>
        Uint8Array.from(nodeCrypto.randomBytes(n)),
      sha256: async (input: string): Promise<string> =>
        nodeCrypto.createHash('sha256').update(input).digest('hex'),
      randomUUID: () => nodeCrypto.randomUUID(),
    },
    secureStorage: {
      getItem: async (k: string) => {
        if (flags.failReadOf === `secure:${k}`) throw new Error('read failed');
        return secure.has(k) ? secure.get(k)! : null;
      },
      setItem: async (k: string, v: string) => {
        if (flags.failWriteOf === `secure:${k}`) {
          ops.push(`secure:setfail:${k}`);
          throw new Error('write failed');
        }
        ops.push(`secure:set:${k}`);
        secure.set(k, v);
      },
      deleteItem: async (k: string) => {
        ops.push(`secure:del:${k}`);
        secure.delete(k);
      },
      getItemWithAuth: jest.fn(async (k: string) => {
        if (flags.authRead === 'throw') throw new Error('user cancelled');
        return secure.has(k) ? secure.get(k)! : null;
      }),
      setItemWithAuth: async (k: string, v: string) => {
        ops.push(`secure:setAuth:${k}`);
        secure.set(k, v);
      },
    },
    storage: {
      getItem: async (k: string) => {
        if (flags.failReadOf === `kv:${k}`) throw new Error('read failed');
        return kv.has(k) ? kv.get(k)! : null;
      },
      setItem: async (k: string, v: string) => {
        ops.push(`kv:set:${k}`);
        kv.set(k, v);
      },
      removeItem: async (k: string) => {
        ops.push(`kv:del:${k}`);
        kv.delete(k);
      },
    },
    biometrics: {
      isAvailable: async () => flags.enrolled,
      isEnrolled: async () => flags.enrolled,
    },
    deviceId: { getDeviceId: async () => 'task509-device-idfv' },
  };
});

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async () => null),
    setItem: jest.fn(async () => {}),
    removeItem: jest.fn(async () => {}),
    multiRemove: jest.fn(async () => {}),
    multiSet: jest.fn(async () => {}),
    getAllKeys: jest.fn(async () => []),
  },
}));
jest.mock('@/store/walletStore', () => ({
  removePersistedBalanceCaches: jest.fn(async () => {}),
}));
// Inert collaborators of the provider.
jest.mock('@/services/wipe', () => ({
  wipeWalletData: jest.fn(async () => {}),
  isWipeInFlight: jest.fn(() => false),
}));
jest.mock('@/services/wipe/notices', () => ({
  showWipeCompleteNotice: jest.fn(),
}));
jest.mock('@/services/secure/biometricUnlock', () => ({
  unlockVaultWithBiometrics: jest.fn(),
}));
jest.mock('@/services/secure/sessionTeardown', () => ({
  enterLockedState: jest.fn(),
}));
jest.mock('@/services/secure/appLockState', () => ({
  AppLockSignal: {
    setUnlocked: jest.fn(),
    isUnlocked: jest.fn(() => true),
    subscribe: jest.fn(() => () => {}),
  },
}));
jest.mock('@/utils/security', () => ({
  SecurityUtils: { generateSessionId: jest.fn(() => 'test-session-id') },
}));
jest.mock('@/services/deeplink', () => ({
  DeepLinkService: {
    getInstance: jest.fn(() => ({ setUnlockState: jest.fn() })),
  },
}));
jest.mock('expo-local-authentication', () => ({
  hasHardwareAsync: jest.fn(async () => true),
  isEnrolledAsync: jest.fn(async () => true),
}));

import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import * as platform from '@/platform';
import { AuthProvider, useAuth } from '../AuthContext';
import type { AuthContextType } from '../AuthContext';
import { AccountSecureStorage } from '@/services/secure/AccountSecureStorage';
import { SessionKeyVault } from '@/services/secure/SessionKeyVault';
import { unlockVaultWithBiometrics } from '@/services/secure/biometricUnlock';

jest.setTimeout(120000);

const OLD_PIN = '482917';
const STALE_PIN = '730561';
const ITEM = 'voi_biometric_secret';
const FLAG = 'voi_biometric_enabled';
const THROTTLE = 'voi_pin_throttle';
const WIPE_INTENT = 'voi_wipe_intent';

const mockPlatform = platform as unknown as {
  __secure: Map<string, string>;
  __kv: Map<string, string>;
  __ops: string[];
  __flags: {
    failReadOf: string | null;
    failWriteOf: string | null;
    authRead: 'normal' | 'throw';
    mobile: boolean;
    enrolled: boolean;
  };
  __reset: () => void;
  secureStorage: { getItemWithAuth: jest.Mock };
};
const getItemWithAuth = mockPlatform.secureStorage.getItemWithAuth;

// The device after a reinstall: a PIN credential and nothing else. Built once
// (PBKDF2 is slow) and restored before every test.
let snapshot: { secure: Map<string, string>; kv: Map<string, string> };

function resetThrottleMirror() {
  (
    AccountSecureStorage as unknown as { throttleMirror: unknown }
  ).throttleMirror = null;
}

beforeAll(async () => {
  mockPlatform.__reset();
  await AccountSecureStorage.setupPin(OLD_PIN, 'pin');
  snapshot = {
    secure: new Map(mockPlatform.__secure),
    kv: new Map(mockPlatform.__kv),
  };
});

let consoleSpies: jest.SpyInstance[] = [];
let mounted: { unmount: () => void } | null = null;

beforeEach(() => {
  mockPlatform.__reset();
  snapshot.secure.forEach((v, k) => mockPlatform.__secure.set(k, v));
  snapshot.kv.forEach((v, k) => mockPlatform.__kv.set(k, v));
  resetThrottleMirror();
  SessionKeyVault.clear();
  getItemWithAuth.mockClear();
  consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(
    (method) => jest.spyOn(console, method).mockImplementation(() => {})
  );
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  consoleSpies.forEach((spy) => spy.mockRestore());
  jest.restoreAllMocks();
});

/** Boot the real provider over the reinstalled device, then clear the log so
 *  only what the old-PIN step does is seen. */
async function bootAuth(): Promise<{ current: AuthContextType }> {
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <AuthProvider>{children}</AuthProvider>
  );
  const rendered = await renderHook(() => useAuth(), { wrapper });
  await waitFor(
    () => expect(rendered.result.current.authState.authChecked).toBe(true),
    { timeout: 60000 }
  );
  mounted = rendered;
  mockPlatform.__ops.length = 0;
  getItemWithAuth.mockClear();
  return rendered.result;
}

function seedItem(secret: string) {
  mockPlatform.__secure.set(
    ITEM,
    JSON.stringify({ secret, secretSource: 'pin' })
  );
}

function biometricWrites(): string[] {
  return mockPlatform.__ops.filter(
    (op) => op.endsWith(`:${ITEM}`) || op.endsWith(`:${FLAG}`)
  );
}

function expectNoBiometricWrites() {
  expect(biometricWrites()).toEqual([]);
}

function expectSecretNeverLogged() {
  for (const spy of consoleSpies) {
    for (const call of spy.mock.calls) {
      for (const arg of call) {
        const text =
          typeof arg === 'string'
            ? arg
            : arg instanceof Error
              ? `${arg.message} ${arg.stack ?? ''}`
              : (JSON.stringify(arg) ?? String(arg));
        expect(text).not.toContain(OLD_PIN);
        expect(text).not.toContain(STALE_PIN);
      }
    }
  }
}

async function unlockWithItem(
  auth: { current: AuthContextType },
  isCurrent?: () => boolean
) {
  let result: Awaited<
    ReturnType<AuthContextType['unlockForRestoreWithBiometrics']>
  > | null = null;
  await act(async () => {
    result = await auth.current.unlockForRestoreWithBiometrics(isCurrent);
  });
  return result!;
}

async function canOffer(auth: { current: AuthContextType }) {
  let offered: boolean | null = null;
  await act(async () => {
    offered = await auth.current.canOfferBiometricForRestore();
  });
  return offered!;
}

describe('readBiometricEnabledFlagState (read-only tri-state)', () => {
  it('reports absent, true and false, from AsyncStorage then the legacy secure-store copy, and writes nothing', async () => {
    expect(await AccountSecureStorage.readBiometricEnabledFlagState()).toBe(
      'absent'
    );
    mockPlatform.__kv.set(FLAG, 'true');
    expect(await AccountSecureStorage.readBiometricEnabledFlagState()).toBe(
      'true'
    );
    mockPlatform.__kv.set(FLAG, 'false');
    expect(await AccountSecureStorage.readBiometricEnabledFlagState()).toBe(
      'false'
    );
    mockPlatform.__kv.delete(FLAG);
    mockPlatform.__secure.set(FLAG, 'false');
    expect(await AccountSecureStorage.readBiometricEnabledFlagState()).toBe(
      'false'
    );
    mockPlatform.__secure.set(FLAG, 'true');
    expect(await AccountSecureStorage.readBiometricEnabledFlagState()).toBe(
      'true'
    );
    // No migration of the legacy copy.
    expect(mockPlatform.__ops).toEqual([]);
    expect(mockPlatform.__kv.has(FLAG)).toBe(false);
  });

  it('throws when a read fails, never reporting absent', async () => {
    mockPlatform.__flags.failReadOf = `kv:${FLAG}`;
    await expect(
      AccountSecureStorage.readBiometricEnabledFlagState()
    ).rejects.toThrow();
    mockPlatform.__flags.failReadOf = `secure:${FLAG}`;
    await expect(
      AccountSecureStorage.readBiometricEnabledFlagState()
    ).rejects.toThrow();
  });
});

describe('canOfferBiometricForRestore', () => {
  it('offers on a reinstalled phone (flag absent, enrolled, mobile, no wipe) without reading the item', async () => {
    seedItem(OLD_PIN);
    const auth = await bootAuth();
    expect(await canOffer(auth)).toBe(true);
    expect(getItemWithAuth).not.toHaveBeenCalled();
    expect(mockPlatform.__ops).toEqual([]);
  });

  it.each([
    ['the flag is false', () => mockPlatform.__kv.set(FLAG, 'false')],
    ['the flag is true', () => mockPlatform.__kv.set(FLAG, 'true')],
    [
      'only the legacy flag is false',
      () => mockPlatform.__secure.set(FLAG, 'false'),
    ],
    [
      'the flag read throws',
      () => {
        mockPlatform.__flags.failReadOf = `kv:${FLAG}`;
      },
    ],
    [
      'biometrics is not enrolled',
      () => {
        mockPlatform.__flags.enrolled = false;
      },
    ],
    [
      'the platform has no auth-gated store',
      () => {
        mockPlatform.__flags.mobile = false;
      },
    ],
    ['a wipe is pending', () => mockPlatform.__kv.set(WIPE_INTENT, '1')],
  ])('does not offer when %s', async (_label, arrange) => {
    seedItem(OLD_PIN);
    const auth = await bootAuth();
    arrange();
    expect(await canOffer(auth)).toBe(false);
    expect(getItemWithAuth).not.toHaveBeenCalled();
    expectNoBiometricWrites();
    // The legacy flag is never migrated by this path.
    expect(mockPlatform.__kv.has(FLAG)).toBe(
      _label === 'the flag is false' || _label === 'the flag is true'
    );
  });
});

describe('unlockForRestoreWithBiometrics', () => {
  it('verified: the saved secret goes through verifyPin and fills the vault as PIN entry does', async () => {
    seedItem(OLD_PIN);
    const auth = await bootAuth();
    const verifySpy = jest.spyOn(AccountSecureStorage, 'verifyPin');
    const migrateSpy = jest.spyOn(
      AccountSecureStorage,
      'migrateAllAccountsToV2'
    );
    const pick = (a: AuthContextType['authState']) => ({
      isLocked: a.isLocked,
      isAuthenticated: a.isAuthenticated,
      sessionId: a.sessionId,
    });
    const sessionBefore = pick(auth.current.authState);
    const result = await unlockWithItem(auth);
    expect(result).toEqual({
      status: 'verified',
      epoch: SessionKeyVault.currentEpoch(),
    });
    expect(getItemWithAuth).toHaveBeenCalledTimes(1);
    expect(getItemWithAuth).toHaveBeenCalledWith(ITEM, {
      prompt: 'Unlock with your old PIN',
    });
    expect(verifySpy).toHaveBeenCalledTimes(1);
    expect(verifySpy).toHaveBeenCalledWith(OLD_PIN);
    expect(SessionKeyVault.isUnlocked()).toBe(true);
    expect(SessionKeyVault.getSecretSource()).toBe('pin');
    // Not the lock-screen biometric path: no migration sweep, no session.
    expect(migrateSpy).not.toHaveBeenCalled();
    expect(unlockVaultWithBiometrics).not.toHaveBeenCalled();
    expect(pick(auth.current.authState)).toEqual(sessionBefore);
    expectNoBiometricWrites();
    expectSecretNeverLogged();
  });

  it.each([
    ['false', () => mockPlatform.__kv.set(FLAG, 'false')],
    ['true', () => mockPlatform.__kv.set(FLAG, 'true')],
  ])('flag %s: unavailable, no prompt, no verify', async (_label, arrange) => {
    seedItem(OLD_PIN);
    const auth = await bootAuth();
    arrange();
    const verifySpy = jest.spyOn(AccountSecureStorage, 'verifyPin');
    expect(await unlockWithItem(auth)).toEqual({ status: 'unavailable' });
    expect(getItemWithAuth).not.toHaveBeenCalled();
    expect(verifySpy).not.toHaveBeenCalled();
    expect(SessionKeyVault.isUnlocked()).toBe(false);
    expectNoBiometricWrites();
  });

  it('legacy flag false with AsyncStorage absent: unavailable, and no migration write', async () => {
    seedItem(OLD_PIN);
    const auth = await bootAuth();
    mockPlatform.__secure.set(FLAG, 'false');
    expect(await unlockWithItem(auth)).toEqual({ status: 'unavailable' });
    expect(getItemWithAuth).not.toHaveBeenCalled();
    expect(mockPlatform.__kv.has(FLAG)).toBe(false);
    expect(mockPlatform.__secure.get(FLAG)).toBe('false');
    expectNoBiometricWrites();
  });

  it('flag read throws: unavailable, no prompt', async () => {
    seedItem(OLD_PIN);
    const auth = await bootAuth();
    mockPlatform.__flags.failReadOf = `kv:${FLAG}`;
    expect(await unlockWithItem(auth)).toEqual({ status: 'unavailable' });
    expect(getItemWithAuth).not.toHaveBeenCalled();
    expectNoBiometricWrites();
  });

  it('no auth-gated store on this platform: unavailable, no read', async () => {
    seedItem(OLD_PIN);
    const auth = await bootAuth();
    mockPlatform.__flags.mobile = false;
    expect(await unlockWithItem(auth)).toEqual({ status: 'unavailable' });
    expect(getItemWithAuth).not.toHaveBeenCalled();
    expectNoBiometricWrites();
  });

  it('wipe pending: no prompt, wipe_pending', async () => {
    seedItem(OLD_PIN);
    const auth = await bootAuth();
    mockPlatform.__kv.set(WIPE_INTENT, '1');
    const verifySpy = jest.spyOn(AccountSecureStorage, 'verifyPin');
    expect(await unlockWithItem(auth)).toEqual({ status: 'wipe_pending' });
    expect(getItemWithAuth).not.toHaveBeenCalled();
    expect(verifySpy).not.toHaveBeenCalled();
    expect(SessionKeyVault.isUnlocked()).toBe(false);
    expectNoBiometricWrites();
  });

  it('PIN lockout active: no prompt, locked, no attempt counted', async () => {
    seedItem(OLD_PIN);
    const lockoutUntil = Date.now() + 10 * 60 * 1000;
    mockPlatform.__secure.set(
      THROTTLE,
      JSON.stringify({ failCount: 5, lockoutUntil, lastFailAt: Date.now() })
    );
    const auth = await bootAuth();
    const verifySpy = jest.spyOn(AccountSecureStorage, 'verifyPin');
    expect(await unlockWithItem(auth)).toEqual({ status: 'locked' });
    expect(getItemWithAuth).not.toHaveBeenCalled();
    expect(verifySpy).not.toHaveBeenCalled();
    expect(SessionKeyVault.isUnlocked()).toBe(false);
    expect(JSON.parse(mockPlatform.__secure.get(THROTTLE)!).failCount).toBe(5);
    expectNoBiometricWrites();
  });

  it('item absent: no_item, nothing verified', async () => {
    const auth = await bootAuth();
    const verifySpy = jest.spyOn(AccountSecureStorage, 'verifyPin');
    expect(await unlockWithItem(auth)).toEqual({ status: 'no_item' });
    expect(getItemWithAuth).toHaveBeenCalledTimes(1);
    expect(verifySpy).not.toHaveBeenCalled();
    expect(SessionKeyVault.isUnlocked()).toBe(false);
    expectNoBiometricWrites();
  });

  it('item corrupt: no_item, nothing verified, the item is left as it was', async () => {
    mockPlatform.__secure.set(ITEM, '{not json');
    const auth = await bootAuth();
    const verifySpy = jest.spyOn(AccountSecureStorage, 'verifyPin');
    expect(await unlockWithItem(auth)).toEqual({ status: 'no_item' });
    expect(verifySpy).not.toHaveBeenCalled();
    expect(mockPlatform.__secure.get(ITEM)).toBe('{not json');
    expectNoBiometricWrites();
  });

  it('OS prompt cancelled or failed (read throws): biometric_cancelled', async () => {
    seedItem(OLD_PIN);
    const auth = await bootAuth();
    mockPlatform.__flags.authRead = 'throw';
    const verifySpy = jest.spyOn(AccountSecureStorage, 'verifyPin');
    expect(await unlockWithItem(auth)).toEqual({
      status: 'biometric_cancelled',
    });
    expect(verifySpy).not.toHaveBeenCalled();
    expect(SessionKeyVault.isUnlocked()).toBe(false);
    expect(mockPlatform.__secure.has(ITEM)).toBe(true);
    expectNoBiometricWrites();
    expectSecretNeverLogged();
  });

  it('stale item (an older PIN): invalid, vault empty, counted as one wrong attempt by verifyPin', async () => {
    seedItem(STALE_PIN);
    const auth = await bootAuth();
    const before = await AccountSecureStorage.getPinThrottleState();
    const verifySpy = jest.spyOn(AccountSecureStorage, 'verifyPin');
    expect(await unlockWithItem(auth)).toEqual({ status: 'invalid' });
    expect(verifySpy).toHaveBeenCalledWith(STALE_PIN);
    expect(SessionKeyVault.isUnlocked()).toBe(false);
    const after = await AccountSecureStorage.getPinThrottleState();
    expect(after.attemptsRemaining).toBe(before.attemptsRemaining - 1);
    // The stale item is kept; this path never clears it.
    expect(JSON.parse(mockPlatform.__secure.get(ITEM)!).secret).toBe(STALE_PIN);
    expectNoBiometricWrites();
    expectSecretNeverLogged();
  });

  it('screen left while verifying (isCurrent false after the verify): cancelled, vault empty', async () => {
    seedItem(OLD_PIN);
    const auth = await bootAuth();
    const verifySpy = jest.spyOn(AccountSecureStorage, 'verifyPin');
    // Current until the verify has started, then left.
    const isCurrent = jest.fn(() => verifySpy.mock.calls.length === 0);
    expect(await unlockWithItem(auth, isCurrent)).toEqual({
      status: 'cancelled',
    });
    expect(verifySpy).toHaveBeenCalledTimes(1);
    expect(SessionKeyVault.isUnlocked()).toBe(false);
    expectNoBiometricWrites();
    expectSecretNeverLogged();
  });

  it('step already left before the read: cancelled, no prompt, no verify', async () => {
    seedItem(OLD_PIN);
    const auth = await bootAuth();
    const verifySpy = jest.spyOn(AccountSecureStorage, 'verifyPin');
    const isCurrent = jest.fn(() => false);
    expect(await unlockWithItem(auth, isCurrent)).toEqual({
      status: 'cancelled',
    });
    expect(isCurrent).toHaveBeenCalled();
    expect(getItemWithAuth).not.toHaveBeenCalled();
    expect(verifySpy).not.toHaveBeenCalled();
    expect(SessionKeyVault.isUnlocked()).toBe(false);
    expectNoBiometricWrites();
  });

  it('step left during the prompt: cancelled, no verify, vault empty', async () => {
    seedItem(OLD_PIN);
    const auth = await bootAuth();
    const verifySpy = jest.spyOn(AccountSecureStorage, 'verifyPin');
    let current = true;
    getItemWithAuth.mockImplementationOnce(async (k: string) => {
      // The person taps "I don't remember it" while the OS sheet is up.
      current = false;
      return mockPlatform.__secure.get(k) ?? null;
    });
    expect(await unlockWithItem(auth, () => current)).toEqual({
      status: 'cancelled',
    });
    expect(getItemWithAuth).toHaveBeenCalledTimes(1);
    expect(verifySpy).not.toHaveBeenCalled();
    expect(SessionKeyVault.isUnlocked()).toBe(false);
    expectNoBiometricWrites();
    expectSecretNeverLogged();
  });
});

// An explicit "biometrics off" must outlive a reinstall. A reinstall wipes
// AsyncStorage but keeps the keychain, so setBiometricEnabled(false) also
// leaves a plain (not auth-gated) secure-store 'false', which the old-PIN step
// reads as "not absent".
describe('the biometrics-off marker survives a reinstall', () => {
  function reinstall() {
    // AsyncStorage is wiped; the keychain (secure store) is kept.
    mockPlatform.__kv.clear();
  }

  it("setBiometricEnabled(false) writes 'false' to AsyncStorage and to the secure store", async () => {
    await AccountSecureStorage.setBiometricEnabled(false);
    expect(mockPlatform.__kv.get(FLAG)).toBe('false');
    expect(mockPlatform.__secure.get(FLAG)).toBe('false');
    expect(mockPlatform.__ops).toEqual([
      `kv:set:${FLAG}`,
      `secure:set:${FLAG}`,
    ]);
  });

  it('a failing secure-store write is ignored: AsyncStorage still says false and the call resolves', async () => {
    mockPlatform.__flags.failWriteOf = `secure:${FLAG}`;
    await expect(
      AccountSecureStorage.setBiometricEnabled(false)
    ).resolves.toBeUndefined();
    expect(mockPlatform.__kv.get(FLAG)).toBe('false');
    expect(mockPlatform.__ops).toEqual([
      `kv:set:${FLAG}`,
      `secure:setfail:${FLAG}`,
    ]);
  });

  it("setBiometricEnabled(true) removes the secure copy and never writes a secure 'true'", async () => {
    await AccountSecureStorage.setBiometricEnabled(false);
    mockPlatform.__ops.length = 0;
    await AccountSecureStorage.setBiometricEnabled(true);
    expect(mockPlatform.__kv.get(FLAG)).toBe('true');
    expect(mockPlatform.__secure.has(FLAG)).toBe(false);
    expect(mockPlatform.__ops).toEqual([
      `kv:set:${FLAG}`,
      `secure:del:${FLAG}`,
    ]);
  });

  it('after a reinstall the old-PIN step sees false, offers nothing, and the marker stays', async () => {
    seedItem(OLD_PIN);
    await AccountSecureStorage.setBiometricEnabled(false);
    reinstall();
    expect(await AccountSecureStorage.readBiometricEnabledFlagState()).toBe(
      'false'
    );
    expect(await AccountSecureStorage.isBiometricRestoreAvailable()).toBe(
      false
    );
    expect(await AccountSecureStorage.isBiometricEnabled()).toBe(false);
    // The migration copies it to AsyncStorage but keeps the marker.
    expect(mockPlatform.__kv.get(FLAG)).toBe('false');
    expect(mockPlatform.__secure.get(FLAG)).toBe('false');
    expect(getItemWithAuth).not.toHaveBeenCalled();
  });

  it('after a reinstall the step refuses before any prompt', async () => {
    seedItem(OLD_PIN);
    await AccountSecureStorage.setBiometricEnabled(false);
    // Keep the PIN credential's AsyncStorage copy so the provider boots as on
    // a reinstalled phone; drop only the flag's AsyncStorage copy.
    mockPlatform.__kv.delete(FLAG);
    const auth = await bootAuth();
    expect(await canOffer(auth)).toBe(false);
    expect(await unlockWithItem(auth)).toEqual({ status: 'unavailable' });
    expect(getItemWithAuth).not.toHaveBeenCalled();
    expect(mockPlatform.__secure.get(FLAG)).toBe('false');
  });

  it("secure 'false' with AsyncStorage empty: copied to AsyncStorage, and the secure copy is kept", async () => {
    mockPlatform.__secure.set(FLAG, 'false');
    expect(await AccountSecureStorage.isBiometricEnabled()).toBe(false);
    expect(mockPlatform.__kv.get(FLAG)).toBe('false');
    expect(mockPlatform.__secure.get(FLAG)).toBe('false');
    expect(mockPlatform.__ops).toEqual([`kv:set:${FLAG}`]);
  });

  it("legacy secure 'true' with AsyncStorage empty: migrated and deleted as before", async () => {
    mockPlatform.__secure.set(FLAG, 'true');
    expect(await AccountSecureStorage.isBiometricEnabled()).toBe(true);
    expect(mockPlatform.__kv.get(FLAG)).toBe('true');
    expect(mockPlatform.__secure.has(FLAG)).toBe(false);
  });

  it('clearAll removes the marker with everything else', async () => {
    seedItem(OLD_PIN);
    await AccountSecureStorage.setBiometricEnabled(false);
    expect(mockPlatform.__secure.get(FLAG)).toBe('false');
    await AccountSecureStorage.clearAll();
    expect(mockPlatform.__secure.has(FLAG)).toBe(false);
    expect(mockPlatform.__secure.has(ITEM)).toBe(false);
    expect(mockPlatform.__kv.has(FLAG)).toBe(false);
  });

  // Every production "biometrics off" goes through setBiometricEnabled(false),
  // so each one leaves the marker; nothing else writes the flag key.
  it('every production biometrics-off call goes through the one function', () => {
    const { readFileSync, readdirSync, statSync } = require('fs');
    const { join, relative, resolve } = require('path');
    const root = resolve(__dirname, '../..');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) {
          if (name !== '__tests__') walk(full);
        } else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name)) {
          files.push(full);
        }
      }
    };
    walk(root);
    const callers: Record<string, number> = {};
    const keyUsers: string[] = [];
    for (const file of files) {
      const source: string = readFileSync(file, 'utf8');
      const rel = relative(root, file);
      const calls = source.match(
        /await (?:this|AccountSecureStorage)\.setBiometricEnabled\(false\)/g
      );
      if (calls) callers[rel] = calls.length;
      if (source.includes('voi_biometric_enabled')) keyUsers.push(rel);
    }
    expect(callers).toEqual({
      'contexts/AuthContext.tsx': 1,
      'screens/onboarding/SecuritySetupScreen.tsx': 2,
      'services/secure/AccountSecureStorage.ts': 1,
      'services/secure/biometricUnlock.ts': 1,
      'services/secure/orphanPin.ts': 1,
    });
    // The backup collector names the key but reads the flag through
    // isBiometricEnabled; only AccountSecureStorage writes it.
    expect(keyUsers.sort()).toEqual([
      'services/backup/collectors.ts',
      'services/secure/AccountSecureStorage.ts',
    ]);
  });
});
