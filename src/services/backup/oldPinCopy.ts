/**
 * Words for the old-PIN step of an onboarding restore (TASK-504, DOC-507 3.4).
 * Product's copy, verbatim; pinned by tests.
 */
export const OLD_PIN_NORMAL_TEXT =
  'This phone still has a PIN from before. Enter it to restore your backup.';

// Matches the lock screen (product e7912207 item 6).
export const OLD_PIN_WRONG_TEXT = 'Incorrect PIN. Try again.';

/** The time left in hours and minutes, e.g. "2 hr 5 min", "5 min". */
export function formatTimeLeft(ms: number): string {
  const totalMinutes = Math.max(1, Math.ceil(ms / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes} min`;
  if (minutes === 0) return `${hours} hr`;
  return `${hours} hr ${minutes} min`;
}

export function oldPinLockedText(msLeft: number): string {
  return `Too many wrong tries, so PIN entry is paused. Try again in ${formatTimeLeft(msLeft)}. Nothing on this phone has changed.`;
}

// Biometric unlock on the old-PIN step (TASK-509). The label matches the lock
// screen's biometric button; the lines are one plain sentence each.
export const BIOMETRIC_UNLOCK_LABEL = 'Use Biometric';

export const BIOMETRIC_NO_ITEM_TEXT =
  'No biometric unlock is saved on this phone. Enter your old PIN.';

export const BIOMETRIC_CANCELLED_TEXT =
  "Biometric unlock didn't finish. Enter your old PIN or try again.";

export const BIOMETRIC_INVALID_TEXT =
  "The saved biometric unlock doesn't match. Enter your old PIN.";

export const BIOMETRIC_UNAVAILABLE_TEXT =
  "Biometric unlock isn't available here. Enter your old PIN.";
