import React, { useEffect, useState } from 'react';
import FoundAccountsNotice from './FoundAccountsNotice';
import { useFoundAccountsSummary } from '@/hooks/useFoundAccountsSummary';
import { AccountSecureStorage } from '@/services/secure/AccountSecureStorage';
import {
  presentIdsOf,
  type FoundSummary,
} from '@/services/secure/foundAccounts';

function singleAddress(summary: FoundSummary): string | undefined {
  if (summary.rows.length !== 1 || summary.unreadableIds.length > 0)
    return undefined;
  const row = summary.rows[0];
  return row.kind === 'unscanned' ? row.hintAddress : row.address;
}

/**
 * TASK-478: announces keys found on this device once. Reads the summary (no
 * key) on focus; an id the notice has announced is not announced again.
 */
export default function FoundAccountsNoticeHost({
  onReview,
}: {
  onReview: () => void;
}) {
  const { summary } = useFoundAccountsSummary();
  const [seen, setSeen] = useState<{
    summary: FoundSummary;
    ids: Set<string>;
  } | null>(null);

  useEffect(() => {
    if (!summary || summary.presentCount === 0) return;
    let active = true;
    AccountSecureStorage.readFoundNoticeSeen().then(
      (ids) => {
        if (active) setSeen({ summary, ids: new Set(ids) });
      },
      () => {
        // An unreadable record shows the notice again, which is harmless.
        if (active) setSeen({ summary, ids: new Set() });
      }
    );
    return () => {
      active = false;
    };
  }, [summary]);

  if (!summary || summary.presentCount === 0 || seen?.summary !== summary)
    return null;
  const ids = presentIdsOf(summary);
  if (ids.every((id) => seen.ids.has(id))) return null;

  const markSeen = () => {
    setSeen({ summary, ids: new Set([...seen.ids, ...ids]) });
    AccountSecureStorage.markFoundNoticeSeen(ids).catch(() => {
      console.warn('Unable to record the found-accounts notice');
    });
  };

  return (
    <FoundAccountsNotice
      count={summary.presentCount}
      address={singleAddress(summary)}
      onReview={() => {
        markSeen();
        onReview();
      }}
      onDismiss={markSeen}
    />
  );
}
