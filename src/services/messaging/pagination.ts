/**
 * Incremental-sync pagination helpers.
 *
 * These guard against the message-loss failure mode of a naive
 * "cursor + limit" incremental poll: when more than `limit` messages arrive
 * between two polls, a single limit-bounded query only returns one page and
 * the remaining rows in the range are never fetched again. To avoid this, an
 * incremental fetch must DRAIN the full range — keep paginating while a page
 * comes back full (== limit) — before the durable sync cursor is allowed to
 * advance.
 *
 * Both helpers are pure (no network / crypto): they take a `fetchPage`
 * callback and orchestrate the drain, so they can be unit-tested in isolation.
 */

/**
 * Last-resort backstop against a source that never terminates (e.g. a
 * misbehaving pager). Real termination is structural — a short page for
 * `drainByCursor`, an absent/repeated token for `drainByToken` — and, for a
 * finite backend, always happens before this regardless of backlog size. The
 * value is only a runaway ceiling, not a functional page limit: it is set far
 * beyond any realistic backlog (here, up to ~100k rows) so that even a long
 * offline period drains to completion in a single sync and its gap is fully
 * recovered rather than deferred.
 */
export const MAX_DRAIN_PAGES = 1000;

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
 * Draining oldest-first is what makes this loss-safe: the caller advances its
 * durable sync cursor to the newest row it has actually seen, and every row
 * this stops short of is *newer* than that — so it sits above the durable
 * cursor and is simply picked up by the next poll, never dropped.
 *
 * Returns `complete: true` only when the range was fully exhausted (a short
 * page). Stopping early — the cursor failed to advance (a broken source) or the
 * `maxPages` backstop was hit — returns `complete: false` so the caller knows
 * not to advance a durable cursor past rows it may not have fetched.
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
): Promise<{ rows: T[]; complete: boolean }> {
  const rows: T[] = [];
  let cursor: number | undefined;

  for (let page = 0; page < maxPages; page++) {
    const batch = await fetchPage(cursor);
    rows.push(...batch);

    // A short page means we have reached the end of the range.
    if (batch.length < limit) return { rows, complete: true };

    let maxCursor = cursor ?? Number.NEGATIVE_INFINITY;
    for (const row of batch) {
      const value = getCursor(row);
      if (value > maxCursor) maxCursor = value;
    }

    // The cursor must strictly advance; otherwise stop rather than spin.
    if (cursor !== undefined && maxCursor <= cursor) {
      return { rows, complete: false };
    }
    cursor = maxCursor;
  }

  return { rows, complete: false };
}

/**
 * Drain a token-paginated source (e.g. the Algorand indexer) into a single
 * list. Keeps fetching pages while the source returns a fresh continuation
 * token, so the range is drained to completion — bounded only by the number of
 * rows actually in the incremental window.
 *
 * Termination is structural: a well-behaved source omits the token on the last
 * page, and a repeated token (a misbehaving pager) is treated as the end so the
 * loop can never spin.
 *
 * Returns `complete: true` only when the source signalled the end by omitting
 * the token. Stopping on a repeated token or the `maxPages` backstop returns
 * `complete: false` so the caller does not advance a durable cursor past rows
 * it may not have fetched.
 *
 * @param fetchPage - fetches one page for the given continuation token
 * @param maxPages - runaway backstop (see MAX_DRAIN_PAGES)
 */
export async function drainByToken<T>(
  fetchPage: (
    token: string | undefined
  ) => Promise<{ items: T[]; nextToken?: string }>,
  maxPages: number = MAX_DRAIN_PAGES
): Promise<{ items: T[]; complete: boolean }> {
  const items: T[] = [];
  const seenTokens = new Set<string>();
  let token: string | undefined;

  for (let page = 0; page < maxPages; page++) {
    const { items: batch, nextToken } = await fetchPage(token);
    items.push(...batch);
    if (!nextToken) return { items, complete: true };
    if (seenTokens.has(nextToken)) return { items, complete: false };
    seenTokens.add(nextToken);
    token = nextToken;
  }

  return { items, complete: false };
}
