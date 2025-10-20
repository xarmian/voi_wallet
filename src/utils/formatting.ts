/**
 * Number and currency formatting utilities with locale support
 */

import { useWalletStore } from '@/store/walletStore';

/**
 * Get the user's locale, falling back to en-US
 * Uses Intl API which works in Expo Go and everywhere else
 */
export const getUserLocale = (): string => {
  try {
    // Use Intl API to detect locale - works in Expo Go
    if (typeof Intl !== 'undefined' && Intl.DateTimeFormat) {
      const locale = Intl.DateTimeFormat().resolvedOptions().locale;
      if (locale) return locale;
    }
  } catch {
    // Fall through to default
  }

  return 'en-US';
};

/**
 * Read the persisted locale override from the wallet store, if present.
 * Returns null when no override is set or on failure.
 */
const getLocaleOverride = (): string | null => {
  try {
    const settings = useWalletStore.getState().wallet?.settings;
    const override = settings?.numberLocale;
    if (!override || override === 'system') {
      return null;
    }
    return override;
  } catch {
    return null;
  }
};

/**
 * Resolve the locale to use, honoring explicit options, stored override,
 * and finally falling back to the device locale.
 */
export const resolveLocale = (requestedLocale?: string): string => {
  if (requestedLocale) {
    return requestedLocale;
  }

  const override = getLocaleOverride();
  if (override) {
    return override;
  }

  return getUserLocale();
};

/**
 * Options for formatting token balances
 */
export interface FormatBalanceOptions {
  /** Override automatic decimal calculation */
  decimals?: number;
  /** Locale to use (defaults to user's locale) */
  locale?: string;
  /** Show trailing zeros (default: false) */
  showTrailingZeros?: boolean;
  /** Minimum decimals to show (default: 2) */
  minDecimals?: number;
  /** Maximum decimals to show (default: 8) */
  maxDecimals?: number;
  /** Use compact notation for large numbers (default: false) */
  compact?: boolean;
}

/**
 * Calculate appropriate number of decimal places based on value magnitude
 *
 * Rules:
 * - Large values (≥ 1): 2-4 decimals
 * - Medium values (0.01 - 1): 4-6 decimals
 * - Small values (< 0.01): up to 8 decimals (preserve significant digits)
 */
export const getSignificantDecimals = (
  value: number,
  maxDecimals: number = 8,
  minDecimals: number = 2
): number => {
  if (value === 0) return minDecimals;

  const absValue = Math.abs(value);

  // Large values: use fewer decimals
  if (absValue >= 1000) {
    return Math.max(minDecimals, 2);
  }

  if (absValue >= 1) {
    return Math.max(minDecimals, 4);
  }

  // Medium values: moderate decimals
  if (absValue >= 0.01) {
    return Math.max(minDecimals, 6);
  }

  // Small values: preserve significant digits
  // Count leading zeros after decimal point
  const leadingZeros = Math.floor(-Math.log10(absValue));
  const significantDecimals = leadingZeros + 4; // Show 4 significant digits after leading zeros

  return Math.min(maxDecimals, Math.max(minDecimals, significantDecimals));
};

/**
 * Remove trailing zeros from a formatted number string
 */
const removeTrailingZeros = (
  formatted: string,
  decimalSeparator: string
): string => {
  if (!formatted.includes(decimalSeparator)) return formatted;

  // Split into parts before and after decimal separator
  const parts = formatted.split(decimalSeparator);
  if (parts.length !== 2) return formatted;

  const [integerPart, decimalPart] = parts;

  // Remove trailing zeros from decimal part
  const trimmedDecimal = decimalPart.replace(/0+$/, '');

  // If no decimals remain, return just the integer part
  if (trimmedDecimal === '') return integerPart;

  return `${integerPart}${decimalSeparator}${trimmedDecimal}`;
};

/**
 * Determine the decimal separator for the provided locale.
 * Falls back to '.' if detection fails.
 */
const getDecimalSeparator = (locale: string): string => {
  try {
    const parts = new Intl.NumberFormat(locale, {
      useGrouping: false,
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    }).formatToParts(1.1);

    const decimalPart = parts.find((part) => part.type === 'decimal');
    return decimalPart?.value ?? '.';
  } catch {
    return '.';
  }
};

