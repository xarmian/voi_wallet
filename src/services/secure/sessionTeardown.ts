/**
 * Session-security teardown (Wave-2, DOC-137 §6.3 / Codex P1-D + P1-E, PR3)
 *
 * The SINGLE place that drops every piece of in-memory session key material.
 * AuthContext.lock() calls this on EVERY lock path (explicit, inactivity-timeout,
 * and background-grace), so teardown lives in exactly one location:
 *
 *   1. SessionKeyVault.clear()            — zero memoized wrap keys + drop the
 *                                           secret + bump the vault epoch (P1-D).
 *   2. clearPrivateKeyCache()             — zero + drop the legacy 60 s
 *                                           plaintext-key cache.
 *   3. clearMessagingKeyCache()           — zero + drop the ~30 min derived
 *                                           X25519 messaging keypair cache so a
 *                                           locked device stops decrypting
 *                                           messages (P1-E).
 *
 * Idempotent and safe to call when already locked. This module never logs any
 * secret or key material.
 */

import { AccountSecureStorage } from './AccountSecureStorage';
import { SessionKeyVault } from './SessionKeyVault';
import { AppLockSignal } from './appLockState';
import { clearMessagingKeyCache } from '../messaging/keyDerivation';

/** Clear the session vault, the 60 s key cache, and the messaging key cache. */
export function clearSessionSecurity(): void {
  SessionKeyVault.clear();
  AccountSecureStorage.clearPrivateKeyCache();
  clearMessagingKeyCache();
}

/**
 * Enter the locked state synchronously (Codex P1-E race fix). Order matters:
 *   1. Flip AppLockSignal to LOCKED **first** — synchronously, before any
 *      teardown — so non-React consumers (the messaging cache-write guard and
 *      the poll) observe the lock immediately. A key derivation that started
 *      before the lock and resolves during teardown then refuses to repopulate
 *      the ~30 min messaging cache.
 *   2. Run the cache teardown (vault + 60 s + messaging).
 *
 * AuthContext.lock() calls this on every real lock (i.e. only when a PIN is set;
 * a no-PIN wallet never locks, so its always-unlocked signal is left untouched).
 */
export function enterLockedState(): void {
  AppLockSignal.setUnlocked(false);
  clearSessionSecurity();
}
