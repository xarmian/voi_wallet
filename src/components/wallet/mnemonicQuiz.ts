/**
 * Pure helpers backing the recovery-phrase verification challenge
 * (TASK-45 / DR-12, strengthened by TASK-226).
 *
 * ## The challenge model
 *
 * One question at a time, and the question fixes the SLOT: "which word is #7?".
 * The user picks from {@link CHALLENGE_OPTION_COUNT} chips, exactly one of which
 * is the real word for that position. A wrong pick is a real failure.
 *
 * This replaces the original auto-routing board, where a tapped chip was sent to
 * whichever slot it belonged to. That made a wrong tap a silent no-op, and since
 * the chip bank held only the phrase's own words, the quiz could be passed by
 * tapping chips until the slots filled — without ever having written the phrase
 * down (TASK-226).
 *
 * ## Decoys
 *
 * Wrong-answer chips are drawn from the BIP-39 English wordlist, and
 * {@link PHRASE_DECOY_COUNT} of them are drawn from the phrase's OWN other
 * words. That second part is deliberate and load-bearing in both directions:
 *
 *   - If every decoy were a random BIP-39 word, the real answer would be the
 *     only option belonging to the phrase. Anyone who remembers the phrase's
 *     word SET but not its order could pass every question by picking the
 *     familiar word.
 *   - If every decoy came from the phrase, the union of the option sets would
 *     effectively display the phrase's whole word set to a shoulder-surfer who
 *     never saw the display step.
 *
 * Mixing gives a shoulder-surfer no way to tell real words from decoys, while
 * still denying the "pick the familiar one" shortcut.
 *
 * Every option is a plain lowercase BIP-39 word rendered by the same chip
 * component, so decoys are presentationally indistinguishable from the answer,
 * and the answer's slot in the option array is uniformly random.
 *
 * ## Retry policy
 *
 * A wrong pick costs a mistake and re-presents the SAME position with a FRESH
 * option set — re-presenting the same set would let the user eliminate their way
 * to the answer. Progress on already-answered positions is kept, so a fat-finger
 * does not throw away a correct run.
 *
 * After {@link MAX_MISTAKES} tolerated mistakes the next wrong pick discards the
 * whole attempt: brand-new positions, brand-new option sets, mistake counter
 * back to zero, and the host is told via `onFailed` so onboarding can send the
 * user back to re-read the phrase. There is deliberately NO permanent lockout —
 * a user holding a correct written phrase must always be able to pass — so the
 * bound on blind guessing is friction, not refusal. See MnemonicVerification for
 * the numbers.
 *
 * ## Duplicate words (DR-12) — still preserved
 *
 * Roughly 14% of 25-word Algorand phrases repeat a word. The original quiz
 * resolved a tapped word with `indexOf` (always the FIRST occurrence) and
 * disabled chips by VALUE, so a repeated word's later position could be
 * unanswerable and the user was hard-stuck in onboarding.
 *
 * The directed model removes that class of bug structurally: a question names a
 * position, the answer is compared by value against the word AT that position,
 * and {@link buildChallengeOptions} guarantees exactly one chip carries that
 * value. A repeated word is therefore answerable at every one of its positions,
 * and no two chips are ever ambiguous.
 *
 * ## Security note
 *
 * These helpers only reorder / compare words the user is already being shown on
 * the same screen. They never persist, log, or transmit anything. `Math.random`
 * is adequate for presentation ordering and decoy sampling — it is not used to
 * generate, derive, or protect key material.
 */

import { BIP39Utils } from '@/utils/bip39';

/** How many positions the user must confirm to pass. */
export const VERIFICATION_WORD_COUNT = 3;

/** Chips shown per question: 1 correct word + decoys. */
export const CHALLENGE_OPTION_COUNT = 8;

/** How many decoys are drawn from the phrase's own other words (see above). */
export const PHRASE_DECOY_COUNT = 3;

/**
 * Wrong picks tolerated within one attempt. The NEXT wrong pick after this many
 * discards the attempt and starts over with fresh positions.
 */
export const MAX_MISTAKES = 3;

/** Source of randomness, injectable so tests can be deterministic. */
export type Rng = () => number;

/** One attempt at the challenge sequence. */
export interface QuizAttempt {
  /** Phrase positions to be asked, ascending. */
  readonly positions: number[];
  /** Index into {@link positions} of the question currently on screen. */
  readonly currentIndex: number;
  /** Chips for the current question, already shuffled. */
  readonly options: string[];
  /** Wrong picks so far in this attempt. */
  readonly mistakes: number;
}

/** Outcome of answering the question currently on screen. */
export type QuizAnswer =
  /** Right, and that was the last question. */
  | { status: 'verified' }
  /** Right; move on to the next question. */
  | { status: 'advanced'; attempt: QuizAttempt }
  /** Wrong; same position, fresh options, mistake counted. */
  | { status: 'retry'; attempt: QuizAttempt }
  /** Wrong once too often; the attempt was discarded and rebuilt. */
  | { status: 'reset'; attempt: QuizAttempt };

/** Split a phrase into normalized words (collapses stray whitespace). */
export function splitMnemonic(mnemonic: string): string[] {
  return mnemonic.trim().split(/\s+/).filter(Boolean);
}

/**
 * Unbiased Fisher-Yates shuffle returning a NEW array (the old
 * `sort(() => Math.random() - 0.5)` was both biased and comparator-unstable).
 */
