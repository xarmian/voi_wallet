/**
 * TASK-392 / GH #20: one approval per (contract, owner -> spender), latest wins.
 */

import { dedupeLatestApprovals } from '../arc200Approvals';

const ev = (
  over: Partial<{
    contractId: number;
    owner: string;
    spender: string;
    round: number;
    timestamp: number;
    amount: string;
    transactionId: string;
  }> = {}
) => ({
  contractId: 1,
  owner: 'OWNER',
  spender: 'SPENDER',
  round: 10,
  timestamp: 100,
  amount: '100',
  transactionId: 'TX',
  ...over,
});

describe('dedupeLatestApprovals', () => {
  it('collapses two identical events (the GH #20 shape) to one', () => {
    const result = dedupeLatestApprovals([
      ev({ transactionId: 'TX1' }),
      ev({ transactionId: 'TX2' }),
    ]);
    expect(result).toHaveLength(1);
  });

  it('keeps the higher round regardless of input order', () => {
    const older = ev({ round: 5, amount: '1', transactionId: 'OLD' });
    const newer = ev({ round: 9, amount: '2', transactionId: 'NEW' });
    expect(dedupeLatestApprovals([older, newer])).toEqual([newer]);
    expect(dedupeLatestApprovals([newer, older])).toEqual([newer]);
  });

  it('same round: the higher timestamp wins', () => {
    const a = ev({ timestamp: 100, transactionId: 'A' });
    const b = ev({ timestamp: 101, transactionId: 'B' });
    expect(dedupeLatestApprovals([a, b])).toEqual([b]);
    expect(dedupeLatestApprovals([b, a])).toEqual([b]);
  });

  it('full tie: the first-listed event wins (Mimir was observed newest-first)', () => {
    const first = ev({ transactionId: 'FIRST', amount: '7' });
    const second = ev({ transactionId: 'SECOND', amount: '8' });
    expect(dedupeLatestApprovals([first, second])).toEqual([first]);
  });

  it('keeps distinct pairs apart: other owner, other contract, other spender', () => {
    const base = ev();
    const otherOwner = ev({ owner: 'OWNER2' });
    const otherContract = ev({ contractId: 2 });
    const otherSpender = ev({ spender: 'SPENDER2' });
    expect(
      dedupeLatestApprovals([base, otherOwner, otherContract, otherSpender])
    ).toEqual([base, otherOwner, otherContract, otherSpender]);
  });

  it('a newer zero approval shadows an older non-zero one (dedupe before the zero filter)', () => {
    const result = dedupeLatestApprovals([
      ev({ round: 20, amount: '0', transactionId: 'REVOKE' }),
      ev({ round: 10, amount: '500', transactionId: 'GRANT' }),
    ]).filter((a) => a.amount !== '0');
    expect(result).toEqual([]);
  });

  it('survivors keep the position of their pair’s first occurrence', () => {
    const c1old = ev({ contractId: 1, round: 1, transactionId: 'c1old' });
    const c2 = ev({ contractId: 2, transactionId: 'c2' });
    const c1new = ev({ contractId: 1, round: 3, transactionId: 'c1new' });
    expect(
      dedupeLatestApprovals([c1old, c2, c1new]).map((a) => a.transactionId)
    ).toEqual(['c1new', 'c2']);
  });
});
