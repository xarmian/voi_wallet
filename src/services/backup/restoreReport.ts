/**
 * What the user is told after a restore (TASK-504). Pure: it reads a
 * RestoreResult and returns text, so the wording is pinned by tests and the
 * screen only displays it.
 *
 * Titles and row texts are product's (DOC-507 section 3 and 5.3). Two rows
 * (added in place, added under a new id) and the generic rejection rows have no
 * product wording yet; the lines below stand until product rewords them.
 */
import { formatAddress } from '@/utils/address';
import { AccountType } from '@/types/wallet';
import { LEFT_OUT_REASON_TEXT } from './backupReport';
import type {
  RestoreRecordOutcome,
  RestoreRecordResult,
  RestoreResult,
} from './types';

/** What the restore screen and its confirmation say before anything is added. */
export const RESTORE_ADDS_TEXT =
  'This adds the accounts in this backup to this wallet. Nothing on this device is removed or replaced.';
export const SETTINGS_STAY_TEXT = 'Your settings stay as they are.';

export const NOT_FRESH_LINE =
  "Only accounts were restored. This phone's settings and friends weren't changed.";

export const PAIRINGS_LINE =
  "Airgap signer pairings in this backup weren't restored. To sign with one, pair it again.";

/**
 * The advice to remove an account and restore again. OFF until the dev lead's
 * removal checks are shown (cb78f6f1 item 2: removal by id with duplicates, the
 * classifyKeyHolding loop, and last-account removal not reaching a reset, with
 * the key coming back through the old-PIN screen). With it off, the two rows
 * that carry it end at their first sentences; the rows stay either way.
 */
export const REMOVE_ADVICE_SHOWN = false;
export const REMOVE_ADVICE =
  'To use it, remove this account from the wallet, then restore this backup again.';

function withAdvice(text: string): string {
  return REMOVE_ADVICE_SHOWN ? `${text} ${REMOVE_ADVICE}` : text;
}

export const KEY_UNREADABLE_TEXT =
  "On this device, but its key can't be read here. This backup has the key.";
export const KEY_PROBLEM_TEXT =
  "On this device, but its key can't be read here. There may be a problem with the stored key. This backup has the key.";

const KEYLESS_TYPE_NAME = {
  [AccountType.WATCH]: 'Watch Only',
  [AccountType.LEDGER]: 'Ledger',
  [AccountType.REMOTE_SIGNER]: 'Airgap',
} as const;

export function keylessDeviceText(
  deviceType: keyof typeof KEYLESS_TYPE_NAME
): string {
  return withAdvice(
    `On this device as ${KEYLESS_TYPE_NAME[deviceType]}. The key in this backup wasn't added.`
  );
}

export const OUTCOME_TEXT: Record<RestoreRecordOutcome, string> = {
  'device-key-unreadable': withAdvice(KEY_UNREADABLE_TEXT),
  'device-key-problem': KEY_PROBLEM_TEXT,
  // The text depends on the device record's type: see keylessDeviceText. This
  // entry is the type-less fallback and is not shown when a type is known.
  'device-keyless': withAdvice(
    "On this device without a key. The key in this backup wasn't added."
  ),
  added: 'Added',
  'added-in-place': 'Added. Its key was already on this phone.',
  'added-new-id':
    "Added. This phone was already storing something else in this account's place. We left that alone and added the account separately.",
  'already-present': 'Already on this device',
  'kept-device-record': 'Already on this device',
  'rejected-id-conflict':
    'Not added. It conflicts with another account on this device.',
  'rejected-slot-occupied':
    'Not added. A stored key is already in its place on this device.',
  'rejected-no-safe-slot':
    'Not added. There was no safe place to store its key on this device.',
  'rejected-invalid':
    'Not added. The backup is missing details this account needs.',
};

