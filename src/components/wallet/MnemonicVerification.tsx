/**
 * MnemonicVerification — the recovery-phrase confirmation challenge
 * (TASK-45, strengthened by TASK-226).
 *
 * Renders CONTENT ONLY (no SafeAreaView / header / background) so it can be
 * embedded by all three hosts:
 *   - `CreateWalletScreen` (first-wallet onboarding), inside NFTBackground
 *   - `MnemonicBackupFlow` (add-account), inside its own header + ScrollView
 *   - `VerifyBackupScreen` (post-hoc "verify my backup"), from the Home banner
 *
 * ## The challenge
 *
 * One DIRECTED question at a time — "which word is #7?" — answered from
 * {@link CHALLENGE_OPTION_COUNT} chips, exactly one of which is right. Decoys
 * come from the BIP-39 wordlist, some of them from the phrase's own other words
 * so a shoulder-surfer cannot tell real words from filler and someone who only
 * remembers the phrase's word set cannot pick "the familiar one". All selection
 * and option-building logic lives in `./mnemonicQuiz`; see that module for the
 * full rationale, including how the DR-12 duplicate-word lockout is now
 * structurally impossible.
 *
 * This replaces the original auto-routing board (fixed in TASK-226): a tapped
 * chip used to be routed to whichever slot it belonged to, so a wrong tap was a
 * silent no-op and the bank held only the phrase's own words — meaning the quiz
 * could be completed by tapping chips at random, without ever having written the
 * phrase down. `backupVerified` is load-bearing for a fund-loss guarantee, so it
 * must not be obtainable that way.
 *
 * ## Wrong answers, and why there is no lockout
 *
 * A wrong pick costs a mistake and re-presents the same position with a fresh
 * option set. After `MAX_MISTAKES` tolerated mistakes the next wrong pick throws
 * the whole attempt away and calls `onFailed`, which onboarding uses to send the
 * user back to re-read the phrase.
 *
 * There is deliberately no permanent lockout: a user holding a correct written
 * phrase must ALWAYS be able to pass, and "Skip for now" already exists as a
 * first-class escape that records `backupVerified: false`. So blind guessing is
 * bounded by friction rather than refusal — with 8 options, 3 questions and one
 * tolerated mistake, a user who knows nothing passes an attempt with probability
 * ~0.78% (~128 attempts), and one who has memorised the phrase's words but not
 * their order with ~6.3% (~16 attempts) — each attempt bouncing them back
 * through the phrase they are pretending to have written down. That is strictly
 * more work than reading it, which is the whole point. `MAX_MISTAKES` carries
 * the arithmetic and is the lever that sets those numbers.
 *
 * ## Residuals, knowingly accepted
 *
 * Attempts are not capped, and a lucky guess teaches the guesser one (word,
 * position) pair, so repeated attempts are not fully independent. Every
 * challenge of this shape — Pera's and MetaMask's included — has that property:
 * telling the user whether they were right is the whole mechanism. Both were
 * raised by Codex across two review rounds and are retained deliberately; see
 * "Attempts are NOT capped" in `./mnemonicQuiz` for the full reasoning and for
 * why a cooldown does not survive this failure path.
 *
 * The phrase is only ever held in this component's props (it is already on
 * screen in the host). Nothing here logs, persists, or navigates with it, and no
 * testID or accessibility label exposes which phrase position a chip came from.
 */

import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { useTheme } from '@/contexts/ThemeContext';
import {
  answerCurrentChallenge,
  createOptionProvider,
  currentPosition,
  remainingMistakes,
  splitMnemonic,
  startQuizAttempt,
  VERIFICATION_WORD_COUNT,
  type OptionProvider,
  type QuizAttempt,
} from './mnemonicQuiz';

export interface MnemonicVerificationProps {
  /** The phrase being verified. Display-only; never persisted or logged. */
  mnemonic: string;
  /** Called once the user answers every question correctly. */
  onVerified: () => void;
  /**
   * Called when the mistake budget is exhausted and the challenge restarts.
   * Hosts that can show the phrase again should do so — the component has
   * already rebuilt itself either way, so this is never a dead end.
   */
  onFailed?: () => void;
  /** When provided, renders a "Skip for now" escape (DR-2). */
  onSkip?: () => void;
  /** Label for the skip control. */
  skipLabel?: string;
  /** Optional testID prefix so multiple hosts can address their own instance. */
  testIDPrefix?: string;
}

