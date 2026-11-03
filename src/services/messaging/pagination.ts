/**
 * Incremental-sync pagination helpers.
 *
 * These guard against the message-loss failure mode of a naive
 * "cursor + limit" incremental poll: when more than `limit` messages arrive
 * between two polls, a single limit-bounded query only returns one page and
 * the remaining rows in the range are never fetched again. To avoid this, an
 * incremental fetch must DRAIN the full range — keep paginating while a page
 * comes back full (== limit) — before the durable sync cursor is allowed to
 * advance (to the greatest id it fetched, see drainByCursor).
 *
 * `drainByCursor` is pure (no network / crypto): it takes a `fetchPage`
 * callback and orchestrates the drain, so it can be unit-tested in isolation.
 */

/**
 * Last-resort backstop against a source that never terminates (e.g. a
 * misbehaving pager). Real termination is structural — a short page for
 * `drainByCursor` — and, for a finite backend, always happens before this
 * regardless of backlog size. The value is only a runaway ceiling, not a
 * functional page limit: it is set far beyond any realistic backlog (here, up
 * to ~100k rows) so that even a long offline period drains to completion in a
 * single sync and its gap is fully recovered rather than deferred.
 */
export const MAX_DRAIN_PAGES = 1000;

/** Why a drain stopped; see drainByCursor. */
export type DrainStop = 'complete' | 'page-cap' | 'stalled-cursor';

/**
 * Drain a keyset-paginated source ordered by a strictly-increasing, unique
 * cursor (e.g. a primary-key id), oldest first.
 *
 * Each page is expected to return up to `limit` rows with `cursor > afterCursor`
 * (or the first rows overall when `afterCursor` is undefined), ordered by that
 * cursor ascending. Because the cursor is unique there are no ties to split
 * across a page boundary, so no dedup or overlap is needed and the drain is
 * complete.
 *
 * Draining oldest-first is what makes this loss-safe. The source is ordered by
 * a unique id and filtered to one user, so the rows fetched are a contiguous
 * prefix: EVERY row of that user up to the greatest id seen has been fetched.
 * Everything the drain did not fetch is *newer* than that, so it sits above a
 * durable cursor advanced to the greatest id seen and is picked up by the next
 * poll, never dropped.
 *
 * The result says WHY the drain stopped, never inferred from row counts:
 * - 'complete': a short page; the range is exhausted.
 * - 'page-cap': the `maxPages` backstop was hit. The rows are still a
 *   contiguous prefix, so the caller may advance its durable cursor to the
 *   greatest id seen. Refusing to would wedge the sync: with more than
 *   maxPages x limit rows above the cursor, every poll would refetch the same
 *   prefix and never reach anything newer.
 * - 'stalled-cursor': the id did not strictly advance (a broken source).
 *   Contiguity is not guaranteed, so the caller must NOT advance a durable
 *   cursor.
 *
 * @param limit - page size; a full page (=== limit) means "there may be more"
 * @param fetchPage - fetches up to `limit` rows with `cursor > afterCursor`
 * @param getCursor - the unique, increasing cursor value of a row
 * @param maxPages - runaway backstop (see MAX_DRAIN_PAGES)
 */
export async function drainByCursor<T>(
  limit: number,
  fetchPage: (afterCursor: number | undefined) => Promise<T[]>,
  getCursor: (row: T) => number,
  maxPages: number = MAX_DRAIN_PAGES
): Promise<{ rows: T[]; stop: DrainStop }> {
  const rows: T[] = [];
  let cursor: number | undefined;

  for (let page = 0; page < maxPages; page++) {
    const batch = await fetchPage(cursor);
    rows.push(...batch);

    // A short page means we have reached the end of the range.
    if (batch.length < limit) return { rows, stop: 'complete' };

    let maxCursor = cursor ?? Number.NEGATIVE_INFINITY;
    for (const row of batch) {
      const value = getCursor(row);
      if (value > maxCursor) maxCursor = value;
    }

    // The cursor must strictly advance; otherwise stop rather than spin.
    if (cursor !== undefined && maxCursor <= cursor) {
      return { rows, stop: 'stalled-cursor' };
    }
    cursor = maxCursor;
  }

  return { rows, stop: 'page-cap' };
}
