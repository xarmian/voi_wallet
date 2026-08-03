// TASK-188: batchGetArc200Balances must make per-owner failures observable.
//
// It used to write the string '0' for a pair whose lookup threw, with the
// comment "Set to '0' on error to mark as not claimable". That is a lie the
// caller cannot detect: a genuine zero balance and a failed request produced
// identical output, so a transient network error rendered a claimable token as
// "Insufficient". The contract is now {balances, failed}, with failed pairs
// ABSENT from balances rather than present as '0'.

import { MimirApiService } from '../index';

const service = MimirApiService.getInstance();

describe('MimirApiService.batchGetArc200Balances (TASK-188)', () => {
  let getArc200Balance: jest.SpyInstance;

  beforeEach(() => {
    getArc200Balance = jest.spyOn(service, 'getArc200Balance');
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns successful balances keyed `${contractId}_${owner}`', async () => {
    getArc200Balance.mockImplementation(
      async (contractId: number, owner: string) =>
        `${contractId}${owner.length}`
    );

    const result = await service.batchGetArc200Balances([
      { contractId: 1, owner: 'AAA' },
      { contractId: 2, owner: 'BBBB' },
    ]);

    expect(result.balances.get('1_AAA')).toBe('13');
    expect(result.balances.get('2_BBBB')).toBe('24');
    expect(result.failed.size).toBe(0);
  });

  it('reports a failed pair in `failed` and omits it from `balances` — never as "0"', async () => {
    getArc200Balance.mockImplementation(
      async (contractId: number, owner: string) => {
        if (owner === 'BROKEN') throw new Error('network down');
        return '500';
      }
    );

    const result = await service.batchGetArc200Balances([
      { contractId: 1, owner: 'OK' },
      { contractId: 1, owner: 'BROKEN' },
    ]);

    expect(result.balances.get('1_OK')).toBe('500');
    // The regression this task exists to prevent: a failed lookup must not be
    // indistinguishable from "owner holds nothing".
    expect(result.balances.has('1_BROKEN')).toBe(false);
    expect(result.balances.get('1_BROKEN')).toBeUndefined();
    expect([...result.failed]).toEqual(['1_BROKEN']);
  });

  it('keeps a genuine zero balance in `balances` and out of `failed`', async () => {
    getArc200Balance.mockResolvedValue('0');

    const result = await service.batchGetArc200Balances([
      { contractId: 7, owner: 'ZERO' },
    ]);

    expect(result.balances.get('7_ZERO')).toBe('0');
    expect(result.failed.size).toBe(0);
  });

  it('preserves the existing request shape: dedups pairs, one request per (contract, owner)', async () => {
    getArc200Balance.mockResolvedValue('1');

    await service.batchGetArc200Balances([
      { contractId: 1, owner: 'A' },
      { contractId: 1, owner: 'A' },
      { contractId: 1, owner: 'B' },
      { contractId: 2, owner: 'A' },
    ]);

    // Unchanged from before this task: duplicates collapse, but the fan-out is
    // still one request per unique pair (collapsing it is a different task).
    expect(getArc200Balance).toHaveBeenCalledTimes(3);
    expect(getArc200Balance).toHaveBeenCalledWith(1, 'A');
    expect(getArc200Balance).toHaveBeenCalledWith(1, 'B');
    expect(getArc200Balance).toHaveBeenCalledWith(2, 'A');
  });

  it('returns empty collections for no pairs without issuing a request', async () => {
    getArc200Balance.mockResolvedValue('1');

    const result = await service.batchGetArc200Balances([]);

    expect(result.balances.size).toBe(0);
    expect(result.failed.size).toBe(0);
    expect(getArc200Balance).not.toHaveBeenCalled();
  });
});
