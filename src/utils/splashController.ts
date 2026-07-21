import * as SplashScreen from 'expo-splash-screen';

// Splash lifecycle control for the cold-boot init cascade (F-48, TASK-182).
//
// index.ts calls SplashScreen.preventAutoHideAsync() at module scope so the
// branded native splash stays up through module eval + the async-storage gate
// cascade instead of dismissing at first frame and exposing a blank RN root
// view. The readiness owner (AppStack) hides it only once the FIRST real-content
// frame can paint — see isColdBootContentReady() for the exact gate set.
//
// hideSplashScreen() is the SINGLE funnel through which the splash is ever
// dismissed. It is idempotent and never throws, so every caller — the readiness
// owner (AppStack), the error-boundary fallback, and the watchdog safety net —
// can invoke it freely without coordinating. The readiness owner is the only
// place that decides *when* the happy path hides; the other two are fail-safes
// that guarantee a throw or a silent hang on the init path can NEVER leave the
// user stuck on the splash forever.

// True only AFTER a hideAsync() has actually RESOLVED — i.e. the native splash
// is genuinely gone. Latching on success (not on attempt) means a hideAsync that
// REJECTS while the splash is still visible does NOT neuter later callers: the
// watchdog (or any subsequent caller) can retry. Module-scoped: shared across
// every import of this module for the life of the JS runtime.
let splashHidden = false;

// The single in-flight hide attempt, if any. Concurrent callers share it instead
// of each firing their own hideAsync(). Cleared when the attempt settles, so a
// LATER (sequential) caller can retry after a rejected attempt — while still
// deduping the simultaneous burst the readiness owner + error boundary can
// produce. Distinct from splashHidden: an attempt can be in flight (or have
// failed) without the splash being confirmed hidden.
let hideInFlight: Promise<void> | null = null;

/**
 * Dismiss the native splash. Idempotent and error-swallowing:
 * - Once a hideAsync() has RESOLVED, every later call is a no-op (no double-hide
 *   error spam once the splash is genuinely gone).
 * - Concurrent callers share the single in-flight attempt (one hideAsync fires).
 * - A rejection (already hidden, or no native module on web) is swallowed and
 *   never propagates or blocks startup. Crucially it does NOT latch: if the
 *   splash was still visible when the attempt failed, splashHidden stays false
 *   so the watchdog / a later caller can try again. If it failed because the
 *   splash was already gone, the retry just no-ops harmlessly.
 * Safe to call from the readiness owner and from any fail-safe path.
 */
export async function hideSplashScreen(): Promise<void> {
  if (splashHidden) {
    return;
  }
  if (hideInFlight) {
    // An attempt is already running; share it rather than firing a second
    // hideAsync (which would reject on the native "already hidden" path).
    return hideInFlight;
  }
  hideInFlight = (async () => {
    try {
      await SplashScreen.hideAsync();
      // Latch ONLY after a confirmed native hide. From here every caller no-ops.
      splashHidden = true;
    } catch {
      // hideAsync rejects if the splash is already gone or the native module is
      // unavailable (e.g. web). The app is already up — swallow it. Deliberately
      // do NOT latch: leaving splashHidden false lets the watchdog retry in the
      // (pathological) case the splash is somehow still visible.
    } finally {
      // Clear so a subsequent sequential caller (the watchdog) can retry after a
      // rejected attempt. A resolved attempt has already set splashHidden, so the
      // retry short-circuits to a no-op.
      hideInFlight = null;
    }
  })();
  return hideInFlight;
}

// Absolute ceiling the splash may cover before the watchdog force-hides it. The
// readiness owner normally fires in well under a second; this only trips on a
// pathological hang (e.g. a storage read that never settles) where no gate
// resolves and nothing throws, so neither the readiness owner nor the error
// boundary would ever fire. Force-hiding then reveals whatever gate view is
// underneath — strictly better than trapping the user on the splash forever.
export const SPLASH_WATCHDOG_MS = 10_000;

/**
 * Arm the last-resort watchdog. Call once at module scope right after
 * preventAutoHideAsync(). No-op once a hide has genuinely succeeded, because
 * hideSplashScreen() short-circuits on the resolved latch. If an earlier hide
 * attempt REJECTED while the splash was still visible, this still fires and
 * retries — the whole point of latching on resolve rather than on attempt.
 */
export function armSplashWatchdog(): void {
  setTimeout(() => {
    void hideSplashScreen();
  }, SPLASH_WATCHDOG_MS);
}

/**
 * Cold-boot readiness predicate for the splash (F-48, TASK-182). The branded
 * native splash may hide only once the FIRST real-content frame can paint, which
 * means covering the WHOLE F-03-restructured init cascade — three gates, not two:
 *
 *   1. routeResolved     — AppStack's initial-route storage await has resolved
 *                          (isLoading false), so the route tree can mount.
 *   2. signerInitialized — MainTabNavigator's remote-signer gate has hydrated;
 *                          this both unblocks that navigator AND decides app mode.
 *   3. walletInitialized — the wallet store has hydrated with its CACHED balances
 *                          in state, so the normal-wallet Home screen renders real
 *                          content instead of its "Loading wallet..." placeholder.
 *
 * Gate 3 is what an earlier two-gate readiness missed: on the common existing-
 * wallet cold start the splash would lift after gates 1+2 to reveal Home's
 * "Loading wallet..." placeholder — the exact flash this feature exists to hide.
 *
 * Scoping rules (these are what keep the splash from EVER stranding the user):
 * - Non-Main routes (Onboarding, Lock, ...) have no signer/wallet gate and are
 *   ready the instant the route resolves. Requiring gates 2/3 there would hang
 *   the splash forever, because nothing on those routes ever flips them.
 * - On the Main route in SIGNER mode the air-gapped Home renders straight after
 *   gate 2 and has no "Loading wallet..." placeholder, so gate 3 is NOT required
 *   — waiting on it would needlessly delay (though walletStore is still hydrated
 *   early in both modes, so this is belt-and-suspenders, not a hang guard).
 * - Gate 3 gates ONLY on cached-balance hydration (walletInitialized), never on
 *   network balance/price fetches, so a slow network can never hang the splash.
 *   The 10s watchdog remains the ultimate backstop, not the intended path.
 */
export function isColdBootContentReady(params: {
  routeResolved: boolean;
  isMainRoute: boolean;
  signerInitialized: boolean;
  isSignerMode: boolean;
  walletInitialized: boolean;
}): boolean {
  const {
    routeResolved,
    isMainRoute,
    signerInitialized,
    isSignerMode,
    walletInitialized,
  } = params;

  // Gate 1: the route tree cannot mount until the initial route is known.
  if (!routeResolved) {
    return false;
  }
  // Non-Main routes have no further gates — ready as soon as the route resolves.
  if (!isMainRoute) {
    return true;
  }
  // Gate 2: MainTabNavigator renders a blank View until the remote-signer store
  // hydrates; app mode is unknown until then.
  if (!signerInitialized) {
    return false;
  }
  // Signer mode renders the air-gapped Home with no wallet placeholder.
  if (isSignerMode) {
    return true;
  }
  // Gate 3: normal-wallet Main is ready only once cached balances are in state.
  return walletInitialized;
}
