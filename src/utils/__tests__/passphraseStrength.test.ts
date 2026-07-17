import { estimatePassphraseStrength } from '../passphraseStrength';

const MIN = 12;

describe('estimatePassphraseStrength', () => {
  it('scores below the min length as "too short" (0)', () => {
    const r = estimatePassphraseStrength('short', MIN);
    expect(r.score).toBe(0);
    expect(r.label).toBe('too short');
    expect(r.meetsMinLength).toBe(false);
    expect(r.bits).toBe(0);
  });

  it('treats the empty string as too short', () => {
    expect(estimatePassphraseStrength('', MIN).score).toBe(0);
  });

  it('discounts a long but trivial (all-same-char) string', () => {
    const r = estimatePassphraseStrength('aaaaaaaaaaaa', MIN); // 12 chars, 1 unique
    expect(r.meetsMinLength).toBe(true);
    expect(r.score).toBeLessThanOrEqual(2); // not "good"/"strong"
  });

  it('scores a 12-char mixed passphrase as good or strong', () => {
    const r = estimatePassphraseStrength('Tr0ub4dour&3x', MIN);
    expect(r.meetsMinLength).toBe(true);
    expect(r.score).toBeGreaterThanOrEqual(3);
  });

  it('scores a long multi-word passphrase as strong', () => {
    const r = estimatePassphraseStrength('correct horse battery staple', MIN);
    expect(r.score).toBe(4);
    expect(r.label).toBe('strong');
  });

  it('larger character pool + length ⇒ more bits', () => {
    const lower = estimatePassphraseStrength('abcdefghijkl', MIN).bits;
    const mixed = estimatePassphraseStrength('aB3$eFgH1jKl', MIN).bits;
    expect(mixed).toBeGreaterThan(lower);
  });

  it('meetsMinLength flips exactly at the floor', () => {
    expect(estimatePassphraseStrength('a'.repeat(11), MIN).meetsMinLength).toBe(
      false
    );
    expect(estimatePassphraseStrength('a'.repeat(12), MIN).meetsMinLength).toBe(
      true
    );
  });
});
