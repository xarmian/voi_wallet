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
