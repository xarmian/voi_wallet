// TASK-189: per-asset in-flight dedup + PER-ENTRY cache timestamps for
// AlgorandPriceService.getAssetPrices.
//
// Two failure modes are pinned here:
//
//  1. Dedup must be keyed per ASSET ID, not one promise per service. A single
//     shared promise would hand a caller asking for [1,2] whichever map a
//     concurrent [3,4] caller resolved first, silently dropping prices.
//
//  2. The cache must timestamp each entry INDIVIDUALLY. The previous shape
//     replaced the whole map on every fetch (accounts with disjoint ASA sets
//     evicted each other); the obvious repair — merging into a map that still
//     carries ONE global timestamp — is worse, because it re-stamps every
//     carried-over entry and an asset priced once would stay "fresh" forever.
//     The TTL test below fails if a global timestamp is ever reintroduced.
//
// Expired entries are RETAINED (never deleted on read) so the stale-fallback
// path still has something to serve when a refetch fails — also covered here.

import AlgorandPriceService from '@/services/algorand-price';

type Deferred = {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
};

/** Asset ids the service asked for, in call order. */
function requestedIds(url: string): number[] {
  const match = /asset_ids=([^&]*)/.exec(url);
  return decodeURIComponent(match![1])
    .split(',')
    .map((id) => Number(id));
}

function okResponse(ids: number[], priceFor: (id: number) => number) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () =>
      ids.map((id) => ({
        network_id: 0,
        asset_id: id,
        denominating_asset_id: 31566704,
        price: priceFor(id),
        confidence: 1,
        total_lockup: 0,
      })),
  };
}

