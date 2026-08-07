/**
 * Regression tests for the FAB radial menu's stack-screen params (TASK-313).
 *
 * The bug: Swap was navigated to with `{ accountId: activeAccount.address }`.
 * Both fields are `string`, so the compiler was blind to it, and the failure
 * was silent and downstream — SwapScreen's lookups all miss, the balance never
 * loads, and TokenSelector spins on "Loading tokens..." forever. These tests
 * assert on the ID specifically, with an account whose id and address are
 * clearly distinguishable, so the swap can never come back unnoticed.
 */
import { buildStackScreenParams } from '../fabMenuParams';

const ACCOUNT = {
  id: 'account_1730000000000_abc123',
  address: 'BUD2763FMK6EYVKGHWWUN4QKHPSPCVFUEPPI4PQCPGYVPGQ6GNKBX6IXCQ',
};

describe('buildStackScreenParams', () => {
  it('passes the account ID — not the address — to Swap', () => {
    const params = buildStackScreenParams('Swap', ACCOUNT);

    expect(params).toEqual({ accountId: ACCOUNT.id });
    // Stated separately from the toEqual above: this is the actual regression.
    expect((params as { accountId: string }).accountId).not.toBe(
      ACCOUNT.address
    );
  });

  it('returns empty params for Swap when there is no active account', () => {
    expect(buildStackScreenParams('Swap', null)).toEqual({});
    expect(buildStackScreenParams('Swap', undefined)).toEqual({});
  });

  it.each(['Send', 'Receive', 'ClaimableTokens', 'Messages'])(
    'returns empty params for %s, which reads the active account itself',
    (stackScreen) => {
      expect(buildStackScreenParams(stackScreen, ACCOUNT)).toEqual({});
    }
  );

  it('returns empty params when there is no stack screen', () => {
    expect(buildStackScreenParams(undefined, ACCOUNT)).toEqual({});
  });
});
