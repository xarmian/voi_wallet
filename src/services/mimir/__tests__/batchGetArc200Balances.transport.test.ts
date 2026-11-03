// End to end through fetchWithRetry: a batch whose transport gives up (a
// deadline abort here) is classified as a degraded service, so no per-owner
// request follows (TASK-488). The sibling "degraded" test injects the error
// directly; this one proves the real transport failure arrives as such.

jest.mock('@/utils/fetchBuffered', () => ({
  fetchBuffered: jest.fn(),
}));
jest.mock('@/services/network/offline', () => ({
  shouldSkipForOffline: jest.fn(() => false),
}));

import { fetchBuffered } from '@/utils/fetchBuffered';
import { MimirApiService } from '../index';

const service = MimirApiService.getInstance();
const mockFetchBuffered = fetchBuffered as jest.Mock;

describe('batchGetArc200Balances: a real transport failure is treated as a degraded service (TASK-488)', () => {
  const original = service.getConfig();

  beforeEach(() => {
    service.updateConfig({ retryAttempts: 2, retryDelay: 0 });
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    service.updateConfig(original);
    mockFetchBuffered.mockReset();
    jest.restoreAllMocks();
  });

  it('a deadline abort on the batched POST marks the chunk failed with no per-owner request', async () => {
    mockFetchBuffered.mockRejectedValue(
      new Error('Aborted: deadline exceeded')
    );

    const result = await service.batchGetArc200Balances([
      { contractId: 3, owner: 'A' },
      { contractId: 3, owner: 'B' },
    ]);

    // Only the batched POST was attempted (retryAttempts times), never a GET
    // for a single owner.
    expect(mockFetchBuffered).toHaveBeenCalledTimes(2);
    for (const call of mockFetchBuffered.mock.calls) {
      expect(call[1]).toEqual(expect.objectContaining({ method: 'POST' }));
    }
    expect([...result.failed].sort()).toEqual(['3_A', '3_B']);
    expect(result.balances.size).toBe(0);
  });
});