export function shuffle<T>(items: T[], rng: Rng = Math.random): T[] {
  const shuffled = [...items];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
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
  count: number = VERIFICATION_WORD_COUNT,
  rng: Rng = Math.random
): number[] {
  if (total <= 0) return [];
  if (total <= count) {
    return Array.from({ length: total }, (_, i) => i);
  }
  const positions = new Set<number>();
  while (positions.size < count) {
    positions.add(Math.floor(rng() * total));
  }
  return [...positions].sort((a, b) => a - b);
}

/**
 * Build the chips for "which word is #position?".
 *
 * Invariants (all pinned by tests):
 *   - exactly one chip equals `words[position]`
 *   - no duplicate chips, so no two chips are ever ambiguous (DR-12)
 *   - decoys are BIP-39 words, a bounded number of them from the phrase itself
 *   - order is uniformly shuffled
 */
export function buildChallengeOptions(
  words: string[],
  position: number,
  optionCount: number = CHALLENGE_OPTION_COUNT,
  rng: Rng = Math.random
): string[] {
  const answer = words[position];
  if (answer === undefined || optionCount <= 0) return [];

  const chosen = new Set<string>([answer]);

  // Decoys from the phrase's own other words. Distinct values only, and never
  // the answer itself — otherwise a repeated word would produce two chips that
  // are both "correct", which is exactly the ambiguity DR-12 outlawed.
  const phraseDecoyLimit = Math.min(optionCount, 1 + PHRASE_DECOY_COUNT);
  const phrasePool = shuffle(
    [...new Set(words)].filter((word) => word !== answer),
    rng
  );
  for (const word of phrasePool) {
    if (chosen.size >= phraseDecoyLimit) break;
    chosen.add(word);
  }

  // Remainder from the wider BIP-39 wordlist. `Set` semantics mean a sample that
  // collides with the answer or an existing decoy is simply skipped, so the
  // "exactly one correct chip" invariant holds without a special case.
  const listLength = BIP39Utils.getWordlistLength();
  const maxSamples = optionCount * 64;
  for (let i = 0; chosen.size < optionCount && i < maxSamples; i++) {
    const word = BIP39Utils.getWordAtIndex(Math.floor(rng() * listLength));
    if (word) chosen.add(word);
  }

  // Defensive top-up: guarantees termination with a full option set even if the
  // injected rng is degenerate (e.g. a test stub that always returns 0).
  for (let i = 0; chosen.size < optionCount && i < listLength; i++) {
    const word = BIP39Utils.getWordAtIndex(i);
    if (word) chosen.add(word);
  }

  return shuffle([...chosen], rng);
}

/** Start a fresh attempt: new positions, new options, no mistakes. */
export function startQuizAttempt(
  words: string[],
  rng: Rng = Math.random
): QuizAttempt {
  const positions = pickVerificationPositions(
    words.length,
    VERIFICATION_WORD_COUNT,
    rng
  );
  return {
    positions,
    currentIndex: 0,
    options:
      positions.length > 0
        ? buildChallengeOptions(
            words,
            positions[0],
            CHALLENGE_OPTION_COUNT,
            rng
          )
        : [],
    mistakes: 0,
  };
}

/** The phrase position currently being asked, or `null` if there is none. */
export function currentPosition(attempt: QuizAttempt): number | null {
  const position = attempt.positions[attempt.currentIndex];
  return position === undefined ? null : position;
}

/**
 * Wrong picks still tolerated before the attempt is discarded. Zero means the
 * next wrong pick restarts the challenge.
 */
export function remainingMistakes(attempt: QuizAttempt): number {
  return Math.max(0, MAX_MISTAKES - attempt.mistakes);
}

/**
 * Answer the question currently on screen.
 *
 * `picked` must be one of `attempt.options`; anything else is treated as a wrong
 * answer rather than silently ignored, so there is no "off-board" path to a pass.
 */
export function answerCurrentChallenge(
  attempt: QuizAttempt,
  words: string[],
  picked: string,
  rng: Rng = Math.random
): QuizAnswer {
  const position = currentPosition(attempt);
  if (position === null) {
    // No question is live — never a pass; rebuild rather than dead-end.
    return { status: 'reset', attempt: startQuizAttempt(words, rng) };
  }

  const isCorrect =
    attempt.options.includes(picked) && picked === words[position];

  if (isCorrect) {
    const nextIndex = attempt.currentIndex + 1;
    if (nextIndex >= attempt.positions.length) {
      return { status: 'verified' };
    }
    return {
      status: 'advanced',
      attempt: {
        ...attempt,
        currentIndex: nextIndex,
        options: buildChallengeOptions(
          words,
          attempt.positions[nextIndex],
          CHALLENGE_OPTION_COUNT,
          rng
        ),
      },
    };
  }

  const mistakes = attempt.mistakes + 1;
  if (mistakes > MAX_MISTAKES) {
    return { status: 'reset', attempt: startQuizAttempt(words, rng) };
  }

  // Same position, FRESH options — re-presenting the same set would let the user
  // eliminate their way to the answer.
  return {
    status: 'retry',
    attempt: {
      ...attempt,
      mistakes,
      options: buildChallengeOptions(
        words,
        position,
        CHALLENGE_OPTION_COUNT,
        rng
      ),
    },
  };
}
