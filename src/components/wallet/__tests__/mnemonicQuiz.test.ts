/**
 * TASK-45 / DR-12 + TASK-226 — regression tests for the recovery-phrase
 * verification challenge.
 *
 * Two defects are pinned here, and neither may come back:
 *
 * 1. DR-12 — ONBOARDING LOCKOUT. The original quiz resolved a tapped word with
 *    `mnemonicWords.indexOf(word)` (always the FIRST occurrence) and disabled
 *    chips by word VALUE. About 14% of 25-word Algorand phrases repeat a word,
 *    so when a repeated word's LATER position was a target the tap resolved to a
 *    non-target position, nothing happened, and the user was HARD-STUCK in
 *    onboarding with no way forward. The exhaustive suite at the bottom of this
 *    file walks every position of a deliberately repeated-word phrase and proves
 *    each one is answerable.
 *
 * 2. TASK-226 — PASSABLE WITHOUT THE PHRASE. Taps auto-routed to the slot they
 *    belonged to (so a wrong tap was a silent no-op) and the chip bank held only
 *    the phrase's own words, so the board could be filled by tapping at random.
 *    The tests here pin that a wrong pick is a real, counted failure and that
 *    decoys come from the wider BIP-39 wordlist.
 *
 * SECURITY NOTE: the phrases below are made-up word lists used purely as
 * position/value fixtures. They are not valid BIP-39/Algorand mnemonics and no
 * key material is derived from them anywhere in this file.
 */

import { BIP39Utils } from '@/utils/bip39';
import {
  answerCurrentChallenge,
  buildChallengeOptions,
  createOptionProvider,
  CHALLENGE_OPTION_COUNT,
  currentPosition,
  MAX_MISTAKES,
  PHRASE_DECOY_COUNT,
  pickVerificationPositions,
  remainingMistakes,
  shuffle,
  splitMnemonic,
  startQuizAttempt,
  VERIFICATION_WORD_COUNT,
  type QuizAttempt,
} from '../mnemonicQuiz';

// "abandon" appears at positions 0, 3 and 6 — the exact shape that used to lock
// a user out.
const REPEATED = 'abandon ability able abandon absent absorb abandon abstract';
const REPEATED_WORDS = REPEATED.split(' ');

/** A 25-word-shaped fixture of distinct BIP-39 words. */
const LONG_WORDS = [
  'abandon',
  'ability',
  'able',
  'about',
  'above',
  'absent',
  'absorb',
  'abstract',
  'absurd',
  'abuse',
  'access',
  'accident',
  'account',
  'accuse',
  'achieve',
  'acid',
  'acoustic',
  'acquire',
  'across',
  'act',
  'action',
  'actor',
  'actress',
  'actual',
  'adapt',
];

/**
 * A memoised board provider, as the component holds one per mount. Boards for a
 * position must be STABLE across presentations — see the intersection-oracle
 * suite below.
 */
function providerFor(words: string[]) {
  return createOptionProvider(words);
}

/** Answer the live question correctly; asserts the attempt is still coherent. */
function answerCorrectly(
  attempt: QuizAttempt,
  words: string[],
  optionsFor = providerFor(words)
) {
  const position = currentPosition(attempt);
  expect(position).not.toBeNull();
  return answerCurrentChallenge(
    attempt,
    words,
    words[position as number],
    optionsFor
  );
}

/** Answer the live question with some chip that is NOT the right one. */
function answerWrongly(
  attempt: QuizAttempt,
  words: string[],
  optionsFor = providerFor(words)
) {
  const position = currentPosition(attempt) as number;
  const wrong = attempt.options.find((word) => word !== words[position]);
  expect(wrong).toBeDefined();
  return answerCurrentChallenge(attempt, words, wrong as string, optionsFor);
}

describe('splitMnemonic', () => {
  it('collapses stray whitespace and trims', () => {
    expect(splitMnemonic('  one   two \n three  ')).toEqual([
      'one',
      'two',
      'three',
    ]);
  });
});

