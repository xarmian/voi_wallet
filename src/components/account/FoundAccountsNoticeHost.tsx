import React, { useEffect, useState } from 'react';
import FoundAccountsNotice from './FoundAccountsNotice';
import { useFoundAccountsSummary } from '@/hooks/useFoundAccountsSummary';
import { AccountSecureStorage } from '@/services/secure/AccountSecureStorage';
import {
  presentIdsOf,
  type FoundSummary,
} from '@/services/secure/foundAccounts';

/**
 * What the notice announces: keys the user can act on. A ready address counts
 * once however many copies it has; unscanned rows and unreadable ids count;
 * in-wallet copies do not.
 */
function actionable(summary: FoundSummary): {
  count: number;
  ids: string[];
  address?: string;
} {
  const rows = summary.rows.filter(
    (row) => row.kind === 'ready' || row.kind === 'unscanned'
  );
  const count = rows.length + summary.unreadableIds.length;
  const ids = [
    ...rows.flatMap((row) => (row.kind === 'ready' ? row.ids : [row.id])),
    ...summary.unreadableIds,
  ];
  const addresses = rows.flatMap((row) => {
    const address = row.kind === 'ready' ? row.address : row.hintAddress;
    return address ? [address] : [];
  });
  return {
    count,
    ids,
    ...(count === 1 && addresses.length === 1 ? { address: addresses[0] } : {}),
  };
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
  const shown = actionable(summary);
  if (shown.count === 0 || shown.ids.every((id) => seen.ids.has(id)))
    return null;
  // Every present id is recorded, in-wallet copies included.
  const ids = presentIdsOf(summary);

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
