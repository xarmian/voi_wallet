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
 * still denying the "pick the familiar one" shortcut. Note that the answer chip
 * is a real phrase word by necessity, so a correct pick reveals one (word,
 * position) pair to anyone watching NO MATTER what the decoy policy is; the
 * phrase decoys only remove the certainty an observer would otherwise have about
 * the seven chips that were NOT picked.
 *
 * The counter-risk — an observer separating real words from filler by noticing
 * that phrase words recur across boards while wordlist samples (1 in 2048) do
 * not — is bounded by determinism: a position's board is a pure function of the
 * phrase ({@link createOptionProvider}), so repeat observations of the SAME
 * question return the identical eight words and reveal nothing. Recurrence
 * across DIFFERENT questions can still, over enough boards, hint at which words
 * belong to the phrase — but that yields the phrase's word SET, never its ORDER,
 * which is what the challenge actually asks for and what makes a phrase
 * recoverable.
 *
 * Every option is a plain lowercase BIP-39 word rendered by the same chip
 * component, so decoys are presentationally indistinguishable from the answer,
 * and the answer's slot in the option array is uniformly random.
 *
 * ## Retry policy
 *
 * A wrong pick costs a mistake and re-presents the SAME position with the SAME
 * option set in a reshuffled order. The set is deliberately stable — see
 * {@link createOptionProvider} for the cross-board intersection oracle that
 * rebuilding it would open, and for why elimination inside the mistake budget
 * gains a blind guesser nothing. Progress on already-answered positions is kept,
 * so a fat-finger does not throw away a correct run.
 *
 * After {@link MAX_MISTAKES} tolerated mistakes the next wrong pick discards the
 * whole attempt: brand-new positions, mistake counter back to zero, and the host
 * is told via `onFailed` so onboarding can send the user back to re-read the
 * phrase.
 *
 * ## Attempts are NOT capped — a deliberate decision
 *
 * There is no permanent lockout, no persisted failure counter and no cooldown.
 * A blind guesser can therefore keep starting new attempts, at ~2.9% each, and
 * will eventually pass. That is accepted, for three reasons:
 *
 *   1. A user holding a correct written phrase must ALWAYS be able to pass. Any
 *      hard cap risks locking a legitimate user out of the one signal that says
 *      their funds are recoverable — a worse failure than a weak signal.
 *   2. There is no third-party adversary. `backupVerified` authorises nothing;
 *      it only silences a "you have not backed this up" warning. The only person
 *      who benefits from faking it is the device owner, who is defeating their
 *      own safety net, and who already has a one-tap "Skip for now".
 *   3. Grinding is strictly more work than complying. ~128 attempts blind, or
 *      ~16 for someone who has memorised the words but not their order — each
 *      several taps plus a bounce back to the phrase they are pretending to have
 *      copied. See {@link MAX_MISTAKES} for the arithmetic.
 *
 * A cooldown would also not survive the failure path as designed: `onFailed`
 * unmounts the challenge by design, so any in-memory counter resets, and making
 * it stick would mean new persisted state on a security path. Flagged by Codex
 * across two review rounds and knowingly retained.
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

import { sha256 } from '@noble/hashes/sha256';
import { utf8ToBytes } from '@noble/hashes/utils';

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
 *
 * This is the dominant security lever, so the value is not arbitrary. Because
 * the option set for a position is stable (see {@link createOptionProvider}),
 * every tolerated mistake is an elimination, and a guesser needs
 * {@link VERIFICATION_WORD_COUNT} correct picks with at most this many failures
 * anywhere in the run. Drawing without replacement makes each pick worth exactly
 * `1 / candidates`, so the per-attempt pass probability is
 * `C(MAX_MISTAKES + 3, 3) / candidates ** 3`:
 *
 * | tolerated | blind (8 candidates) | knows the word set (4 candidates) |
 * | --------- | -------------------- | --------------------------------- |
 * | 3         | 3.9%  (~26 attempts) | 31.3% (~3 attempts)               |
 * | 1         | 0.78% (~128 attempts)| 6.3%  (~16 attempts)              |
 *
 * Three tolerated mistakes made the challenge cheap for someone who remembers
 * the phrase's words but not their order — exactly the user it must stop, since
 * word order is what makes a phrase recoverable. One tolerated mistake still
 * forgives a fat-finger, and the penalty for a second is a restart, never a
 * lockout.
 */
export const MAX_MISTAKES = 1;

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

/**
 * Returns the canonical option SET for a phrase position.
 *
 * Every presentation of a given position must draw from the SAME set — see
 * {@link createOptionProvider} for why that is a security property and not an
 * optimisation.
 */
export type OptionProvider = (position: number) => string[];

/** Domain separator, so this digest can never be confused with anything else. */
const BOARD_SEED_DOMAIN = 'voi-wallet/mnemonic-quiz/board/v1';

