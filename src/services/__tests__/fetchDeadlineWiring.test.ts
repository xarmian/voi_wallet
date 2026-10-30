import { VoiPriceService, VoiPriceError } from '@/services/price';
import { MimirApiService, MimirApiError } from '@/services/mimir';
import { NFTService } from '@/services/nft';
import { NFT_ERROR_MESSAGES } from '@/constants/nft';

// TASK-440 #9 wiring: the three audit-named services must reach the body
// deadline through their real entry points, not just via the helper. Each
// fetch returns headers at once and then a body that never arrives; before
// the fix every one of these calls hung forever.

const ADDRESS = 'A'.repeat(58);

const stalledBody = () =>
  Promise.resolve({
    ok: true,
    status: 200,
    statusText: 'OK',
    // Both body readers stall, so the test measures the deadline, not which
    // reader a given implementation happens to call.
    text: () => new Promise<string>(() => {}),
    json: () => new Promise<unknown>(() => {}),
  });

describe('HTTP deadlines cover the response body (TASK-440 #9)', () => {
  const realFetch = global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    fetchMock = jest.fn(stalledBody);
    (global as unknown as { fetch: unknown }).fetch = fetchMock;
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    (global as unknown as { fetch: unknown }).fetch = realFetch;
  });

  // Every retry attempt times out, then backs off; this covers the full ladder
  // (3 x 10 s deadlines + 1 s + 2 s backoff) with room to spare.
  const LADDER_MS = 60_000;

  it('VoiPriceService.getVoiMarketData rejects instead of hanging', async () => {
    const result = VoiPriceService.getInstance().getVoiMarketData();
    const assertion = expect(result).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
    });
    await jest.advanceTimersByTimeAsync(LADDER_MS);
    await assertion;
    await expect(result).rejects.toBeInstanceOf(VoiPriceError);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('MimirApiService.getAccountAssets rejects instead of hanging', async () => {
    const result = MimirApiService.getInstance().getAccountAssets(ADDRESS);
    const assertion = expect(result).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
    });
    await jest.advanceTimersByTimeAsync(LADDER_MS);
    await assertion;
    await expect(result).rejects.toBeInstanceOf(MimirApiError);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('NFTService.fetchUserNFTs rejects with the timeout message instead of hanging', async () => {
    const result = NFTService.fetchUserNFTs(ADDRESS);
    const assertion = expect(result).rejects.toThrow(
      NFT_ERROR_MESSAGES.NETWORK_TIMEOUT
    );
    await jest.advanceTimersByTimeAsync(LADDER_MS);
    await assertion;
  });
});
