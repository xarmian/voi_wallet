// Money-display formatting. Assertions are SPECIFICATION-based: every expected
// value is hand-computed from the documented behavior of each function (decimal
// rules, locale separators, rounding, min/max-decimals), not read back from the
// implementation — so a regression fails the test instead of being codified.
//
// formatting.ts imports @/store/walletStore only to read an optional locale
// override. Mock it so the import resolves without the real zustand store, and
// keep a mutable state object we can point at a fixed locale for determinism.
let mockStoreState: unknown = {};
jest.mock('@/store/walletStore', () => ({
  useWalletStore: Object.assign(() => ({}), {
    getState: () => mockStoreState,
  }),
}));

import {
  getSignificantDecimals,
  formatNumber,
  formatTokenBalance,
  formatCurrency,
  formatAssetListBalance,
  formatAssetDetailBalance,
  resolveLocale,
  getUserLocale,
} from '../formatting';

// Every non-locale-specific test pins locale: 'en-US' so grouping/decimal
// separators are deterministic regardless of the runner's system locale.
const EN = { locale: 'en-US' } as const;

afterEach(() => {
  // Reset the store back to the neutral {} default the task specifies.
  mockStoreState = {};
});

describe('getSignificantDecimals (magnitude -> decimal-place count)', () => {
  it('returns minDecimals for exactly zero', () => {
    expect(getSignificantDecimals(0)).toBe(2); // default minDecimals
    expect(getSignificantDecimals(0, 8, 4)).toBe(4);
  });

  it('large values (>= 1000) collapse to 2 decimals', () => {
    expect(getSignificantDecimals(5000)).toBe(2);
    expect(getSignificantDecimals(1000)).toBe(2);
    expect(getSignificantDecimals(1_234_567.89)).toBe(2);
    // magnitude is taken on the absolute value
    expect(getSignificantDecimals(-1500)).toBe(2);
  });

  it('values in [1, 1000) use 4 decimals', () => {
    expect(getSignificantDecimals(1)).toBe(4);
    expect(getSignificantDecimals(5)).toBe(4);
    expect(getSignificantDecimals(999.99)).toBe(4);
  });

  it('medium values in [0.01, 1) use 6 decimals', () => {
    expect(getSignificantDecimals(0.5)).toBe(6);
    expect(getSignificantDecimals(0.01)).toBe(6);
  });

  it('small values (< 0.01) preserve significant digits: floor(-log10)+4, capped by maxDecimals', () => {
    // 0.001 -> leadingZeros = floor(-log10(0.001)) = 3, +4 = 7
    expect(getSignificantDecimals(0.001)).toBe(7);
    // 0.0001 -> 4 + 4 = 8
    expect(getSignificantDecimals(0.0001)).toBe(8);
    // 0.00001 -> floor is 5, 5 + 4 = 9, clamped to maxDecimals (8)
    expect(getSignificantDecimals(0.00001)).toBe(8);
    // magnitude uses abs value
    expect(getSignificantDecimals(-0.001)).toBe(7);
  });

  it('honors minDecimals as a floor', () => {
    // large branch would give 2, but minDecimals 5 raises it
    expect(getSignificantDecimals(5000, 8, 5)).toBe(5);
    // [1,1000) branch gives 4, minDecimals 6 raises it
    expect(getSignificantDecimals(5, 8, 6)).toBe(6);
  });

  it('honors maxDecimals in the small-value (<0.01) branch', () => {
    // Without the clamp this would be leadingZeros(5)+4 = 9.
    expect(getSignificantDecimals(0.0000012345, 6, 2)).toBe(6);
  });

  // KNOWN BUG (tracked): maxDecimals is documented "Maximum decimals to show",
  // but the fixed magnitude bands (>=1000 -> 2, [1,1000) -> 4, [0.01,1) -> 6)
  // never clamp to it — only the small-value branch does. So a maxDecimals below
  // a band default is ignored. Not triggered in-app today (callers pass
  // maxDecimals >= the band defaults). it.failing asserts the correct clamp.
  it.failing('clamps the fixed magnitude bands to maxDecimals', () => {
    expect(getSignificantDecimals(0.123456789, 4, 2)).toBe(4); // min(4, band 6)
    expect(getSignificantDecimals(5, 3, 2)).toBe(3); // min(3, band 4)
  });
});

