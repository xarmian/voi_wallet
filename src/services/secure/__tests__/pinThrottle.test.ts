// Unit tests for the PERSISTENT PIN throttle (DOC-137 §8 / TASK-26).
//
// Proves that AccountSecureStorage.verifyPin (which KEEPS its boolean return):
//   - counts wrong PINs and locks out at PIN_ATTEMPT_LIMIT,
//   - while locked, refuses WITHOUT running the PBKDF2 hash (even a correct PIN),
//   - resets on success,
//   - persists the lockout across a simulated relaunch (record lives in
//     SecureStore, not in-memory state),
//   - never loses an increment under concurrent calls (promise-chain mutex),
//   - and that the escalating backoff math + getPinThrottleState values are correct.
//
// SECURITY NOTE: PINs here are throwaway test strings; no secret or hash is logged.

// In-memory platform mock (SecureStore/AsyncStorage/crypto). getRandomBytes is
// backed by Node so salt generation runs; hashing uses the real crypto-js PBKDF2.
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
      getItem: async (k: string) => (secure.has(k) ? secure.get(k)! : null),
      setItem: async (k: string, v: string) => {
        secure.set(k, v);
      },
      deleteItem: async (k: string) => {
        secure.delete(k);
      },
      getItemWithAuth: async (k: string) =>
        secure.has(k) ? secure.get(k)! : null,
    },
    storage: {
      getItem: async (k: string) => (kv.has(k) ? kv.get(k)! : null),
      setItem: async (k: string, v: string) => {
        kv.set(k, v);
      },
      removeItem: async (k: string) => {
        kv.delete(k);
      },
      multiRemove: async (keys: string[]) => {
        keys.forEach((k) => kv.delete(k));
      },
    },
    biometrics: {
      isAvailable: async () => false,
      isEnrolled: async () => false,
    },
    deviceId: {
      getDeviceId: async () => 'throttle-test-device-idfv',
    },
  };
});

import 'crypto-js/pbkdf2';
import * as platform from '@/platform';
import { AccountSecureStorage } from '../AccountSecureStorage';
import { SECURITY_CONFIG } from '../../../config/security';

const { PIN_ATTEMPT_LIMIT, PIN_LOCKOUT_DURATION } = SECURITY_CONFIG;
const DAY_MS = 24 * 60 * 60 * 1000;
const CORRECT_PIN = '123456';
const WRONG_PIN = '000000';
const THROTTLE_KEY = 'voi_pin_throttle';

const mockPlatform = platform as unknown as {
  __secure: Map<string, string>;
  __reset: () => void;
};

// Deterministic clock so lockout math is exact.
let mockNow = 1_700_000_000_000;

const getState = () => AccountSecureStorage.getPinThrottleState();
const failOnce = () => AccountSecureStorage.verifyPin(WRONG_PIN);

/** Fail once, first jumping the clock past any active lockout. */
async function failPastLockout(): Promise<void> {
  const state = await getState();
  if (state.lockedUntil !== null) {
    mockNow = state.lockedUntil + 1;
  }
  await failOnce();
}

