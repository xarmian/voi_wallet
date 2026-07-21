// Durable "PIN setup is pending" breadcrumb (TASK-213 restore-before-PIN fix).
//
// WHY THIS EXISTS
// AuthContext's key-bearing invariant treats "a locally-key-bearing (STANDARD)
// account exists but no PIN is readable" as an IMPOSSIBLE genuine state and fails
// CLOSED to the recovery screen (whose Reset WIPES local data). That invariant is
// correct for a genuine keystore break — but restore-from-backup DELIBERATELY
// persists STANDARD accounts BEFORE the user sets a PIN (restorers.ts wipes the
// old PIN, writes the accounts, then routes to SecuritySetup). A cold-kill in that
// durable on-disk window would otherwise strand a healthy just-restored wallet on
// the recovery screen and let its Reset wipe it.
//
// This breadcrumb distinguishes the two: restore SETS it before persisting any
// account, so the key-bearing guard can route to SecuritySetup (resume PIN setup)
// instead of recovery. A genuine keystore break has NO breadcrumb → still recovery.
//
// FAIL-OPEN SAFETY (this is the whole ballgame)
// A stale / never-cleared breadcrumb would be a FAIL-OPEN: it would let someone set
// a NEW PIN over a real, PIN-protected wallet whose keystore later broke. So the
// breadcrumb is cleared the MOMENT a PIN is durably established (setupPin) AND
// re-cleared on every boot that can read the PIN (checkInitialAuthState, when the
// strict PIN read resolves present). A wallet that has ever had a readable PIN
// therefore never carries a lingering breadcrumb.
//
// STORAGE CHOICE
// PLAINTEXT AsyncStorage (`storage`), NOT the secure store — the whole point is
// that it stays readable when the KEYSTORE is broken. It holds NO secret material:
// only the literal marker string 'true'.

import { storage } from '../../platform';

/** Plaintext AsyncStorage key for the restore-before-PIN breadcrumb. */
export const PIN_SETUP_PENDING_KEY = 'pin_setup_pending';

const PENDING_VALUE = 'true';

/**
 * Set the breadcrumb. Called at the START of the restore flow (after the old PIN
 * is wiped, BEFORE any key-bearing account is persisted). Propagates on failure:
 * if plaintext AsyncStorage cannot even be written, the restore itself is unsafe
 * and should surface the error rather than proceed without the guard.
 */
export async function markPinSetupPending(): Promise<void> {
  await storage.setItem(PIN_SETUP_PENDING_KEY, PENDING_VALUE);
}

/**
 * Clear the breadcrumb. Best-effort and NEVER throws — a clear failure must not
 * fail an otherwise-successful PIN setup. It is called from multiple points
 * (setupPin success + every readable-PIN boot), so any single failed clear is
 * self-healed by the next one. This is the anti-fail-open guarantee.
 */
export async function clearPinSetupPending(): Promise<void> {
  try {
    await storage.removeItem(PIN_SETUP_PENDING_KEY);
  } catch (error) {
    console.warn('Failed to clear pin_setup_pending breadcrumb:', error);
  }
}

/**
 * Read the breadcrumb. FAIL-CLOSED on a read error: a breadcrumb that cannot be
 * read is treated as ABSENT, so the key-bearing guard routes to RECOVERY (never
 * SecuritySetup). Never throws.
 */
export async function isPinSetupPending(): Promise<boolean> {
  try {
    return (await storage.getItem(PIN_SETUP_PENDING_KEY)) === PENDING_VALUE;
  } catch (error) {
    console.warn('Failed to read pin_setup_pending breadcrumb:', error);
    return false;
  }
}