// Drain microtasks so in-flight promises reach the pending fetch.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('AlgorandPriceService.getAssetPrices dedup + per-entry TTL (TASK-189)', () => {
  let fetchMock: jest.Mock;
  let fetchedBatches: number[][];
  let nowMs: number;

  beforeEach(() => {
    nowMs = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => nowMs);
    jest.spyOn(console, 'warn').mockImplementation(() => {});

    fetchedBatches = [];
    fetchMock = jest.fn();
    (global as unknown as { fetch: unknown }).fetch = fetchMock;

    AlgorandPriceService.clearCache();
    // Keep the retry ladder and abort timer short so failure cases don't sleep.
    AlgorandPriceService.updateConfig({
      retryAttempts: 1,
      retryDelay: 0,
      timeout: 50,
      cacheDuration: 5 * 60 * 1000,
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /** Every requested id is priced as `id * 10`, recording the batch. */
  function respondWithTenTimesId() {
    fetchMock.mockImplementation(async (url: string) => {
      const ids = requestedIds(url);
      fetchedBatches.push(ids);
      return okResponse(ids, (id) => id * 10);
    });
  }

  it('issues ONE request for N concurrent callers past the TTL and resolves them all with the same prices', async () => {
    let deferred!: Deferred;
    fetchMock.mockImplementation(
      (url: string) =>
        new Promise((resolve, reject) => {
          fetchedBatches.push(requestedIds(url));
          deferred = { resolve, reject };
        })
    );

    // Four accounts refreshing the same holdings at once on a cold cache.
    const calls = [
      AlgorandPriceService.getAssetPrices([0, 7]),
      AlgorandPriceService.getAssetPrices([0, 7]),
      AlgorandPriceService.getAssetPrices([0, 7]),
      AlgorandPriceService.getAssetPrices([0, 7]),
    ];

    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);

    deferred.resolve(okResponse([0, 7], (id) => id * 10));
    const results = await Promise.all(calls);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    for (const result of results) {
      expect(Array.from(result.entries()).sort()).toEqual([
        [0, 0],
        [7, 70],
      ]);
    }
  });

  it('gives concurrent [1,2] and [3,4] callers their OWN complete set (per-asset in-flight keys)', async () => {
    const deferreds: Deferred[] = [];
    const batches: number[][] = [];
    fetchMock.mockImplementation(
      (url: string) =>
        new Promise((resolve, reject) => {
          batches.push(requestedIds(url));
          deferreds.push({ resolve, reject });
        })
    );

    const first = AlgorandPriceService.getAssetPrices([1, 2]);
    const second = AlgorandPriceService.getAssetPrices([3, 4]);

    await flush();

    // Two distinct outbound requests — the second caller shares no asset with
    // the first, so it must not join (and inherit) the first request's map.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(batches[0]).toEqual(expect.arrayContaining([1, 2]));
    expect(batches[1]).toEqual(expect.arrayContaining([3, 4]));
    expect(batches[1]).not.toEqual(expect.arrayContaining([1]));

    // Resolve out of order to prove neither caller reads the other's result.
    deferreds[1].resolve(okResponse(batches[1], (id) => id * 10));
    deferreds[0].resolve(okResponse(batches[0], (id) => id * 10));

    const [a, b] = await Promise.all([first, second]);

    expect(Array.from(a.entries()).sort()).toEqual([
      [1, 10],
      [2, 20],
    ]);
    expect(Array.from(b.entries()).sort()).toEqual([
      [3, 30],
      [4, 40],
    ]);
  });

  it('joins an in-flight request for an overlapping asset instead of refetching it', async () => {
    const deferreds: Deferred[] = [];
    const batches: number[][] = [];
    fetchMock.mockImplementation(
      (url: string) =>
        new Promise((resolve, reject) => {
          batches.push(requestedIds(url));
          deferreds.push({ resolve, reject });
        })
    );

    const first = AlgorandPriceService.getAssetPrices([5]);
    await flush();
    const second = AlgorandPriceService.getAssetPrices([5, 6]);
    await flush();

    // Asset 5 is already in flight, so the second request carries only 6.
    expect(batches).toHaveLength(2);
    expect(batches[1]).not.toEqual(expect.arrayContaining([5]));
    expect(batches[1]).toEqual(expect.arrayContaining([6]));

    deferreds.forEach((deferred, index) =>
      deferred.resolve(okResponse(batches[index], (id) => id * 10))
    );

    const [a, b] = await Promise.all([first, second]);
    expect(a.get(5)).toBe(50);
    // Union of the joined in-flight id and this caller's own request.
    expect(Array.from(b.entries()).sort()).toEqual([
      [5, 50],
      [6, 60],
    ]);
  });

  it('does not wedge the in-flight slots when the fetch fails (finally cleanup)', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));

    // Failures are absorbed: no cache to fall back on, so the map is empty.
    await expect(AlgorandPriceService.getAssetPrices([9])).resolves.toEqual(
      new Map()
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The slots were released, so the next caller starts a fresh request.
    respondWithTenTimesId();
    const result = await AlgorandPriceService.getAssetPrices([9]);
    expect(result.get(9)).toBe(90);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not let accounts with disjoint asset sets evict each other', async () => {
    respondWithTenTimesId();

    // Account A holds asset 1; account B holds asset 2.
    const a1 = await AlgorandPriceService.getAssetPrices([0, 1]);
    expect(a1.get(1)).toBe(10);

    const b1 = await AlgorandPriceService.getAssetPrices([0, 2]);
    expect(b1.get(2)).toBe(20);
    // Account B's fetch covered only the asset it was missing.
    expect(fetchedBatches[1]).toEqual([2]);

    // Account A refreshes again: its price survived B's fetch, so nothing goes
    // out at all (the old whole-map replacement would have forced a refetch).
    const a2 = await AlgorandPriceService.getAssetPrices([0, 1]);
    expect(Array.from(a2.entries()).sort()).toEqual([
      [0, 0],
      [1, 10],
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('refetches an entry older than cacheDuration even when other entries were just refreshed', async () => {
    // REGRESSION GUARD for the rejected "merge into a single-timestamp map"
    // fix: under that shape, asset 1 would be re-stamped by asset 2's fetch and
    // would never expire while anything else keeps refetching.
    respondWithTenTimesId();

    await AlgorandPriceService.getAssetPrices([1]);
    const { cacheDuration } = AlgorandPriceService.getConfig();

    // Asset 1 goes stale, then a DIFFERENT asset is fetched (re-stamping the
    // whole map under a global timestamp).
    nowMs += cacheDuration + 1;
    await AlgorandPriceService.getAssetPrices([2]);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Asset 2 is fresh; asset 1 is expired and must go back out.
    const result = await AlgorandPriceService.getAssetPrices([1, 2]);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchedBatches[2]).toEqual(expect.arrayContaining([1]));
    expect(fetchedBatches[2]).not.toEqual(expect.arrayContaining([2]));
    expect(Array.from(result.entries()).sort()).toEqual([
      [1, 10],
      [2, 20],
    ]);
  });

  it('returns an expired-but-retained entry when the refetch fails (retain, do not delete)', async () => {
    respondWithTenTimesId();
    await AlgorandPriceService.getAssetPrices([3]);

    // Entry 3 expires…
    nowMs += AlgorandPriceService.getConfig().cacheDuration + 1;
    fetchMock.mockRejectedValue(new Error('network down'));

    // …and the refetch fails. The expired entry was never deleted, so the
    // stale-fallback path can still price the asset instead of dropping it.
    const result = await AlgorandPriceService.getAssetPrices([3]);

    expect(result.get(3)).toBe(30);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('abandons in-flight requests on clearCache so they cannot repopulate the cache', async () => {
    let deferred!: Deferred;
    const batches: number[][] = [];
    fetchMock.mockImplementation(
      (url: string) =>
        new Promise((resolve, reject) => {
          batches.push(requestedIds(url));
          deferred = { resolve, reject };
        })
    );

    const inFlight = AlgorandPriceService.getAssetPrices([8]);
    await flush();

    AlgorandPriceService.clearCache();
    deferred.resolve(okResponse(batches[0], (id) => id * 10));

    // The caller that asked for it still gets its price…
    await expect(inFlight).resolves.toEqual(new Map([[8, 80]]));

    // …but the cleared cache stays cleared, and the next caller neither joins
    // the abandoned request nor reads its write-back.
    respondWithTenTimesId();
    await AlgorandPriceService.getAssetPrices([8]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps getAlgoPrice reading asset 0 from the per-entry cache', async () => {
    respondWithTenTimesId();
    fetchMock.mockImplementationOnce(async (url: string) => {
      const ids = requestedIds(url);
      fetchedBatches.push(ids);
      return okResponse(ids, () => 1.25);
    });

    await expect(AlgorandPriceService.getAlgoPrice()).resolves.toBe(1.25);
    expect(fetchedBatches[0]).toEqual([0]);
    expect(AlgorandPriceService.formatUsdValue(2_000_000)).toBe('$2.50');
  });
});
