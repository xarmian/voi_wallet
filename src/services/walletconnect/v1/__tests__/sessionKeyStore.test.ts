// Unit tests for the WalletConnect v1 secure session-key store (PLAN-260, TASK-261).
//
// Proves the invariants the rest of the plan leans on:
//   - round-trip through the single constant slot,
//   - a topic MISMATCH reads as "no key" rather than handing back a wrong key,
//   - a malformed envelope / non-hex / wrong-length key fails closed,
//   - deletion is TOPIC-CONDITIONAL (DR-3a) — the regression that would
//     otherwise destroy a retained session's key,
//   - rollback restores or clears the prior slot value (DR-5a),
//   - an Android keystore-desync THROW propagates from reads (so the caller can
//     decide) but is absorbed by deletion,
//   - and that no key material ever reaches a console call (DR-13).

jest.mock('@/platform', () => {
  const secure = new Map<string, string>();
  let throwOnGet: Error | null = null;
  return {
    __secure: secure,
    __reset: () => {
      secure.clear();
      throwOnGet = null;
    },
    __throwOnGet: (error: Error | null) => {
      throwOnGet = error;
    },
    secureStorage: {
      setItem: async (k: string, v: string) => {
        secure.set(k, v);
      },
      getItem: async (k: string) => {
        if (throwOnGet) {
          throw throwOnGet;
        }
        return secure.has(k) ? secure.get(k)! : null;
      },
      deleteItem: async (k: string) => {
        secure.delete(k);
      },
    },
  };
});

import {
  isValidV1SessionKey,
  readSessionKey,
  readSessionKeySlotRaw,
  writeSessionKey,
  restoreSessionKeySlot,
  deleteSessionKeyForTopic,
  deleteSessionKeySlot,
} from '../sessionKeyStore';
import { WC_V1_SESSION_KEY_SLOT } from '../config';

const platformMock = jest.requireMock('@/platform') as {
  __secure: Map<string, string>;
  __reset: () => void;
  __throwOnGet: (error: Error | null) => void;
};

// Throwaway test vectors — not real session keys.
const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);
const TOPIC_A = 'topic-aaaa-1111';
const TOPIC_B = 'topic-bbbb-2222';

beforeEach(() => {
  platformMock.__reset();
  jest.restoreAllMocks();
});

describe('isValidV1SessionKey', () => {
  it('accepts 64-char hex in either case', () => {
    expect(isValidV1SessionKey(KEY_A)).toBe(true);
    expect(isValidV1SessionKey('A1b2'.repeat(16))).toBe(true);
  });

  it('rejects wrong length, non-hex, and non-strings', () => {
    expect(isValidV1SessionKey('a'.repeat(63))).toBe(false);
    expect(isValidV1SessionKey('a'.repeat(65))).toBe(false);
    expect(isValidV1SessionKey('z'.repeat(64))).toBe(false);
    expect(isValidV1SessionKey('')).toBe(false);
    expect(isValidV1SessionKey(undefined)).toBe(false);
    expect(isValidV1SessionKey(null)).toBe(false);
    expect(isValidV1SessionKey(123)).toBe(false);
    expect(isValidV1SessionKey({ key: KEY_A })).toBe(false);
  });
});

describe('write / read round-trip', () => {
  it('returns the key for the bound topic', async () => {
    await writeSessionKey(TOPIC_A, KEY_A);
    await expect(readSessionKey(TOPIC_A)).resolves.toBe(KEY_A);
  });

  it('uses the single constant slot', async () => {
    await writeSessionKey(TOPIC_A, KEY_A);
    expect([...platformMock.__secure.keys()]).toEqual([WC_V1_SESSION_KEY_SLOT]);
  });

  it('reads null when the slot is empty', async () => {
    await expect(readSessionKey(TOPIC_A)).resolves.toBeNull();
  });

  it('refuses to persist a malformed key or a missing topic', async () => {
    await expect(writeSessionKey(TOPIC_A, 'not-a-key')).rejects.toThrow();
    await expect(writeSessionKey('', KEY_A)).rejects.toThrow();
    expect(platformMock.__secure.size).toBe(0);
  });
});

describe('topic binding (DR-3)', () => {
  it('returns null for a DIFFERENT topic rather than the stored key', async () => {
    await writeSessionKey(TOPIC_A, KEY_A);
    await expect(readSessionKey(TOPIC_B)).resolves.toBeNull();
  });

  it('a newer pairing overwrites the slot and the older topic reads null', async () => {
    await writeSessionKey(TOPIC_A, KEY_A);
    await writeSessionKey(TOPIC_B, KEY_B);
    await expect(readSessionKey(TOPIC_B)).resolves.toBe(KEY_B);
    await expect(readSessionKey(TOPIC_A)).resolves.toBeNull();
  });
});

