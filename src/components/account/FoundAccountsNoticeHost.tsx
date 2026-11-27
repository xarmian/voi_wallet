import React, { useEffect, useState } from 'react';
import FoundAccountsNotice from './FoundAccountsNotice';
import { useFoundAccountsSummary } from '@/hooks/useFoundAccountsSummary';
import { AccountSecureStorage } from '@/services/secure/AccountSecureStorage';
import { actionableOf } from '@/services/secure/foundAccountsCount';
import type { FoundSummary } from '@/services/secure/foundAccounts';

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
  const shown = actionableOf(summary);
  if (shown.count === 0 || shown.ids.every((id) => seen.ids.has(id)))
    return null;
  // Only what the notice announced is recorded: an in-wallet copy that may be
  // its wallet account's only usable key is, a duplicate is not (so it is
  // announced if it later becomes a ready row, its wallet account gone).
  const ids = shown.ids;

  const markSeen = () => {
    setSeen({ summary, ids: new Set([...seen.ids, ...ids]) });
    AccountSecureStorage.markFoundNoticeSeen(ids).catch(() => {
      console.warn('Unable to record the found-accounts notice');
    });
  };

  return (
    <FoundAccountsNotice
      count={shown.count}
      address={shown.address}
      onReview={() => {
        markSeen();
        onReview();
      }}
      onDismiss={markSeen}
    />
  );
}
