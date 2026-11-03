/**
 * Durable message-sync cursor logic.
 *
 * The "committed sync cursor" is a MIMIR ingestion id (`voiwallet.messages`
 * BIGSERIAL PK) through which we have provably fetched everything. It is
 * deliberately an INGESTION-order id, not a round: MIMIR can index a
 * transaction late (even at an earlier round) than others, and a round-based
 * watermark would advance past that row and skip it forever. Ingestion id is
 * assigned in commit order by the sequential Conduit pipeline, so a late row
 * always gets a HIGHER id and is picked up by the next `id > cursor` query —
 * gap-free and monotonic.
 *
 * Rules (see computeSyncCursor):
 * - The cursor advances to the greatest ingestion id fetched (`maxId`) when the
 *   drain stopped because its range was exhausted ('complete') OR because it
 *   hit the page cap ('page-cap'). The drain is oldest-first on a unique
 *   ascending id for this user, so either way every row up to `maxId` has been
 *   fetched, and the rows it did not reach are above the new cursor for the
 *   next poll. Not advancing on a cap stop would wedge the sync on the same
 *   prefix forever.
 * - A stalled drain ('stalled-cursor': the id stopped advancing, a broken
 *   source), or a source with no ingestion id (the indexer fallback,
 *   `maxId == null`), leaves the cursor untouched so nothing below it is
 *   skipped.
 * - It never moves backwards.
 */

import type { DrainStop } from './pagination';

export interface SyncCursorInput {
  /** The current committed cursor (null before the first successful sync). */
  previous: number | null;
  /** Why the drain stopped (see drainByCursor). */
  stop: DrainStop;
  /**
   * Greatest MIMIR ingestion id fetched, or null when the source exposes no
   * ingestion id (indexer fallback) or nothing was fetched.
   */
  maxId: number | null;
}

/**
 * Decide the next committed sync cursor. Never advances on a stalled drain or a
 * source without an ingestion id, and never moves backwards.
 */
export function computeSyncCursor(input: SyncCursorInput): number | null {
  const { previous, stop, maxId } = input;

  // Only a contiguous prefix from an ingestion-ordered source may advance.
  if (stop === 'stalled-cursor' || maxId == null) return previous;

  return previous == null ? maxId : Math.max(previous, maxId);
}
