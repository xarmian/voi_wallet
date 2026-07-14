/**
 * Biometric-unlock orchestration (Wave-2, DOC-137 §3.3/§3.4, PR6)
 *
 * The single, React-free place that turns a biometric prompt into a populated
 * SessionKeyVault. AuthContext.unlockWithBiometrics calls this and then handles
 * the React state + AppLockSignal; keeping the security-critical work here makes
 * it unit-testable without a React harness.
 *
 * THE FLOW (§3.3): read the biometric-convenience secret behind the OS biometric
 * gate (the `getItemWithAuth` read IS the prompt) → on success, feed the raw
 * secret into the SAME SessionKeyVault the manual PIN path populates, so a
 * biometric-unlocked session can derive at-rest wrap keys this session (the
 * prerequisite for PR4's v2 keys, which read under pin=undefined via the vault).
 *
 * THE INVARIANT (§3.4): a biometric / enrollment-change invalidation NEVER
 * requires the mnemonic. expo-secure-store resolves `null` (not a throw) when a
 * `requireAuthentication` item is absent or has been invalidated by an
 * enrollment change / lock removal; we map that to `invalidated`, clear the
 * stale enabled flag, and let the caller fall back to PIN/passphrase entry. A
 * genuine OS-auth failure / user cancel THROWS instead, which we map to
 * `cancelled` so biometrics stays enabled and the user can retry or use the PIN.
 * NEITHER path ever routes to the mnemonic — the key at rest is wrapped by the
 * user-secret scrypt envelope (plain setItem), which survives all enrollment
 * events.
 *
 * SECURITY: never logs the secret or secretSource.
 */

import { AccountSecureStorage } from './AccountSecureStorage';
import { SessionKeyVault } from './SessionKeyVault';

export type BiometricUnlockOutcome =
  /** Vault populated with the recovered secret; the session is unlocked. */
  | { status: 'unlocked' }
  /**
   * The convenience item is gone or was invalidated (enrollment change / lock
   * removal). The enabled flag has been cleared. Caller falls back to PIN —
   * NEVER the mnemonic (THE INVARIANT, §3.4). Vault is NOT populated.
   */
  | { status: 'invalidated' }
  /**
   * The user cancelled or the OS auth failed. Biometrics stays enabled; caller
   * falls back to PIN for this attempt. Vault is NOT populated.
   */
  | { status: 'cancelled' };

/**
 * Read the biometric-convenience secret and, on success, populate the session
 * vault. Returns a discriminated outcome; performs NO React state or
 * AppLockSignal side effects (the caller owns those).
 */
export async function unlockVaultWithBiometrics(
  prompt: string
): Promise<BiometricUnlockOutcome> {
  // GATE on the PERSISTED enabled-flag BEFORE reading the auth-gated convenience
  // item (Codex P1). The enabled-flag is the read gate for a stale item: a
  // changePin fail-safe disables the PERSISTED flag but does NOT touch
  // AuthContext's in-memory React state, so a stale item behind a false flag
  // must never be read here. AuthContext also guards on its in-memory flag; this
  // persisted check is the authoritative, defense-in-depth gate. If disabled,
  // route to PIN WITHOUT reading the item (no biometric prompt for the item).
  let enabled = false;
  try {
    enabled = await AccountSecureStorage.isBiometricEnabled();
  } catch {
    enabled = false;
  }
  if (!enabled) {
    // Biometrics not (or no longer) enabled — fall back to PIN. Reported as
    // 'invalidated' so the caller reflects the disabled state and routes to PIN;
    // never the mnemonic (THE INVARIANT). No convenience item was read.
    return { status: 'invalidated' };
  }

  let bio: { secret: string; secretSource: 'pin' | 'passphrase' } | null;
  try {
    bio = await AccountSecureStorage.getBiometricSecret(prompt);
  } catch {
    // THROW = user cancelled / OS auth failure (NOT an invalidation, which
    // resolves null). Keep biometrics enabled; fall back to PIN for this attempt.
    return { status: 'cancelled' };
  }

  if (bio === null) {
    // NULL = the auth-gated item is absent or was invalidated by an enrollment
    // change / lock removal. INVARIANT (§3.4): this NEVER requires the mnemonic —
    // clear the stale enabled flag and fall back to PIN/passphrase entry.
    await AccountSecureStorage.setBiometricEnabled(false).catch(() => {});
    return { status: 'invalidated' };
  }

  // Populate the vault synchronously (mirrors the PIN unlock path) so
  // pin=undefined callers and future v2 keys derive wrap keys this session.
  SessionKeyVault.set(bio.secret, bio.secretSource);
  return { status: 'unlocked' };
}
