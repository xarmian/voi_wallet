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
 * The advice to remove an account and restore again. True only when the device
 * holds exactly one record at the address: removing it by id and restoring again
 * gets the key back (shown in task504.removeAdvice.test.ts, including the last
 * account, a retained-key REKEYED record and the key-less types). With duplicates
 * at one address (TASK-423) removing one entry leaves the row in place, so the
 * row ends at its first sentences.
 */
export const REMOVE_ADVICE =
  'To use it, remove this account from the wallet, then restore this backup again.';

function withAdvice(text: string, deviceEntries: number | undefined): string {
  return deviceEntries === 1 ? `${text} ${REMOVE_ADVICE}` : text;
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
  deviceType: keyof typeof KEYLESS_TYPE_NAME,
  deviceEntries?: number
): string {
  return withAdvice(
    `On this device as ${KEYLESS_TYPE_NAME[deviceType]}. The key in this backup wasn't added.`,
    deviceEntries
  );
}

/** A record the file carries WITHOUT its key, added without one (e7912207 item 3). */
export const ADDED_WATCH_ONLY_TEXT =
  "Added as Watch Only. This backup doesn't have its key.";
export const ADDED_WITHOUT_KEY_TEXT = 'Added without its key.';
/** Appended when such a record went under a fresh id. */
export const NEW_ID_SUFFIX =
  " This phone was already storing something else in this account's place, and we left that alone.";

export const OUTCOME_TEXT: Record<RestoreRecordOutcome, string> = {
  'device-key-unreadable': KEY_UNREADABLE_TEXT,
  'device-key-problem': KEY_PROBLEM_TEXT,
  // The text depends on the device record's type: see keylessDeviceText. This
  // entry is the type-less fallback and is not shown when a type is known.
  'device-keyless':
    "On this device without a key. The key in this backup wasn't added.",
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

export interface RestoreReport {
  title: string;
  summary: string;
  /** Every record that was not simply added, so an exception is never hidden */
  rows: RestoreReportRow[];
  /** Lines under the rows; the accounts-only line, when it applies, is last */
  notes: string[];
}

function rowFor(record: RestoreRecordResult): RestoreReportRow {
  let text: string;
  if (record.withoutKey !== undefined) {
    // Added without its key. The accounts ARE in the file now, so there is no
    // separate "not in this backup" list; this row says what happened.
    text =
      record.withoutKey === 'watch-only'
        ? ADDED_WATCH_ONLY_TEXT
        : ADDED_WITHOUT_KEY_TEXT;
    if (record.outcome === 'added-new-id') text += NEW_ID_SUFFIX;
  } else if (record.outcome === 'device-keyless') {
    text = record.deviceType
      ? keylessDeviceText(record.deviceType, record.deviceEntries)
      : withAdvice(OUTCOME_TEXT[record.outcome], record.deviceEntries);
  } else if (record.outcome === 'device-key-unreadable') {
    text = withAdvice(OUTCOME_TEXT[record.outcome], record.deviceEntries);
  } else {
    text = OUTCOME_TEXT[record.outcome];
  }
  return {
    label: record.label || 'Account',
    shortAddress: formatAddress(record.address),
    text,
  };
}

export function buildRestoreReport(result: RestoreResult): RestoreReport {
  const records = result.records;
  const added = records.filter((r) => ADDED.has(r.outcome)).length;
  const already = records.filter((r) =>
    ALREADY_ON_DEVICE.has(r.outcome)
  ).length;
  const other = records.length - added - already;

  // A record added without its key is never "Restore complete" (e7912207 item 3).
  const withoutKey = records.some((r) => r.withoutKey !== undefined);

  let title: string;
  let summary: string;
  if (other === 0 && already === 0 && added > 0 && !withoutKey) {
    title = 'Restore complete';
    summary = `Added ${added} of ${records.length} accounts.`;
  } else if (added === 0 && other === 0) {
    title = 'Nothing to add';
    summary = 'Every account in this backup is already on this device.';
  } else {
    title = 'Restore finished';
    summary = `Added ${added} of ${records.length} accounts. Check the list below.`;
  }

  // Only a plain 'added' is hidden. A record added without its key shows its
  // row even though its outcome is 'added' (the old filter would have hidden it).
  const rows = records
    .filter((r) => r.outcome !== 'added' || r.withoutKey !== undefined)
    .map(rowFor);

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

  return {
    title,
    summary,
    rows,
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
  if (report.notes.length > 0) {
    parts.push(report.notes.join('\n\n'));
  }
  return parts.join('\n\n');
}
