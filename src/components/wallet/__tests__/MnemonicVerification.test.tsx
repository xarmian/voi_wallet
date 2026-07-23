/**
 * TASK-45 / DR-12 — component-level regression test for the verification quiz.
 *
 * `mnemonicQuiz.test.ts` pins the pure logic; this pins the WIRING, which is
 * where the original defect lived: chips were keyed/disabled by word value and
 * resolved with `indexOf`, so tapping the second occurrence of a repeated word
 * did nothing at all and the user could not leave onboarding.
 *
 * SECURITY NOTE: the phrases here are made-up fixtures, not real mnemonics; no
 * key material is derived from them.
 */

import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';

import MnemonicVerification from '../MnemonicVerification';

jest.mock('@/contexts/ThemeContext', () => ({
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  useTheme: () => ({ theme: require('@/constants/themes').lightTheme }),
}));

// "abandon" occupies positions 0, 3 and 6.
const REPEATED = 'abandon ability able abandon absent absorb abandon abstract';
const WORDS = REPEATED.split(' ');

/**
 * Force the quiz onto a known target triple by pinning Math.random. The
 * component picks positions via `Math.floor(Math.random() * total)`, so feeding
 * it `pos / total` yields exactly `pos`. The shuffle consumes the remaining
 * values; any leftovers just produce some deterministic chip order.
 */
function withTargets<T>(targets: number[], total: number, run: () => T): T {
  const queue = targets.map((pos) => pos / total);
  const spy = jest
    .spyOn(Math, 'random')
    .mockImplementation(() => (queue.length > 0 ? queue.shift()! : 0));
  try {
    return run();
  } finally {
    spy.mockRestore();
  }
}

describe('MnemonicVerification — repeated words (DR-12)', () => {
  it("completes when a repeated word's LATER position is a target", () => {
    const onVerified = jest.fn();

    // Targets 1, 4, 6 — position 6 is the THIRD "abandon". Under the old
    // indexOf() resolution this tap computed position 0, which is not a target,
    // so nothing was selected and "Verify Words" stayed permanently disabled.
    const screen = withTargets([1, 4, 6], WORDS.length, () =>
      render(
        <MnemonicVerification mnemonic={REPEATED} onVerified={onVerified} />
      )
    );

    for (const index of [1, 4, 6]) {
      fireEvent.press(
        screen.getByTestId(`mnemonic-verification-option-${index}`)
      );
    }

    // Each slot shows the right word, including the duplicate.
    expect(
      screen.getByTestId('mnemonic-verification-slot-6')
    ).toHaveTextContent('abandon');

    fireEvent.press(screen.getByTestId('mnemonic-verification-verify'));
    expect(onVerified).toHaveBeenCalledTimes(1);
  });

  it('accepts the OTHER duplicate chip for the same slot', () => {
    const onVerified = jest.fn();

    // Only position 6 holds a target "abandon", but the user taps the chip at
    // position 0. The chips are visually identical, so that tap must land.
    const screen = withTargets([1, 4, 6], WORDS.length, () =>
      render(
        <MnemonicVerification mnemonic={REPEATED} onVerified={onVerified} />
      )
    );

    fireEvent.press(screen.getByTestId('mnemonic-verification-option-1'));
    fireEvent.press(screen.getByTestId('mnemonic-verification-option-4'));
    fireEvent.press(screen.getByTestId('mnemonic-verification-option-0'));

    expect(
      screen.getByTestId('mnemonic-verification-slot-6')
    ).toHaveTextContent('abandon');

    fireEvent.press(screen.getByTestId('mnemonic-verification-verify'));
    expect(onVerified).toHaveBeenCalledTimes(1);
  });

  it('disables only the CONSUMED chip, not every chip with the same word', () => {
    const screen = withTargets([1, 4, 6], WORDS.length, () =>
      render(
        <MnemonicVerification mnemonic={REPEATED} onVerified={jest.fn()} />
      )
    );

    fireEvent.press(screen.getByTestId('mnemonic-verification-option-6'));

    expect(
      screen.getByTestId('mnemonic-verification-option-6').props
        .accessibilityState
    ).toEqual(expect.objectContaining({ disabled: true }));
    // The other "abandon" chips remain live.
    expect(
      screen.getByTestId('mnemonic-verification-option-0').props
        .accessibilityState
    ).toEqual(expect.objectContaining({ disabled: false }));
    expect(
      screen.getByTestId('mnemonic-verification-option-3').props
        .accessibilityState
    ).toEqual(expect.objectContaining({ disabled: false }));
  });

  it('lets the user clear a slot and re-answer', () => {
    const screen = withTargets([1, 4, 6], WORDS.length, () =>
      render(
        <MnemonicVerification mnemonic={REPEATED} onVerified={jest.fn()} />
      )
    );

    fireEvent.press(screen.getByTestId('mnemonic-verification-option-1'));
    expect(
      screen.getByTestId('mnemonic-verification-slot-1')
    ).toHaveTextContent(WORDS[1]);

    fireEvent.press(screen.getByTestId('mnemonic-verification-slot-1'));
    expect(
      screen.getByTestId('mnemonic-verification-slot-1')
    ).toHaveTextContent('Tap a word below');
  });
});

