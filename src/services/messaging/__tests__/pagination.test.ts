import { drainByCursor, drainByToken, MAX_DRAIN_PAGES } from '../pagination';

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
});

describe('drainByToken', () => {
  it('returns a single page when there is no continuation token', async () => {
    const fetchPage = jest.fn(async () => ({
      items: [1, 2, 3],
      nextToken: undefined,
    }));

    const result = await drainByToken(fetchPage);

    expect(result.items).toEqual([1, 2, 3]);
    expect(result.complete).toBe(true);
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(fetchPage).toHaveBeenCalledWith(undefined);
  });

  it('follows continuation tokens to completion', async () => {
    const pages: Record<string, { items: number[]; nextToken?: string }> = {
      __start__: { items: [1, 2], nextToken: 'a' },
      a: { items: [3, 4], nextToken: 'b' },
      b: { items: [5], nextToken: undefined },
    };
    const seen: (string | undefined)[] = [];
    const fetchPage = async (token: string | undefined) => {
      seen.push(token);
      return pages[token ?? '__start__'];
    };

    const result = await drainByToken(fetchPage);

    expect(result.items).toEqual([1, 2, 3, 4, 5]);
    expect(result.complete).toBe(true);
    expect(seen).toEqual([undefined, 'a', 'b']);
  });

  it('reports incomplete if the source repeats a token (does not spin)', async () => {
    let pageCount = 0;
    const fetchPage = async () => {
      pageCount++;
      return { items: [pageCount], nextToken: 'stuck' };
    };

    const result = await drainByToken(fetchPage);

    // First page consumed, second page sees the already-seen token and stops.
    expect(pageCount).toBe(2);
    expect(result.items).toEqual([1, 2]);
    expect(result.complete).toBe(false);
  });

  it('reports incomplete when it hits the maxPages safety cap', async () => {
    let pageCount = 0;
    // Fresh token every page => would loop forever without the cap.
    const fetchPage = async () => {
      pageCount++;
      return { items: [pageCount], nextToken: `t${pageCount}` };
    };

    const result = await drainByToken(fetchPage, 4);

    expect(pageCount).toBe(4);
    expect(result.items).toEqual([1, 2, 3, 4]);
    expect(result.complete).toBe(false);
  });
});
