import { useEffect, useRef, useState } from 'react';
import {
  Arc200TransactionGroup,
  Arc200TransactionService,
} from '@/services/transactions/arc200';
import { isArc200MbrRace } from '@/services/transactions/arc200MbrRace';

// Retain one group for both review and signing; discard stale async builds.
export function useArc200Confirmation(
  build: (
    forceMbrPayment?: boolean
  ) => Promise<Arc200TransactionGroup> | undefined
) {
  const [review, setReview] = useState<{
    build: typeof build;
    group: Arc200TransactionGroup;
  }>();
  const recovery = useRef({ build, attempted: false });
  useEffect(() => {
    recovery.current = { build, attempted: false };
    let cancelled = false;
    build()
      ?.then((group) => {
        if (!cancelled) setReview({ build, group });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      recovery.current = { build, attempted: true };
    };
  }, [build]);
  const group = review?.build === build ? review.group : undefined;
  const recover = async (error: unknown, failedGroup = group) => {
    const state = recovery.current;
    if (
      state.build !== build ||
      state.attempted ||
      !failedGroup ||
      failedGroup.needsMbrPayment ||
      !isArc200MbrRace(error, failedGroup)
    )
      return false;
    // Latch before awaiting: duplicate callbacks cannot build a third group.
    state.attempted = true;
    setReview(undefined);
    try {
      const rebuilt = await build(true);
      if (rebuilt && recovery.current === state)
        setReview({ build, group: rebuilt });
    } catch {
      // Keep confirmation disabled if rebuilding fails; never expose the race error.
    }
    return true;
  };
  return {
    group,
    fee: group ? Arc200TransactionService.groupCost(group) : 0,
    recover,
  };
}
