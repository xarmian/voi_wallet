// Unit tests for the SessionKeyVault (DOC-137 §6.2 / Codex P1-D, PR3).
//
// Covers: set() unlock + epoch bump; getWrapKey memoization (scrypt runs ONCE
// per account); getWrapKey locked-guard; clear() zeroing wrap-key buffers +
// locking + epoch bump; rotate() secret swap without re-lock + wrap-key
// invalidation; and the epoch-abort guard (a derivation whose epoch changes
// mid-flight returns NO material, caches nothing, and zeroes the fresh key).
//
// SECURITY NOTE: `deriveWrapKey` (scrypt) is MOCKED so the suite is fast and so
// call counts / timing are observable. No real secret or key material is used —
// wrap keys are synthetic non-zero byte patterns.

// Mock the scrypt KDF so we can count derivations and control their timing. The
// vault imports exactly these two symbols from envelopeV2.
jest.mock('../envelopeV2', () => ({
  AT_REST_KDF_PARAMS: { N: 2 ** 12, r: 8, p: 1, dkLen: 32 },
  deriveWrapKey: jest.fn(),
}));

import { SessionKeyVault, VaultLockedError } from '../SessionKeyVault';
import { deriveWrapKey } from '../envelopeV2';

const mockDerive = deriveWrapKey as jest.MockedFunction<typeof deriveWrapKey>;

const SALT = 'ab'.repeat(32); // 32-byte hex salt (value irrelevant to the mock)

/** A synthetic, all-`fill` non-zero 32-byte wrap key (NOT real key material). */
function nonZeroKey(fill = 7): Uint8Array {
  return Uint8Array.from({ length: 32 }, () => fill);
}

beforeEach(() => {
  // The vault is a process singleton; reset it to a locked state each test.
  SessionKeyVault.clear();
  mockDerive.mockReset();
  mockDerive.mockImplementation(async () => nonZeroKey());
});

describe('SessionKeyVault set / secret exposure', () => {
  it('starts locked and exposes no secret', () => {
    expect(SessionKeyVault.isUnlocked()).toBe(false);
    expect(SessionKeyVault.getSecret()).toBeNull();
  });

  it('set() unlocks, records the secret + source, and bumps the epoch', () => {
    const before = SessionKeyVault.currentEpoch();
    SessionKeyVault.set('123456', 'pin');
    expect(SessionKeyVault.isUnlocked()).toBe(true);
    expect(SessionKeyVault.getSecret()).toBe('123456');
    expect(SessionKeyVault.getSecretSource()).toBe('pin');
    expect(SessionKeyVault.currentEpoch()).toBe(before + 1);
  });
});

describe('SessionKeyVault getWrapKey (memoized scrypt)', () => {
  it('runs scrypt at most ONCE per (account, salt) and returns the memoized buffer', async () => {
    SessionKeyVault.set('123456', 'pin');

    const k1 = await SessionKeyVault.getWrapKey('acct-1', SALT);
    const k2 = await SessionKeyVault.getWrapKey('acct-1', SALT);

    expect(k2).toBe(k1); // same memoized instance
    expect(mockDerive).toHaveBeenCalledTimes(1);

    await SessionKeyVault.getWrapKey('acct-2', SALT);
    expect(mockDerive).toHaveBeenCalledTimes(2); // per-account derivation
  });

  it('memoizes per SALT too: the same account with a different salt derives again', async () => {
    SessionKeyVault.set('123456', 'pin');
    const otherSalt = 'cd'.repeat(32);

    await SessionKeyVault.getWrapKey('acct-1', SALT);
    await SessionKeyVault.getWrapKey('acct-1', SALT); // memoized
    expect(mockDerive).toHaveBeenCalledTimes(1);

    // A different blob salt for the SAME account (dual-slot) must derive its own
    // wrap key, not collide on accountId.
    await SessionKeyVault.getWrapKey('acct-1', otherSalt);
    expect(mockDerive).toHaveBeenCalledTimes(2);
  });

  it('throws VaultLockedError (and never derives) when locked', async () => {
    expect(SessionKeyVault.isUnlocked()).toBe(false);
    await expect(
      SessionKeyVault.getWrapKey('acct', SALT)
    ).rejects.toBeInstanceOf(VaultLockedError);
    expect(mockDerive).not.toHaveBeenCalled();
  });
});

describe('SessionKeyVault clear (zeroes buffers + bumps epoch)', () => {
  it('zeroes memoized wrap keys in place, locks, and bumps the epoch', async () => {
    SessionKeyVault.set('123456', 'pin');
    const key = await SessionKeyVault.getWrapKey('acct', SALT);
    expect(key.some((b) => b !== 0)).toBe(true);

    const before = SessionKeyVault.currentEpoch();
    SessionKeyVault.clear();

    // The exact buffer the caller holds is zeroed (defense-in-depth scrub).
    expect(Array.from(key).every((b) => b === 0)).toBe(true);
    expect(SessionKeyVault.isUnlocked()).toBe(false);
    expect(SessionKeyVault.getSecret()).toBeNull();
    expect(SessionKeyVault.currentEpoch()).toBe(before + 1);
  });
});

describe('SessionKeyVault rotate (secret swap, no re-lock)', () => {
  it('swaps the secret without locking, invalidates wrap keys, and bumps epoch', async () => {
    SessionKeyVault.set('111111', 'pin');
    const oldKey = await SessionKeyVault.getWrapKey('acct', SALT);
    expect(mockDerive).toHaveBeenCalledTimes(1);

    const before = SessionKeyVault.currentEpoch();
    SessionKeyVault.rotate('222222');

    expect(Array.from(oldKey).every((b) => b === 0)).toBe(true); // old key zeroed
    expect(SessionKeyVault.isUnlocked()).toBe(true); // session stays alive
    expect(SessionKeyVault.getSecret()).toBe('222222');
    expect(SessionKeyVault.currentEpoch()).toBe(before + 1);

    await SessionKeyVault.getWrapKey('acct', SALT);
    expect(mockDerive).toHaveBeenCalledTimes(2); // re-derived under the new secret
  });

  it('can change the secret source when rotating', () => {
    SessionKeyVault.set('111111', 'pin');
    SessionKeyVault.rotate('a-long-passphrase', 'passphrase');
    expect(SessionKeyVault.getSecretSource()).toBe('passphrase');
    expect(SessionKeyVault.getSecret()).toBe('a-long-passphrase');
  });
});

describe('SessionKeyVault epoch-abort guard (Codex P1-D)', () => {
  it('aborts a derivation whose epoch changes mid-flight: no return, no cache, key zeroed', async () => {
    SessionKeyVault.set('123456', 'pin');

    // A derivation that resolves only AFTER we release the gate — long enough to
    // clear() (bump the epoch) while the scrypt await is outstanding.
    const derived = nonZeroKey(9);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockDerive.mockImplementationOnce(async () => {
      await gate;
      return derived;
    });

    const pending = SessionKeyVault.getWrapKey('acct', SALT);

    // Lock mid-flight — this bumps the epoch the derivation captured.
    SessionKeyVault.clear();
    release();

    await expect(pending).rejects.toBeInstanceOf(VaultLockedError);
    // The freshly derived key was scrubbed rather than returned/cached.
    expect(Array.from(derived).every((b) => b === 0)).toBe(true);

    // Nothing was cached: re-unlocking and requesting the same account derives
    // AGAIN (the aborted run left no memo behind).
    SessionKeyVault.set('123456', 'pin');
    await SessionKeyVault.getWrapKey('acct', SALT);
    expect(mockDerive).toHaveBeenCalledTimes(2);
  });
});
