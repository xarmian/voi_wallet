/**
 * TASK-45 / DR-12 — regression tests for the recovery-phrase verification quiz.
 *
 * The defect this pins: the quiz used to resolve a tapped word with
 * `mnemonicWords.indexOf(word)` (always the FIRST occurrence) and disable chips
 * by word VALUE. About 14% of 25-word Algorand phrases repeat a word, so when a
 * repeated word's LATER position was one of the verification targets the tap
 * resolved to a non-target position, no selection happened, and the user was
 * HARD-STUCK in onboarding with no way forward.
 *
 * These tests deliberately use phrases with repeated words.
 *
 * SECURITY NOTE: the phrases below are made-up word lists used purely as
 * position/value fixtures. They are not valid BIP-39/Algorand mnemonics and no
 * key material is derived from them anywhere in this file.
 */

import {
  buildWordOptions,
  clearWordSelection,
  isVerificationComplete,
  pickVerificationPositions,
  resolveVerificationTarget,
  selectWordOption,
  shuffleWordOptions,
  splitMnemonic,
  usedOptionIndices,
  verifySelections,
  VERIFICATION_WORD_COUNT,
  type WordSelections,
} from '../mnemonicQuiz';

// "abandon" appears at positions 0, 3 and 6 — the exact shape that used to lock
// a user out.
const REPEATED = 'abandon ability able abandon absent absorb abandon abstract';
const REPEATED_WORDS = REPEATED.split(' ');

describe('splitMnemonic', () => {
  it('collapses stray whitespace and trims', () => {
    expect(splitMnemonic('  one   two \n three  ')).toEqual([
      'one',
      'two',
      'three',
    ]);
  });
});

