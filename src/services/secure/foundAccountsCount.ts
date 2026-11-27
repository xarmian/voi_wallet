/**
 * TASK-478: how found keys are counted. No storage imports: Settings, the Home
 * notice and the found screen count from a summary they already hold.
 */
import { accountTypeHoldsOwnKey } from '@/types/wallet';
import type { FoundRow, FoundSummary } from './foundAccounts';

/**
 * The one rule for whether an in-wallet copy's wallet account can use a key
 * of its own. The count, the row text and the Remove button all use it. It
 * reads the verdict the auth-gated scan recorded (the wallet account's slot
 * read the key back), never presence and never a slot. A missing verdict is
 * not "holds its key", so the found key stays reachable. A watch, Ledger or
 * remote-signer account never signs with a stored key, whatever was recorded
 * (accountTypeHoldsOwnKey). The verdict can be stale: Remove re-checks the
 * slot under the key-mutation mutex.
 */
export function walletHoldsOwnKey(
  row: Extract<FoundRow, { kind: 'in-wallet' }>
): boolean {
  return row.walletKeyUsable === true && accountTypeHoldsOwnKey(row.walletType);
}

/**
 * A row the user can act on: a ready or unscanned key, or an in-wallet copy
 * whose wallet account is not known to hold a key of its own
 * (walletHoldsOwnKey), since the found key may then be its only usable copy.
 * A copy whose wallet account was checked and holds the key is a duplicate and
 * is not counted.
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
 * in-wallet copies not known to be duplicates (walletHoldsOwnKey) count. `ids`
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

/**
 * An in-wallet copy the next auth-gated scan should check: no verdict yet, and
 * its wallet account's type can hold a key (a watch, Ledger or remote-signer
 * account can't, so its row needs no scan).
 */
export function inWalletNeedsVerdict(row: FoundRow): boolean {
  return (
    row.kind === 'in-wallet' &&
    row.walletKeyUsable === undefined &&
    accountTypeHoldsOwnKey(row.walletType)
  );
}

/**
 * The ids an auth-gated scan should read: unscanned keys, and in-wallet copies
 * with no verdict on whether their wallet account still holds its key
 * (inWalletNeedsVerdict).
 */
export function idsNeedingScan(summary: FoundSummary): string[] {
  return [
    ...summary.unscannedIds,
    ...summary.rows.flatMap((row) =>
      inWalletNeedsVerdict(row) ? [row.id] : []
    ),
  ];
}
