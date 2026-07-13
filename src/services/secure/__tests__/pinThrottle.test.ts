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

// Reset the private in-memory throttle mirror to simulate a fresh process.
const resetThrottleMirror = () => {
  (
    AccountSecureStorage as unknown as { throttleMirror: unknown }
  ).throttleMirror = null;
};

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
  resetThrottleMirror();
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

  it('a reset then a later increment persists the increment, ordered in-mutex', async () => {
    // Both the reset (delete) and the increment (save) are plain awaited writes
    // in the same mutex, so they serialize: reset clears the counter, then the
    // later increment reads clean and persists 1 — never clobbered or doubled.
    await failOnce(); // failCount 1
    expect(await AccountSecureStorage.verifyPin(CORRECT_PIN)).toBe(true); // reset -> clean
    expect(await AccountSecureStorage.verifyPin(WRONG_PIN)).toBe(false); // reads clean -> 1

    const raw = mockPlatform.__secure.get(THROTTLE_KEY);
    expect(raw).toBeDefined(); // increment persisted, not erased by the reset
    expect(JSON.parse(raw as string).failCount).toBe(1);
    expect((await getState()).attemptsRemaining).toBe(PIN_ATTEMPT_LIMIT - 1);
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

    // Simulate a relaunch: a fresh process starts with an EMPTY in-memory
    // mirror; only the SecureStore record survives. Clearing the mirror proves
    // the persisted record alone still enforces the lockout.
    AccountSecureStorage.clearPrivateKeyCache();
    resetThrottleMirror();
    expect(mockPlatform.__secure.has(THROTTLE_KEY)).toBe(true);

    const after = await getState();
    expect(after.lockedUntil).toBe(before.lockedUntil);
    // Still within the window -> even the correct PIN is refused.
    expect(await AccountSecureStorage.verifyPin(CORRECT_PIN)).toBe(false);
  });

  it('durably persists a single increment before verifyPin resolves (force-kill race)', async () => {
    // verifyPin awaits the persist, so once it resolves false the record is
    // already on disk. Clearing the mirror (fresh process after a force-kill)
    // must still show the increment purely from the persisted record.
    expect(await failOnce()).toBe(false);
    expect(mockPlatform.__secure.has(THROTTLE_KEY)).toBe(true); // persisted, not fire-and-forget

    resetThrottleMirror();
    expect((await getState()).attemptsRemaining).toBe(PIN_ATTEMPT_LIMIT - 1);
  });

  it('persists sequential increments in order (no out-of-order clobber)', async () => {
    // Two awaited increments through the mutex land 1 then 2 in order — there is
    // no timed-out write that could complete late and overwrite a newer counter.
    await failOnce();
    expect(
      JSON.parse(mockPlatform.__secure.get(THROTTLE_KEY) as string).failCount
    ).toBe(1);
    await failOnce();
    expect(
      JSON.parse(mockPlatform.__secure.get(THROTTLE_KEY) as string).failCount
    ).toBe(2);
    expect((await getState()).attemptsRemaining).toBe(PIN_ATTEMPT_LIMIT - 2);
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

// Codex P1: the throttle must fail CLOSED. A corrupt record, a read/IO error,
// or a swallowed write failure must NOT reset the counter and let an attacker
// keep guessing. Only a genuinely-absent record (fresh install) is clean.
describe('PIN throttle fails closed (Codex P1)', () => {
  it('treats a corrupt/unparseable stored record as locked, without hashing', async () => {
    // A rooted/tampered device overwrites the record with garbage to reset it.
    mockPlatform.__secure.set(THROTTLE_KEY, 'not-json-{{{');
    resetThrottleMirror(); // fresh process re-reads the tampered persisted value

    const hashSpy = jest.spyOn(
      AccountSecureStorage as unknown as {
        hashPin: (...a: unknown[]) => string;
      },
      'hashPin'
    );

    // Even the correct PIN is refused while fail-closed, and no hash is run.
    expect(await AccountSecureStorage.verifyPin(CORRECT_PIN)).toBe(false);
    expect(hashSpy).not.toHaveBeenCalled();

    const state = await getState();
    expect(state.lockedUntil).toBe(mockNow + PIN_LOCKOUT_DURATION);
    expect(state.attemptsRemaining).toBe(0);
  });

  it('best-effort repairs a corrupt record into a valid fail-closed record', async () => {
    mockPlatform.__secure.set(THROTTLE_KEY, '{ broken');
    resetThrottleMirror();

    await getState(); // triggers the corrupt-detection + repair write

    const repaired = mockPlatform.__secure.get(THROTTLE_KEY);
    expect(repaired).toBeDefined();
    const parsed = JSON.parse(repaired as string);
    expect(parsed.failCount).toBe(PIN_ATTEMPT_LIMIT);
    expect(parsed.lockoutUntil).toBe(mockNow + PIN_LOCKOUT_DURATION);
  });

  it('treats a read/IO error as locked, without hashing', async () => {
    resetThrottleMirror();
    jest
      .spyOn(platform.secureStorage, 'getItem')
      .mockImplementation(async (k: string) => {
        if (k === THROTTLE_KEY) {
          throw new Error('secure read failure');
        }
        return mockPlatform.__secure.has(k)
          ? (mockPlatform.__secure.get(k) as string)
          : null;
      });

    const hashSpy = jest.spyOn(
      AccountSecureStorage as unknown as {
        hashPin: (...a: unknown[]) => string;
      },
      'hashPin'
    );

    expect(await AccountSecureStorage.verifyPin(CORRECT_PIN)).toBe(false);
    expect(hashSpy).not.toHaveBeenCalled();

    const state = await getState();
    expect(state.lockedUntil).not.toBeNull();
    expect(state.attemptsRemaining).toBe(0);
  });

  it('enforces via the in-memory mirror when the persisted write fails', async () => {
    // SecureStore writes fail (e.g. disk/IO error): the persisted record never
    // updates, but the mirror must still count the failures within the session.
    jest
      .spyOn(platform.secureStorage, 'setItem')
      .mockRejectedValue(new Error('secure write failure'));

    // Two wrong attempts: the mirror tracks them even though nothing persisted.
    await failOnce();
    await failOnce();
    expect(mockPlatform.__secure.has(THROTTLE_KEY)).toBe(false); // never written
    expect((await getState()).attemptsRemaining).toBe(PIN_ATTEMPT_LIMIT - 2);

    // Continue to the limit: the mirror locks out even with no persistence.
    for (let i = 2; i < PIN_ATTEMPT_LIMIT; i++) {
      await failOnce();
    }
    const locked = await getState();
    expect(locked.attemptsRemaining).toBe(0);
    expect(locked.lockedUntil).not.toBeNull();
    // A locked session refuses even the correct PIN — purely via the mirror.
    expect(await AccountSecureStorage.verifyPin(CORRECT_PIN)).toBe(false);
  });

  it('a genuinely-absent record stays clean (does not fail closed)', async () => {
    // No throttle key present (fresh install) — must be unlocked, LIMIT attempts.
    resetThrottleMirror();
    expect(mockPlatform.__secure.has(THROTTLE_KEY)).toBe(false);
    expect(await getState()).toEqual({
      lockedUntil: null,
      attemptsRemaining: PIN_ATTEMPT_LIMIT,
    });
    // And a correct PIN still verifies normally.
    expect(await AccountSecureStorage.verifyPin(CORRECT_PIN)).toBe(true);
  });
});
