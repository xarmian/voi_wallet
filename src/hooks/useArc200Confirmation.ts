import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Arc200TransactionGroup,
  Arc200TransactionService,
} from '@/services/transactions/arc200';
import {
  isArc200MbrRace,
  isArc200ExpiredGroup,
} from '@/services/transactions/arc200MbrRace';

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
  const [failure, setFailure] = useState<{
    build: typeof build;
    error: unknown;
  }>();
  const recovery = useRef({ build, attempted: false, force: false });
  const load = useCallback(
    async (state: typeof recovery.current) => {
      try {
        const group = await build(state.force);
        if (group && recovery.current === state) setReview({ build, group });
        return !!group;
      } catch (error) {
        if (recovery.current === state) setFailure({ build, error });
        return false;
      }
    },
    [build]
  );
  useEffect(() => {
    const state = { build, attempted: false, force: false };
    recovery.current = state;
    void Promise.resolve().then(() => {
      if (recovery.current === state) return load(state);
    });
    return () => {
      recovery.current = { build, attempted: true, force: false };
    };
  }, [build, load]);
  const group = review?.build === build ? review.group : undefined;
  const recover = async (error: unknown, failedGroup = group) => {
    const state = recovery.current;
    if (
      state.build !== build ||
      state.attempted ||
      !failedGroup ||
      (!isArc200MbrRace(error, failedGroup) &&
        !isArc200ExpiredGroup(error, failedGroup))
    )
      return false;
    // Latch before awaiting: duplicate callbacks cannot build a third group.
    state.attempted = true;
    setReview(undefined);
    setFailure(undefined);
    // An MBR race forces funding for the whole group; expiry simulates afresh.
    state.force = isArc200MbrRace(error, failedGroup);
    return (await load(state)) ? 'rebuilt' : 'failed';
  };
  return {
    group,
    fee: group ? Arc200TransactionService.groupCost(group) : 0,
    recover,
    buildError: failure?.build === build ? failure.error : undefined,
    retry: () => {
      setReview(undefined);
      setFailure(undefined);
      void load(recovery.current);
    },
  };
}
