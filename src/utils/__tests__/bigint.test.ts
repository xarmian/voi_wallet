// The money-math core. Assertions are spec-based (hand-computed from the
// documented behavior), so a regression that changes a signed/parsed amount
// fails the test rather than being silently codified.

// bigint.ts -> formatting.ts -> @/store/walletStore. The pure money-math
// functions under test don't touch the store; mock it so the import resolves
// without pulling in the real zustand store / services.
jest.mock('@/store/walletStore', () => ({
  useWalletStore: Object.assign(() => ({}), { getState: () => ({}) }),
}));

import {
  parseAmountToBaseUnits,
  formatBaseUnitsToAmount,
  sanitizeAmountInput,
  compareBigInt,
  compareBigIntSafe,
  addBigIntSafe,
  subtractBigIntSafe,
  toBigIntSafeNumber,
} from '../bigint';

describe('parseAmountToBaseUnits (user amount string -> integer base units)', () => {
  it('parses whole and fractional amounts exactly', () => {
    expect(parseAmountToBaseUnits('1', 6)).toBe(1000000n);
    expect(parseAmountToBaseUnits('1.5', 6)).toBe(1500000n);
    // the documented example — the float pattern would lose precision here
    expect(parseAmountToBaseUnits('1.005', 6)).toBe(1005000n);
    expect(parseAmountToBaseUnits('0.000001', 6)).toBe(1n);
  });

  it('treats empty / bare dot / zero as 0n', () => {
    expect(parseAmountToBaseUnits('', 6)).toBe(0n);
    expect(parseAmountToBaseUnits('.', 6)).toBe(0n);
    expect(parseAmountToBaseUnits('0', 6)).toBe(0n);
    expect(parseAmountToBaseUnits('   ', 6)).toBe(0n);
  });

  it('allows trailing zeros beyond precision but rejects significant excess', () => {
    expect(parseAmountToBaseUnits('1.0000000', 6)).toBe(1000000n); // trailing zeros ok
    expect(() => parseAmountToBaseUnits('1.0000001', 6)).toThrow(
      /more decimal places/
    );
  });

  it('handles 0-decimal assets (reject any significant fraction)', () => {
    expect(parseAmountToBaseUnits('5', 0)).toBe(5n);
    expect(parseAmountToBaseUnits('5.0', 0)).toBe(5n);
    expect(() => parseAmountToBaseUnits('5.1', 0)).toThrow(
      /more decimal places/
    );
  });

  it('is exact for high-decimal ARC-200 amounts (no Number overflow)', () => {
    expect(parseAmountToBaseUnits('1.123456789012345678', 18)).toBe(
      1123456789012345678n
    );
  });

  it('tolerates leading zeros', () => {
    expect(parseAmountToBaseUnits('007', 6)).toBe(7000000n);
  });

  it('throws on malformed / negative / exponent / multi-dot input', () => {
    for (const bad of ['-5', '1.2.3', 'abc', '1e6', '1,000']) {
      expect(() => parseAmountToBaseUnits(bad, 6)).toThrow('Invalid amount');
    }
  });
});

describe('formatBaseUnitsToAmount (inverse of parseAmountToBaseUnits)', () => {
  it('formats and trims trailing zeros', () => {
    expect(formatBaseUnitsToAmount(1000000n, 6)).toBe('1');
    expect(formatBaseUnitsToAmount(1500000n, 6)).toBe('1.5');
    expect(formatBaseUnitsToAmount(1005000n, 6)).toBe('1.005');
    expect(formatBaseUnitsToAmount(1n, 6)).toBe('0.000001');
    expect(formatBaseUnitsToAmount(0n, 6)).toBe('0');
  });

  it('handles 0-decimals and negatives', () => {
    expect(formatBaseUnitsToAmount(5n, 0)).toBe('5');
    expect(formatBaseUnitsToAmount(-1500000n, 6)).toBe('-1.5');
  });

  it('round-trips with parseAmountToBaseUnits', () => {
    // All inputs are in canonical form (no trailing zeros), so the round-trip
    // returns the exact same string.
    for (const [amt, dec] of [
      ['1.005', 6],
      ['0.000001', 6],
      ['1234.56', 8],
      ['1.123456789012345678', 18],
    ] as const) {
      expect(
        formatBaseUnitsToAmount(parseAmountToBaseUnits(amt, dec), dec)
      ).toBe(amt);
    }
  });
});

describe('sanitizeAmountInput (raw field text -> normalized decimal string | null)', () => {
  it('normalizes comma to dot', () => {
    expect(sanitizeAmountInput('1,5')).toBe('1.5');
    expect(sanitizeAmountInput('1.5')).toBe('1.5');
    expect(sanitizeAmountInput('0,000001')).toBe('0.000001');
  });

  it('allows a lone dot as a typing intermediate', () => {
    expect(sanitizeAmountInput('.')).toBe('.');
    expect(sanitizeAmountInput('.5')).toBe('.5');
  });

  it('returns null for ambiguous multi-separator input', () => {
    expect(sanitizeAmountInput('1,234.56')).toBeNull(); // two separators
    expect(sanitizeAmountInput('1..2')).toBeNull();
    expect(sanitizeAmountInput('1,,2')).toBeNull();
  });

  it('returns null for non-numeric characters', () => {
    expect(sanitizeAmountInput('-1')).toBeNull();
    expect(sanitizeAmountInput('1e3')).toBeNull();
    expect(sanitizeAmountInput('$1')).toBeNull();
  });

  it('passes empty through', () => {
    expect(sanitizeAmountInput('')).toBe('');
  });
});

describe('compareBigInt (true bigint compare, no Number downcast)', () => {
  it('orders values correctly', () => {
    expect(compareBigInt(1n, 2n)).toBe(-1);
    expect(compareBigInt(2n, 1n)).toBe(1);
    expect(compareBigInt(5n, 5n)).toBe(0);
    expect(compareBigInt(3, 5)).toBe(-1);
  });

  it('stays exact above Number.MAX_SAFE_INTEGER (where downcast would fail)', () => {
    const a = 9007199254740993n; // MAX_SAFE_INTEGER + 2
    const b = 9007199254740992n; // MAX_SAFE_INTEGER + 1
    expect(compareBigInt(a, b)).toBe(1);
    // sanity: the lossy comparator cannot distinguish these
    expect(compareBigIntSafe(a, b)).toBe(0);
  });
});

describe('safe number helpers', () => {
  it('toBigIntSafeNumber downcasts bigint', () => {
    expect(toBigIntSafeNumber(5n)).toBe(5);
    expect(toBigIntSafeNumber(5)).toBe(5);
  });

  it('add/subtract operate on numbers', () => {
    expect(addBigIntSafe(2n, 3)).toBe(5);
    expect(subtractBigIntSafe(10n, 4n)).toBe(6);
  });
});