describe('MnemonicVerification — outcomes', () => {
  it('cannot report success until every slot is filled', () => {
    const onVerified = jest.fn();

    const screen = withTargets([1, 4, 6], WORDS.length, () =>
      render(
        <MnemonicVerification mnemonic={REPEATED} onVerified={onVerified} />
      )
    );

    expect(
      screen.getByTestId('mnemonic-verification-verify').props
        .accessibilityState
    ).toEqual(expect.objectContaining({ disabled: true }));
    fireEvent.press(screen.getByTestId('mnemonic-verification-verify'));
    expect(onVerified).not.toHaveBeenCalled();

    fireEvent.press(screen.getByTestId('mnemonic-verification-option-1'));
    fireEvent.press(screen.getByTestId('mnemonic-verification-option-4'));
    expect(
      screen.getByTestId('mnemonic-verification-verify').props
        .accessibilityState
    ).toEqual(expect.objectContaining({ disabled: true }));
    fireEvent.press(screen.getByTestId('mnemonic-verification-verify'));
    expect(onVerified).not.toHaveBeenCalled();

    fireEvent.press(screen.getByTestId('mnemonic-verification-option-6'));
    fireEvent.press(screen.getByTestId('mnemonic-verification-verify'));
    expect(onVerified).toHaveBeenCalledTimes(1);
  });

  it('tapping a word that belongs to no target slot does nothing', () => {
    // Documents the auto-routing contract: a non-target chip is inert rather
    // than filling a slot with a wrong answer. See the KNOWN LIMITATION note on
    // the component — this is why `verified` is weaker than a pick-for-slot
    // challenge, and is preserved deliberately per DR-12.
    const screen = withTargets([1, 4, 6], WORDS.length, () =>
      render(
        <MnemonicVerification mnemonic={REPEATED} onVerified={jest.fn()} />
      )
    );

    fireEvent.press(screen.getByTestId('mnemonic-verification-option-5'));
    expect(
      screen.getByTestId('mnemonic-verification-slot-1')
    ).toHaveTextContent('Tap a word below');
    expect(
      screen.getByTestId('mnemonic-verification-slot-4')
    ).toHaveTextContent('Tap a word below');
    expect(
      screen.getByTestId('mnemonic-verification-slot-6')
    ).toHaveTextContent('Tap a word below');
  });

  it('renders a skip control only when onSkip is supplied', () => {
    const withoutSkip = withTargets([1, 4, 6], WORDS.length, () =>
      render(
        <MnemonicVerification mnemonic={REPEATED} onVerified={jest.fn()} />
      )
    );
    expect(withoutSkip.queryByTestId('mnemonic-verification-skip')).toBeNull();

    const onSkip = jest.fn();
    const withSkip = withTargets([1, 4, 6], WORDS.length, () =>
      render(
        <MnemonicVerification
          mnemonic={REPEATED}
          onVerified={jest.fn()}
          onSkip={onSkip}
        />
      )
    );
    fireEvent.press(withSkip.getByTestId('mnemonic-verification-skip'));
    expect(onSkip).toHaveBeenCalledTimes(1);
  });
});
