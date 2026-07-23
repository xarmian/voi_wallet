/**
 * Test helpers for driving the recovery-phrase challenge (TASK-226).
 *
 * The challenge is deliberately non-deterministic — random positions, random
 * BIP-39 decoys, random chip order — so tests must not pin `Math.random` and
 * assert fixed chip indices the way the old auto-routing board allowed. Instead
 * they read the question off the screen and pick the chip that carries the right
 * word, exactly as a user with a written copy would.
 *
 * SECURITY NOTE: these helpers only read what is already rendered. They never
 * log or persist anything.
 */

import { fireEvent } from '@testing-library/react-native';
import { CHALLENGE_OPTION_COUNT } from '@/components/wallet/mnemonicQuiz';

interface QuizNode {
  props: Record<string, unknown>;
}

/** Minimal slice of the RTL render result these helpers need. */
export interface QuizScreen {
  getByTestId: (testID: string) => QuizNode;
  queryByTestId: (testID: string) => QuizNode | null;
}

function textOf(node: QuizNode): string {
  const children = node.props.children;
  return Array.isArray(children) ? children.join('') : String(children ?? '');
}

/** The phrase position (zero-based) the challenge is currently asking about. */
export function currentQuizPosition(
  screen: QuizScreen,
  prefix: string
): number {
  const text = textOf(screen.getByTestId(`${prefix}-prompt`));
  const match = /#(\d+)/.exec(text);
  if (!match) {
    throw new Error(`Could not read the challenge prompt: "${text}"`);
  }
  return Number(match[1]) - 1;
}

/** How many questions this attempt asks in total. */
export function quizQuestionCount(screen: QuizScreen, prefix: string): number {
  const text = textOf(screen.getByTestId(`${prefix}-progress`));
  const match = /of (\d+)/.exec(text);
  if (!match) {
    throw new Error(`Could not read the challenge progress: "${text}"`);
  }
  return Number(match[1]);
}

/** Press the chip carrying `word`, or throw if it is not on the board. */
export function pressQuizOption(
  screen: QuizScreen,
  prefix: string,
  word: string
): void {
  for (let slot = 0; slot < CHALLENGE_OPTION_COUNT; slot++) {
    const chip = screen.queryByTestId(`${prefix}-option-${slot}`);
    if (chip && chip.props.accessibilityLabel === word) {
      fireEvent.press(chip as never);
      return;
    }
  }
  throw new Error(`No option chip for "${word}" is on the board`);
}

/** Press a chip that is NOT the answer to the current question. */
export function pressWrongQuizOption(
  screen: QuizScreen,
  prefix: string,
  words: string[]
): void {
  const answer = words[currentQuizPosition(screen, prefix)];
  for (let slot = 0; slot < CHALLENGE_OPTION_COUNT; slot++) {
    const chip = screen.queryByTestId(`${prefix}-option-${slot}`);
    if (chip && chip.props.accessibilityLabel !== answer) {
      fireEvent.press(chip as never);
      return;
    }
  }
  throw new Error('Every chip on the board is the correct answer');
}

/**
 * Answer every question correctly, the way a user holding a correct written
 * phrase would. Returns the positions that were asked.
 */
export function completeQuiz(
  screen: QuizScreen,
  prefix: string,
  words: string[]
): number[] {
  const total = quizQuestionCount(screen, prefix);
  const asked: number[] = [];
  for (let question = 0; question < total; question++) {
    const position = currentQuizPosition(screen, prefix);
    asked.push(position);
    pressQuizOption(screen, prefix, words[position]);
  }
  return asked;
}