describe('shuffle', () => {
  it('preserves every element and does not mutate the input', () => {
    const items = [...REPEATED_WORDS];
    const snapshot = JSON.stringify(items);
    const shuffled = shuffle(items);

    expect(JSON.stringify(items)).toBe(snapshot);
    expect([...shuffled].sort()).toEqual([...items].sort());
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

describe('buildChallengeOptions — TASK-226 decoys', () => {
  it('always presents exactly one correct chip and no duplicates', () => {
    for (let position = 0; position < LONG_WORDS.length; position++) {
      for (let run = 0; run < 20; run++) {
        const options = buildChallengeOptions(LONG_WORDS, position);
        expect(options).toHaveLength(CHALLENGE_OPTION_COUNT);
        expect(new Set(options).size).toBe(CHALLENGE_OPTION_COUNT);
        expect(
          options.filter((word) => word === LONG_WORDS[position])
        ).toHaveLength(1);
      }
    }
  });

  it('draws decoys the phrase does not contain (not just its own words)', () => {
    // The whole point of TASK-226's decoy change: a bank of only the phrase's
    // own words tells the user which words are real.
    let sawForeignDecoy = false;
    for (let run = 0; run < 50 && !sawForeignDecoy; run++) {
      const options = buildChallengeOptions(LONG_WORDS, 4);
      sawForeignDecoy = options.some((word) => !LONG_WORDS.includes(word));
    }
    expect(sawForeignDecoy).toBe(true);
  });

  it('draws every chip from the BIP-39 English wordlist', () => {
    // Decoys must be presentationally indistinguishable from the answer: same
    // lowercase BIP-39 vocabulary, rendered by the same chip.
    for (let run = 0; run < 50; run++) {
      const options = buildChallengeOptions(LONG_WORDS, run % 25);
      options.forEach((word) => {
        expect(BIP39Utils.isValidWord(word)).toBe(true);
        expect(word).toBe(word.toLowerCase());
      });
    }
  });

  it('mixes in some of the phrase’s own words as decoys', () => {
    // Without these, the answer would be the only option belonging to the
    // phrase and anyone who remembers the word SET could pass every question.
    let sawPhraseDecoy = false;
    for (let run = 0; run < 50 && !sawPhraseDecoy; run++) {
      const options = buildChallengeOptions(LONG_WORDS, 4);
      sawPhraseDecoy = options.some(
        (word) => word !== LONG_WORDS[4] && LONG_WORDS.includes(word)
      );
    }
    expect(sawPhraseDecoy).toBe(true);
  });

  it('keeps the number of phrase words on the board at its budget', () => {
    // A board made mostly of the phrase's own words would show a shoulder-surfer
    // the phrase's whole vocabulary; a board with none of them would let a
    // set-memoriser pick "the familiar one". The budget is the answer plus
    // PHRASE_DECOY_COUNT, and the only excess is the rare wordlist sample that
    // happens to collide with the phrase (~0.05 per board for 25 words).
    const runs = 500;
    let total = 0;
    for (let run = 0; run < runs; run++) {
      const options = buildChallengeOptions(LONG_WORDS, 11);
      total += options.filter((word) => LONG_WORDS.includes(word)).length;
    }
    const mean = total / runs;
    expect(mean).toBeGreaterThanOrEqual(1 + PHRASE_DECOY_COUNT);
    expect(mean).toBeLessThan(1 + PHRASE_DECOY_COUNT + 0.5);
  });

  it('puts the answer in a uniformly random slot', () => {
    const counts = new Array(CHALLENGE_OPTION_COUNT).fill(0);
    for (let run = 0; run < 2000; run++) {
      const options = buildChallengeOptions(LONG_WORDS, 7);
      counts[options.indexOf(LONG_WORDS[7])] += 1;
    }
    // Loose bound: no slot may be starved or dominant (uniform would be 250).
    counts.forEach((count) => {
      expect(count).toBeGreaterThan(120);
      expect(count).toBeLessThan(400);
    });
  });

  it('still fills the board when the rng is degenerate', () => {
    const options = buildChallengeOptions(
      LONG_WORDS,
      3,
      CHALLENGE_OPTION_COUNT,
      () => 0
    );
    expect(options).toHaveLength(CHALLENGE_OPTION_COUNT);
    expect(new Set(options).size).toBe(CHALLENGE_OPTION_COUNT);
    expect(options).toContain(LONG_WORDS[3]);
  });

  it('returns nothing for a position that does not exist', () => {
    expect(buildChallengeOptions(LONG_WORDS, 99)).toEqual([]);
  });
});

describe('startQuizAttempt', () => {
  it('opens on the first question with a full board and no mistakes', () => {
    for (let run = 0; run < 50; run++) {
      const attempt = startQuizAttempt(LONG_WORDS, providerFor(LONG_WORDS));
      expect(attempt.positions).toHaveLength(VERIFICATION_WORD_COUNT);
      expect(attempt.currentIndex).toBe(0);
      expect(attempt.mistakes).toBe(0);
      expect(attempt.options).toHaveLength(CHALLENGE_OPTION_COUNT);
      expect(attempt.options).toContain(LONG_WORDS[attempt.positions[0]]);
      expect(remainingMistakes(attempt)).toBe(MAX_MISTAKES);
    }
  });

  it('has no live question for an empty phrase', () => {
    const attempt = startQuizAttempt([], providerFor([]));
    expect(currentPosition(attempt)).toBeNull();
    expect(attempt.options).toEqual([]);
  });
});

describe('answerCurrentChallenge — TASK-226 wrong picks really fail', () => {
  it('advances on a correct pick and verifies on the last one', () => {
    const optionsFor = providerFor(LONG_WORDS);
    let attempt = startQuizAttempt(LONG_WORDS, optionsFor);

    const first = answerCorrectly(attempt, LONG_WORDS, optionsFor);
    expect(first.status).toBe('advanced');
    attempt = (first as { attempt: QuizAttempt }).attempt;
    expect(attempt.currentIndex).toBe(1);
    expect(attempt.mistakes).toBe(0);

    const second = answerCorrectly(attempt, LONG_WORDS, optionsFor);
    expect(second.status).toBe('advanced');
    attempt = (second as { attempt: QuizAttempt }).attempt;

    expect(answerCorrectly(attempt, LONG_WORDS, optionsFor).status).toBe(
      'verified'
    );
  });

  it('counts a wrong pick and keeps the position, with the SAME option set', () => {
    const optionsFor = providerFor(LONG_WORDS);
    const attempt = startQuizAttempt(LONG_WORDS, optionsFor);
    const before = attempt.options;

    const result = answerWrongly(attempt, LONG_WORDS, optionsFor);
    expect(result.status).toBe('retry');
    const next = (result as { attempt: QuizAttempt }).attempt;

    // Same question...
    expect(currentPosition(next)).toBe(currentPosition(attempt));
    expect(next.currentIndex).toBe(attempt.currentIndex);
    // ...one mistake spent...
    expect(next.mistakes).toBe(1);
    expect(remainingMistakes(next)).toBe(MAX_MISTAKES - 1);
    // ...and the SAME set of chips. Rebuilding it would leak the answer by
    // intersection (see the oracle suite below); the answer is still there, so
    // this is never a dead end.
    expect([...next.options].sort()).toEqual([...before].sort());
    expect(next.options).toContain(LONG_WORDS[currentPosition(next) as number]);
  });

  it('keeps correct progress when a later question is answered wrongly', () => {
    // A fat-finger must not throw away a correct run — that would punish the
    // legitimate user this challenge exists to protect.
    const optionsFor = providerFor(LONG_WORDS);
    let attempt = startQuizAttempt(LONG_WORDS, optionsFor);
    attempt = (
      answerCorrectly(attempt, LONG_WORDS, optionsFor) as {
        attempt: QuizAttempt;
      }
    ).attempt;
    expect(attempt.currentIndex).toBe(1);

    const wrong = answerWrongly(attempt, LONG_WORDS, optionsFor);
    expect(wrong.status).toBe('retry');
    expect((wrong as { attempt: QuizAttempt }).attempt.currentIndex).toBe(1);
  });

  it('discards the whole attempt once the mistake budget is exhausted', () => {
    const optionsFor = providerFor(LONG_WORDS);
    let attempt = startQuizAttempt(LONG_WORDS, optionsFor);

    for (let mistake = 1; mistake <= MAX_MISTAKES; mistake++) {
      const result = answerWrongly(attempt, LONG_WORDS, optionsFor);
      expect(result.status).toBe('retry');
      attempt = (result as { attempt: QuizAttempt }).attempt;
      expect(attempt.mistakes).toBe(mistake);
    }
    expect(remainingMistakes(attempt)).toBe(0);

    const final = answerWrongly(attempt, LONG_WORDS, optionsFor);
    expect(final.status).toBe('reset');
    const fresh = (final as { attempt: QuizAttempt }).attempt;
    expect(fresh.mistakes).toBe(0);
    expect(fresh.currentIndex).toBe(0);
    expect(fresh.options).toHaveLength(CHALLENGE_OPTION_COUNT);
  });

  it('cannot be passed by a word that is not on the board', () => {
    // No off-board path to a pass: anything not presented is a wrong answer.
    const attempt = startQuizAttempt(LONG_WORDS, providerFor(LONG_WORDS));
    const result = answerCurrentChallenge(
      attempt,
      LONG_WORDS,
      'zoo-not-a-chip',
      providerFor(LONG_WORDS)
    );
    expect(result.status).toBe('retry');
  });

  it('rebuilds instead of passing when there is no live question', () => {
    const attempt = startQuizAttempt([], providerFor([]));
    const result = answerCurrentChallenge(
      attempt,
      [],
      'anything',
      providerFor([])
    );
    expect(result.status).toBe('reset');
  });

  it('never verifies a run that contains a wrong pick', () => {
    // Exhaustive-ish: for every question index, a wrong pick at that point can
    // only ever produce retry/reset, never verified.
    for (let run = 0; run < 100; run++) {
      const optionsFor = providerFor(LONG_WORDS);
      let attempt = startQuizAttempt(LONG_WORDS, optionsFor);
      const wrongAt = run % VERIFICATION_WORD_COUNT;
      for (let question = 0; question < VERIFICATION_WORD_COUNT; question++) {
        const result =
          question === wrongAt
            ? answerWrongly(attempt, LONG_WORDS, optionsFor)
            : answerCorrectly(attempt, LONG_WORDS, optionsFor);
        if (question === wrongAt) {
          expect(result.status).not.toBe('verified');
          expect(result.status).not.toBe('advanced');
          break;
        }
        expect(result.status).toBe('advanced');
        attempt = (result as { attempt: QuizAttempt }).attempt;
      }
    }
  });
});

describe('MAX_MISTAKES — the security lever', () => {
  it('stays small enough that elimination does not make the challenge cheap', () => {
    // Because a position's option set is stable, every tolerated mistake is a
    // free elimination. Per-attempt pass probability is
    // C(MAX_MISTAKES + 3, 3) / candidates ** 3, and the relevant guesser is not
    // the blind one but someone who remembers the phrase's WORDS but not their
    // ORDER — they can spot the ~4 phrase words on each board. At 3 tolerated
    // mistakes that is 20/64 ≈ 31% per attempt; at 1 it is 4/64 ≈ 6%.
    // Raising this constant re-opens that shortcut, so pin it.
    expect(MAX_MISTAKES).toBeLessThanOrEqual(1);

    const compositions = (budget: number) =>
      ((budget + 3) * (budget + 2) * (budget + 1)) / 6;
    const setMemoriserCandidates = 1 + PHRASE_DECOY_COUNT;
    const perAttempt = compositions(MAX_MISTAKES) / setMemoriserCandidates ** 3;
    expect(perAttempt).toBeLessThan(0.1);
  });

  it('still forgives a mistake — a legitimate user is never restarted for one slip', () => {
    const optionsFor = providerFor(LONG_WORDS);
    let attempt = startQuizAttempt(LONG_WORDS, optionsFor);

    const slip = answerWrongly(attempt, LONG_WORDS, optionsFor);
    expect(slip.status).toBe('retry');
    attempt = (slip as { attempt: QuizAttempt }).attempt;

    for (let question = 0; question < VERIFICATION_WORD_COUNT; question++) {
      const result = answerCorrectly(attempt, LONG_WORDS, optionsFor);
      if (question < VERIFICATION_WORD_COUNT - 1) {
        expect(result.status).toBe('advanced');
        attempt = (result as { attempt: QuizAttempt }).attempt;
      } else {
        expect(result.status).toBe('verified');
      }
    }
  });
});

describe('createOptionProvider — the option-set intersection oracle', () => {
  it('derives the SAME board for a position across INDEPENDENT providers', () => {
    // THE SECOND HALF OF THE DEFECT: memoising per component mount closed the
    // oracle within a mount, but the failure path deliberately UNMOUNTS the
    // challenge, so re-entering re-rolled every board. Someone could note the
    // "which word is #7?" prompt, fail out, re-enter until #7 came round again,
    // and intersect — an ORDER-recovery oracle, i.e. exactly what the challenge
    // is meant to test. A board must be a pure function of the phrase, never of
    // the mount.
    for (let position = 0; position < LONG_WORDS.length; position++) {
      const boards = Array.from({ length: 4 }, () =>
        providerFor(LONG_WORDS)(position)
      );
      boards.forEach((board) => expect(board).toEqual(boards[0]));
    }
  });

  it('derives the same board from an equal phrase built independently', () => {
    // Determinism must come from the phrase's VALUE, not from array identity.
    const copy = LONG_WORDS.join(' ').split(' ');
    expect(copy).not.toBe(LONG_WORDS);
    for (let position = 0; position < LONG_WORDS.length; position++) {
      expect(providerFor(copy)(position)).toEqual(
        providerFor(LONG_WORDS)(position)
      );
    }
  });

  it('gives different positions different boards', () => {
    const optionsFor = providerFor(LONG_WORDS);
    const seen = new Set(
      LONG_WORDS.map((_, position) => optionsFor(position).join('|'))
    );
    expect(seen.size).toBe(LONG_WORDS.length);
  });

  it('returns the SAME set for a position, every time it is asked', () => {
    // THE DEFECT THIS PINS: the first cut of this challenge rebuilt a fresh
    // board on every retry. Only the answer is guaranteed to survive a rebuild —
    // the four BIP-39 decoys are resampled from 2048 words and essentially never
    // recur — so intersecting two boards for one position yields the answer.
    // A user could answer wrong ON PURPOSE, intersect, and then answer
    // correctly, inside the mistake budget, for all three questions.
    for (let run = 0; run < 25; run++) {
      const optionsFor = providerFor(LONG_WORDS);
      for (let position = 0; position < LONG_WORDS.length; position++) {
        const first = optionsFor(position);
        for (let repeat = 0; repeat < 5; repeat++) {
          expect(optionsFor(position)).toEqual(first);
        }
      }
    }
  });

  it('gives a retry board that intersects the previous one in ALL its chips', () => {
    // The observable form of the same property: an attacker who intersects the
    // board before and after a wrong answer learns nothing, because the
    // intersection is the whole board.
    for (let run = 0; run < 50; run++) {
      const optionsFor = providerFor(LONG_WORDS);
      const attempt = startQuizAttempt(LONG_WORDS, optionsFor);
      const before = new Set(attempt.options);

      const result = answerWrongly(attempt, LONG_WORDS, optionsFor);
      const after = (result as { attempt: QuizAttempt }).attempt.options;

      const intersection = after.filter((word) => before.has(word));
      expect(intersection).toHaveLength(CHALLENGE_OPTION_COUNT);
    }
  });

  it('keeps a position stable across an attempt restart too', () => {
    // The restart rebuilds POSITIONS, not boards. If it rebuilt boards, the same
    // intersection attack would work across attempts instead of across retries.
    const optionsFor = providerFor(LONG_WORDS);
    const boards = LONG_WORDS.map((_, position) => optionsFor(position));

    let attempt = startQuizAttempt(LONG_WORDS, optionsFor);
    for (let mistake = 0; mistake <= MAX_MISTAKES; mistake++) {
      attempt = (
        answerWrongly(attempt, LONG_WORDS, optionsFor) as {
          attempt: QuizAttempt;
        }
      ).attempt;
    }

    LONG_WORDS.forEach((_, position) => {
      expect(optionsFor(position)).toEqual(boards[position]);
    });
  });

  it('gives DIFFERENT phrases different boards', () => {
    // The derivation is domain-separated per (phrase, position); a board must
    // never carry over between phrases.
    const a = providerFor(LONG_WORDS)(4);
    const b = providerFor(REPEATED_WORDS)(4);
    expect(a).not.toEqual(b);

    // A one-word edit must change the board, or the derivation would not really
    // be a function of the phrase.
    const edited = [...LONG_WORDS];
    edited[20] = 'zebra';
    expect(providerFor(edited)(4)).not.toEqual(a);
  });
});

describe('DR-12 end-to-end: every repeated-word phrase stays answerable', () => {
  it('builds an unambiguous, solvable board for EVERY position, duplicates included', () => {
    for (let position = 0; position < REPEATED_WORDS.length; position++) {
      for (let run = 0; run < 50; run++) {
        const options = buildChallengeOptions(REPEATED_WORDS, position);
        // Exactly one chip is right — a repeated word never yields two chips
        // that are both "correct", which is the ambiguity DR-12 outlawed.
        expect(
          options.filter((word) => word === REPEATED_WORDS[position])
        ).toHaveLength(1);
        expect(new Set(options).size).toBe(options.length);

        // And answering it is accepted, at EVERY one of the repeated word's
        // positions — under the old value-indexed logic this silently did
        // nothing and the user was hard-stuck in onboarding.
        const attempt: QuizAttempt = {
          positions: [position],
          currentIndex: 0,
          options,
          mistakes: 0,
        };
        expect(
          answerCurrentChallenge(
            attempt,
            REPEATED_WORDS,
            REPEATED_WORDS[position],
            providerFor(REPEATED_WORDS)
          ).status
        ).toBe('verified');
      }
    }
  });

  it('can always be finished, for every possible question triple', () => {
    const words = REPEATED_WORDS;
    // Exhaustively enumerate every 3-position question set for the
    // repeated-word phrase. Under the old value-indexed logic many of these
    // were unwinnable.
    for (let a = 0; a < words.length; a++) {
      for (let b = a + 1; b < words.length; b++) {
        for (let c = b + 1; c < words.length; c++) {
          const optionsFor = providerFor(words);
          let attempt: QuizAttempt = {
            positions: [a, b, c],
            currentIndex: 0,
            options: optionsFor(a),
            mistakes: 0,
          };

          for (let question = 0; question < 3; question++) {
            const position = currentPosition(attempt) as number;
            expect(attempt.options).toContain(words[position]);
            const result = answerCurrentChallenge(
              attempt,
              words,
              words[position],
              optionsFor
            );
            if (question < 2) {
              expect(result.status).toBe('advanced');
              attempt = (result as { attempt: QuizAttempt }).attempt;
            } else {
              expect(result.status).toBe('verified');
            }
          }
        }
      }
    }
  });

  it('a repeated word is accepted at each of its positions, in one run', () => {
    // "abandon" sits at 0, 3 and 6 — ask all three in a single attempt.
    const repeatedProvider = providerFor(REPEATED_WORDS);
    let attempt: QuizAttempt = {
      positions: [0, 3, 6],
      currentIndex: 0,
      options: repeatedProvider(0),
      mistakes: 0,
    };
    for (const expected of [0, 3, 6]) {
      expect(currentPosition(attempt)).toBe(expected);
      const result = answerCurrentChallenge(
        attempt,
        REPEATED_WORDS,
        'abandon',
        repeatedProvider
      );
      if (expected === 6) {
        expect(result.status).toBe('verified');
      } else {
        expect(result.status).toBe('advanced');
        attempt = (result as { attempt: QuizAttempt }).attempt;
      }
    }
  });
});
