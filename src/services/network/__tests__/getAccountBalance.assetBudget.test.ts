// The ASA metadata pass of a balance load is bounded in time and in live
// requests (TASK-489, audit 10-29 medium #17).
//
// Before: each cache miss ran getAssetByID(...).do() under a non-aborting
// timeout, in batches of 8. On a hung node every batch timed out at 15 s while
// its requests stayed live and the next batch dispatched on top, so live
// requests grew without bound and publishing the balance waited for
// ceil(assets / 8) x 15 s.
//
// Now: a worker pool of 8 with a hard cap on LIVE requests (a timed-out lookup
// is aborted), and one total budget for the pass. When the budget runs out the
// in-flight lookups are aborted, nothing more is dispatched, and the balance
// publishes with every unresolved asset OMITTED (never a guessed decimals: 0).
// What did resolve is cached, so each refresh makes progress.

import algosdk from 'algosdk';
import { NetworkService } from '../index';
import { NetworkId } from '@/types/network';
import AlgorandPriceService from '@/services/algorand-price';

const ADDRESS = algosdk.encodeAddress(new Uint8Array(32));
const REQUEST_TIMEOUT_MS = 15_000;
const BUDGET_MS = 20_000;
const CONCURRENCY = 8;

const makeAssets = (count: number, startId = 1000) =>
  Array.from({ length: count }, (_, i) => ({
    assetId: BigInt(startId + i),
    amount: BigInt(100 + i),
  }));

interface Probe {
  algodClient: unknown;
  started: number[];
  /** Requests that were started and not yet settled or aborted. */
  live: () => number;
  maxLive: () => number;
  aborted: () => number;
}

/**
 * Fake algod. `hangs(id)` decides whether getAssetByID(id) never answers (it
 * then only ends when the caller aborts the signal it was handed).
 */
function makeProbe(
  assets: unknown[],
  hangs: (id: number) => boolean,
  ignoresAbort = false
): Probe {
  const started: number[] = [];
  let live = 0;
  let maxLive = 0;
  let aborted = 0;
  const algodClient = {
    accountInformation: () => ({
      do: async () => ({ amount: 5_000_000n, minBalance: 100_000n, assets }),
    }),
    getAssetByID: (id: number) => ({
      do: (_headers?: unknown, options?: { signal?: AbortSignal }) => {
        started.push(id);
        live += 1;
        maxLive = Math.max(maxLive, live);
        if (!hangs(id)) {
          live -= 1;
          return Promise.resolve({
            params: { decimals: 6, name: `Asset ${id}`, unitName: `A${id}` },
          });
        }
        return new Promise((_resolve, reject) => {
          // A runtime that ignores the signal never ends the request itself.
          if (ignoresAbort) return;
          options?.signal?.addEventListener('abort', () => {
            live -= 1;
            aborted += 1;
            reject(new Error('aborted'));
          });
        });
      },
    }),
  };
  return {
    algodClient,
    started,
    live: () => live,
    maxLive: () => maxLive,
    aborted: () => aborted,
  };
}

