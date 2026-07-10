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
 * Format an integer base-unit amount to a plain decimal string (no grouping,
 * no symbol) — the inverse of parseAmountToBaseUnits. Exact for bigint values
 * of any magnitude; trailing zeros are trimmed. Suitable for setting an
 * amount TextInput's value.
 */
export const formatBaseUnitsToAmount = (
  base: bigint | number,
  decimals: number
): string => {
  const b = typeof base === 'bigint' ? base : BigInt(Math.trunc(base));
  const neg = b < 0n;
  const digits = (neg ? -b : b).toString().padStart(decimals + 1, '0');
  const cut = digits.length - decimals;
  const intPart = digits.slice(0, cut) || '0';
  let fracPart = decimals > 0 ? digits.slice(cut).replace(/0+$/, '') : '';
  const out = fracPart ? `${intPart}.${fracPart}` : intPart;
  return neg ? `-${out}` : out;
};

/**
 * Sanitize raw amount-input text into a single well-formed decimal string
 * (using '.' as the separator) suitable for a controlled TextInput, for display,
 * and for {@link parseAmountToBaseUnits}.
 *
 * Both ',' and '.' are accepted as the decimal separator and normalized to '.'
 * — a `decimal-pad` keyboard emits ',' in many locales, and `parseFloat('1,5')
 * === 1` would otherwise silently send 1.0 instead of 1.5 (and stripping ','
 * turned '1,5' into '15', a 10x error, in Swap). Accepting either separator is
 * required because this value is stored and re-fed to the field on every
 * keystroke, so we cannot treat '.' (our own normalized separator) as grouping.
 *
 * Returns `null` — signalling the caller to keep the previous value — when the
 * input is ambiguous or malformed:
 * - it contains any character other than digits, ',', '.', or whitespace (e.g.
 *   a pasted '-1', '1e3', or currency symbol), which could otherwise be silently
 *   rewritten into a different valid amount; or
 * - it contains more than one decimal separator (e.g. a pasted grouped number
 *   like '1,234.56'), which is ambiguous.
 *
 * A single lone '.' is allowed as a valid typing intermediate for '.5'; the
 * downstream positive-amount validation rejects a bare '.' as an amount.
 *
 * KNOWN LIMITATION: a paste of a *thousands-grouped* number that uses a single
 * separator (e.g. US '1,234' meaning 1234) is read as a decimal (1.234). This
 * is inherent to supporting ',' as a decimal separator and is visible to the
 * user in the field before they confirm; full locale-aware grouping detection
 * that does not break comma-decimal typing is tracked separately.
 *
 * @returns the sanitized decimal string, or `null` if the input is invalid.
 */
export const sanitizeAmountInput = (text: string): string | null => {
  const raw = text ?? '';
  // Reject anything that isn't a digit, a separator, or whitespace so a
  // malformed paste ('-1', '1e3', '$1', '1,,2') isn't silently transformed.
  if (/[^0-9.,\s]/.test(raw)) {
    return null;
  }
  const normalized = raw.replace(/,/g, '.').replace(/[^0-9.]/g, '');
  const dotCount = (normalized.match(/\./g) || []).length;
  if (dotCount > 1) {
    return null;
  }
  return normalized;
};

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
