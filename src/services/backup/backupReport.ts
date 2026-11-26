/**
 * What the user is told after a backup (TASK-504). Pure: it reads a
 * BackupResult and returns text, so the wording is pinned by tests and the
 * screen only displays it.
 *
 * Product's copy, verbatim: e7912207 item 4, db99d45f items 2 and 3, 2c7b0680
 * item 2 (the "key may never have existed" correction). Nothing here says a key
 * was lost or deleted. A backup that lacks any key is never a success state:
 * the same title and rows appear in the modal that must be acknowledged before
 * Save or Export, and on the result screen, and "Backup Created" / "Backup
 * Saved!" are never shown for it.
 */
import { formatAddress } from '@/utils/address';
import type { BackupLeftOutReason, BackupResult } from './types';

export const LEFT_OUT_REASON_TEXT: Record<BackupLeftOutReason, string> = {
  'no-key-on-device': 'No key on this device',
  'key-unreadable': "Couldn't read this key",
  'other-key-on-device':
    "Its own key is in this backup. A different key stored with it isn't.",
};

/** Under the rows of the without-key block, for "Couldn't read this key". */
export const KEY_UNREADABLE_ADVICE =
  'Keep this wallet installed until these accounts are safe. Open each one and try to view its recovery phrase. If it opens, write it down.';

/** The only way out of the modal. */
export const ACKNOWLEDGE_BUTTON_TEXT = 'I understand';

const TITLE_ONE = "A key isn't in this backup";
const TITLE_SEVERAL = "Some keys aren't in this backup";

export interface BackupReportRow {
  label: string;
  shortAddress: string;
  reason: string;
}

export interface BackupReportBlock {
  text: string;
  rows: BackupReportRow[];
  /** Shown under the rows when it applies; absent otherwise */
  advice?: string;
}

export interface BackupReport {
  /** True when the file lacks any key (the list is not empty). */
  incomplete: boolean;
  /** Set only when incomplete; a complete backup keeps today's titles. */
  title?: string;
  /**
   * k: accounts WITHOUT their own key in the file. Only these count in the
   * "{k} accounts" text, the Android alert and the restore confirmation.
   */
  withoutKeyCount: number;
  /** j: accounts whose own key is in the file but a different key is on the phone. */
  otherKeyCount: number;
  /** Accounts whose own key is not in the file; absent when k is 0. */
  withoutKey?: BackupReportBlock;
  /** Accounts that also have a different key on this phone; absent when j is 0. */
  otherKey?: BackupReportBlock;
  /** The label of the modal's only button. */
  acknowledgeText: string;
}

function rowOf(a: {
  address: string;
  label?: string;
  reason: BackupLeftOutReason;
}): BackupReportRow {
  return {
    label: a.label || 'Account',
    shortAddress: formatAddress(a.address),
    reason: LEFT_OUT_REASON_TEXT[a.reason],
  };
}

export function buildBackupReport(
  result: Pick<BackupResult, 'incomplete'>
): BackupReport {
  const entries = result.incomplete?.leftOut ?? [];
  const without = entries.filter((a) => a.reason !== 'other-key-on-device');
  const other = entries.filter((a) => a.reason === 'other-key-on-device');
  if (entries.length === 0) {
    return {
      incomplete: false,
      withoutKeyCount: 0,
      otherKeyCount: 0,
      acknowledgeText: ACKNOWLEDGE_BUTTON_TEXT,
    };
  }

  const k = without.length;
  const j = other.length;
  // The title follows the block that leads: the without-key block when there is
  // one, otherwise the other-key block standing alone (db99d45f item 2).
  const leadCount = k > 0 ? k : j;
  const withoutKey: BackupReportBlock | undefined =
    k > 0
      ? {
          text:
            k === 1
              ? "This backup doesn't have the key for this account. You'll still see it after a restore, but this backup can't give you that key."
              : `This backup doesn't have the keys for these ${k} accounts. You'll still see them after a restore, but this backup can't give you those keys.`,
          rows: without.map(rowOf),
          advice: without.some((a) => a.reason === 'key-unreadable')
            ? KEY_UNREADABLE_ADVICE
            : undefined,
        }
      : undefined;
  const otherKey: BackupReportBlock | undefined =
    j > 0
      ? {
          text:
            j === 1
              ? "This phone also holds a different key for this account that isn't in this backup."
              : `This phone also holds different keys for these ${j} accounts that aren't in this backup.`,
          rows: other.map(rowOf),
          advice:
            j === 1
              ? "Keep this wallet installed so this key isn't lost."
              : "Keep this wallet installed so these keys aren't lost.",
        }
      : undefined;

  return {
    incomplete: true,
    title: leadCount === 1 ? TITLE_ONE : TITLE_SEVERAL,
    withoutKeyCount: k,
    otherKeyCount: j,
    ...(withoutKey ? { withoutKey } : {}),
    ...(otherKey ? { otherKey } : {}),
    acknowledgeText: ACKNOWLEDGE_BUTTON_TEXT,
  };
}

/**
 * Android's alert after the file is saved to the chosen folder (e7912207 item 4,
 * db99d45f item 3). Counts k only; when k is 0 it says the file lacks a key that
 * is on the phone.
 */
export function androidSavedAlertText(report: BackupReport): string {
  const base = 'Backup saved to your selected folder.';
  if (!report.incomplete) return base;
  const k = report.withoutKeyCount;
  if (k === 0) return `${base} It doesn't have every key on this phone.`;
  return k === 1
    ? `${base} It doesn't have the key for 1 account.`
    : `${base} It doesn't have the keys for ${k} accounts.`;
}

/**
 * The line the restore confirmation adds under its existing text when the file
 * lacks keys (e7912207 item 5, db99d45f item 3). k only; none when k is 0,
 * because those accounts restore with their keys.
 */
export function restoreConfirmationKeysLine(
  incomplete: BackupResult['incomplete']
): string | null {
  const k = (incomplete?.leftOut ?? []).filter(
    (a) => a.reason !== 'other-key-on-device'
  ).length;
  if (k === 0) return null;
  return k === 1
    ? "This backup doesn't have the key for 1 account. It'll be added without it."
    : `This backup doesn't have the keys for ${k} accounts. They'll be added without them.`;
}
