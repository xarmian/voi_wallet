/**
 * TASK-478: how found keys are counted. No storage imports: Settings, the Home
 * notice and the found screen count from a summary they already hold.
 */
import { AccountType } from '@/types/wallet';
import type { FoundRow, FoundSummary } from './foundAccounts';

/**
 * The one rule for whether an in-wallet copy's wallet account can use a key
 * of its own. The count, the row text and the Remove button all use it. A
 * watch or Ledger account never signs with a stored key, whatever its slot
 * holds. This is presence only, never a decrypt; Remove re-checks the slot
 * under the key-mutation mutex.
 */
export function walletHoldsOwnKey(
  row: Extract<FoundRow, { kind: 'in-wallet' }>
): boolean {
  return (
    row.walletHasKey &&
    row.walletType !== AccountType.WATCH &&
    row.walletType !== AccountType.LEDGER
  );
}

/**
 * A row the user can act on: a ready or unscanned key, or an in-wallet copy
 * whose wallet account can't use a key of its own (walletHoldsOwnKey), since
 * the found key is then its only usable copy. A copy whose wallet account
 * already holds a key is a duplicate and is not counted.
 */
function isActionable(row: FoundRow): boolean {
  return (
    row.kind === 'ready' ||
    row.kind === 'unscanned' ||
    (row.kind === 'in-wallet' && !walletHoldsOwnKey(row))
  );
}

/**
 * The keys a user can act on, as every surface counts them: a ready address
 * counts once however many copies it has; unscanned rows, unreadable ids and
 * in-wallet copies that are a wallet account's only usable key count. `ids`
 * are the ids those entries name, and `address` is set when exactly one entry
 * is counted and its address is known.
 */
export function actionableOf(summary: FoundSummary): {
  count: number;
  ids: string[];
  address?: string;
} {
  const rows = summary.rows.filter(isActionable);
  const count = rows.length + summary.unreadableIds.length;
  const ids = [
    ...rows.flatMap((row) => (row.kind === 'ready' ? row.ids : [row.id])),
    ...summary.unreadableIds,
  ];
  const addresses = rows.flatMap((row) => {
    const address = row.kind === 'unscanned' ? row.hintAddress : row.address;
    return address ? [address] : [];
  });
  return {
    count,
    ids,
    ...(count === 1 && addresses.length === 1 ? { address: addresses[0] } : {}),
  };
}

/** The found-key count the Home notice, Settings and the found screen show. */
export function actionableCount(summary: FoundSummary): number {
  return actionableOf(summary).count;
}
