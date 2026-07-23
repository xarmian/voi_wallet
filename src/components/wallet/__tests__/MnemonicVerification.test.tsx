/**
 * TASK-45 / DR-12 + TASK-226 — component-level tests for the recovery-phrase
 * challenge.
 *
 * `mnemonicQuiz.test.ts` pins the pure logic; this pins the WIRING:
 *
 * - TASK-226: one DIRECTED question at a time, and a wrong pick is a real,
 *   counted failure. The old board auto-routed taps to the slot they belonged
 *   to, so a wrong tap did nothing and the quiz could be completed by tapping at
 *   random without ever having written the phrase down.
 * - DR-12: a phrase with a repeated word stays answerable at every one of that
 *   word's positions. The original defect lived exactly here — chips were keyed
 *   and disabled by word value and resolved with `indexOf`, so tapping the
 *   second occurrence did nothing and the user could not leave onboarding.
 *
 * SECURITY NOTE: the phrases here are made-up fixtures, not real mnemonics; no
 * key material is derived from them.
 */

import React from 'react';
import { TouchableOpacity } from 'react-native';
import { render, fireEvent, act } from '@testing-library/react-native';

import MnemonicVerification from '../MnemonicVerification';
import {
  CHALLENGE_OPTION_COUNT,
  MAX_MISTAKES,
  VERIFICATION_WORD_COUNT,
} from '../mnemonicQuiz';
import {
  completeQuiz,
  currentQuizPosition,
  pressQuizOption,
  pressWrongQuizOption,
} from '@/__tests__/fixtures/mnemonicQuiz';

jest.mock('@/contexts/ThemeContext', () => ({
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  useTheme: () => ({ theme: require('@/constants/themes').lightTheme }),
}));

const PREFIX = 'mnemonic-verification';

// "abandon" occupies positions 0, 3 and 6.
const REPEATED = 'abandon ability able abandon absent absorb abandon abstract';
const REPEATED_WORDS = REPEATED.split(' ');

const LONG = [
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
].join(' ');
const LONG_WORDS = LONG.split(' ');

/** Shares no word with LONG — used to prove a phrase swap really rebuilds. */
const DISJOINT =
  'zone zero youth young yellow year wrong write world work wolf wisdom';
const DISJOINT_WORDS = DISJOINT.split(' ');

function renderQuiz(
  mnemonic: string,
  props: Partial<React.ComponentProps<typeof MnemonicVerification>> = {}
) {
  const onVerified = props.onVerified ?? jest.fn();
  const screen = render(
    <MnemonicVerification
      mnemonic={mnemonic}
      {...props}
      onVerified={onVerified}
    />
  );
  return { screen, onVerified };
}