describe('NetworkService.getAccountBalance: bounded ASA metadata pass (TASK-489)', () => {
  let service: NetworkService;

  beforeEach(() => {
    jest.useFakeTimers();
    service = NetworkService.getInstance(NetworkId.ALGORAND_MAINNET);
    (service as any).assetParamsCache.clear();
    (service as any).rekeyInfoCache.clear();
    jest.spyOn(service as any, 'getMimirAssets').mockResolvedValue([]);
    jest.spyOn(service, 'isFeatureAvailable').mockReturnValue(true);
    jest
      .spyOn(AlgorandPriceService, 'getAssetPrices')
      .mockResolvedValue(new Map<number, number>([[0, 1.5]]));
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('aborts a lookup that times out, so it is no longer a live request', async () => {
    const probe = makeProbe(makeAssets(1), () => true);
    (service as any).algodClient = probe.algodClient;

    const run = service.getAccountBalance(ADDRESS);
    await jest.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 1);
    const result = await run;

    expect(probe.aborted()).toBe(1);
    expect(probe.live()).toBe(0);
    expect(result.assets).toEqual([]); // omitted, never a fabricated decimals
  });

  it('never has more than 8 live lookups, even when every one times out', async () => {
    const probe = makeProbe(makeAssets(40), () => true);
    (service as any).algodClient = probe.algodClient;

    const run = service.getAccountBalance(ADDRESS);
    await jest.advanceTimersByTimeAsync(BUDGET_MS + 1);
    await run;

    expect(probe.maxLive()).toBeLessThanOrEqual(CONCURRENCY);
    expect(probe.live()).toBe(0);
  });

  it('publishes within the total budget on a hung node, not after every batch times out', async () => {
    // 40 holdings = 5 batches of 8; the old loop needed 5 x 15 s = 75 s.
    const probe = makeProbe(makeAssets(40), () => true);
    (service as any).algodClient = probe.algodClient;

    const run = service.getAccountBalance(ADDRESS);
    await jest.advanceTimersByTimeAsync(BUDGET_MS + 1);
    const result = await run; // settles here instead of hanging

    expect(result.assets).toEqual([]);
    expect(result.amount).toBe(5_000_000n);
  });

  it('dispatches nothing once the budget is spent', async () => {
    const probe = makeProbe(makeAssets(40), () => true);
    (service as any).algodClient = probe.algodClient;

    const run = service.getAccountBalance(ADDRESS);
    await jest.advanceTimersByTimeAsync(BUDGET_MS + 1);
    await run;
    const startedAtBudget = probe.started.length;
    await jest.advanceTimersByTimeAsync(60_000);

    expect(probe.started.length).toBe(startedAtBudget);
  });

  it('keeps what resolved: partial results are returned and cached, so the next refresh makes progress', async () => {
    // The first 10 resolve at once; the rest hang.
    const probe = makeProbe(makeAssets(30), (id) => id >= 1010);
    (service as any).algodClient = probe.algodClient;

    const run = service.getAccountBalance(ADDRESS);
    await jest.advanceTimersByTimeAsync(BUDGET_MS + 1);
    const first = await run;

    expect(first.assets.map((a) => a.assetId)).toEqual(
      makeAssets(10).map((a) => Number(a.assetId))
    );
    for (const a of first.assets) expect(a.decimals).toBe(6);

    // Second refresh: the 10 resolved assets are cache hits (no lookup).
    const second = makeProbe(makeAssets(30), () => false);
    (service as any).algodClient = second.algodClient;
    await service.getAccountBalance(ADDRESS);
    expect(second.started.some((id) => id < 1010)).toBe(false);
    expect(second.started).toHaveLength(20);
  });

  it('a fast pass does not wait for the budget and leaves no budget timer behind', async () => {
    const probe = makeProbe(makeAssets(20), () => false);
    (service as any).algodClient = probe.algodClient;

    const run = service.getAccountBalance(ADDRESS);
    await jest.advanceTimersByTimeAsync(0);
    const result = await run;

    expect(result.assets).toHaveLength(20);
    // No timer is left behind (the budget timer is cleared, once, on the way
    // out), so nothing can fire a late abort.
    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(BUDGET_MS * 2);
    expect(probe.aborted()).toBe(0);
  });

  it('if the runtime ignores the abort, dispatch still stops at the budget and the pass ends within one request timeout of it', async () => {
    // The worst case when fetch does not honour the signal: lookups already in
    // flight only end at their own 15 s timeout, but nothing new is dispatched
    // after the budget, so the pass ends by BUDGET + REQUEST_TIMEOUT.
    const probe = makeProbe(makeAssets(40), () => true, true);
    (service as any).algodClient = probe.algodClient;

    const run = service.getAccountBalance(ADDRESS);
    await jest.advanceTimersByTimeAsync(BUDGET_MS + 1);
    const startedAtBudget = probe.started.length;
    await jest.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    const result = await run;

    expect(result.assets).toEqual([]);
    expect(probe.started.length).toBe(startedAtBudget);
    expect(probe.started.length).toBeLessThan(40);
  });
});
