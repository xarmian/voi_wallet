/**
 * Pure helpers backing the recovery-phrase verification quiz (TASK-45, DR-12).
 *
 * ## Why this exists
 *
 * The quiz used to resolve a tapped word with `mnemonicWords.indexOf(word)`,
 * which always returns the FIRST occurrence, and disabled the option chips by
 * word VALUE. Roughly 14% of 25-word Algorand mnemonics repeat at least one
 * word, so if a repeated word's LATER position was one of the verification
 * targets the tap resolved to a position that wasn't a target, nothing was
 * selected, and the user was hard-stuck in onboarding with no way forward.
 *
 * Everything here is therefore **position-indexed**: every option carries the
 * index it came from, selections record which option index filled which slot,
 * and chips are disabled by index rather than by value.
 *
 * ## Security note
 *
 * These helpers only ever reorder / compare words the user is already being
 * shown on the same screen. They never persist, log, or transmit anything.
 * `Math.random` is adequate for the presentation ordering here — it is not used
 * to generate, derive, or protect key material.
 */

/** A single tappable word chip, tied to its position in the phrase. */
export interface WordOption {
  /** The word as it appears in the phrase. */
  word: string;
  /** Zero-based position of this word in the original phrase. */
  index: number;
}

/** Which option chip filled a given verification slot. */
export interface WordSelection {
  word: string;
  /** The `WordOption.index` that was consumed — used to disable that chip. */
  optionIndex: number;
}

/** Slot position (zero-based) -> the selection that filled it. */
export type WordSelections = Record<number, WordSelection>;

/** Number of words the user is asked to confirm. */
export const VERIFICATION_WORD_COUNT = 3;

/** Split a phrase into normalized words (collapses stray whitespace). */
export function splitMnemonic(mnemonic: string): string[] {
  return mnemonic.trim().split(/\s+/).filter(Boolean);
}

/**
 * Build the position-indexed option chips for a phrase, in phrase order.
 * Callers shuffle with {@link shuffleWordOptions}.
 */
export function buildWordOptions(mnemonic: string): WordOption[] {
  return splitMnemonic(mnemonic).map((word, index) => ({ word, index }));
}

/**
 * Unbiased Fisher-Yates shuffle returning a NEW array (the old
 * `sort(() => Math.random() - 0.5)` was both biased and comparator-unstable).
 */
export function shuffleWordOptions(options: WordOption[]): WordOption[] {
  const shuffled = [...options];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

/**
 * Pick `count` distinct positions in `[0, total)`, ascending.
 * Returns every position when `total <= count` so a short (test) phrase can
 * still be completed rather than looping forever.
 */
export function pickVerificationPositions(
  total: number,
  count: number = VERIFICATION_WORD_COUNT
): number[] {
  if (total <= 0) return [];
  if (total <= count) {
    return Array.from({ length: total }, (_, i) => i);
  }
  const positions = new Set<number>();
  while (positions.size < count) {
    positions.add(Math.floor(Math.random() * total));
  }
  return [...positions].sort((a, b) => a - b);
}

/** The set of option indices already consumed by a selection. */
export function usedOptionIndices(selections: WordSelections): Set<number> {
  return new Set(
    Object.values(selections).map((selection) => selection.optionIndex)
  );
}

/**
 * Decide which verification slot a tapped chip should fill.
 *
 * DR-12: resolution is by INDEX first. The value fallback exists purely so a
 * repeated word can be answered from *either* of its chips — without it, a user
 * facing a duplicate would have to guess which of two identical-looking chips
 * is the "live" one, and half the time the tap would do nothing.
 *
 * Returns `null` when the tap is a no-op (chip already used, or no matching
 * empty slot).
 */
export function resolveVerificationTarget(
  option: WordOption,
  verificationWords: number[],
  selections: WordSelections,
  mnemonicWords: string[]
): number | null {
  // A chip may only ever be consumed once.
  if (usedOptionIndices(selections).has(option.index)) {
    return null;
  }

  // Exact positional match — the common case, and the only one that can occur
  // for a phrase with no repeated words.
  if (
    verificationWords.includes(option.index) &&
    selections[option.index] === undefined
  ) {
    return option.index;
  }

  // Duplicate-word fallback: fill the first still-empty target slot that
  // expects this exact word.
  const fallback = verificationWords.find(
    (position) =>
      selections[position] === undefined &&
      mnemonicWords[position] === option.word
  );

  return fallback === undefined ? null : fallback;
}

/** Apply a tap, returning a NEW selections object (or the same one on no-op). */
export function selectWordOption(
  option: WordOption,
  verificationWords: number[],
  selections: WordSelections,
  mnemonicWords: string[]
): WordSelections {
  const target = resolveVerificationTarget(
    option,
    verificationWords,
    selections,
    mnemonicWords
  );
  if (target === null) return selections;
  return {
    ...selections,
    [target]: { word: option.word, optionIndex: option.index },
  };
}

/** Clear one slot, freeing the chip that filled it. */
export function clearWordSelection(
  position: number,
  selections: WordSelections
): WordSelections {
  if (selections[position] === undefined) return selections;
  const next = { ...selections };
  delete next[position];
  return next;
}

/** True once every target slot has a word in it. */
export function isVerificationComplete(
  verificationWords: number[],
  selections: WordSelections
): boolean {
  return (
    verificationWords.length > 0 &&
    verificationWords.every((position) => selections[position] !== undefined)
  );
}

/**
 * True when every target slot holds the correct word. Compares by VALUE, which
 * is correct: a duplicate word answered from either of its chips is still the
 * right word for that position.
 */
export function verifySelections(
  verificationWords: number[],
  selections: WordSelections,
  mnemonicWords: string[]
): boolean {
  if (!isVerificationComplete(verificationWords, selections)) return false;
  return verificationWords.every(
    (position) => selections[position]?.word === mnemonicWords[position]
  );
}