const ADDED: ReadonlySet<RestoreRecordOutcome> = new Set([
  'added',
  'added-in-place',
  'added-new-id',
]);
const ALREADY_ON_DEVICE: ReadonlySet<RestoreRecordOutcome> = new Set([
  'already-present',
  'kept-device-record',
]);

export interface RestoreReportRow {
  label: string;
  shortAddress: string;
  text: string;
}

export const NOT_IN_BACKUP_TITLE = 'Not in this backup';

export interface RestoreReport {
  title: string;
  summary: string;
  /** Every record that was not simply added, so an exception is never hidden */
  rows: RestoreReportRow[];
  /** An incomplete file's left-out accounts; absent for a complete file */
  notInBackup?: { title: string; rows: RestoreReportRow[] };
  /** Lines under the rows; the accounts-only line, when it applies, is last */
  notes: string[];
}

function rowFor(record: RestoreRecordResult): RestoreReportRow {
  return {
    label: record.label || 'Account',
    shortAddress: formatAddress(record.address),
    text:
      record.outcome === 'device-keyless' && record.deviceType
        ? keylessDeviceText(record.deviceType)
        : OUTCOME_TEXT[record.outcome],
  };
}

export function buildRestoreReport(result: RestoreResult): RestoreReport {
  const records = result.records;
  const added = records.filter((r) => ADDED.has(r.outcome)).length;
  const already = records.filter((r) =>
    ALREADY_ON_DEVICE.has(r.outcome)
  ).length;
  const other = records.length - added - already;

  let title: string;
  let summary: string;
  if (other === 0 && already === 0 && added > 0) {
    title = 'Restore complete';
    summary = `Added ${added} of ${records.length} accounts.`;
  } else if (added === 0 && other === 0) {
    title = 'Nothing to add';
    summary = 'Every account in this backup is already on this device.';
  } else {
    title = 'Restore finished';
    summary = `Added ${added} of ${records.length} accounts. Check the list below.`;
  }

  const rows = records.filter((r) => r.outcome !== 'added').map(rowFor);

  const notes: string[] = [];
  if (result.ledgerAccountCount > 0) {
    notes.push(
      `${result.ledgerAccountCount} Ledger account(s) will need to be re-paired with your device.`
    );
  }
  if (result.duplicateAccountsDropped > 0) {
    notes.push(
      `${result.duplicateAccountsDropped} duplicate account record(s) in the backup were merged.`
    );
  }
  if (result.pairedSignersNotRestored > 0) {
    notes.push(PAIRINGS_LINE);
  }
  // Every restore that is not fresh ends with this line, a repeat after a crash
  // included; a fresh first run never shows it. Nothing in the report claims
  // settings or friends came across in that case.
  if (!result.settingsRestored) {
    notes.push(NOT_FRESH_LINE);
  }

  const leftOut = result.leftOut ?? [];
  const notInBackup =
    leftOut.length > 0
      ? {
          title: NOT_IN_BACKUP_TITLE,
          rows: leftOut.map((a) => ({
            label: a.label || 'Account',
            shortAddress: formatAddress(a.address),
            text: LEFT_OUT_REASON_TEXT[a.reason],
          })),
        }
      : undefined;

  return {
    title,
    summary,
    rows,
    ...(notInBackup ? { notInBackup } : {}),
    notes,
  };
}

/** The report as one block of text, for an alert. */
export function formatRestoreReport(report: RestoreReport): string {
  const parts = [report.summary];
  if (report.rows.length > 0) {
    parts.push(
      report.rows
        .map((r) => `• ${r.label} (${r.shortAddress}): ${r.text}`)
        .join('\n')
    );
  }
  if (report.notInBackup) {
    parts.push(
      `${report.notInBackup.title}\n` +
        report.notInBackup.rows
          .map((r) => `• ${r.label} (${r.shortAddress}): ${r.text}`)
          .join('\n')
    );
  }
  if (report.notes.length > 0) {
    parts.push(report.notes.join('\n\n'));
  }
  return parts.join('\n\n');
}
