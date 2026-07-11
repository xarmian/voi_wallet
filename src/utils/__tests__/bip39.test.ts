import { BIP39Utils } from '../bip39';

describe('BIP39Utils', () => {
  describe('isValidWord', () => {
    it('accepts real wordlist words', () => {
      expect(BIP39Utils.isValidWord('abandon')).toBe(true);
      expect(BIP39Utils.isValidWord('zoo')).toBe(true);
    });

    it('is case-insensitive and trims whitespace', () => {
      expect(BIP39Utils.isValidWord('  ABANDON  ')).toBe(true);
      expect(BIP39Utils.isValidWord('Zoo')).toBe(true);
    });

    it('rejects non-wordlist words', () => {
      expect(BIP39Utils.isValidWord('notaword')).toBe(false);
      expect(BIP39Utils.isValidWord('')).toBe(false);
      // "abandonx" is a prefix-superset, must still be rejected
      expect(BIP39Utils.isValidWord('abandonx')).toBe(false);
    });
  });

  describe('getWordlistLength', () => {
    it('is the standard BIP-39 length of 2048', () => {
      expect(BIP39Utils.getWordlistLength()).toBe(2048);
    });
  });

  describe('getWordIndex / getWordAtIndex', () => {
    it('maps the first and last words to their indices', () => {
      expect(BIP39Utils.getWordIndex('abandon')).toBe(0);
      expect(BIP39Utils.getWordAtIndex(0)).toBe('abandon');
      expect(BIP39Utils.getWordAtIndex(2047)).toBe('zoo');
    });

    it('round-trips index -> word -> index', () => {
      for (const i of [0, 1, 1000, 2047]) {
        const word = BIP39Utils.getWordAtIndex(i);
        expect(BIP39Utils.getWordIndex(word)).toBe(i);
      }
    });

    it('returns -1 / empty string for invalid input', () => {
      expect(BIP39Utils.getWordIndex('notaword')).toBe(-1);
      expect(BIP39Utils.getWordAtIndex(-1)).toBe('');
      expect(BIP39Utils.getWordAtIndex(9999)).toBe('');
    });
  });

  describe('getWordSuggestions', () => {
    it('returns words matching the prefix, capped at the limit', () => {
      const suggestions = BIP39Utils.getWordSuggestions('aban', 5);
      expect(suggestions.length).toBeGreaterThan(0);
      expect(suggestions.length).toBeLessThanOrEqual(5);
      expect(suggestions.every((s) => s.word.startsWith('aban'))).toBe(true);
      expect(suggestions.map((s) => s.word)).toContain('abandon');
    });

    it('respects a custom limit', () => {
      expect(BIP39Utils.getWordSuggestions('a', 3)).toHaveLength(3);
    });

    it('returns [] for empty input', () => {
      expect(BIP39Utils.getWordSuggestions('')).toEqual([]);
    });
  });

  describe('validateMnemonicWords (Algorand 25-word)', () => {
    const valid25 = Array(25).fill('abandon');

    it('accepts exactly 25 valid words', () => {
      expect(BIP39Utils.validateMnemonicWords(valid25)).toBe(true);
    });

    it('rejects the wrong word count', () => {
      expect(BIP39Utils.validateMnemonicWords(Array(24).fill('abandon'))).toBe(
        false
      );
      expect(BIP39Utils.validateMnemonicWords(Array(26).fill('abandon'))).toBe(
        false
      );
    });

    it('rejects when any word is invalid or blank', () => {
      const withBad = [...valid25];
      withBad[12] = 'notaword';
      expect(BIP39Utils.validateMnemonicWords(withBad)).toBe(false);

      const withBlank = [...valid25];
      withBlank[3] = '   ';
      expect(BIP39Utils.validateMnemonicWords(withBlank)).toBe(false);
    });
  });

  describe('normalizeWord / getMnemonicFromWords', () => {
    it('normalizes case and whitespace', () => {
      expect(BIP39Utils.normalizeWord('  AbAnDoN ')).toBe('abandon');
    });

    it('joins normalized words, dropping empties', () => {
      expect(
        BIP39Utils.getMnemonicFromWords(['Abandon', '', '  Zoo  ', ''])
      ).toBe('abandon zoo');
    });
  });

  describe('parsePastedMnemonic', () => {
    it('splits on any whitespace and pads to 25 slots', () => {
      const result = BIP39Utils.parsePastedMnemonic('abandon   zoo\nvote');
      expect(result).toHaveLength(25);
      expect(result.slice(0, 3)).toEqual(['abandon', 'zoo', 'vote']);
      expect(result.slice(3).every((w) => w === '')).toBe(true);
    });

    it('truncates to the first 25 words when more are pasted', () => {
      const result = BIP39Utils.parsePastedMnemonic(
        Array(30).fill('abandon').join(' ')
      );
      expect(result).toHaveLength(25);
    });
  });
});
