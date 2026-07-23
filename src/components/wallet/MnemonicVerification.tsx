/**
 * MnemonicVerification — the "confirm 3 words" recovery-phrase quiz (TASK-45).
 *
 * Renders CONTENT ONLY (no SafeAreaView / header / background) so it can be
 * embedded by both hosts:
 *   - `MnemonicBackupFlow` (add-account), inside its own header + ScrollView
 *   - `CreateWalletScreen` (first-wallet onboarding), inside NFTBackground
 *
 * All selection logic lives in `./mnemonicQuiz` and is position-indexed
 * per DR-12 — see that module for why a value-indexed quiz could hard-lock a
 * user out of onboarding.
 *
 * The phrase is only ever held in this component's props (it is already on
 * screen in the host). Nothing here logs, persists, or navigates with it.
 *
 * ## KNOWN LIMITATION — the quiz auto-routes taps
 *
 * A tapped chip is routed to the slot it belongs to, so a wrong tap is a no-op
 * rather than a wrong answer. That means the quiz is passable by tapping chips
 * until the slots fill, WITHOUT having written the phrase down — `verified` is
 * therefore weaker evidence than a Pera/MetaMask-style "pick the word for slot
 * N" challenge, where a wrong pick actually fails.
 *
 * This behaviour is inherited from the pre-existing quiz and is preserved
 * deliberately: DR-12 prescribes exactly "carry {word, index} through selection
 * and disable by index, not value", i.e. keep the auto-routing and fix the
 * duplicate-word lockout. Strengthening the challenge is a separate UX/security
 * decision and is raised as a follow-up rather than taken unilaterally here.
 */

