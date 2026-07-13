import * as Clipboard from 'expo-clipboard';

/**
 * Handle returned by {@link scheduleClipboardClear}. Lets the caller cancel the
 * pending auto-clear (e.g. when re-copying) and/or clear immediately (e.g. on
 * component unmount).
 */
export interface ClipboardClearHandle {
  /** Cancel the pending timer. Does NOT touch the clipboard. */
  cancel: () => void;
  /**
   * Cancel the timer and immediately run the check-then-clear now: clears the
   * clipboard only if it still holds the scheduled secret. Safe to call after
   * the timer has already fired. Resolves once the (optional) clear completes.
   */
  clearNow: () => Promise<void>;
}

/**
 * Schedule the OS clipboard to be wiped `ms` after a secret (e.g. a recovery
 * phrase) was copied — but only if the clipboard STILL contains that exact
 * secret at clear time. This "check-then-clear" avoids nuking unrelated content
 * the user copied in the meantime.
 *
 * Security notes:
 * - The secret is never logged and only lives in this closure.
 * - Platform-agnostic: it uses expo-clipboard, which works on both the mobile
 *   and the web/extension (react-native-web) targets, and the compare/clear
 *   logic makes no platform assumptions.
 *
 * @param secret The exact string that was copied to the clipboard.
 * @param ms Delay before the auto-clear runs (default 60_000 = 60s).
 * @returns A {@link ClipboardClearHandle} to cancel or clear-now.
 */
export function scheduleClipboardClear(
  secret: string,
  ms = 60_000
): ClipboardClearHandle {
  let cleared = false;

  const clearIfStillSecret = async (): Promise<void> => {
    try {
      const current = await Clipboard.getStringAsync();
      // Only clear when the clipboard hasn't changed since we copied the secret.
      if (current === secret) {
        await Clipboard.setStringAsync('');
      }
    } catch {
      // Never surface or log clipboard errors — doing so could leak the secret.
    }
  };

  const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
    if (cleared) return;
    cleared = true;
    // Fire-and-forget: the timer callback itself can't be async.
    void clearIfStillSecret();
  }, ms);

  return {
    cancel: () => {
      cleared = true;
      clearTimeout(timer);
    },
    clearNow: async () => {
      if (cleared) return;
      cleared = true;
      clearTimeout(timer);
      await clearIfStillSecret();
    },
  };
}

export default scheduleClipboardClear;
