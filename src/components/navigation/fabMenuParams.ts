/**
 * Route params for the FAB radial menu's nested stack destinations.
 *
 * Extracted from FABRadialMenu so it can be unit-tested without rendering the
 * component — a render test would need jest mocks for both react-native-
 * reanimated and react-native-gesture-handler, which the suite does not have.
 * The bug this guards (TASK-313) lived entirely in this expression, so a pure
 * helper covers it exactly.
 */

/** The minimum shape of an account this module needs. */
export interface FabMenuAccount {
  /** Account ID (`account_<ts>_<rand>`) — NOT the address. */
  id: string;
  address: string;
}

/** Params handed to a nested stack screen. Empty for screens that take none. */
export type FabStackScreenParams =
  | { accountId: string }
  | Record<string, never>;

/**
 * Build the params for a nested stack destination.
 *
 * SwapScreen requires an `accountId`, and it must be the account ID, NOT the
 * address. Everything downstream keys on the ID —
 * `wallet.accounts.find(acc => acc.id === accountId)`,
 * `accountStates[accountId]`, `loadAccountBalance(accountId)` — so an address
 * silently misses every lookup: the balance never loads, and TokenSelector
 * (which gates its entire token load on that balance) spins on "Loading
 * tokens..." forever with the From token unset. Both fields are `string`, so
 * the type system cannot catch the swap; this helper plus its tests can.
 *
 * Every other destination navigates with no params and reads the active
 * account from the store itself.
 */
export function buildStackScreenParams(
  stackScreen: string | undefined,
  activeAccount: FabMenuAccount | null | undefined
): FabStackScreenParams {
  if (stackScreen === 'Swap' && activeAccount) {
    return { accountId: activeAccount.id };
  }
  return {};
}