import React, { useMemo, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { useTheme } from '@/contexts/ThemeContext';
import {
  buildWordOptions,
  clearWordSelection,
  isVerificationComplete,
  pickVerificationPositions,
  selectWordOption,
  shuffleWordOptions,
  splitMnemonic,
  usedOptionIndices,
  verifySelections,
  type WordSelections,
} from './mnemonicQuiz';

export interface MnemonicVerificationProps {
  /** The phrase being verified. Display-only; never persisted or logged. */
  mnemonic: string;
  /** Called once the user selects all target words correctly. */
  onVerified: () => void;
  /**
   * Called on a wrong answer. When omitted the component just clears the
   * selections and lets the user retry in place.
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

  const mnemonicWords = useMemo(() => splitMnemonic(mnemonic), [mnemonic]);

  // Both the target positions and the chip order are impure (Math.random), so
  // they must be memoized on the stable `mnemonic` string — otherwise they would
  // be recomputed on every render and the quiz would reshuffle under the user's
  // finger as soon as they tapped a word.
  const verificationWords = useMemo(
    () => pickVerificationPositions(mnemonicWords.length),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mnemonic]
  );
  const shuffledOptions = useMemo(
    () => shuffleWordOptions(buildWordOptions(mnemonic)),
    [mnemonic]
  );

  const [selections, setSelections] = useState<WordSelections>({});
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const used = usedOptionIndices(selections);
  const complete = isVerificationComplete(verificationWords, selections);

  const handleVerify = () => {
    if (verifySelections(verificationWords, selections, mnemonicWords)) {
      setErrorMessage(null);
      onVerified();
      return;
    }
    // Wrong answer: always clear so the user gets a clean retry rather than
    // being stuck staring at a full, rejected board.
    setSelections({});
    setErrorMessage(
      'That does not match your recovery phrase. Check your written copy and try again.'
    );
    onFailed?.();
  };

  return (
    <View testID={`${testIDPrefix}-root`}>
      <Text style={[styles.title, { color: theme.colors.text }]}>
        Confirm your recovery phrase
      </Text>
      <Text style={[styles.subtitle, { color: theme.colors.textSecondary }]}>
        Tap the words below to fill in the missing positions from your written
        copy.
      </Text>

      <View style={styles.slotsContainer}>
        {verificationWords.map((position) => {
          const selection = selections[position];
          return (
            <View key={position} style={styles.slotRow}>
              <Text style={[styles.slotLabel, { color: theme.colors.text }]}>
                Word #{position + 1}
              </Text>
              <TouchableOpacity
                testID={`${testIDPrefix}-slot-${position}`}
                accessibilityRole="button"
                accessibilityLabel={
                  selection
                    ? `Word ${position + 1}, ${selection.word}. Tap to clear.`
                    : `Word ${position + 1}, empty. Select a word below.`
                }
                style={[
                  styles.slot,
                  {
                    backgroundColor: theme.colors.card,
                    borderColor: theme.colors.border,
                  },
                  selection !== undefined && {
                    borderColor: theme.colors.primary,
                    backgroundColor: theme.colors.primaryLight,
                  },
                ]}
                // Tapping a filled slot clears it — without this, a mis-tap on a
                // duplicate word would leave the user unable to change an answer.
                onPress={() =>
                  setSelections((prev) => clearWordSelection(position, prev))
                }
                disabled={selection === undefined}
              >
                <Text
                  style={[
                    styles.slotText,
                    { color: theme.colors.textSecondary },
                    selection !== undefined && { color: theme.colors.primary },
                  ]}
                >
                  {selection?.word ?? 'Tap a word below'}
                </Text>
              </TouchableOpacity>
            </View>
          );
        })}
      </View>

      <View style={styles.optionsContainer}>
        {shuffledOptions.map((option) => {
          const isUsed = used.has(option.index);
          return (
            <TouchableOpacity
              // DR-12: keyed and disabled by POSITION, never by word value, so a
              // repeated word yields two independently addressable chips.
              key={option.index}
              testID={`${testIDPrefix}-option-${option.index}`}
              accessibilityRole="button"
              accessibilityLabel={option.word}
              accessibilityState={{ disabled: isUsed }}
              style={[
                styles.option,
                {
                  backgroundColor: theme.colors.card,
                  borderColor: theme.colors.border,
                },
                isUsed && {
                  backgroundColor: theme.colors.surface,
                  borderColor: theme.colors.disabled,
                },
              ]}
              onPress={() => {
                setErrorMessage(null);
                setSelections((prev) =>
                  selectWordOption(
                    option,
                    verificationWords,
                    prev,
                    mnemonicWords
                  )
                );
              }}
              disabled={isUsed}
            >
              <Text
                style={[
                  styles.optionText,
                  { color: theme.colors.text },
                  isUsed && { color: theme.colors.textSecondary },
                ]}
              >
                {option.word}
              </Text>
            </TouchableOpacity>
          );
        })}
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

      <TouchableOpacity
        testID={`${testIDPrefix}-verify`}
        accessibilityRole="button"
        accessibilityLabel="Verify words"
        accessibilityState={{ disabled: !complete }}
        style={[
          styles.verifyButton,
          {
            backgroundColor: complete
              ? theme.colors.primary
              : theme.colors.disabled,
          },
        ]}
        onPress={handleVerify}
        disabled={!complete}
      >
        <Text
          style={[styles.verifyButtonText, { color: theme.colors.background }]}
        >
          Verify Words
        </Text>
      </TouchableOpacity>

      {onSkip && (
        <TouchableOpacity
          testID={`${testIDPrefix}-skip`}
          accessibilityRole="button"
          accessibilityLabel={skipLabel}
          style={styles.skipButton}
          onPress={onSkip}
        >
          <Text
            style={[styles.skipButtonText, { color: theme.colors.primary }]}
          >
            {skipLabel}
          </Text>
        </TouchableOpacity>
      )}
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
    marginBottom: 30,
    textAlign: 'center',
    lineHeight: 22,
  },
  slotsContainer: {
    marginBottom: 30,
  },
  slotRow: {
    marginBottom: 15,
  },
  slotLabel: {
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 8,
  },
  slot: {
    borderWidth: 2,
    borderStyle: 'dashed',
    borderRadius: 10,
    paddingVertical: 15,
    paddingHorizontal: 20,
    alignItems: 'center',
  },
  slotText: {
    fontSize: 16,
  },
  optionsContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    marginBottom: 20,
  },
  option: {
    width: '30%',
    borderRadius: 8,
    paddingVertical: 12,
    paddingHorizontal: 10,
    marginBottom: 10,
    alignItems: 'center',
    borderWidth: 1,
  },
  optionText: {
    fontSize: 14,
    fontWeight: '500',
  },
  error: {
    fontSize: 14,
    marginBottom: 16,
    textAlign: 'center',
    lineHeight: 20,
  },
  verifyButton: {
    paddingVertical: 15,
    paddingHorizontal: 30,
    borderRadius: 10,
  },
  verifyButtonText: {
    fontSize: 18,
    fontWeight: '600',
    textAlign: 'center',
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
