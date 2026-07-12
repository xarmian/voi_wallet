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
 * - The cursor advances ONLY when a fetch fully drained its range (`complete`).
 * - It advances to the greatest ingestion id fetched (`maxId`).
 * - A truncated drain, or a source with no ingestion id (the indexer fallback,
 *   `maxId == null`), leaves the cursor untouched so nothing below it is
 *   skipped.
 * - It never moves backwards.
 */

export interface SyncCursorInput {
  /** The current committed cursor (null before the first successful sync). */
  previous: number | null;
  /** Whether the fetch drained its entire range. */
  complete: boolean;
  /**
   * Greatest MIMIR ingestion id fetched, or null when the source exposes no
   * ingestion id (indexer fallback) or nothing was fetched.
   */
  maxId: number | null;
}

/**
 * Decide the next committed sync cursor. Never advances on a truncated drain or
 * a source without an ingestion id, and never moves backwards.
 */
export function computeSyncCursor(input: SyncCursorInput): number | null {
  const { previous, complete, maxId } = input;

  // Only a fully-drained fetch from an ingestion-ordered source may advance.
  if (!complete || maxId == null) return previous;

  return previous == null ? maxId : Math.max(previous, maxId);
}
