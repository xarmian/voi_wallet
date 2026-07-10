/**
 * Utility functions for handling BigInt values from algosdk v3.4.0+
 */

import { formatTokenBalance, FormatBalanceOptions } from './formatting';

/**
 * Safely convert BigInt or number to number for calculations
 */
export const toBigIntSafeNumber = (value: number | bigint): number => {
  return typeof value === 'bigint' ? Number(value) : value;
};

/**
 * Format balance amount (microVOI to VOI) with proper BigInt handling
 * @deprecated Use formatNativeBalance for network-aware formatting
 */
export const formatVoiBalance = (amount: number | bigint): string => {
  const numAmount = toBigIntSafeNumber(amount);
  return (numAmount / 1000000).toFixed(6);
};

/**
 * Format native balance amount with network-aware currency symbol
 * Now uses intelligent truncation and locale-aware formatting
 */
export const formatNativeBalance = (
  amount: number | bigint,
  currency: string = 'VOI',
  options?: FormatBalanceOptions
): string => {
  return formatTokenBalance(amount, 6, options); // Native tokens have 6 decimals
};

/**
 * Get currency symbol for balance display based on network
 * @deprecated Use network store currentNetworkConfig.nativeToken directly
 */
export const getCurrencySymbol = (currency?: string): string => {
  return currency || 'VOI';
};

/**
 * Format asset balance with proper BigInt handling and decimals
 * Now uses intelligent truncation and locale-aware formatting
 */
export const formatAssetBalance = (
  amount: number | bigint,
  decimals: number,
  options?: FormatBalanceOptions
): string => {
  return formatTokenBalance(amount, decimals, options);
};

/**
 * Compare BigInt or number values safely
 */
export const compareBigIntSafe = (
  a: number | bigint,
  b: number | bigint
): number => {
  const numA = toBigIntSafeNumber(a);
  const numB = toBigIntSafeNumber(b);
  return numA - numB;
};

/**
 * TRUE bigint comparison of two money values without any Number downcast.
 *
 * Unlike {@link compareBigIntSafe} (which downcasts bigint -> Number and can
 * lose precision above Number.MAX_SAFE_INTEGER), this coerces `number` inputs
 * to bigint via BigInt(Math.trunc(x)) and compares bigints directly. Use this
 * on money-critical paths (balances / amounts for high-decimal ARC-200 tokens).
 *
 * @returns -1 if a < b, 0 if equal, 1 if a > b
 */
export const compareBigInt = (
  a: number | bigint,
  b: number | bigint
): number => {
  const bigA = typeof a === 'bigint' ? a : BigInt(Math.trunc(a));
  const bigB = typeof b === 'bigint' ? b : BigInt(Math.trunc(b));
  if (bigA < bigB) return -1;
  if (bigA > bigB) return 1;
  return 0;
};

/**
 * Parse a user-entered decimal amount STRING into integer base units without
 * any floating-point math.
 *
 * This replaces the lossy `Math.floor(parseFloat(amount) * 10 ** decimals)`
 * pattern, which both loses precision (e.g. parseFloat('1.005') * 1e6 =>
 * 1004999.9999… => 1004999) and overflows Number.MAX_SAFE_INTEGER for
 * high-decimal ARC-200 tokens. String parsing yields the EXACT typed value:
 * parseAmountToBaseUnits('1.005', 6) === 1005000n.
 *
 * Semantics:
 * - Fractional digits beyond `decimals` are REJECTED (throws) rather than
 *   truncated, so the signed amount always equals what the user was shown.
 *   Trailing zeros beyond `decimals` are harmless and allowed.
 * - `decimals === 0` allows no fractional part (a non-zero one throws).
 * - Empty input, '' , '.' and '0' all resolve to 0n.
 *
 * The caller is responsible for normalizing the decimal separator to '.'
 * (locale handling is a separate concern and intentionally NOT done here).
 *
 * @throws {Error} 'Invalid amount' on malformed numeric input (e.g. '1.2.3',
 * 'abc', or a negative value like '-5'), or 'Amount has more decimal places
 * than the asset supports' when the fractional precision exceeds `decimals`,
 * so callers can surface a validation error instead of signing a wrong amount.
 */
export const parseAmountToBaseUnits = (
  amount: string,
  decimals: number
): bigint => {
  const trimmed = (amount ?? '').trim();

  // Empty / bare decimal point represent "no amount".
  if (trimmed === '' || trimmed === '.') {
    return 0n;
  }

  // Only digits with at most a single decimal point are allowed. This rejects
  // negatives ('-5'), multiple dots ('1.2.3'), exponents ('1e6'), thousands
  // separators, and any other non-numeric input.
  if (!/^\d*\.?\d*$/.test(trimmed)) {
    throw new Error('Invalid amount');
  }

  const [intPartRaw, fracPartRaw = ''] = trimmed.split('.');
  const intPart = intPartRaw;

  // Reject amounts with more *significant* fractional digits than the asset
  // supports, so the signed amount always equals the amount shown to the user
  // (silently truncating here would sign a different value than displayed —
  // e.g. '1.9' of a 0-decimal asset would send 1). Trailing zeros beyond the
  // asset's precision are harmless and allowed.
  const excessFraction = fracPartRaw.slice(decimals);
  if (excessFraction.length > 0 && /[^0]/.test(excessFraction)) {
    throw new Error('Amount has more decimal places than the asset supports');
  }

  let fracPart = '';
  if (decimals > 0) {
    fracPart = fracPartRaw.slice(0, decimals).padEnd(decimals, '0');
  }

  const combined = `${intPart}${fracPart}`;
  if (combined === '') {
    return 0n;
  }

  // BigInt() tolerates leading zeros ('007' => 7n).
  return BigInt(combined);
};

/**
 * Alias for {@link parseAmountToBaseUnits}.
 */
export const toBaseUnitsBigInt = parseAmountToBaseUnits;

/**
 * Add BigInt or number values safely
 */
export const addBigIntSafe = (
  a: number | bigint,
  b: number | bigint
): number => {
  const numA = toBigIntSafeNumber(a);
  const numB = toBigIntSafeNumber(b);
  return numA + numB;
};

/**
 * Subtract BigInt or number values safely
 */
export const subtractBigIntSafe = (
  a: number | bigint,
  b: number | bigint
): number => {
  const numA = toBigIntSafeNumber(a);
  const numB = toBigIntSafeNumber(b);
  return numA - numB;
};
