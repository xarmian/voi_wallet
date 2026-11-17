/**
 * Words for the forgotten-PIN step of an onboarding restore (TASK-504, DOC-507
 * 5.3). Product's copy, verbatim (77907c78, c26b00b7, 24197886, b0ca7d55);
 * pinned by tests. Pure: the consent screen only displays what these return.
 */
import { formatAddress } from '@/utils/address';
import { LEFT_OUT_REASON_TEXT } from './backupReport';
import type { BackupInfo } from './types';
import { NOTHING_TO_ADD_TEXT, NO_KEYS_TEXT } from './forgottenPinTexts';

export { NOTHING_TO_ADD_TEXT, NO_KEYS_TEXT };

export const FORGOT_LINK_TEXT = "I don't remember it";
/** Back from the forgotten-PIN step to PIN entry. Wording is the seat's, not
 *  product's. */
export const ENTER_PIN_INSTEAD_TEXT = 'Enter my PIN instead';
export const REMOVE_BUTTON_TEXT = 'Remove old PIN and restore';
export const CANCEL_BUTTON_TEXT = 'Cancel';
/** The word the user types to enable the button on an incomplete file. */
export const CONFIRM_WORD = 'REMOVE';
export const CONFIRM_WORD_HINT = `Type ${CONFIRM_WORD} to continue`;

const LOCKED_KEYS_SENTENCE =
  "Any other key on this phone that's locked with your old PIN, such as an account added after this backup, can't be opened by the app.";

export const NOT_ADDED_REASON_TEXT =
  'Not added. The backup is missing details this account needs.';

type Plan = BackupInfo['restorePlan'];

/** Why the step is not offered for this file, or null when it is. */
export function forgottenPinUnavailable(plan: Plan): string | null {
  if (plan.addable === 0) return NOTHING_TO_ADD_TEXT;
  if (plan.addableWithKey === 0) return NO_KEYS_TEXT;
  return null;
}

/** The consent text above the list (5.3). */
export function forgottenPinConsentText(plan: Plan): string {
  const n = plan.addable;
  const accounts = n === 1 ? 'account' : 'accounts';
  const first =
    n === plan.total
      ? `${n} ${accounts} from your backup will be restored, and you'll set a new PIN.`
      : `${n} of the ${plan.total} accounts in your backup will be restored, and you'll set a new PIN. The rest are listed below, with the reason.`;
  return `Restore without your PIN? ${first} ${LOCKED_KEYS_SENTENCE}`;
}

export interface ForgottenPinRow {
  label: string;
  shortAddress: string;
  text?: string;
}

/** The records the restore will not add, each with its reason. */
export function forgottenPinNotAddedRows(plan: Plan): ForgottenPinRow[] {
  return plan.notAdded.map((a) => ({
    label: a.label || 'Account',
    shortAddress: formatAddress(a.address),
    text: NOT_ADDED_REASON_TEXT,
  }));
}

/** The incomplete-file warning and the accounts it names (5.3). */
export function forgottenPinIncompleteWarning(
  info: Pick<BackupInfo, 'incomplete'>
): { text: string; rows: ForgottenPinRow[] } | null {
  const leftOut = info.incomplete?.leftOut ?? [];
  if (leftOut.length === 0) return null;
  return {
    text: `This backup doesn't have the keys for these ${leftOut.length} accounts. Those keys may exist only on this phone, locked with your old PIN. If you remove the PIN, the app won't be able to open them. If you might remember it, or can find a complete backup, cancel now.`,
    rows: leftOut.map((a) => ({
      label: a.label || 'Account',
      shortAddress: formatAddress(a.address),
      // An account whose own key IS in the file shows why it is listed, so the
      // sentence above does not mislead (db99d45f item 3).
      ...(a.reason === 'other-key-on-device'
        ? { text: LEFT_OUT_REASON_TEXT[a.reason] }
        : {}),
    })),
  };
}
