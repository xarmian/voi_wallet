/**
 * AppLockSignal (Wave-2, DOC-137 §6.5 row 9 / Codex P1-E, PR3)
 *
 * A minimal, module-level mirror of the app's unlock state so NON-React services
 * (e.g. the background messaging poll) can cheaply check whether the app is
 * currently unlocked WITHOUT importing React or AuthContext. AuthContext is the
 * single writer (it already computes `isUnlocked` and pushes it to
 * DeepLinkService); readers only observe.
 *
 * WHY NOT SessionKeyVault.isUnlocked(): in PR3 the vault is populated on PIN
 * unlock but not on biometric unlock (the biometric-convenience secret item
 * lands in a later PR), so the vault is not yet a reliable app-unlock signal for
 * biometric users. This signal reflects the AuthContext lock state regardless of
 * unlock method.
 *
 * Defaults to `false` (locked) so a poll that fires before AuthContext has
 * synced defers rather than deriving keys while the lock state is unknown.
 */

let unlocked = false;

export const AppLockSignal = {
  /** AuthContext writes the current unlock state here on every transition. */
  setUnlocked(value: boolean): void {
    unlocked = value;
  },
  /** True when the app is unlocked (safe to derive keys). */
  isUnlocked(): boolean {
    return unlocked;
  },
};
