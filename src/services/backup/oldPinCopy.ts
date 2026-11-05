/**
 * Words for the old-PIN step of an onboarding restore (TASK-504, DOC-507 3.4).
 * Product's copy, verbatim; pinned by tests.
 */
export const OLD_PIN_NORMAL_TEXT =
  'This phone still has a PIN from before. Enter it to restore your backup.';

export const OLD_PIN_WRONG_TEXT = 'That PIN is not right. Try again.';

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