describe('buildWordOptions', () => {
  it('carries the ORIGINAL position of every word, duplicates included', () => {
    const options = buildWordOptions(REPEATED);
    expect(options).toHaveLength(8);
    expect(options.map((o) => o.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    // Each occurrence of "abandon" is a distinct, independently addressable chip.
    expect(
      options.filter((o) => o.word === 'abandon').map((o) => o.index)
    ).toEqual([0, 3, 6]);
  });
});

describe('shuffleWordOptions', () => {
  it('preserves every (word, index) pair and does not mutate the input', () => {
    const options = buildWordOptions(REPEATED);
    const snapshot = JSON.stringify(options);
    const shuffled = shuffleWordOptions(options);

    expect(JSON.stringify(options)).toBe(snapshot);
    expect([...shuffled].sort((a, b) => a.index - b.index)).toEqual(options);
  });
});

describe('pickVerificationPositions', () => {
  it('picks 3 distinct ascending positions for a full 25-word phrase', () => {
    for (let run = 0; run < 200; run++) {
      const positions = pickVerificationPositions(25);
      expect(positions).toHaveLength(VERIFICATION_WORD_COUNT);
      expect(new Set(positions).size).toBe(VERIFICATION_WORD_COUNT);
      expect([...positions].sort((a, b) => a - b)).toEqual(positions);
      positions.forEach((p) => {
        expect(p).toBeGreaterThanOrEqual(0);
        expect(p).toBeLessThan(25);
      });
    }
  });

  it('returns every position (instead of looping forever) for a short phrase', () => {
    expect(pickVerificationPositions(2)).toEqual([0, 1]);
    expect(pickVerificationPositions(0)).toEqual([]);
  });
});

describe('resolveVerificationTarget — DR-12 duplicate words', () => {
  it('resolves a LATER occurrence of a repeated word to its own position', () => {
    // Target is position 6 — the THIRD "abandon". The old indexOf() logic
    // resolved this tap to position 0, which is not a target, so the tap was a
    // silent no-op and the user could never complete the quiz.
    const target = resolveVerificationTarget(
      { word: 'abandon', index: 6 },
      [1, 4, 6],
      {},
      REPEATED_WORDS
    );
    expect(target).toBe(6);
  });

  it('lets a non-target duplicate chip fill an equivalent empty target slot', () => {
    // The user taps the chip at position 0; only position 6 is a target. Both
    // chips read "abandon" and are visually indistinguishable, so the tap must
    // still land rather than doing nothing.
    const target = resolveVerificationTarget(
      { word: 'abandon', index: 0 },
      [1, 4, 6],
      {},
      REPEATED_WORDS
    );
    expect(target).toBe(6);
  });

  it('never reuses a chip that already filled a slot', () => {
    const selections: WordSelections = {
      6: { word: 'abandon', optionIndex: 6 },
    };
    expect(
      resolveVerificationTarget(
        { word: 'abandon', index: 6 },
        [1, 4, 6],
        selections,
        REPEATED_WORDS
      )
    ).toBeNull();
  });

  it('returns null when no empty target slot expects this word', () => {
    expect(
      resolveVerificationTarget(
        { word: 'absorb', index: 5 },
        [1, 4, 6],
        {},
        REPEATED_WORDS
      )
    ).toBeNull();
  });

  it('fills a second target slot from the second duplicate chip', () => {
    // Both position 0 and position 6 are targets and both hold "abandon".
    const first = selectWordOption(
      { word: 'abandon', index: 0 },
      [0, 4, 6],
      {},
      REPEATED_WORDS
    );
    const second = selectWordOption(
      { word: 'abandon', index: 6 },
      [0, 4, 6],
      first,
      REPEATED_WORDS
    );
    expect(Object.keys(second).sort()).toEqual(['0', '6']);
    expect(second[0].optionIndex).toBe(0);
    expect(second[6].optionIndex).toBe(6);
  });
});

describe('selectWordOption / clearWordSelection', () => {
  it('is a no-op (same object) when the tap resolves to nothing', () => {
    const selections: WordSelections = {};
    expect(
      selectWordOption(
        { word: 'absorb', index: 5 },
        [1, 4, 6],
        selections,
        REPEATED_WORDS
      )
    ).toBe(selections);
  });

  it('clearing a slot frees its chip for reuse', () => {
    const filled = selectWordOption(
      { word: 'abandon', index: 6 },
      [1, 4, 6],
      {},
      REPEATED_WORDS
    );
    expect(usedOptionIndices(filled).has(6)).toBe(true);

    const cleared = clearWordSelection(6, filled);
    expect(usedOptionIndices(cleared).has(6)).toBe(false);
    expect(
      resolveVerificationTarget(
        { word: 'abandon', index: 6 },
        [1, 4, 6],
        cleared,
        REPEATED_WORDS
      )
    ).toBe(6);
  });
});

describe('verifySelections', () => {
  const targets = [1, 4, 6];

  it('accepts a fully correct board containing a repeated word', () => {
    let selections: WordSelections = {};
    for (const index of targets) {
      selections = selectWordOption(
        { word: REPEATED_WORDS[index], index },
        targets,
        selections,
        REPEATED_WORDS
      );
    }
    expect(isVerificationComplete(targets, selections)).toBe(true);
    expect(verifySelections(targets, selections, REPEATED_WORDS)).toBe(true);
  });

  it('rejects an incomplete board', () => {
    const selections = selectWordOption(
      { word: REPEATED_WORDS[1], index: 1 },
      targets,
      {},
      REPEATED_WORDS
    );
    expect(isVerificationComplete(targets, selections)).toBe(false);
    expect(verifySelections(targets, selections, REPEATED_WORDS)).toBe(false);
  });

  it('rejects a board with a wrong word in a slot', () => {
    const selections: WordSelections = {
      1: { word: 'wrong', optionIndex: 99 },
      4: { word: REPEATED_WORDS[4], optionIndex: 4 },
      6: { word: REPEATED_WORDS[6], optionIndex: 6 },
    };
    expect(verifySelections(targets, selections, REPEATED_WORDS)).toBe(false);
  });
});

describe('DR-12 end-to-end: every repeated-word phrase stays completable', () => {
  it('can always be finished, for every possible target triple', () => {
    const words = REPEATED_WORDS;
    // Exhaustively enumerate every 3-position target set for the repeated-word
    // phrase. Under the old value-indexed logic many of these were unwinnable.
    for (let a = 0; a < words.length; a++) {
      for (let b = a + 1; b < words.length; b++) {
        for (let c = b + 1; c < words.length; c++) {
          const targets = [a, b, c];
          let selections: WordSelections = {};
          // Simulate the user tapping the chip at each target position.
          for (const index of targets) {
            selections = selectWordOption(
              { word: words[index], index },
              targets,
              selections,
              words
            );
          }
          expect(isVerificationComplete(targets, selections)).toBe(true);
          expect(verifySelections(targets, selections, words)).toBe(true);
        }
      }
    }
  });
});
