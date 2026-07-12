import { drainByCursor, MAX_DRAIN_PAGES } from '../pagination';

interface Row {
  id: number;
  round: number;
}

/**
 * Build a fake keyset source that mimics the MIMIR query
 * `.gt('id', afterCursor).order('id', { ascending: true }).limit(limit)`:
 * return up to `limit` rows with `id > afterCursor` (or the first rows overall
 * when `afterCursor` is undefined), ordered by id ascending.
 */
function makeCursorSource(allRows: Row[], limit: number) {
  const calls: (number | undefined)[] = [];
  const sorted = [...allRows].sort((a, b) => a.id - b.id);

  const fetchPage = async (afterCursor: number | undefined): Promise<Row[]> => {
    calls.push(afterCursor);
    const inRange = sorted.filter(
      (r) => afterCursor === undefined || r.id > afterCursor
    );
    return inRange.slice(0, limit);
  };

  return { fetchPage, calls };
}

describe('drainByCursor', () => {
  it('returns a single short page without paginating', async () => {
    const rows: Row[] = [
      { id: 1, round: 10 },
      { id: 2, round: 11 },
    ];
    const { fetchPage, calls } = makeCursorSource(rows, 3);

    const result = await drainByCursor(3, fetchPage, (r) => r.id);

    expect(result.rows.map((r) => r.id)).toEqual([1, 2]);
    expect(result.complete).toBe(true);
    expect(calls).toEqual([undefined]); // one fetch only
  });

  it('drains every row across many full pages (message-loss guard)', async () => {
    // 10 rows, page size 3 => a naive single page would only return 3 and
    // strand the other 7.
    const rows: Row[] = Array.from({ length: 10 }, (_, i) => ({
      id: i + 1,
      round: 1000 + i,
    }));
    const { fetchPage } = makeCursorSource(rows, 3);

    const result = await drainByCursor(3, fetchPage, (r) => r.id);

    // No loss and no duplicates: every row exactly once, in id order.
    expect(result.rows.map((r) => r.id)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
    expect(result.complete).toBe(true);
  });

  it('drains all messages sharing one round (unique-id keyset, no tie stall)', async () => {
    // The pathological case for round-based keyset pagination: many messages in
    // a single round. Paging by the unique id drains them all across pages.
    const rows: Row[] = Array.from({ length: 5 }, (_, i) => ({
      id: i + 1,
      round: 42, // all the same round
    }));
    const { fetchPage } = makeCursorSource(rows, 2);

    const result = await drainByCursor(2, fetchPage, (r) => r.id);

    expect(result.rows).toHaveLength(5);
    expect(new Set(result.rows.map((r) => r.id))).toEqual(
      new Set([1, 2, 3, 4, 5])
    );
    expect(result.complete).toBe(true);
  });

  it('reports incomplete (does not spin) when the cursor cannot advance', async () => {
    // A broken source that ignores the cursor and keeps returning a full page.
    let pageCount = 0;
    const fetchPage = async (): Promise<Row[]> => {
      pageCount++;
      return [
        { id: 1, round: 1 },
        { id: 2, round: 1 },
      ];
    };

    const result = await drainByCursor(2, fetchPage, (r) => r.id);

    // Bails via the no-progress guard almost immediately, flagged incomplete.
    expect(pageCount).toBe(2);
    expect(result.complete).toBe(false);
  });

  it('reports incomplete when it hits the maxPages safety cap', async () => {
    let pageCount = 0;
    // Always returns a full page of strictly newer ids => would drain forever
    // without the cap.
    const fetchPage = async (
      afterCursor: number | undefined
    ): Promise<Row[]> => {
      pageCount++;
      const start = (afterCursor ?? 0) + 1;
      return [
        { id: start, round: start },
        { id: start + 1, round: start + 1 },
      ];
    };

    const result = await drainByCursor(2, fetchPage, (r) => r.id, 5);

    expect(pageCount).toBe(5);
    expect(result.complete).toBe(false);
  });

  it('defaults its safety cap to MAX_DRAIN_PAGES', () => {
    expect(MAX_DRAIN_PAGES).toBeGreaterThan(0);
  });

  it('fetches a late-indexed row with a LOWER round but HIGHER id (watermark race)', async () => {
    // The exact bug the ingestion-id cursor fixes: after the cursor advanced
    // past round 200, a row is indexed at an EARLIER round (150) but — because
    // ingestion id is monotonic — a HIGHER id (3000). Paging by id (not round)
    // still picks it up on the next drain.
    const allRows: Row[] = [
      { id: 1000, round: 100 },
      { id: 2000, round: 200 },
      { id: 3000, round: 150 }, // indexed later, earlier round, higher id
    ];
    const committedId = 2000; // advanced past the round-200 row

    const { fetchPage } = makeCursorSource(allRows, 10);
    // Model the store's incremental query: first page starts at `committedId`.
    const drainFrom = async (cursor: number | undefined) =>
      fetchPage(cursor ?? committedId);

    const result = await drainByCursor(10, drainFrom, (r) => r.id);

    expect(result.rows.map((r) => r.id)).toEqual([3000]);
    expect(result.complete).toBe(true);
  });
});
