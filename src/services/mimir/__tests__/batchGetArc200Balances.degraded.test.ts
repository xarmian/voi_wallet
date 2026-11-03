// A failed batch must not turn into serial per-owner retries against a service
// that is already struggling (TASK-488, audit 10-29 medium #16).
//
//   * A batch that failed because Mimir looks unhealthy (transport failure or
//     timeout, 5xx, 429) marks the chunk `failed` and issues NO per-owner calls.
//   * Any other batch failure still falls back per owner, so one bad owner
//     cannot make a whole chunk unknown, but with bounded concurrency and one
//     shared wall-clock budget.
//   * A failure is never written as a zero balance: it stays in `failed`.

import { MimirApiError, MimirApiService } from '../index';

const service = MimirApiService.getInstance();

describe('MimirApiService.batchGetArc200Balances under a degraded service (TASK-488)', () => {
  let fetchForOwners: jest.SpyInstance;
  let getArc200Balance: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    fetchForOwners = jest
      .spyOn(
        service as unknown as {
          fetchArc200BalancesForOwners: (
            c: number,
            o: string[]
          ) => Promise<Map<string, string>>;
        },
        'fetchArc200BalancesForOwners'
      )
      .mockRejectedValue(new Error('placeholder'));
    getArc200Balance = jest.spyOn(service, 'getArc200Balance');
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  const OWNERS = ['A', 'B', 'C'];
  const pairs = (owners: string[]) =>
    owners.map((owner) => ({ contractId: 5, owner }));

  describe.each([
    [
      'a transport failure / timeout',
      new MimirApiError('All 3 attempts failed', undefined, 'NETWORK_ERROR'),
    ],
    ['a 500', new MimirApiError('Server Error', 500)],
    ['a 503', new MimirApiError('Unavailable', 503)],
    ['a 429', new MimirApiError('Too Many Requests', 429)],
  ])('when the batch failed with %s', (_label, error) => {
    it('marks the whole chunk failed and issues no per-owner requests', async () => {
      fetchForOwners.mockRejectedValue(error);

      const result = await service.batchGetArc200Balances(pairs(OWNERS));

      expect(getArc200Balance).not.toHaveBeenCalled();
      expect([...result.failed].sort()).toEqual(['5_A', '5_B', '5_C']);
      // Never written as a zero.
      expect(result.balances.size).toBe(0);
    });
  });

  it('still falls back per owner for a client error (a bad owner must not hide the rest)', async () => {
    fetchForOwners.mockRejectedValue(new MimirApiError('Bad Request', 400));
    getArc200Balance.mockImplementation(async (_c: number, owner: string) => {
      if (owner === 'B') throw new MimirApiError('Bad Request', 400);
      return '7';
    });

    const result = await service.batchGetArc200Balances(pairs(OWNERS));

    expect(getArc200Balance).toHaveBeenCalledTimes(3);
    expect(result.balances.get('5_A')).toBe('7');
    expect(result.balances.get('5_C')).toBe('7');
    expect([...result.failed]).toEqual(['5_B']);
  });

  it('keeps at most FALLBACK_CONCURRENCY per-owner requests in flight', async () => {
    fetchForOwners.mockRejectedValue(new MimirApiError('Bad Request', 400));
    const owners = Array.from({ length: 12 }, (_, i) => `O${i}`);
    let inFlight = 0;
    let maxInFlight = 0;
    getArc200Balance.mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
      return '1';
    });

    const run = service.batchGetArc200Balances(pairs(owners));
    await jest.advanceTimersByTimeAsync(1000);
    const result = await run;

    expect(maxInFlight).toBeLessThanOrEqual(
      MimirApiService.FALLBACK_CONCURRENCY
    );
    expect(maxInFlight).toBeGreaterThan(1); // concurrent, not serial
    expect(result.balances.size).toBe(12);
    expect(result.failed.size).toBe(0);
  });

  it('bounds the whole fallback by FALLBACK_BUDGET_MS and reports the rest as failed', async () => {
    fetchForOwners.mockRejectedValue(new MimirApiError('Bad Request', 400));
    const owners = Array.from({ length: 12 }, (_, i) => `O${i}`);
    // The first FALLBACK_CONCURRENCY answer; everything after hangs forever.
    let calls = 0;
    getArc200Balance.mockImplementation(() => {
      calls++;
      return calls <= MimirApiService.FALLBACK_CONCURRENCY
        ? Promise.resolve('1')
        : new Promise<string>(() => {});
    });

    const run = service.batchGetArc200Balances(pairs(owners));
    await jest.advanceTimersByTimeAsync(MimirApiService.FALLBACK_BUDGET_MS + 1);
    const result = await run; // settles at the budget instead of hanging

    // Four answered, four hung in flight; the last four were still queued when
    // the budget ran out and were never asked (no request past the deadline).
    expect(getArc200Balance).toHaveBeenCalledTimes(
      2 * MimirApiService.FALLBACK_CONCURRENCY
    );
    expect(result.balances.size).toBe(MimirApiService.FALLBACK_CONCURRENCY);
    expect(result.failed.size).toBe(12 - MimirApiService.FALLBACK_CONCURRENCY);
    // Nothing is both answered and failed, and nothing is written as zero.
    for (const key of result.failed)
      expect(result.balances.has(key)).toBe(false);
    for (const value of result.balances.values()) expect(value).toBe('1');
  });

  it('a late answer after the budget is discarded, not written', async () => {
    fetchForOwners.mockRejectedValue(new MimirApiError('Bad Request', 400));
    let late!: (v: string) => void;
    getArc200Balance.mockImplementation(
      () => new Promise<string>((r) => (late = r))
    );

    const run = service.batchGetArc200Balances(pairs(['A']));
    await jest.advanceTimersByTimeAsync(MimirApiService.FALLBACK_BUDGET_MS + 1);
    const result = await run;
    late('999');
    await jest.advanceTimersByTimeAsync(0);

    expect([...result.failed]).toEqual(['5_A']);
    expect(result.balances.has('5_A')).toBe(false);
  });

  it('shares one budget across chunks: a second failing chunk does not get a fresh one', async () => {
    fetchForOwners.mockRejectedValue(new MimirApiError('Bad Request', 400));
    // 150 owners = two chunks (100 + 50), both of which fall back.
    const owners = Array.from({ length: 150 }, (_, i) => `O${i}`);
    getArc200Balance.mockImplementation(
      () => new Promise<string>((r) => setTimeout(() => r('1'), 6000))
    );

    const run = service.batchGetArc200Balances(pairs(owners));
    await jest.advanceTimersByTimeAsync(MimirApiService.FALLBACK_BUDGET_MS + 1);
    // A fresh budget for chunk 2 would leave this still pending.
    const result = await run;

    // Waves of FALLBACK_CONCURRENCY at t = 0, 6, 12 answered (the one at 18 ran
    // out of budget); every other owner is failed and was never asked.
    expect(getArc200Balance.mock.calls.length).toBeLessThanOrEqual(
      4 * MimirApiService.FALLBACK_CONCURRENCY
    );
    expect(result.balances.size + result.failed.size).toBe(150);
    expect(result.failed.size).toBeGreaterThan(100);
  });

  it('holds the concurrency limit across contracts whose fallbacks start at different times', async () => {
    // Contract 1's batch fails at once; contract 2's batch fails 150 ms later,
    // while contract 1's per-owner requests are still running and queued.
    fetchForOwners.mockImplementation(async (contractId: number) => {
      if (contractId === 2) await new Promise((r) => setTimeout(r, 150));
      throw new MimirApiError('Bad Request', 400);
    });
    let inFlight = 0;
    let maxInFlight = 0;
    getArc200Balance.mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 100));
      inFlight--;
      return '1';
    });
    const many = (contractId: number) =>
      Array.from({ length: 12 }, (_, i) => ({ contractId, owner: `O${i}` }));

    const run = service.batchGetArc200Balances([...many(1), ...many(2)]);
    await jest.advanceTimersByTimeAsync(5000);
    const result = await run;

    expect(maxInFlight).toBeLessThanOrEqual(
      MimirApiService.FALLBACK_CONCURRENCY
    );
    expect(result.balances.size).toBe(24);
  });
});