describe('MnemonicVerification — directed challenge (TASK-226)', () => {
  it('asks one position at a time and passes only when all are right', () => {
    const { screen, onVerified } = renderQuiz(LONG);

    expect(screen.getByTestId(`${PREFIX}-progress`)).toHaveTextContent(
      `Question 1 of ${VERIFICATION_WORD_COUNT}`
    );
    expect(screen.getByTestId(`${PREFIX}-prompt`)).toHaveTextContent(
      /Which word is #\d+\?/
    );

    const asked = completeQuiz(screen, PREFIX, LONG_WORDS);
    expect(asked).toHaveLength(VERIFICATION_WORD_COUNT);
    expect(new Set(asked).size).toBe(VERIFICATION_WORD_COUNT);
    expect(onVerified).toHaveBeenCalledTimes(1);
  });

  it('shows exactly one correct chip among BIP-39 decoys', () => {
    const { screen } = renderQuiz(LONG);
    const position = currentQuizPosition(screen, PREFIX);

    const labels: string[] = [];
    for (let slot = 0; slot < CHALLENGE_OPTION_COUNT; slot++) {
      labels.push(
        String(
          screen.getByTestId(`${PREFIX}-option-${slot}`).props
            .accessibilityLabel
        )
      );
    }

    expect(labels).toHaveLength(CHALLENGE_OPTION_COUNT);
    expect(new Set(labels).size).toBe(CHALLENGE_OPTION_COUNT);
    expect(labels.filter((w) => w === LONG_WORDS[position])).toHaveLength(1);
    // Decoys are not restricted to the phrase's own words.
    expect(labels.some((w) => !LONG_WORDS.includes(w))).toBe(true);
  });

  it('a wrong pick FAILS — it does not silently fill the slot', () => {
    const onVerified = jest.fn();
    const { screen } = renderQuiz(LONG, { onVerified });

    const position = currentQuizPosition(screen, PREFIX);
    pressWrongQuizOption(screen, PREFIX, LONG_WORDS);

    expect(onVerified).not.toHaveBeenCalled();
    expect(screen.getByTestId(`${PREFIX}-error`)).toBeTruthy();
    // Same question, still question 1 of N — no progress was made.
    expect(currentQuizPosition(screen, PREFIX)).toBe(position);
    expect(screen.getByTestId(`${PREFIX}-progress`)).toHaveTextContent(
      `Question 1 of ${VERIFICATION_WORD_COUNT}`
    );
  });

  it('re-presents a failed question with the SAME chips, not a new set', () => {
    // Rebuilding the board on retry would leak the answer: it is the only chip
    // guaranteed to survive a rebuild, so intersecting the two boards names it.
    // See the intersection-oracle suite in `mnemonicQuiz.test.ts`.
    const { screen } = renderQuiz(LONG);

    const readBoard = () =>
      Array.from({ length: CHALLENGE_OPTION_COUNT }, (_, slot) =>
        String(
          screen.getByTestId(`${PREFIX}-option-${slot}`).props
            .accessibilityLabel
        )
      );

    const before = readBoard();
    const position = currentQuizPosition(screen, PREFIX);
    pressWrongQuizOption(screen, PREFIX, LONG_WORDS);
    const after = readBoard();

    expect(currentQuizPosition(screen, PREFIX)).toBe(position);
    expect([...after].sort()).toEqual([...before].sort());
    // The answer is still reachable — never a dead end.
    expect(after).toContain(LONG_WORDS[position]);
  });

  it('keeps a position’s chips stable across a full restart', () => {
    // Same oracle, across attempts instead of across retries.
    const { screen } = renderQuiz(LONG);

    const readBoard = () =>
      Array.from({ length: CHALLENGE_OPTION_COUNT }, (_, slot) =>
        String(
          screen.getByTestId(`${PREFIX}-option-${slot}`).props
            .accessibilityLabel
        )
      );

    const boards = new Map<number, string[]>();
    for (let pick = 0; pick < 12; pick++) {
      const position = currentQuizPosition(screen, PREFIX);
      const board = [...readBoard()].sort();
      const seen = boards.get(position);
      if (seen) {
        expect(board).toEqual(seen);
      } else {
        boards.set(position, board);
      }
      pressWrongQuizOption(screen, PREFIX, LONG_WORDS);
    }
    // The walk really did span more than one attempt.
    expect(boards.size).toBeGreaterThan(1);
  });

  it('restarts the whole challenge once the mistake budget runs out', () => {
    const onFailed = jest.fn();
    const onVerified = jest.fn();
    const { screen } = renderQuiz(LONG, { onFailed, onVerified });

    for (let mistake = 0; mistake < MAX_MISTAKES; mistake++) {
      pressWrongQuizOption(screen, PREFIX, LONG_WORDS);
      expect(onFailed).not.toHaveBeenCalled();
    }

    pressWrongQuizOption(screen, PREFIX, LONG_WORDS);

    expect(onFailed).toHaveBeenCalledTimes(1);
    expect(onVerified).not.toHaveBeenCalled();
    expect(screen.getByTestId(`${PREFIX}-error`)).toHaveTextContent(
      /started over/i
    );
    expect(screen.getByTestId(`${PREFIX}-progress`)).toHaveTextContent(
      `Question 1 of ${VERIFICATION_WORD_COUNT}`
    );
  });

  it('a restarted challenge is still winnable by someone with the phrase', () => {
    // The lockout guard: friction, never refusal.
    const onVerified = jest.fn();
    const { screen } = renderQuiz(LONG, { onVerified });

    for (let mistake = 0; mistake <= MAX_MISTAKES; mistake++) {
      pressWrongQuizOption(screen, PREFIX, LONG_WORDS);
    }
    expect(onVerified).not.toHaveBeenCalled();

    completeQuiz(screen, PREFIX, LONG_WORDS);
    expect(onVerified).toHaveBeenCalledTimes(1);
  });

  it('keeps correct progress when a later question is missed', () => {
    const { screen } = renderQuiz(LONG);

    pressQuizOption(
      screen,
      PREFIX,
      LONG_WORDS[currentQuizPosition(screen, PREFIX)]
    );
    expect(screen.getByTestId(`${PREFIX}-progress`)).toHaveTextContent(
      `Question 2 of ${VERIFICATION_WORD_COUNT}`
    );

    pressWrongQuizOption(screen, PREFIX, LONG_WORDS);
    // Still on question 2 — a fat-finger does not discard a correct run.
    expect(screen.getByTestId(`${PREFIX}-progress`)).toHaveTextContent(
      `Question 2 of ${VERIFICATION_WORD_COUNT}`
    );
  });

  it('cannot be brute-forced by tapping every chip faster than a re-render', () => {
    // The burst attack: fire every chip on the painted board before React can
    // repaint. Only the FIRST tap may be scored; the rest belong to a board that
    // has already been superseded. Without that guard a user could try all eight
    // options for the cost of a single mistake.
    const onVerified = jest.fn();
    const { screen } = renderQuiz(LONG, { onVerified });

    const answer = LONG_WORDS[currentQuizPosition(screen, PREFIX)];
    // Reach for the composite instances so we can invoke the raw handlers
    // together inside ONE act() — `fireEvent.press` flushes React between taps,
    // which is precisely the repaint a burst outruns.
    const chips = screen
      .UNSAFE_getAllByType(TouchableOpacity)
      .filter((node) =>
        String(node.props.testID ?? '').startsWith(`${PREFIX}-option-`)
      );
    expect(chips).toHaveLength(CHALLENGE_OPTION_COUNT);

    const wrongPresses: (() => void)[] = [];
    let correctPress: (() => void) | null = null;
    for (const chip of chips) {
      const press = chip.props.onPress as () => void;
      if (chip.props.accessibilityLabel === answer) {
        correctPress = press;
      } else {
        wrongPresses.push(press);
      }
    }
    expect(correctPress).not.toBeNull();

    act(() => {
      // One wrong tap lands; everything after it — including the right answer —
      // is a stale board and must be ignored.
      wrongPresses.forEach((press) => press());
      (correctPress as () => void)();
    });

    expect(onVerified).not.toHaveBeenCalled();
    expect(screen.getByTestId(`${PREFIX}-progress`)).toHaveTextContent(
      `Question 1 of ${VERIFICATION_WORD_COUNT}`
    );
    // Exactly ONE mistake was charged for the whole burst: the message counts
    // down from the full budget.
    expect(screen.getByTestId(`${PREFIX}-error`)).toHaveTextContent(
      new RegExp(`${MAX_MISTAKES} more wrong answers?`)
    );
  });

  it('never leaks which phrase position a chip came from', () => {
    // testIDs address the chip's slot on screen only; a testID carrying the
    // phrase index would put the answer in the view tree.
    const { screen } = renderQuiz(LONG);
    for (let slot = 0; slot < CHALLENGE_OPTION_COUNT; slot++) {
      expect(screen.getByTestId(`${PREFIX}-option-${slot}`)).toBeTruthy();
    }
    expect(screen.queryByTestId(`${PREFIX}-option-24`)).toBeNull();
  });
});

