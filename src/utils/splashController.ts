import * as SplashScreen from 'expo-splash-screen';

// Splash lifecycle control for the cold-boot init cascade (F-48, TASK-182).
//
// index.ts calls SplashScreen.preventAutoHideAsync() at module scope so the
// branded native splash stays up through module eval + the async-storage gate
// cascade (AppStack initial-route await + MainTabNavigator remote-signer gate)
// instead of dismissing at first frame and exposing a blank RN root view.
//
// hideSplashScreen() is the SINGLE funnel through which the splash is ever
// dismissed. It is idempotent and never throws, so every caller — the readiness
// owner (AppStack), the error-boundary fallback, and the watchdog safety net —
// can invoke it freely without coordinating. The readiness owner is the only
// place that decides *when* the happy path hides; the other two are fail-safes
// that guarantee a throw or a silent hang on the init path can NEVER leave the
// user stuck on the splash forever.

// Latch so the native hideAsync runs at most once. Module-scoped: shared across
// every import of this module for the life of the JS runtime.
let splashHidden = false;

/**
 * Dismiss the native splash exactly once. Idempotent and error-swallowing:
 * repeat calls after the first are no-ops, and a rejection from hideAsync
 * (already hidden, or no native module on web) never propagates or blocks
 * startup. Safe to call from the readiness owner and from any fail-safe path.
 */
export async function hideSplashScreen(): Promise<void> {
  if (splashHidden) {
    return;
  }
  // Latch BEFORE awaiting so a concurrent second caller cannot also fire
  // hideAsync (which would reject on the "already hidden" path).
  splashHidden = true;
  try {
    await SplashScreen.hideAsync();
  } catch {
    // hideAsync rejects if the splash is already gone or the native module is
    // unavailable (e.g. web). The app is already up — swallow it.
  }
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
 * preventAutoHideAsync(). No-op once the readiness owner has already hidden the
 * splash, because hideSplashScreen() is latched.
 */
export function armSplashWatchdog(): void {
  setTimeout(() => {
    void hideSplashScreen();
  }, SPLASH_WATCHDOG_MS);
}
