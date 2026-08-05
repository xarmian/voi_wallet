// batchGetArc200Balances collapses the per-(contract, owner) fan-out into one
// request per contract via the server's `accountIds` batch parameter (F-20 /
// PLAN-279 Phase E), while preserving two contracts established by TASK-188:
//
//   * A pair whose lookup fails is reported in `failed` and ABSENT from
//     `balances` — never written as '0'. A genuine zero and a failed request
//     must stay distinguishable, or a transient error renders a claimable token
//     as "Insufficient".
//   * A genuine zero balance stays in `balances` and out of `failed`.
//
// The batched request is `fetchArc200BalancesForOwners`. When it throws, the
// method falls back to per-owner `getArc200Balance`, so one failed request
// cannot make a whole contract's balances unknown.

import { MimirApiService } from '../index';

const service = MimirApiService.getInstance();

describe('MimirApiService.batchGetArc200Balances (F-20 fan-out collapse)', () => {
  let fetchForOwners: jest.SpyInstance;
  let getArc200Balance: jest.SpyInstance;

  beforeEach(() => {
    // The batched path. Default: echo a deterministic balance per owner so the
    // happy-path assertions are stable.
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
      .mockImplementation(async (contractId: number, owners: string[]) => {
        const m = new Map<string, string>();
        for (const owner of owners)
          m.set(owner, `${contractId}${owner.length}`);
        return m;
      });
    // The per-owner fallback path.
    getArc200Balance = jest.spyOn(service, 'getArc200Balance');
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns balances keyed `${contractId}_${owner}` from one request per contract', async () => {
    const result = await service.batchGetArc200Balances([
      { contractId: 1, owner: 'AAA' },
      { contractId: 2, owner: 'BBBB' },
    ]);

    expect(result.balances.get('1_AAA')).toBe('13');
    expect(result.balances.get('2_BBBB')).toBe('24');
    expect(result.failed.size).toBe(0);
    // The collapse: one batched request per contract, NOT per pair, and no
    // per-owner fallback on the happy path.
    expect(fetchForOwners).toHaveBeenCalledTimes(2);
    expect(getArc200Balance).not.toHaveBeenCalled();
  });

  it('dedups owners and sends one batched request per contract', async () => {
    await service.batchGetArc200Balances([
      { contractId: 1, owner: 'A' },
      { contractId: 1, owner: 'A' },
      { contractId: 1, owner: 'B' },
      { contractId: 2, owner: 'A' },
    ]);

    expect(fetchForOwners).toHaveBeenCalledTimes(2);
    expect(fetchForOwners).toHaveBeenCalledWith(1, ['A', 'B']);
    expect(fetchForOwners).toHaveBeenCalledWith(2, ['A']);
  });

  it('maps an owner absent from a successful batch response to "0", not failed', async () => {
    fetchForOwners.mockImplementation(async () => {
      // ZERO held nothing, so the server omits it (excludes zero balances).
      const m = new Map<string, string>();
      m.set('HELD', '500');
      return m;
    });

    const result = await service.batchGetArc200Balances([
      { contractId: 7, owner: 'HELD' },
      { contractId: 7, owner: 'ZERO' },
    ]);

    expect(result.balances.get('7_HELD')).toBe('500');
    expect(result.balances.get('7_ZERO')).toBe('0');
    expect(result.failed.size).toBe(0);
  });

  it('falls back to per-owner when the batched request fails, keeping successes', async () => {
    fetchForOwners.mockRejectedValue(new Error('batch endpoint 500'));
    getArc200Balance.mockImplementation(
      async (_contractId: number, owner: string) => {
        if (owner === 'BROKEN') throw new Error('network down');
        return '500';
      }
    );

    const result = await service.batchGetArc200Balances([
      { contractId: 1, owner: 'OK' },
      { contractId: 1, owner: 'BROKEN' },
    ]);

    // Fallback fired for the whole chunk.
    expect(getArc200Balance).toHaveBeenCalledWith(1, 'OK');
    expect(getArc200Balance).toHaveBeenCalledWith(1, 'BROKEN');
    expect(result.balances.get('1_OK')).toBe('500');
    // TASK-188: a failed lookup must not read as "owner holds nothing".
    expect(result.balances.has('1_BROKEN')).toBe(false);
    expect([...result.failed]).toEqual(['1_BROKEN']);
  });

  it('keeps a genuine zero balance in `balances` and out of `failed`', async () => {
    fetchForOwners.mockResolvedValue(new Map([['ZERO', '0']]));

    const result = await service.batchGetArc200Balances([
      { contractId: 7, owner: 'ZERO' },
    ]);

    expect(result.balances.get('7_ZERO')).toBe('0');
    expect(result.failed.size).toBe(0);
  });

  it('chunks a contract with more than MAX_BATCH_ACCOUNTS owners across requests', async () => {
    const owners = Array.from({ length: 150 }, (_, i) => `OWNER${i}`);
    const pairs = owners.map((owner) => ({ contractId: 9, owner }));

    const result = await service.batchGetArc200Balances(pairs);

    // 150 owners -> two batched requests (100 + 50), not 150 per-owner calls.
    expect(fetchForOwners).toHaveBeenCalledTimes(2);
    expect(fetchForOwners.mock.calls[0][1]).toHaveLength(100);
    expect(fetchForOwners.mock.calls[1][1]).toHaveLength(50);
    expect(getArc200Balance).not.toHaveBeenCalled();
    expect(result.balances.size).toBe(150);
    expect(result.failed.size).toBe(0);
  });

  it('returns empty collections for no pairs without issuing a request', async () => {
    const result = await service.batchGetArc200Balances([]);

    expect(result.balances.size).toBe(0);
    expect(result.failed.size).toBe(0);
    expect(fetchForOwners).not.toHaveBeenCalled();
    expect(getArc200Balance).not.toHaveBeenCalled();
  });
});