describe('MnemonicVerification — repeated words (DR-12)', () => {
  it('is completable for a phrase with a repeated word', () => {
    const { screen, onVerified } = renderQuiz(REPEATED);
    completeQuiz(screen, PREFIX, REPEATED_WORDS);
    expect(onVerified).toHaveBeenCalledTimes(1);
  });

  it('offers exactly one chip for a repeated word, at every position it occupies', () => {
    // Mount repeatedly until every position of the 8-word fixture has been
    // asked — including 0, 3 and 6, the three "abandon" positions that used to
    // be unanswerable. Every question in every run must be unambiguous and
    // answerable, so this is the wiring-level form of the exhaustive
    // DR-12 regression in `mnemonicQuiz.test.ts`.
    const seen = new Set<number>();
    for (let run = 0; run < 300 && seen.size < REPEATED_WORDS.length; run++) {
      const { screen, onVerified } = renderQuiz(REPEATED);

      for (let question = 0; question < VERIFICATION_WORD_COUNT; question++) {
        const position = currentQuizPosition(screen, PREFIX);
        seen.add(position);

        const labels = Array.from(
          { length: CHALLENGE_OPTION_COUNT },
          (_, slot) =>
            String(
              screen.getByTestId(`${PREFIX}-option-${slot}`).props
                .accessibilityLabel
            )
        );
        expect(
          labels.filter((w) => w === REPEATED_WORDS[position])
        ).toHaveLength(1);

        // The answer is accepted at that position, duplicate or not.
        pressQuizOption(screen, PREFIX, REPEATED_WORDS[position]);
      }

      expect(onVerified).toHaveBeenCalledTimes(1);
      screen.unmount();
    }

    expect([...seen].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });
});

describe('MnemonicVerification — escapes and edge cases', () => {
  it('renders a skip control only when onSkip is supplied', () => {
    const { screen: withoutSkip } = renderQuiz(REPEATED);
    expect(withoutSkip.queryByTestId(`${PREFIX}-skip`)).toBeNull();

    const onSkip = jest.fn();
    const { screen: withSkip } = renderQuiz(REPEATED, { onSkip });
    fireEvent.press(withSkip.getByTestId(`${PREFIX}-skip`));
    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it('never auto-passes when there is no phrase to ask about', () => {
    const onVerified = jest.fn();
    const onSkip = jest.fn();
    const { screen } = renderQuiz('', { onVerified, onSkip });

    expect(screen.getByTestId(`${PREFIX}-unavailable`)).toBeTruthy();
    expect(screen.queryByTestId(`${PREFIX}-prompt`)).toBeNull();
    expect(onVerified).not.toHaveBeenCalled();
    // The escape hatch is still reachable, so this is not a dead end.
    expect(screen.getByTestId(`${PREFIX}-skip`)).toBeTruthy();
  });

  it('rebuilds the challenge if the host swaps the phrase', () => {
    // Otherwise the board would keep asking about a phrase that is no longer on
    // screen — an unwinnable challenge, i.e. exactly the lockout class DR-12
    // exists to prevent.
    const onVerified = jest.fn();
    const screen = render(
      <MnemonicVerification mnemonic={LONG} onVerified={onVerified} />
    );

    screen.rerender(
      <MnemonicVerification mnemonic={DISJOINT} onVerified={onVerified} />
    );

    // DISJOINT shares no word with LONG, so this only passes if the challenge
    // was actually rebuilt around the new phrase.
    completeQuiz(screen, PREFIX, DISJOINT_WORDS);
    expect(onVerified).toHaveBeenCalledTimes(1);
  });
});
