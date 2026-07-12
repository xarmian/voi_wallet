/**
 * Durable message-sync cursor logic.
 *
 * The "committed sync cursor" is the round through which we have *provably
 * fetched everything* for an account. It is deliberately decoupled from "the
 * max round among messages we happen to hold": the latter can jump ahead of
 * rows we never fetched (e.g. a truncated/capped incremental drain persists a
 * partial prefix), and recomputing a durable cursor from held rows would
 * advance it past that gap and permanently skip the unfetched rows.
 *
 * Rules (see computeSyncCursor):
 * - The cursor advances ONLY when a fetch fully drained its range (`complete`).
 * - A newest-window bootstrap proves only that everything ABOVE the window's
 *   oldest round is in hand, so it commits to that minimum round.
 * - A complete incremental drain reached the live tip, so it commits to the
 *   newest round held.
 * - A truncated drain leaves the cursor untouched; the next poll re-drains the
 *   same range, so nothing below the cursor is ever skipped.
 */

export interface SyncCursorInput {
  /** The current committed cursor (null before the first successful sync). */
  previous: number | null;
  /** Whether the fetch drained its entire range. */
  complete: boolean;
  /**
   * Whether this was a bootstrap (newest-window) fetch — i.e. no `afterRound`
   * cursor was passed — versus an incremental drain from the committed cursor.
   */
  isBootstrap: boolean;
  /**
   * Minimum confirmed round among the rows returned by a bootstrap fetch (its
   * oldest row), or null when nothing was returned.
   */
  minFetchedRound: number | null;
  /**
   * Maximum confirmed round held after an incremental drain merged its rows,
   * or null when nothing is held.
   */
  maxHeldRound: number | null;
}

/**
 * Decide the next committed sync cursor. Never advances past rows we may not
 * have fetched: a truncated drain (`complete === false`) returns the previous
 * cursor unchanged, and the result never moves backwards.
 */
export function computeSyncCursor(input: SyncCursorInput): number | null {
  const { previous, complete, isBootstrap, minFetchedRound, maxHeldRound } =
    input;

  // Only a fully-drained fetch may advance the durable cursor.
  if (!complete) return previous;

  if (isBootstrap) {
    // Newest-window bootstrap: everything with round > (oldest fetched round)
    // is provably in hand. Commit to that oldest round; the next poll's
    // boundary overlap re-fetches it. Never move the cursor backwards.
    if (minFetchedRound == null) return previous;
    return previous == null
      ? minFetchedRound
      : Math.max(previous, minFetchedRound);
  }

  // A complete incremental drain reached the live tip: everything up to the
  // newest held round is in hand.
  if (maxHeldRound == null) return previous;
  return previous == null ? maxHeldRound : Math.max(previous, maxHeldRound);
}
