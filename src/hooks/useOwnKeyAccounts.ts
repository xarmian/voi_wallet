import { useEffect, useMemo, useState } from 'react';
import { useIsFocused } from '@react-navigation/native';
import { AccountMetadata } from '@/types/wallet';
import {
  filterOwnKeyAccounts,
  OwnKeyAccount,
} from '@/services/wallet/ownKeyCustody';

/**
 * The accounts a custody filter admits (TASK-425 U2; by default, those whose
 * own secret this device holds), or null until the first probe resolves.
 * Callers treat null as "none yet", never as "all". It re-probes when the
 * account set changes and whenever the screen regains focus, since a secret can
 * appear or go without the record changing. Between probes it keeps the last
 * answer, limited to accounts still present, so a screen isn't torn down.
 */
export function useOwnKeyAccounts<T extends AccountMetadata = OwnKeyAccount>(
  accounts: readonly AccountMetadata[],
  filter: (
    accounts: readonly AccountMetadata[]
  ) => Promise<T[]> = filterOwnKeyAccounts as never
): T[] | null {
  const isFocused = useIsFocused();
  const [heldIds, setHeldIds] = useState<ReadonlySet<string> | null>(null);
  // Re-probe only when the set of (id, type) changes, not on every store tick.
  const key = useMemo(
    () => accounts.map((a) => `${a.id}:${a.type}`).join('|'),
    [accounts]
  );

  useEffect(() => {
    if (!isFocused) return;
    let cancelled = false;
    void filter(accounts).then((result) => {
      if (!cancelled) setHeldIds(new Set(result.map((a) => a.id)));
    });
    return () => {
      cancelled = true;
    };
    // `key` and focus capture every input that changes the answer; `filter`
    // is a module-level function.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, isFocused]);

  // Return the current records, so a label or colour change shows at once.
  return useMemo(
    () =>
      heldIds === null
        ? null
        : (accounts.filter((a) => heldIds.has(a.id)) as T[]),
    [accounts, heldIds]
  );
}