describe('formatNumber (locale-aware, intelligent truncation)', () => {
  it('applies magnitude-based decimals and pads up to minDecimals', () => {
    // >=1000 => 2 decimals; "1,234.5" then padded to min 2 => "1,234.50"
    expect(formatNumber(1234.5, EN)).toBe('1,234.50');
    // rounds to the 2 allowed decimals
    expect(formatNumber(1234.567, EN)).toBe('1,234.57');
    // [1,1000) => 4 decimals; "5.5" padded to 2 => "5.50"
    expect(formatNumber(5.5, EN)).toBe('5.50');
  });

  it('leaves whole numbers without a decimal part', () => {
    expect(formatNumber(5, EN)).toBe('5');
    expect(formatNumber(0, EN)).toBe('0');
    expect(formatNumber(-5, EN)).toBe('-5');
  });

  it('truncates fractional digits to the significant count', () => {
    // medium value => 6 decimals, rounds 0.123456789 -> 0.123457
    expect(formatNumber(0.123456789, EN)).toBe('0.123457');
    // small value keeps significant digits (8 decimals here)
    expect(formatNumber(0.00001234, EN)).toBe('0.00001234');
  });

  it('formats negatives with grouping and min-decimal padding', () => {
    expect(formatNumber(-1234.5, EN)).toBe('-1,234.50');
  });

  it('honors an explicit locale separator (de-DE)', () => {
    // German: "." grouping, "," decimal
    expect(formatNumber(1234.5, { locale: 'de-DE' })).toBe('1.234,50');
  });

  it('reads a stored locale override when no explicit locale is passed', () => {
    mockStoreState = { wallet: { settings: { numberLocale: 'de-DE' } } };
    expect(formatNumber(1234.5)).toBe('1.234,50');
  });

  it('showTrailingZeros keeps the full computed decimal count', () => {
    // 5 -> 4 decimals, all zeros retained
    expect(formatNumber(5, { ...EN, showTrailingZeros: true })).toBe('5.0000');
    // 1234.5 -> 2 decimals retained
    expect(formatNumber(1234.5, { ...EN, showTrailingZeros: true })).toBe(
      '1,234.50'
    );
  });

  it('respects an explicit decimals override', () => {
    expect(formatNumber(1.23456, { ...EN, decimals: 3 })).toBe('1.235');
    // decimals:0 rounds to integer, but minDecimals(2) still forces ".00"
    // on a fractional input (min-decimals rule wins over the override).
    expect(formatNumber(1.2, { ...EN, decimals: 0 })).toBe('1.00');
    // dropping minDecimals to 0 yields a clean integer
    expect(formatNumber(1.2, { ...EN, decimals: 0, minDecimals: 0 })).toBe('1');
  });

  it('supports compact notation', () => {
    expect(formatNumber(1_000_000, { ...EN, compact: true })).toBe('1M');
    expect(formatNumber(1_500_000, { ...EN, compact: true })).toBe('1.5M');
  });

  it('falls back to Number.toFixed(computedDecimals) when the locale is invalid', () => {
    // Intl.NumberFormat throws RangeError on a malformed locale -> catch path.
    // 1.5 is in [1,1000) => 4 decimals => toFixed(4).
    expect(formatNumber(1.5, { locale: 'bad!!locale' })).toBe('1.5000');
  });

  it('degrades predictably on non-finite input', () => {
    // getSignificantDecimals(NaN) -> NaN, Intl throws, toFixed coerces -> "NaN"
    expect(formatNumber(NaN, EN)).toBe('NaN');
    // Infinity hits the >=1000 branch (2 decimals); Intl renders the glyph
    expect(formatNumber(Infinity, EN)).toBe('∞');
  });

  // KNOWN BUG (same maxDecimals gap, tracked): downstream, formatNumber does not
  // cap a medium value to maxDecimals=4. Correct output is "0.1235".
  it.failing(
    'caps formatNumber output to maxDecimals for medium magnitudes',
    () => {
      expect(formatNumber(0.123456789, { ...EN, maxDecimals: 4 })).toBe(
        '0.1235'
      );
    }
  );
});

describe('formatTokenBalance (base units -> display units)', () => {
  it('converts by 10^decimals and formats the result', () => {
    // 1500000 / 1e6 = 1.5 -> "1.50"
    expect(formatTokenBalance(1_500_000, 6, EN)).toBe('1.50');
    // 1234567890 / 1e6 = 1234.56789 -> 2 decimals -> "1,234.57"
    expect(formatTokenBalance(1_234_567_890, 6, EN)).toBe('1,234.57');
  });

  it('accepts bigint amounts', () => {
    // 1000000n / 1e6 = 1 -> whole -> "1"
    expect(formatTokenBalance(1_000_000n, 6, EN)).toBe('1');
  });

  it('preserves precision for sub-unit balances', () => {
    // 123456 / 1e6 = 0.123456 -> medium value, exact to 6 decimals
    expect(formatTokenBalance(123_456, 6, EN)).toBe('0.123456');
    // 1 / 1e6 = 0.000001 -> small value, 8-decimal cap keeps it
    expect(formatTokenBalance(1, 6, EN)).toBe('0.000001');
  });

  it('handles 0-decimal assets and zero balances', () => {
    expect(formatTokenBalance(5, 0, EN)).toBe('5');
    expect(formatTokenBalance(0, 6, EN)).toBe('0');
  });

  it('converts large bigints via Number (display precision, not exact)', () => {
    // 123456789012345678n / 1e18 -> ~0.12345678901234568 (Number-domain).
    // formatTokenBalance is a *display* helper that downcasts to Number, so a
    // medium value renders to 6 decimals: "0.123457".
    expect(formatTokenBalance(123_456_789_012_345_678n, 18, EN)).toBe(
      '0.123457'
    );
  });
});

