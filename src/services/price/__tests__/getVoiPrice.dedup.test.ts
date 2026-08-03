// TASK-189: in-flight dedup for VoiPriceService.getVoiPrice.
//
// getVoiPrice takes no arguments, so every concurrent caller wants the same
// value — a SINGLE shared promise is the correct dedup unit here (unlike
// AlgorandPriceService, which must key per asset id). Without it, N callers
// past the 5-minute TTL (refreshAllBalances fanning out over N accounts, the
// account switcher, a network switch) each launch their own fetch, each with
// up to `retryAttempts` attempts.

import VoiPriceService, { type VoiPriceResponse } from '@/services/price';

type Deferred = {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
};

function marketDataResponse(price: number): VoiPriceResponse {
  return {
    marketData: [],
    aggregates: {
      totalVolume: 0,
      totalTvl: 0,
      weightedAveragePrice: price,
    },
    circulatingSupply: { circulatingSupply: 0, percentDistributed: 0 },
  };
}

function okResponse(price: number) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => marketDataResponse(price),
  };
}

// Drain microtasks so the shared in-flight promise reaches the pending fetch.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('VoiPriceService.getVoiPrice in-flight dedup (TASK-189)', () => {
  let fetchMock: jest.Mock;
  let nowMs: number;

  beforeEach(() => {
    nowMs = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => nowMs);
    jest.spyOn(console, 'warn').mockImplementation(() => {});

    fetchMock = jest.fn();
    (global as unknown as { fetch: unknown }).fetch = fetchMock;

    VoiPriceService.clearCache();
    // Keep the retry ladder and abort timer short so failure cases don't sleep.
    VoiPriceService.updateConfig({
      retryAttempts: 1,
      retryDelay: 0,
      timeout: 50,
      cacheDuration: 5 * 60 * 1000,
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('issues ONE request for N concurrent callers past the TTL and resolves them all with the same value', async () => {
    let deferred!: Deferred;
    fetchMock.mockImplementation(
      () =>
        new Promise((resolve, reject) => {
          deferred = { resolve, reject };
        })
    );

    // Five accounts refreshing at once on a cold cache.
    const calls = [
      VoiPriceService.getVoiPrice(),
      VoiPriceService.getVoiPrice(),
      VoiPriceService.getVoiPrice(),
      VoiPriceService.getVoiPrice(),
      VoiPriceService.getVoiPrice(),
    ];

    await flush();

    // One network request, not five (and not five × retryAttempts).
    expect(fetchMock).toHaveBeenCalledTimes(1);

    deferred.resolve(okResponse(0.42));
    const prices = await Promise.all(calls);

    expect(prices).toEqual([0.42, 0.42, 0.42, 0.42, 0.42]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('serves later callers from the cache without a second request', async () => {
    fetchMock.mockResolvedValue(okResponse(0.42));

    await expect(VoiPriceService.getVoiPrice()).resolves.toBe(0.42);
    await expect(VoiPriceService.getVoiPrice()).resolves.toBe(0.42);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refetches once the cached price is older than cacheDuration', async () => {
    fetchMock.mockResolvedValue(okResponse(0.42));
    await VoiPriceService.getVoiPrice();

    nowMs += VoiPriceService.getConfig().cacheDuration + 1;
    fetchMock.mockResolvedValue(okResponse(0.99));

    await expect(VoiPriceService.getVoiPrice()).resolves.toBe(0.99);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not wedge the in-flight slot when the fetch fails (finally cleanup)', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));

    // No cached price yet, so the failure falls back to 0 rather than throwing.
    await expect(VoiPriceService.getVoiPrice()).resolves.toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The slot was released, so the next caller starts a fresh request instead
    // of joining a dead promise forever.
    fetchMock.mockResolvedValue(okResponse(0.42));
    await expect(VoiPriceService.getVoiPrice()).resolves.toBe(0.42);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('shares the stale-price fallback with every joined caller when the fetch fails', async () => {
    fetchMock.mockResolvedValue(okResponse(0.42));
    await VoiPriceService.getVoiPrice();

    nowMs += VoiPriceService.getConfig().cacheDuration + 1;
    fetchMock.mockRejectedValue(new Error('network down'));

    const [a, b] = await Promise.all([
      VoiPriceService.getVoiPrice(),
      VoiPriceService.getVoiPrice(),
    ]);

    // Both joiners get the retained stale price, and only one request went out.
    expect(a).toBe(0.42);
    expect(b).toBe(0.42);
    expect(fetchMock).toHaveBeenCalledTimes(2); // 1 initial success + 1 failure
  });

  it('abandons an in-flight request on clearCache so it cannot repopulate the cache', async () => {
    let deferred!: Deferred;
    fetchMock.mockImplementation(
      () =>
        new Promise((resolve, reject) => {
          deferred = { resolve, reject };
        })
    );

    const inFlight = VoiPriceService.getVoiPrice();
    await flush();

    VoiPriceService.clearCache();
    deferred.resolve(okResponse(0.42));

    // The caller that asked for it still gets its price…
    await expect(inFlight).resolves.toBe(0.42);

    // …but the cleared cache stays cleared, and the next caller neither joins
    // the abandoned request nor reads its write-back.
    fetchMock.mockResolvedValue(okResponse(0.99));
    await expect(VoiPriceService.getVoiPrice()).resolves.toBe(0.99);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