describe('malformed envelopes fail closed (DR-10)', () => {
  it.each([
    ['not json at all', 'definitely-not-json'],
    ['a json scalar', '"just-a-string"'],
    ['null', 'null'],
    ['missing topic', JSON.stringify({ key: KEY_A })],
    ['blank topic', JSON.stringify({ topic: '', key: KEY_A })],
    ['missing key', JSON.stringify({ topic: TOPIC_A })],
    ['non-hex key', JSON.stringify({ topic: TOPIC_A, key: 'z'.repeat(64) })],
    ['short key', JSON.stringify({ topic: TOPIC_A, key: 'a'.repeat(32) })],
  ])('reads null for %s', async (_label, raw) => {
    platformMock.__secure.set(WC_V1_SESSION_KEY_SLOT, raw);
    await expect(readSessionKey(TOPIC_A)).resolves.toBeNull();
  });
});

describe('topic-conditional deletion (DR-3a)', () => {
  it('deletes the slot when it is bound to the given topic', async () => {
    await writeSessionKey(TOPIC_A, KEY_A);
    await deleteSessionKeyForTopic(TOPIC_A);
    expect(platformMock.__secure.has(WC_V1_SESSION_KEY_SLOT)).toBe(false);
  });

  it('REGRESSION: leaves a slot bound to a different topic intact', async () => {
    // The pair-then-reject sequence: session A is stored, B is being paired,
    // B is rejected and clears "its" session. A's key must survive.
    await writeSessionKey(TOPIC_A, KEY_A);
    await deleteSessionKeyForTopic(TOPIC_B);
    await expect(readSessionKey(TOPIC_A)).resolves.toBe(KEY_A);
  });

  it('clears an unparseable slot, which is useless to everyone', async () => {
    platformMock.__secure.set(WC_V1_SESSION_KEY_SLOT, 'garbage');
    await deleteSessionKeyForTopic(TOPIC_A);
    expect(platformMock.__secure.has(WC_V1_SESSION_KEY_SLOT)).toBe(false);
  });

  it('is a no-op on an empty slot', async () => {
    await expect(deleteSessionKeyForTopic(TOPIC_A)).resolves.toBeUndefined();
  });

  it('deleteSessionKeySlot clears regardless of binding', async () => {
    await writeSessionKey(TOPIC_A, KEY_A);
    await deleteSessionKeySlot();
    expect(platformMock.__secure.has(WC_V1_SESSION_KEY_SLOT)).toBe(false);
  });
});

describe('rollback (DR-5a)', () => {
  it('restores the prior value after a failed paired write', async () => {
    await writeSessionKey(TOPIC_A, KEY_A);
    const prior = await readSessionKeySlotRaw();

    // Session B takes the slot, then its metadata write fails.
    await writeSessionKey(TOPIC_B, KEY_B);
    await restoreSessionKeySlot(prior);

    await expect(readSessionKey(TOPIC_A)).resolves.toBe(KEY_A);
    await expect(readSessionKey(TOPIC_B)).resolves.toBeNull();
  });

  it('clears the slot when there was nothing there before', async () => {
    const prior = await readSessionKeySlotRaw();
    expect(prior).toBeNull();

    await writeSessionKey(TOPIC_B, KEY_B);
    await restoreSessionKeySlot(prior);

    expect(platformMock.__secure.has(WC_V1_SESSION_KEY_SLOT)).toBe(false);
  });
});

describe('Android keystore desync', () => {
  const desync = new Error(
    'Secure storage read failed: a stored item is present but unreadable'
  );

  it('propagates from reads so the caller can decide (DR-4)', async () => {
    platformMock.__throwOnGet(desync);
    await expect(readSessionKey(TOPIC_A)).rejects.toThrow(desync);
    await expect(readSessionKeySlotRaw()).rejects.toThrow(desync);
  });

  it('is absorbed by deletion, which clears the unreadable entry', async () => {
    platformMock.__secure.set(WC_V1_SESSION_KEY_SLOT, 'unreadable');
    platformMock.__throwOnGet(desync);

    await expect(deleteSessionKeyForTopic(TOPIC_A)).resolves.toBeUndefined();
    expect(platformMock.__secure.has(WC_V1_SESSION_KEY_SLOT)).toBe(false);
  });
});

describe('no key material reaches logs (DR-13)', () => {
  it('logs a fixed message and never the payload when discarding a bad record', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});

    // A malformed payload that nonetheless embeds a key, in both the bare form
    // and the `key=<hex>` URI form.
    platformMock.__secure.set(
      WC_V1_SESSION_KEY_SLOT,
      `{ broken json, key=${KEY_A}, ${KEY_A} }`
    );
    await expect(readSessionKey(TOPIC_A)).resolves.toBeNull();

    const logged = [...warn.mock.calls, ...error.mock.calls, ...log.mock.calls]
      .flat()
      .map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg)))
      .join(' ');

    expect(logged).not.toContain(KEY_A);
    expect(logged).not.toMatch(/[0-9a-f]{64}/i);
    expect(warn).toHaveBeenCalledWith(
      'WC v1 SessionKeyStore: discarding malformed stored record'
    );
  });

  it('does not log the key on a successful round-trip', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});

    await writeSessionKey(TOPIC_A, KEY_A);
    await readSessionKey(TOPIC_A);
    await deleteSessionKeyForTopic(TOPIC_A);

    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });
});
