/**
 * ARC-200 approval-event helpers (GH #20 / TASK-392).
 */

/** The fields of an approval event that identify and order it. */
export interface Arc200ApprovalEvent {
  contractId: number;
  owner: string;
  spender: string;
  round: number;
  timestamp: number;
}

/**
 * Keep only the LATEST approval event per (contract, owner -> spender).
 *
 * An ARC-200 approval overwrites the previous allowance, so only the newest
 * event for a pair says what the spender may claim. Building one claim per
 * event gave the claim-all group byte-identical transactions, which the node
 * rejects as a duplicate.
 *
 * Ordering key:
 *   1. higher `round` wins: approvals are on-chain state changes, and the
 *      round is the authoritative order between blocks;
 *   2. same round: higher `timestamp` wins (the block timestamp, so this is
 *      normally equal within a round and only guards against inconsistent
 *      data);
 *   3. still tied: the event listed FIRST in the input wins. The Mimir
 *      approvals endpoint exposes no intra-round index, and its responses
 *      were observed round-descending (newest first; mainnet sample,
 *      2026-10-25). That is not a documented guarantee, so this tie-break is
 *      best-effort: the response position is the only intra-round order
 *      available.
 *
 * Run this BEFORE dropping zero-amount events: a later zero approval
 * (revoked or spent allowance) must hide an older non-zero one, not be
 * filtered out and let the stale allowance come back.
 *
 * The survivors keep the input order of their first occurrence.
 */
export function dedupeLatestApprovals<T extends Arc200ApprovalEvent>(
  approvals: readonly T[]
): T[] {
  const latest = new Map<string, T>();
  for (const approval of approvals) {
    const key = JSON.stringify([
      approval.contractId,
      approval.owner,
      approval.spender,
    ]);
    const current = latest.get(key);
    if (current === undefined || isNewer(approval, current)) {
      // Map.set on an existing key keeps the key's original position.
      latest.set(key, approval);
    }
  }
  return [...latest.values()];
}

function isNewer(
  candidate: Arc200ApprovalEvent,
  current: Arc200ApprovalEvent
): boolean {
  if (candidate.round !== current.round) {
    return candidate.round > current.round;
  }
  // Equal timestamps: the earlier-listed event stays (newest-first order).
  return candidate.timestamp > current.timestamp;
}