/**
 * Format a number with locale-aware formatting and intelligent truncation
 */
export const formatNumber = (
  value: number,
  options: FormatBalanceOptions = {}
): string => {
  const {
    decimals,
    locale,
    showTrailingZeros = false,
    minDecimals = 2,
    maxDecimals = 8,
    compact = false,
  } = options;

  const resolvedLocale = resolveLocale(locale);

  // Determine decimal places
  const decimalPlaces = decimals !== undefined
    ? decimals
    : getSignificantDecimals(value, maxDecimals, minDecimals);

  try {
    const formatter = new Intl.NumberFormat(resolvedLocale, {
      minimumFractionDigits: showTrailingZeros ? decimalPlaces : 0,
      maximumFractionDigits: decimalPlaces,
      notation: compact ? 'compact' : 'standard',
    });

    const decimalSeparator = getDecimalSeparator(resolvedLocale);
    let formatted = formatter.format(value);

    // Remove trailing zeros if requested
    if (!showTrailingZeros) {
      formatted = removeTrailingZeros(formatted, decimalSeparator);

      // Ensure minimum decimals
      if (formatted.includes(decimalSeparator)) {
        const [intPart, decPart] = formatted.split(decimalSeparator);
        if (decPart.length < minDecimals) {
          formatted = `${intPart}${decimalSeparator}${decPart.padEnd(minDecimals, '0')}`;
        }
      } else if (minDecimals > 0 && value !== Math.floor(value)) {
        // Add decimal separator and min decimals if value has fractional part
        formatted = `${formatted}${decimalSeparator}${'0'.repeat(minDecimals)}`;
      }
    }

    return formatted;
  } catch (error) {
    // Fallback to basic formatting
    return value.toFixed(decimalPlaces);
  }
};

/**
 * Format a token balance with intelligent truncation and locale support
 * Converts from base units to display units
 */
export const formatTokenBalance = (
  amount: number | bigint,
  decimals: number,
  options: FormatBalanceOptions = {}
): string => {
  // Convert bigint to number
  const numAmount = typeof amount === 'bigint' ? Number(amount) : amount;

  // Convert from base units to display units
  const displayValue = numAmount / Math.pow(10, decimals);

  return formatNumber(displayValue, options);
};

/**
 * Format USD currency value with locale-aware formatting
 */
export const formatCurrency = (
  value: number,
  options: {
    locale?: string;
    currency?: string;
    showCurrencySymbol?: boolean;
    compact?: boolean;
  } = {}
): string => {
  const {
    locale,
    currency = 'USD',
    showCurrencySymbol = true,
    compact = false,
  } = options;

  const resolvedLocale = resolveLocale(locale);

  // Handle very small values
  try {
    const formatter = new Intl.NumberFormat(resolvedLocale, {
      style: showCurrencySymbol ? 'currency' : 'decimal',
      currency: currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
      notation: compact ? 'compact' : 'standard',
    });

    if (value > 0 && value < 0.01) {
      return `<${formatter.format(0.01)}`;
    }

    if (value === 0) {
      return formatter.format(0);
    }

    return formatter.format(value);
  } catch (error) {
    // Fallback formatting
    const formatted = value.toFixed(2);
    return showCurrencySymbol ? `$${formatted}` : formatted;
  }
};

/**
 * Format a balance for display in the HomeScreen asset list
 * Uses more aggressive truncation to keep UI clean
 */
export const formatAssetListBalance = (
  amount: number | bigint,
  decimals: number,
  options: Omit<FormatBalanceOptions, 'maxDecimals'> = {}
): string => {
  return formatTokenBalance(amount, decimals, {
    ...options,
    maxDecimals: 6, // More aggressive truncation for list view
    minDecimals: 2,
  });
};

/**
 * Format a balance for detail screens where more precision is useful
 */
export const formatAssetDetailBalance = (
  amount: number | bigint,
  decimals: number,
  options: Omit<FormatBalanceOptions, 'maxDecimals'> = {}
): string => {
  return formatTokenBalance(amount, decimals, {
    ...options,
    maxDecimals: 8, // More precision for detail view
    minDecimals: 2,
  });
};