beforeEach(async () => {
  mockPlatform.__reset();
  mockNow = 1_700_000_000_000;
  jest.spyOn(Date, 'now').mockImplementation(() => mockNow);
  await AccountSecureStorage.storePin(CORRECT_PIN);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('PIN throttle backoff math (pinLockoutBackoff)', () => {
  const backoff = (n: number): number =>
    (
      AccountSecureStorage as unknown as {
        pinLockoutBackoff: (n: number) => number;
      }
    ).pinLockoutBackoff(n);

  it('doubles the lockout every PIN_ATTEMPT_LIMIT failures', () => {
    expect(backoff(5)).toBe(PIN_LOCKOUT_DURATION); // 5 min
    expect(backoff(9)).toBe(PIN_LOCKOUT_DURATION); // still tier 1
    expect(backoff(10)).toBe(PIN_LOCKOUT_DURATION * 2); // 10 min
    expect(backoff(15)).toBe(PIN_LOCKOUT_DURATION * 4); // 20 min
    expect(backoff(20)).toBe(PIN_LOCKOUT_DURATION * 8); // 40 min
  });

  it('caps the escalation at 24h', () => {
    expect(backoff(50)).toBe(DAY_MS);
    expect(backoff(200)).toBe(DAY_MS);
  });
});

describe('verifyPin throttle behavior', () => {
  it('starts with a clean throttle state', async () => {
    const state = await getState();
    expect(state).toEqual({
      lockedUntil: null,
      attemptsRemaining: PIN_ATTEMPT_LIMIT,
    });
  });

  it('increments on wrong PIN and locks out at the limit', async () => {
    for (let i = 1; i < PIN_ATTEMPT_LIMIT; i++) {
      expect(await failOnce()).toBe(false);
      const state = await getState();
      expect(state.attemptsRemaining).toBe(PIN_ATTEMPT_LIMIT - i);
      expect(state.lockedUntil).toBeNull();
    }

    // The PIN_ATTEMPT_LIMIT-th failure arms the first-tier (5 min) lockout.
    expect(await failOnce()).toBe(false);
    const locked = await getState();
    expect(locked.attemptsRemaining).toBe(0);
    expect(locked.lockedUntil).toBe(mockNow + PIN_LOCKOUT_DURATION);
  });

  it('escalates the lockout at each PIN_ATTEMPT_LIMIT multiple', async () => {
    const expectations: [number, number][] = [
      [5, PIN_LOCKOUT_DURATION], // 5 min
      [10, PIN_LOCKOUT_DURATION * 2], // 10 min
      [15, PIN_LOCKOUT_DURATION * 4], // 20 min
    ];
    let idx = 0;
    for (let failCount = 1; failCount <= 15; failCount++) {
      await failPastLockout();
      if (idx < expectations.length && failCount === expectations[idx][0]) {
        const state = await getState();
        expect(state.lockedUntil).not.toBeNull();
        expect((state.lockedUntil ?? 0) - mockNow).toBe(expectations[idx][1]);
        idx++;
      }
    }
    expect(idx).toBe(expectations.length);
  });

  it('refuses WITHOUT running the hash while locked out', async () => {
    for (let i = 0; i < PIN_ATTEMPT_LIMIT; i++) {
      await failOnce();
    }
    expect((await getState()).lockedUntil).not.toBeNull();

    // Spy AFTER lockout is armed: a call during the window must not hash — and
    // even the CORRECT pin is refused.
    const hashSpy = jest.spyOn(
      AccountSecureStorage as unknown as {
        hashPin: (...a: unknown[]) => string;
      },
      'hashPin'
    );
    expect(await AccountSecureStorage.verifyPin(CORRECT_PIN)).toBe(false);
    expect(hashSpy).not.toHaveBeenCalled();
  });

  it('resets the throttle on a successful verify', async () => {
    await failOnce();
    await failOnce();
    expect((await getState()).attemptsRemaining).toBe(PIN_ATTEMPT_LIMIT - 2);

    expect(await AccountSecureStorage.verifyPin(CORRECT_PIN)).toBe(true);

    const state = await getState();
    expect(state.attemptsRemaining).toBe(PIN_ATTEMPT_LIMIT);
    expect(state.lockedUntil).toBeNull();
    expect(mockPlatform.__secure.has(THROTTLE_KEY)).toBe(false);
  });

  it('clears the lockout once the window elapses, then allows a retry', async () => {
    for (let i = 0; i < PIN_ATTEMPT_LIMIT; i++) {
      await failOnce();
    }
    const locked = await getState();
    expect(locked.lockedUntil).not.toBeNull();

    // Jump past the lockout window.
    mockNow = (locked.lockedUntil ?? 0) + 1;
    expect((await getState()).lockedUntil).toBeNull();

    // A correct PIN now succeeds and wipes the record.
    expect(await AccountSecureStorage.verifyPin(CORRECT_PIN)).toBe(true);
    expect((await getState()).attemptsRemaining).toBe(PIN_ATTEMPT_LIMIT);
  });

  it('persists the lockout across a simulated relaunch', async () => {
    for (let i = 0; i < PIN_ATTEMPT_LIMIT; i++) {
      await failOnce();
    }
    const before = await getState();
    expect(before.lockedUntil).not.toBeNull();

    // Simulate a relaunch: the ONLY app-level state that resets is in-memory
    // (there is no in-memory throttle cache). The record lives in SecureStore,
    // so a fresh read still reports the lockout.
    AccountSecureStorage.clearPrivateKeyCache();
    expect(mockPlatform.__secure.has(THROTTLE_KEY)).toBe(true);

    const after = await getState();
    expect(after.lockedUntil).toBe(before.lockedUntil);
    // Still within the window -> even the correct PIN is refused.
    expect(await AccountSecureStorage.verifyPin(CORRECT_PIN)).toBe(false);
  });

  it('does not lose increments under concurrent verifyPin (mutex)', async () => {
    // Fire (LIMIT - 1) wrong PINs in parallel — all should count (stays under
    // the lockout threshold). Without the mutex, concurrent read-modify-write
    // would lose increments and attemptsRemaining would be too high.
    const n = PIN_ATTEMPT_LIMIT - 1;
    await Promise.all(Array.from({ length: n }, () => failOnce()));

    const state = await getState();
    expect(state.attemptsRemaining).toBe(PIN_ATTEMPT_LIMIT - n);
    expect(state.lockedUntil).toBeNull();
  });

  it('does not count malformed input as an attempt', async () => {
    expect(await AccountSecureStorage.verifyPin('12')).toBe(false);
    expect(await AccountSecureStorage.verifyPin('abcdef')).toBe(false);
    expect(await AccountSecureStorage.verifyPin('')).toBe(false);
    expect((await getState()).attemptsRemaining).toBe(PIN_ATTEMPT_LIMIT);
  });

  it('clearAll wipes the persisted throttle record', async () => {
    for (let i = 0; i < PIN_ATTEMPT_LIMIT; i++) {
      await failOnce();
    }
    expect(mockPlatform.__secure.has(THROTTLE_KEY)).toBe(true);

    await AccountSecureStorage.clearAll();
    expect(mockPlatform.__secure.has(THROTTLE_KEY)).toBe(false);
    expect(await getState()).toEqual({
      lockedUntil: null,
      attemptsRemaining: PIN_ATTEMPT_LIMIT,
    });
  });
});