/**
 * sfc32 — a small, fast, well-distributed counter PRNG. Not cryptographic, and
 * it does not need to be: it only decides which decoy words appear and in what
 * order. Its ONLY job is to be reproducible.
 */
function sfc32(a: number, b: number, c: number, d: number): Rng {
  return () => {
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

/**
 * A reproducible rng for one (phrase, position) board.
 *
 * The digest is a ONE-WAY function of the phrase, computed in memory and thrown
 * away with the rng. It is never stored, logged, transmitted, or used as key
 * material — it is not a derivation, it just makes the decoy draw deterministic
 * so the same position always yields the same board. Nothing about the phrase is
 * recoverable from the board: the decoys are wordlist entries, and SHA-256 is
 * preimage-resistant.
 *
 * The alternative — a per-mount random draw — is what made the board
 * intersectable across remounts; see {@link createOptionProvider}.
 */
function createBoardRng(words: string[], position: number): Rng {
  const digest = sha256(
    utf8ToBytes(`${BOARD_SEED_DOMAIN}:${position}:${words.join(' ')}`)
  );
  const seed = (offset: number) =>
    ((digest[offset] << 24) |
      (digest[offset + 1] << 16) |
      (digest[offset + 2] << 8) |
      digest[offset + 3]) >>>
    0;
  return sfc32(seed(0), seed(4), seed(8), seed(12));
}

/**
 * Build an option provider: the canonical board for each phrase position.
 *
 * ## Why this exists — the option-set intersection oracle
 *
 * The first cut of this challenge rebuilt a FRESH board every time a position
 * was re-asked, on the theory that a stable board could be eliminated one chip
 * at a time. That was backwards. The right answer is the one word GUARANTEED to
 * appear on every board for a position, while the decoys are resampled (the
 * BIP-39 ones from 2048 words, so they essentially never recur). Intersecting
 * two boards for the same position therefore names the answer. An attacker could
 * answer wrong on purpose, intersect, and then answer correctly.
 *
 * Memoising per component mount closed that within a mount but not across them:
 * the failure path deliberately unmounts the challenge, so re-entering re-rolled
 * every board, and a "which word is #7?" prompt observed across a handful of
 * re-entries could be intersected just the same — an ORDER-recovery oracle,
 * which is precisely what the challenge is supposed to test.
 *
 * So the board is DERIVED, not drawn: `sha256(domain : position : phrase)` seeds
 * the decoy selection, making the set for a position a pure function of the
 * phrase. Every observation of position 7 — this mount, the next one, next week
 * — returns the identical eight words, so intersecting any number of them
 * returns the set the user could already see, and frequency analysis has nothing
 * to bite on. The Map is then only a cache; correctness comes from determinism.
 * See {@link createBoardRng} for why hashing the phrase here is not a
 * derivation of key material.
 *
 * Only the display ORDER is reshuffled between presentations, and a uniform
 * shuffle of an unchanged set carries no information.
 *
 * Elimination within the mistake budget is the residual. Drawing without
 * replacement from a fixed set makes every guess worth exactly `1 / candidates`
 * no matter how many chips have already been ruled out, so spending a mistake
 * buys a guesser nothing per question — but it does buy them another guess, so
 * the budget itself is what has to be small. See {@link MAX_MISTAKES}.
 */
export function createOptionProvider(words: string[]): OptionProvider {
  const cache = new Map<number, string[]>();
  return (position: number) => {
    const cached = cache.get(position);
    if (cached) return cached;
    const options = buildChallengeOptions(
      words,
      position,
      CHALLENGE_OPTION_COUNT,
      createBoardRng(words, position)
    );
    cache.set(position, options);
    return options;
  };
}

/** Start a fresh attempt: new positions, no mistakes. */
export function startQuizAttempt(
  words: string[],
  optionsFor: OptionProvider,
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
    options: positions.length > 0 ? shuffle(optionsFor(positions[0]), rng) : [],
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
  optionsFor: OptionProvider,
  rng: Rng = Math.random
): QuizAnswer {
  const position = currentPosition(attempt);
  if (position === null) {
    // No question is live — never a pass; rebuild rather than dead-end.
    return {
      status: 'reset',
      attempt: startQuizAttempt(words, optionsFor, rng),
    };
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
        options: shuffle(optionsFor(attempt.positions[nextIndex]), rng),
      },
    };
  }

  const mistakes = attempt.mistakes + 1;
  if (mistakes > MAX_MISTAKES) {
    return {
      status: 'reset',
      attempt: startQuizAttempt(words, optionsFor, rng),
    };
  }

  // Same position, same SET, reshuffled order. The set must not be rebuilt: the
  // answer is the only word guaranteed to survive a rebuild, so two boards for
  // one position would intersect to it. See createOptionProvider.
  return {
    status: 'retry',
    attempt: {
      ...attempt,
      mistakes,
      options: shuffle(optionsFor(position), rng),
    },
  };
}
