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
// FAIL-OPEN SAFETY — WHY A STALE MARKER CANNOT AUTHORIZE A NEW PIN OVER A WALLET
// A stale marker would be a FAIL-OPEN only if it were READ (in the key-bearing
// guard) while a PIN actually exists. Three independent properties prevent that:
//
//   1. FAIL-CLOSED READ. isPinSetupPending() resolves `false` on ANY read error
//      (below). So if AsyncStorage is broken enough that a stale marker could not
//      be removed, it also cannot be READ — the guard sees "absent" and routes to
//      RECOVERY, never a resume. A marker can only be trusted when the store is
//      healthy, and a healthy store can always remove it.
//   2. VERIFYING, RETRYING CLEAR. clearPinSetupPending() re-reads to CONFIRM
//      removal and retries, so on a healthy store it ESTABLISHES removal (it does
//      not blindly swallow a failed removeItem). Called on setupPin success AND on
//      every readable-PIN boot (self-heal), so a marker cannot survive a completed
//      PIN setup on a functioning device.
//   3. PRESENCE-SENTINEL BACKSTOP. A PIN committed through secureStorage.setItem
//      records a durable plaintext presence sentinel (src/platform/.../secureStorage
//      .ts). A later keystore break then makes the strict PIN read THROW (present-
//      but-unreadable ⇒ read failure), so checkInitialAuthState fails closed to
//      recovery WITHOUT reaching the breadcrumb guard at all. The guard is reached
//      only when the strict read RESOLVES false (genuine absence / a pre-sentinel
//      install with no PIN of its own), where a resume is the correct outcome.
//
// STORAGE CHOICE
// PLAINTEXT AsyncStorage (`storage`), NOT the secure store — the whole point is
// that it stays readable when the KEYSTORE is broken. It holds NO secret material:
// only the literal marker string 'true'.

import { storage } from '../../platform';

/** Plaintext AsyncStorage key for the restore-before-PIN breadcrumb. */
export const PIN_SETUP_PENDING_KEY = 'pin_setup_pending';

const PENDING_VALUE = 'true';

// Bounded, best-effort clear parameters. Each storage op is time-bounded so a
// wedged AsyncStorage can never hang a caller (setupPin runs on the SecuritySetup
// submit path; the boot self-heal runs on the render-gating path), and removal is
// retried + verified so a transient hiccup does not leave a durable marker.
// 2 attempts × (remove + verify), each bounded — worst case ≈ 4.8s on a fully
// wedged store (vs. a normal ~20ms), so setupPin's submit is bounded, never hung.
const CLEAR_MAX_ATTEMPTS = 2;
const CLEAR_OP_TIMEOUT_MS = 1200;

// Reject if `promise` has not settled within `ms` (no-stuck bound). The underlying
// op is abandoned on timeout; the timer is always cleared so no handle survives.
const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('storage op timed out')),
      ms
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });

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
 * Clear the breadcrumb — bounded, retrying, verifying, and NEVER-throwing.
 *
 * It re-reads to CONFIRM the marker is gone and retries a bounded number of times,
 * so on a functioning store it ESTABLISHES removal rather than silently accepting
 * a failed removeItem. Every op is time-bounded so a wedged store cannot hang the
 * caller. It never throws: a persistent failure is SAFE because isPinSetupPending()
 * fails closed (an unreadable/broken marker resolves absent ⇒ recovery, never a
 * resume), so a marker that genuinely cannot be removed also cannot be read to
 * cause a fail-open.
 */
export async function clearPinSetupPending(): Promise<void> {
  for (let attempt = 0; attempt < CLEAR_MAX_ATTEMPTS; attempt += 1) {
    try {
      await withTimeout(
        storage.removeItem(PIN_SETUP_PENDING_KEY),
        CLEAR_OP_TIMEOUT_MS
      );
      // Verify removal: on a healthy store this reads back absent and we are done.
      const remaining = await withTimeout(
        storage.getItem(PIN_SETUP_PENDING_KEY),
        CLEAR_OP_TIMEOUT_MS
      );
      if (remaining !== PENDING_VALUE) {
        return; // confirmed gone (null) — or unreadable, which fails closed on read
      }
    } catch {
      // Timeout or read/write error — retry. (Never rethrow: see the doc above.)
    }
  }
  console.warn(
    'pin_setup_pending breadcrumb clear could not be confirmed after retries'
  );
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
