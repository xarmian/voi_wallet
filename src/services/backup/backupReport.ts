/**
 * What the user is told after a backup (TASK-504). Pure: it reads a
 * BackupResult and returns text, so the wording is pinned by tests and the
 * screen only displays it. An incomplete backup is never a success state.
 *
 * Titles and copy are product's (TASK-504 rulings 11-05).
 */
import { formatAddress } from '@/utils/address';
import type { BackupLeftOutReason, BackupResult } from './types';

export const INCOMPLETE_TITLE = 'Backup incomplete';

export const LEFT_OUT_REASON_TEXT: Record<BackupLeftOutReason, string> = {
  'no-key-on-device': 'No key on this device',
  'key-unreadable': "Couldn't read this key",
  'other-key-on-device':
    "Its own key is in this backup. A different key stored with it isn't.",
};

export const KEY_UNREADABLE_ADVICE =
  'Keep this wallet installed until these accounts are safe. Open each one and try to view its recovery phrase. If it opens, write it down.';

export interface BackupReportRow {
  label: string;
  shortAddress: string;
  reason: string;
}

export interface BackupReport {
  incomplete: boolean;
  /** Set only for an incomplete backup; a complete one keeps today's titles */
  title?: string;
  summary?: string;
  rows: BackupReportRow[];
  /** Shown under the rows when any key could not be read */
  advice?: string;
}

export function buildBackupReport(
  result: Pick<BackupResult, 'incomplete' | 'totalAccountCount'>
): BackupReport {
  const leftOut = result.incomplete?.leftOut ?? [];
  if (leftOut.length === 0) {
    return { incomplete: false, rows: [] };
  }
  const total = result.totalAccountCount;
  const saved = Math.max(0, total - leftOut.length);
  return {
    incomplete: true,
    title: INCOMPLETE_TITLE,
    summary: `Saved ${saved} of ${total} accounts. These weren't included:`,
    rows: leftOut.map((a) => ({
      label: a.label || 'Account',
      shortAddress: formatAddress(a.address),
      reason: LEFT_OUT_REASON_TEXT[a.reason],
    })),
    advice: leftOut.some((a) => a.reason === 'key-unreadable')
      ? KEY_UNREADABLE_ADVICE
      : undefined,
  };
}