describe('formatAssetListBalance / formatAssetDetailBalance (maxDecimals presets)', () => {
  it('list view caps precision more aggressively than detail view', () => {
    // 123 / 1e8 = 0.00000123 (a small value; rule wants 9 decimals).
    // List preset maxDecimals=6 -> "0.000001"; detail preset maxDecimals=8 ->
    // "0.00000123". This is where the small-value clamp *does* apply.
    expect(formatAssetListBalance(123, 8, EN)).toBe('0.000001');
    expect(formatAssetDetailBalance(123, 8, EN)).toBe('0.00000123');
  });

  it('both share the standard formatting for ordinary balances', () => {
    expect(formatAssetListBalance(1_500_000, 6, EN)).toBe('1.50');
    expect(formatAssetDetailBalance(1_500_000, 6, EN)).toBe('1.50');
  });
});

describe('formatCurrency (USD-style money display)', () => {
  it('formats standard USD amounts with symbol and 2 decimals', () => {
    expect(formatCurrency(1234.5, EN)).toBe('$1,234.50');
    // rounds to cents
    expect(formatCurrency(1234.567, EN)).toBe('$1,234.57');
    expect(formatCurrency(0, EN)).toBe('$0.00');
  });

  it('collapses tiny positive amounts to a "< $0.01" sentinel', () => {
    expect(formatCurrency(0.005, EN)).toBe('<$0.01');
    expect(formatCurrency(0.001, EN)).toBe('<$0.01');
    // exactly 0.01 is not "less than", so it renders normally
    expect(formatCurrency(0.01, EN)).toBe('$0.01');
  });

  it('formats negative amounts', () => {
    expect(formatCurrency(-5, EN)).toBe('-$5.00');
  });

  it('omits the currency symbol when requested (decimal style)', () => {
    expect(formatCurrency(1234.5, { ...EN, showCurrencySymbol: false })).toBe(
      '1,234.50'
    );
    // the tiny-value sentinel still prefixes "<" but no symbol
    expect(formatCurrency(0.005, { ...EN, showCurrencySymbol: false })).toBe(
      '<0.01'
    );
  });

  it('supports alternate currencies and locales', () => {
    expect(formatCurrency(1234.5, { ...EN, currency: 'EUR' })).toBe(
      '€1,234.50'
    );
    // de-DE places the USD symbol after the amount with a comma decimal
    expect(formatCurrency(5, { locale: 'de-DE' })).toBe('5,00 $');
  });

  it('supports compact notation', () => {
    // compact currency keeps 2 fraction digits: "$1.00M"
    expect(formatCurrency(1_000_000, { ...EN, compact: true })).toBe('$1.00M');
  });

  it('falls back to a plain $x.xx string on an invalid locale', () => {
    // Intl throws -> catch -> value.toFixed(2) with a "$" prefix.
    expect(formatCurrency(1.5, { locale: 'bad!!locale' })).toBe('$1.50');
    expect(
      formatCurrency(1.5, { locale: 'bad!!locale', showCurrencySymbol: false })
    ).toBe('1.50');
  });
});

describe('resolveLocale / getUserLocale (locale resolution precedence)', () => {
  it('prefers an explicitly requested locale over everything', () => {
    mockStoreState = { wallet: { settings: { numberLocale: 'de-DE' } } };
    expect(resolveLocale('en-GB')).toBe('en-GB');
  });

  it('uses the stored override when no locale is requested', () => {
    mockStoreState = { wallet: { settings: { numberLocale: 'fr-FR' } } };
    expect(resolveLocale()).toBe('fr-FR');
  });

  it('treats the "system" sentinel as "no override" and falls back to device locale', () => {
    mockStoreState = { wallet: { settings: { numberLocale: 'system' } } };
    expect(resolveLocale()).toBe(getUserLocale());
  });

  it('falls back to the device locale when no override is present', () => {
    mockStoreState = {};
    expect(resolveLocale()).toBe(getUserLocale());
  });

  it('swallows store-access failures and falls back to the device locale', () => {
    // getState().wallet on null throws -> getLocaleOverride catches -> null.
    mockStoreState = null;
    expect(resolveLocale()).toBe(getUserLocale());
  });

  it('getUserLocale returns a non-empty BCP-47-ish string', () => {
    const loc = getUserLocale();
    expect(typeof loc).toBe('string');
    expect(loc.length).toBeGreaterThan(0);
  });
});
