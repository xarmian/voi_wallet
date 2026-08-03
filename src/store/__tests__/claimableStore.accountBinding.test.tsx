/**
 * TASK-188: claimable reads are bound to an account.
 *
 * `ClaimableState` is flat — one `claimableItems` array, not a per-account
 * record — so any consumer that reads it directly can render account A's
 * claimables (or A's count) while account B is active. These hooks make that
 * unrepresentable: a mismatch reads as empty/zero rather than as another
 * account's data.
 */

import { renderHook } from '@testing-library/react-native';

import {
  useClaimableStore,
  useClaimableItemsForAccount,
  useClaimablePartialFailure,
  useVisibleClaimableCountForAccount,
} from '../claimableStore';
import type { ClaimableItem } from '@/types/claimable';

jest.mock('@/services/mimir', () => ({ __esModule: true, default: {} }));
jest.mock('@/services/envoi', () => ({ __esModule: true, default: {} }));
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async () => null),
    setItem: jest.fn(async () => {}),
    removeItem: jest.fn(async () => {}),
  },
}));

const ACCOUNT_A = 'ACCOUNT_A';
const ACCOUNT_B = 'ACCOUNT_B';

const item = (id: string): ClaimableItem => ({
  id,
  contractId: 1,
  tokenName: 'Token',
  tokenSymbol: 'TKN',
  tokenDecimals: 0,
  tokenVerified: false,
  owner: 'OWNER',
  amount: 1n,
  ownerBalance: 10n,
  isClaimable: true,
  approval: {
    owner: 'OWNER',
    round: 1,
    amount: '1',
    spender: 'SPENDER',
    timestamp: 1,
    contractId: 1,
    transactionId: 'TX',
  },
});

beforeEach(() => {
  useClaimableStore.setState({
    claimableItems: [item('1_A'), item('2_A')],
    itemsAccountAddress: ACCOUNT_A,
    hiddenApprovals: new Set<string>(),
    hasPartialFailure: false,
  });
});

describe('account-bound claimable reads (TASK-188)', () => {
  it('returns the items when they belong to the requested account', () => {
    const { result } = renderHook(() => useClaimableItemsForAccount(ACCOUNT_A));
    expect(result.current).toHaveLength(2);
  });

  it('returns nothing for an account the held items do not belong to', () => {
    const { result } = renderHook(() => useClaimableItemsForAccount(ACCOUNT_B));
    expect(result.current).toEqual([]);
  });

  it('returns nothing when there is no active account', () => {
    const { result } = renderHook(() => useClaimableItemsForAccount(undefined));
    expect(result.current).toEqual([]);
  });

  it('counts only the requested account, and excludes hidden items', () => {
    useClaimableStore.setState({ hiddenApprovals: new Set(['2_A']) });

    const { result } = renderHook(() =>
      useVisibleClaimableCountForAccount(ACCOUNT_A)
    );
    expect(result.current).toBe(1);
  });

  it('counts zero for a non-active account rather than the other account total', () => {
    const { result } = renderHook(() =>
      useVisibleClaimableCountForAccount(ACCOUNT_B)
    );
    expect(result.current).toBe(0);
  });

  it('reports the degraded flag only for the account whose fetch was partial', () => {
    useClaimableStore.setState({ hasPartialFailure: true });

    const forA = renderHook(() => useClaimablePartialFailure(ACCOUNT_A));
    expect(forA.result.current).toBe(true);

    const forB = renderHook(() => useClaimablePartialFailure(ACCOUNT_B));
    expect(forB.result.current).toBe(false);

    const forNone = renderHook(() => useClaimablePartialFailure(undefined));
    expect(forNone.result.current).toBe(false);
  });
});
