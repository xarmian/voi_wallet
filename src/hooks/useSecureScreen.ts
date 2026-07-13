import { useId } from 'react';
import { Platform } from 'react-native';
import { usePreventScreenCapture } from 'expo-screen-capture';

/**
 * useSecureScreen
 *
 * Prevents the OS from screenshotting or screen-recording the current screen
 * for as long as the owning component is mounted, and restores normal capture
 * on unmount (this is `usePreventScreenCapture`'s built-in behavior).
 *
 * Apply it to any surface that renders a secret — a mnemonic, a raw private
 * key, or a QR code that encodes one — so that OS screenshots / screen
 * recordings cannot exfiltrate it.
 *
 * Platform behavior (Expo SDK 54 / expo-screen-capture):
 * - Android: sets the FLAG_SECURE window flag, which blocks BOTH screenshots
 *   and screen recordings, and shows a blank page in the recent-apps preview.
 * - iOS: blocks screen RECORDINGS (iOS 11+) and SCREENSHOTS (iOS 13+). On older
 *   iOS versions this is a no-op. (iOS cannot hard-block a screenshot the way
 *   Android can; the OS blanks the captured secret content instead.)
 *
 * Cross-target: expo-screen-capture is a native module. On the web / browser-
 * extension target (`Platform.OS === 'web'`, react-native-web) there is no
 * equivalent capability and calling the native hook throws an
 * `UnavailabilityError`, so we bind a no-op there. `Platform.OS` is a runtime
 * constant, so `useSecureScreen` always calls exactly one hook in a stable
 * order (Rules of Hooks safe).
 */
const usePreventCapture: (key?: string) => void =
  Platform.OS === 'web'
    ? // No-op on web/extension: browsers expose no screenshot-prevention API.
      () => {}
    : usePreventScreenCapture;

export function useSecureScreen(): void {
  // A stable, per-instance key. expo-screen-capture ref-counts prevention by
  // tag and only re-allows capture once EVERY active tag is released. Two
  // guarded components mounted at once (e.g. a host screen + the nested
  // MnemonicDisplay) must therefore use DISTINCT keys — otherwise unmounting
  // the inner one would delete the shared default tag and re-enable capture
  // while the outer one is still showing the secret. `useId()` guarantees a
  // unique, render-stable key per mounted instance, making nested guards fully
  // idempotent.
  const key = useId();
  usePreventCapture(key);
}

export default useSecureScreen;