export default function MnemonicVerification({
  mnemonic,
  onVerified,
  onFailed,
  onSkip,
  skipLabel = 'Skip for now',
  testIDPrefix = 'mnemonic-verification',
}: MnemonicVerificationProps) {
  const { theme } = useTheme();

  // One memoised option provider per mount. Each position's board is built once
  // and then re-presented (reshuffled) for the whole mount, including across a
  // restart — rebuilding it would let a user intersect two boards for the same
  // position and read off the answer, since only the answer is guaranteed to
  // survive a rebuild. See `createOptionProvider`.
  const [initial] = useState(() => {
    const words = splitMnemonic(mnemonic);
    const optionsFor = createOptionProvider(words);
    return { optionsFor, attempt: startQuizAttempt(words, optionsFor) };
  });
  const optionsForRef = useRef<OptionProvider>(initial.optionsFor);

  const [attempt, setAttempt] = useState<QuizAttempt>(initial.attempt);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // `attempt` is also mirrored in a ref so a burst of taps is resolved against
  // the LATEST board rather than the one React last painted. Without this, a
  // user could tap several chips faster than a re-render and have every one of
  // them scored against the same board — i.e. try multiple options for a single
  // question at the cost of one mistake. The ref holds only what is already on
  // screen; the phrase itself is never stored.
  const attemptRef = useRef(attempt);
  const applyAttempt = (next: QuizAttempt) => {
    attemptRef.current = next;
    setAttempt(next);
  };

  // If the host swaps the phrase under us, rebuild rather than keep asking about
  // a phrase that is no longer on screen — that would be an unwinnable board.
  // The ref only skips the initial run.
  const isFirstRun = useRef(true);
  useEffect(() => {
    if (isFirstRun.current) {
      isFirstRun.current = false;
      return;
    }
    const words = splitMnemonic(mnemonic);
    // A different phrase means every cached board is stale.
    optionsForRef.current = createOptionProvider(words);
    applyAttempt(startQuizAttempt(words, optionsForRef.current));
    setErrorMessage(null);
    // `applyAttempt` is recreated every render by design; the phrase is the only
    // input that should re-run this.
  }, [mnemonic]);

  const position = currentPosition(attempt);

  const renderSkip = () =>
    onSkip ? (
      <TouchableOpacity
        testID={`${testIDPrefix}-skip`}
        accessibilityRole="button"
        accessibilityLabel={skipLabel}
        style={styles.skipButton}
        onPress={onSkip}
      >
        <Text style={[styles.skipButtonText, { color: theme.colors.primary }]}>
          {skipLabel}
        </Text>
      </TouchableOpacity>
    ) : null;

  if (position === null) {
    // No phrase to ask about. Never silently "pass" — say so and leave the skip
    // escape available so the user is not stuck.
    return (
      <View testID={`${testIDPrefix}-root`}>
        <Text
          testID={`${testIDPrefix}-unavailable`}
          accessibilityRole="alert"
          style={[styles.error, { color: theme.colors.error }]}
        >
          Your recovery phrase is not available to confirm right now.
        </Text>
        {renderSkip()}
      </View>
    );
  }

  /**
   * `board` is the attempt object the pressed chip was rendered from. A chip
   * belonging to a superseded board is ignored — that is a stale render, not an
   * answer, and it can never be a correct one (the answer always exists on the
   * live board). This is the double-tap / burst-tap guard, not an answer path.
   */
  const handlePick = (board: QuizAttempt, word: string) => {
    if (board !== attemptRef.current) return;

    const askedPosition = currentPosition(board);
    if (askedPosition === null) return;

    const words = splitMnemonic(mnemonic);
    const result = answerCurrentChallenge(
      board,
      words,
      word,
      optionsForRef.current
    );

    switch (result.status) {
      case 'verified':
        // Rebuild first: the ref move makes any queued tap stale (so `onVerified`
        // cannot fire twice), and a host that keeps this mounted after success —
        // e.g. the user dismisses the confirmation alert — gets a live challenge
        // back instead of an inert board.
        applyAttempt(startQuizAttempt(words, optionsForRef.current));
        setErrorMessage(null);
        onVerified();
        return;
      case 'advanced':
        setErrorMessage(null);
        applyAttempt(result.attempt);
        return;
      case 'retry': {
        const untilRestart = remainingMistakes(result.attempt) + 1;
        applyAttempt(result.attempt);
        setErrorMessage(
          `That is not word #${askedPosition + 1}. Check your written copy — ${untilRestart} more wrong ${untilRestart === 1 ? 'answer' : 'answers'} will restart this check.`
        );
        return;
      }
      case 'reset':
        applyAttempt(result.attempt);
        setErrorMessage(
          'Too many incorrect answers. Check your written recovery phrase — the check has started over.'
        );
        onFailed?.();
        return;
    }
  };

  const questionNumber = attempt.currentIndex + 1;
  const totalQuestions = attempt.positions.length || VERIFICATION_WORD_COUNT;

  return (
    <View testID={`${testIDPrefix}-root`}>
      <Text style={[styles.title, { color: theme.colors.text }]}>
        Confirm your recovery phrase
      </Text>
      <Text style={[styles.subtitle, { color: theme.colors.textSecondary }]}>
        Using your written copy, pick the word that belongs at each position. A
        wrong answer does not count.
      </Text>

      <Text
        testID={`${testIDPrefix}-progress`}
        style={[styles.progress, { color: theme.colors.textSecondary }]}
      >
        {`Question ${questionNumber} of ${totalQuestions}`}
      </Text>

      <Text
        testID={`${testIDPrefix}-prompt`}
        accessibilityRole="header"
        style={[styles.prompt, { color: theme.colors.text }]}
      >
        {`Which word is #${position + 1}?`}
      </Text>

      <View style={styles.optionsContainer}>
        {attempt.options.map((word, slot) => (
          <TouchableOpacity
            // Keyed and identified by the chip's slot on screen, never by the
            // word or by its position in the phrase — a testID or key carrying
            // the phrase index would leak the answer into the view tree.
            key={`${attempt.currentIndex}-${attempt.mistakes}-${slot}`}
            testID={`${testIDPrefix}-option-${slot}`}
            accessibilityRole="button"
            accessibilityLabel={word}
            style={[
              styles.option,
              {
                backgroundColor: theme.colors.card,
                borderColor: theme.colors.border,
              },
            ]}
            onPress={() => handlePick(attempt, word)}
          >
            <Text style={[styles.optionText, { color: theme.colors.text }]}>
              {word}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {errorMessage !== null && (
        <Text
          testID={`${testIDPrefix}-error`}
          accessibilityRole="alert"
          style={[styles.error, { color: theme.colors.error }]}
        >
          {errorMessage}
        </Text>
      )}

      {renderSkip()}
    </View>
  );
}

const styles = StyleSheet.create({
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    marginBottom: 10,
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 16,
    marginBottom: 24,
    textAlign: 'center',
    lineHeight: 22,
  },
  progress: {
    fontSize: 14,
    fontWeight: '600',
    textAlign: 'center',
    marginBottom: 8,
  },
  prompt: {
    fontSize: 20,
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: 24,
  },
  optionsContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    marginBottom: 20,
  },
  option: {
    width: '48%',
    borderRadius: 8,
    paddingVertical: 14,
    paddingHorizontal: 10,
    marginBottom: 12,
    alignItems: 'center',
    borderWidth: 1,
  },
  optionText: {
    fontSize: 15,
    fontWeight: '500',
  },
  error: {
    fontSize: 14,
    marginBottom: 16,
    textAlign: 'center',
    lineHeight: 20,
  },
  skipButton: {
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 8,
  },
  skipButtonText: {
    fontSize: 16,
    fontWeight: '600',
  },
});
