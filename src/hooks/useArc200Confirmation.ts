import { useEffect, useState } from 'react';
import {
  Arc200TransactionGroup,
  Arc200TransactionService,
} from '@/services/transactions/arc200';

// Retain one group for both review and signing; discard stale async builds.
export function useArc200Confirmation(
  build: () => Promise<Arc200TransactionGroup> | undefined
) {
  const [review, setReview] = useState<{
    build: typeof build;
    group: Arc200TransactionGroup;
  }>();
  useEffect(() => {
    let cancelled = false;
    build()
      ?.then((group) => {
        if (!cancelled) setReview({ build, group });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [build]);
  const group = review?.build === build ? review.group : undefined;
  return { group, fee: group ? Arc200TransactionService.groupCost(group) : 0 };
}
