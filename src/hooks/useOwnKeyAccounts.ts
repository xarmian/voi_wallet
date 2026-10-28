import { useEffect, useMemo, useState } from 'react';
import { AccountMetadata } from '@/types/wallet';
import {
  filterOwnKeyAccounts,
  OwnKeyAccount,
} from '@/services/wallet/ownKeyCustody';

/**
 * The accounts whose own secret this device holds (TASK-425 U2), or null while
 * the custody probe runs. Callers treat null as "none yet", never as "all".
 */
export function useOwnKeyAccounts(
  accounts: readonly AccountMetadata[]
): OwnKeyAccount[] | null {
  const [held, setHeld] = useState<{
    key: string;
    accounts: OwnKeyAccount[];
  } | null>(null);
  // Re-probe only when the set of (id, type) changes, not on every store tick.
  const key = useMemo(
    () => accounts.map((a) => `${a.id}:${a.type}`).join('|'),
    [accounts]
  );

  useEffect(() => {
    let cancelled = false;
    void filterOwnKeyAccounts(accounts).then((result) => {
      if (!cancelled) setHeld({ key, accounts: result });
    });
    return () => {
      cancelled = true;
    };
    // `key` captures every input that changes the answer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (held?.key !== key) return null;
  // Return the current records, so a label or colour change shows at once.
  const ids = new Set(held.accounts.map((a) => a.id));
  return accounts.filter((a): a is OwnKeyAccount => ids.has(a.id));
}
