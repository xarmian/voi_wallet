import { wordlist as englishWordlist } from '@scure/bip39/wordlists/english';

export interface WordSuggestion {
  word: string;
  index: number;
}

export class BIP39Utils {
  private static readonly wordlist = englishWordlist;

  static isValidWord(word: string): boolean {
    const cleanWord = word.trim().toLowerCase();
    return this.wordlist.includes(cleanWord);
  }

  static getWordSuggestions(
    input: string,
    limit: number = 5
  ): WordSuggestion[] {
    if (!input || input.length < 1) return [];

    const cleanInput = input.trim().toLowerCase();
    const suggestions: WordSuggestion[] = [];

    for (let i = 0; i < this.wordlist.length; i++) {
      const word = this.wordlist[i];
      if (word.startsWith(cleanInput)) {
        suggestions.push({ word, index: i });
        if (suggestions.length >= limit) break;
      }
    }

    return suggestions;
  }

  static validateMnemonicWords(words: string[]): boolean {
    if (words.length !== 25) return false;

    return words.every((word) => {
      if (!word || word.trim() === '') return false;
      return this.isValidWord(word.trim());
    });
  }

  static normalizeWord(word: string): string {
    return word.trim().toLowerCase();
  }

  static getMnemonicFromWords(words: string[]): string {
    return words
      .map((word) => this.normalizeWord(word))
      .filter((word) => word.length > 0)
      .join(' ');
  }

  static parsePastedMnemonic(text: string): string[] {
    const cleanText = text.trim().replace(/\s+/g, ' ');
    const words = cleanText.split(' ').filter((word) => word.length > 0);

    // Pad with empty strings to ensure we have 25 slots
    const paddedWords = [...words];
    while (paddedWords.length < 25) {
      paddedWords.push('');
    }

    // Only return first 25 words if more were pasted
    return paddedWords.slice(0, 25);
  }

  static getWordIndex(word: string): number {
    const cleanWord = this.normalizeWord(word);
    return this.wordlist.indexOf(cleanWord);
  }

  static getWordAtIndex(index: number): string {
    if (index >= 0 && index < this.wordlist.length) {
      return this.wordlist[index];
    }
    return '';
  }

  static getWordlistLength(): number {
    return this.wordlist.length;
  }
}
