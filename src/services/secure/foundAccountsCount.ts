/**
 * TASK-478: how found keys are counted. No storage imports: Settings, the Home
 * notice and the found screen count from a summary they already hold.
 */
import type { FoundSummary } from './foundAccounts';

/**
 * The keys a user can act on, as every surface counts them: a ready address
 * counts once however many copies it has; unscanned rows and unreadable ids
 * count; in-wallet copies do not. `ids` are the ids those entries name, and
 * `address` is set when exactly one entry is counted and its address is known.
 */
export function actionableOf(summary: FoundSummary): {
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

/** The found-key count the Home notice, Settings and the found screen show. */
export function actionableCount(summary: FoundSummary): number {
  return actionableOf(summary).count;
}
