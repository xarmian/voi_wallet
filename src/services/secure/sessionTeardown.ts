/**
 * Session-security teardown (Wave-2, DOC-137 §6.3 / Codex P1-D + P1-E, PR3)
 *
 * The SINGLE place that drops every piece of in-memory session key material.
 * AuthContext calls this on EVERY path that lands locked: lock() (explicit,
 * inactivity-timeout, and background-grace) and every auth-check verdict that
 * lands locked, at boot and on recheckAuthState() (TASK-557). Teardown lives in
 * exactly one location:
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

/**
 * Run every step even if an earlier one throws, then rethrow the first error.
 * A failing step (a cache clear) must never leave a later cache holding key
 * material (TASK-557). Listener throws no longer reach here: the vault and the
 * lock signal contain them in their own notifiers (TASK-561).
 */
function runAllThenRethrow(steps: (() => void)[]): void {
  let failed = false;
  let firstError: unknown;
  for (const step of steps) {
    try {
      step();
    } catch (error) {
      if (!failed) {
        failed = true;
        firstError = error;
      }
    }
  }
  if (failed) throw firstError;
}

/** Clear the session vault, the 60 s key cache, and the messaging key cache. */
export function clearSessionSecurity(): void {
  runAllThenRethrow([
    () => SessionKeyVault.clear(),
    () => AccountSecureStorage.clearPrivateKeyCache(),
    () => clearMessagingKeyCache(),
  ]);
}

/**
 * Enter the locked state synchronously (Codex P1-E race fix). Order matters:
 *   1. Flip AppLockSignal to LOCKED **first** — synchronously, before any
 *      teardown — so non-React consumers (the messaging cache-write guard and
 *      the poll) observe the lock immediately. A key derivation that started
 *      before the lock and resolves during teardown then refuses to repopulate
 *      the ~30 min messaging cache.
 *   2. Run the cache teardown (vault + 60 s + messaging).
 * Every step runs even if an earlier one throws; the first error is rethrown
 * after every step has run. (A lock listener's throw is contained by
 * AppLockSignal itself, so step 1 does not throw for that reason.)
 *
 * AuthContext.lock() calls this on every real lock (i.e. only when a PIN is set;
 * lock() leaves a no-PIN wallet unlocked, so its signal is left untouched). Every
 * auth-check verdict that lands locked calls it too, whatever hasPin is, since
 * that state is locked and the signal must match it (TASK-557).
 */
export function enterLockedState(): void {
  runAllThenRethrow([
    () => AppLockSignal.setUnlocked(false),
    () => clearSessionSecurity(),
  ]);
}
