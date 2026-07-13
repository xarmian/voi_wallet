import React, { useState, useMemo, useRef, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import MnemonicDisplay from './MnemonicDisplay';
import { useTheme } from '@/contexts/ThemeContext';
import { useSecureScreen } from '@/hooks/useSecureScreen';
import {
  scheduleClipboardClear,
  ClipboardClearHandle,
} from '@/utils/clipboardAutoClear';

interface MnemonicBackupFlowProps {
  mnemonic: string;
  onBackupConfirmed: () => void;
  title?: string;
  subtitle?: string;
  showCopyOption?: boolean;
  requireVerification?: boolean;
  onBack?: () => void;
}

export default function MnemonicBackupFlow({
  mnemonic,
  onBackupConfirmed,
  title = 'Your Recovery Phrase',
  subtitle = 'Your recovery phrase is the key to your wallet. Keep it safe and secure.',
  showCopyOption = false,
  requireVerification = false,
  onBack,
}: MnemonicBackupFlowProps) {
  const [hasCopied, setHasCopied] = useState(false);
  const [isVerificationStep, setIsVerificationStep] = useState(false);
  const [verificationWords, setVerificationWords] = useState<number[]>([]);
  const [selectedWords, setSelectedWords] = useState<{ [key: number]: string }>(
    {}
  );
  const { theme } = useTheme();
  const clipboardClearRef = useRef<ClipboardClearHandle | null>(null);
  const mountedRef = useRef(true);
  // Monotonic per-copy token: only the latest tap's continuation is allowed to
  // install/keep a clear handle, so a superseded copy can't leak a timer.
  const copyGenRef = useRef(0);
  // Id of the ~3s "Copied!" UI reset timer, so we can clear it on unmount.
  const hasCopiedTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined
  );

  // Block OS screenshots / screen recordings for as long as the recovery phrase
  // is displayed. This component-level guard covers every host screen that
  // renders the backup flow; it is idempotent with any guard the host also
  // applies (each guard uses a unique key — see useSecureScreen).
  useSecureScreen();

  // On unmount, wipe the recovery phrase from the clipboard if it's still there
  // (and cancel the pending auto-clear timer).
  useEffect(() => {
    return () => {
      // Mark unmounted so an in-flight handleCopy wipes the clipboard itself
      // instead of scheduling a timer that would outlive this component.
      mountedRef.current = false;
      clipboardClearRef.current?.clearNow();
      clipboardClearRef.current = null;
      // Clear the pending "Copied!" UI reset timer so it can't fire after unmount.
      if (hasCopiedTimeoutRef.current) {
        clearTimeout(hasCopiedTimeoutRef.current);
      }
    };
  }, []);

  const mnemonicWords = mnemonic.split(' ');

  // Shuffle the verification word bank ONCE per mnemonic. The shuffle uses
  // Math.random() (impure), so it must be explicitly stabilized — otherwise it
  // re-runs on every render and the word buttons jump around each time the user
  // taps one (setSelectedWords triggers a re-render). Keyed on the stable
  // `mnemonic` string, not the per-render mnemonicWords array.
  const shuffledWords = useMemo(
    () => mnemonic.split(' ').sort(() => Math.random() - 0.5),
    [mnemonic]
  );

  const handleCopy = async () => {
    // Serialize concurrent copies: this tap's generation token. Only the copy
    // whose token is still current after the await may install a clear handle.
    const gen = ++copyGenRef.current;

    // Cancel any previously scheduled clear before we overwrite the clipboard,
    // so a stale handle can never wipe the freshly copied content.
    clipboardClearRef.current?.cancel();
    clipboardClearRef.current = null;

    try {
      await Clipboard.setStringAsync(mnemonic);

      // A newer copy superseded this one while we awaited → do nothing (the
      // newer tap owns the clipboard + its clear handle; bailing here avoids a
      // double-schedule / leaked timer).
      if (gen !== copyGenRef.current) return;

      if (!mountedRef.current) {
        // Unmounted mid-copy: the phrase is now on the clipboard but our unmount
        // cleanup has already run. Wipe it now (check-then-clear) and don't
        // schedule a timer that would outlive this component.
        void scheduleClipboardClear(mnemonic, 0).clearNow();
        return;
      }

      setHasCopied(true);
      Alert.alert('Copied!', 'Recovery phrase copied to clipboard');

      // Auto-clear the recovery phrase from the OS clipboard after 60s unless
      // the user copied something else in the meantime. The generation token
      // above guarantees no newer copy ran during our await, so this handle is
      // the only live one.
      clipboardClearRef.current = scheduleClipboardClear(mnemonic);

      hasCopiedTimeoutRef.current = setTimeout(() => setHasCopied(false), 3000);
    } catch (error) {
      Alert.alert('Error', 'Failed to copy to clipboard');
    }
  };

  const startVerification = () => {
    // Select 3 random word positions for verification
    const positions: number[] = [];
    while (positions.length < 3) {
      const randomPos = Math.floor(Math.random() * mnemonicWords.length);
      if (!positions.includes(randomPos)) {
        positions.push(randomPos);
      }
    }
    setVerificationWords(positions.sort((a, b) => a - b));
    setSelectedWords({});
    setIsVerificationStep(true);
  };

  const handleWordSelection = (position: number, word: string) => {
    setSelectedWords((prev) => ({
      ...prev,
      [position]: word,
    }));
  };

  const verifyWords = () => {
    let allCorrect = true;
    for (const position of verificationWords) {
      if (selectedWords[position] !== mnemonicWords[position]) {
        allCorrect = false;
        break;
      }
    }

    if (allCorrect) {
      Alert.alert(
        'Verification Successful!',
        'You have successfully backed up your recovery phrase.',
        [{ text: 'Continue', onPress: onBackupConfirmed }]
      );
    } else {
      Alert.alert(
        'Verification Failed',
        'Some words are incorrect. Please try again.',
        [{ text: 'Try Again', onPress: () => setIsVerificationStep(false) }]
      );
    }
  };

  const handleContinue = () => {
    if (requireVerification) {
      startVerification();
    } else {
      Alert.alert(
        'Backup Confirmation',
        'Have you safely written down your recovery phrase? You will need it to recover your wallet if you lose access to this device.',
        [
          { text: 'Not Yet', style: 'cancel' },
          { text: "Yes, I've Saved It", onPress: onBackupConfirmed },
        ]
      );
    }
  };

  if (isVerificationStep) {
    // Verification step UI (shuffledWords is memoized above so it stays stable
    // as the user taps words)
    return (
      <SafeAreaView
        style={[styles.container, { backgroundColor: theme.colors.background }]}
        edges={['top']}
      >
        <View
          style={[
            styles.header,
            {
              backgroundColor: theme.colors.card,
              borderBottomColor: theme.colors.border,
            },
          ]}
        >
          {onBack && (
            <TouchableOpacity
              style={styles.backButton}
              onPress={() => setIsVerificationStep(false)}
            >
              <Ionicons
                name="arrow-back"
                size={24}
                color={theme.colors.primary}
              />
            </TouchableOpacity>
          )}
          <Text style={[styles.headerTitle, { color: theme.colors.text }]}>
            Verify Backup
          </Text>
          <View style={styles.placeholder} />
        </View>

        <ScrollView
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
        >
          <Text
            style={[styles.verificationTitle, { color: theme.colors.text }]}
          >
            Select the correct words to verify your backup
          </Text>
          <Text
            style={[
              styles.verificationSubtitle,
              { color: theme.colors.textSecondary },
            ]}
          >
            Tap the words below to complete your recovery phrase verification
          </Text>

          <View style={styles.verificationContainer}>
            {verificationWords.map((position, index) => (
              <View key={position} style={styles.verificationWordContainer}>
                <Text
                  style={[
                    styles.verificationLabel,
                    { color: theme.colors.text },
                  ]}
                >
                  Word #{position + 1}
                </Text>
                <TouchableOpacity
                  style={[
                    styles.verificationSlot,
                    {
                      backgroundColor: theme.colors.card,
                      borderColor: theme.colors.border,
                    },
                    selectedWords[position] && {
                      borderColor: theme.colors.primary,
                      backgroundColor: theme.colors.primaryLight,
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.verificationSlotText,
                      { color: theme.colors.textSecondary },
                      selectedWords[position] && {
                        color: theme.colors.primary,
                      },
                    ]}
                  >
                    {selectedWords[position] || 'Tap to select'}
                  </Text>
                </TouchableOpacity>
              </View>
            ))}
          </View>

          <View style={styles.wordOptionsContainer}>
            {shuffledWords.map((word, index) => (
              <TouchableOpacity
                key={`${word}-${index}`}
                style={[
                  styles.wordOption,
                  {
                    backgroundColor: theme.colors.card,
                    borderColor: theme.colors.border,
                  },
                  Object.values(selectedWords).includes(word) && {
                    backgroundColor: theme.colors.surface,
                    borderColor: theme.colors.disabled,
                  },
                ]}
                onPress={() => {
                  // Find which position this word should fill
                  const correctPosition = mnemonicWords.indexOf(word);
                  if (verificationWords.includes(correctPosition)) {
                    handleWordSelection(correctPosition, word);
                  }
                }}
                disabled={Object.values(selectedWords).includes(word)}
              >
                <Text
                  style={[
                    styles.wordOptionText,
                    { color: theme.colors.text },
                    Object.values(selectedWords).includes(word) && {
                      color: theme.colors.textSecondary,
                    },
                  ]}
                >
                  {word}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          <TouchableOpacity
            style={[
              styles.verifyButton,
              {
                backgroundColor: verificationWords.every(
                  (pos) => selectedWords[pos]
                )
                  ? theme.colors.primary
                  : theme.colors.disabled,
              },
            ]}
            onPress={verifyWords}
            disabled={!verificationWords.every((pos) => selectedWords[pos])}
          >
            <Text
              style={[
                styles.verifyButtonText,
                { color: theme.colors.background },
              ]}
            >
              Verify Words
            </Text>
          </TouchableOpacity>
        </ScrollView>
      </SafeAreaView>
    );
  }

  // Main backup flow UI
  return (
    <SafeAreaView
      style={[styles.container, { backgroundColor: theme.colors.background }]}
      edges={['top']}
    >
      <View
        style={[
          styles.header,
          {
            backgroundColor: theme.colors.card,
            borderBottomColor: theme.colors.border,
          },
        ]}
      >
        {onBack && (
          <TouchableOpacity style={styles.backButton} onPress={onBack}>
            <Ionicons
              name="arrow-back"
              size={24}
              color={theme.colors.primary}
            />
          </TouchableOpacity>
        )}
        <Text style={[styles.headerTitle, { color: theme.colors.text }]}>
          {title}
        </Text>
        <View style={styles.placeholder} />
      </View>

      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        <Text style={[styles.subtitle, { color: theme.colors.textSecondary }]}>
          {subtitle}
        </Text>

        <MnemonicDisplay
          mnemonic={mnemonic}
          layout="compact"
          showCopyButton={showCopyOption}
          onCopy={handleCopy}
          hasCopied={hasCopied}
        />

        <View
          style={[
            styles.warningContainer,
            {
              backgroundColor: theme.colors.warningLight,
              borderLeftColor: theme.colors.warning,
            },
          ]}
        >
          <Ionicons name="warning" size={24} color={theme.colors.warning} />
          <Text style={[styles.warningText, { color: theme.colors.warning }]}>
            Write down your recovery phrase and store it in a safe place. Never
            share it with anyone.
          </Text>
        </View>

        <View
          style={[
            styles.securityTipsContainer,
            { backgroundColor: theme.colors.card },
          ]}
        >
          <Text
            style={[styles.securityTipsTitle, { color: theme.colors.text }]}
          >
            Security Tips:
          </Text>
          <Text
            style={[styles.securityTip, { color: theme.colors.textSecondary }]}
          >
            • Write down your phrase on paper and store it safely
          </Text>
          <Text
            style={[styles.securityTip, { color: theme.colors.textSecondary }]}
          >
            • Never store it digitally or take screenshots
          </Text>
          <Text
            style={[styles.securityTip, { color: theme.colors.textSecondary }]}
          >
            • Keep multiple copies in separate secure locations
          </Text>
          <Text
            style={[styles.securityTip, { color: theme.colors.textSecondary }]}
          >
            • Never share your phrase with anyone
          </Text>
        </View>

        <TouchableOpacity
          style={[
            styles.continueButton,
            { backgroundColor: theme.colors.success },
          ]}
          onPress={handleContinue}
        >
          <Text
            style={[
              styles.continueButtonText,
              { color: theme.colors.background },
            ]}
          >
            {requireVerification
              ? 'Continue to Verification'
              : "I've Saved My Recovery Phrase"}
          </Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 15,
    borderBottomWidth: 1,
  },
  backButton: {
    padding: 8,
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '600',
  },
  placeholder: {
    width: 40,
  },
  content: {
    padding: 20,
    paddingBottom: 60,
  },
  subtitle: {
    fontSize: 16,
    marginBottom: 30,
    textAlign: 'center',
    lineHeight: 22,
  },
  warningContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 15,
    borderRadius: 10,
    marginTop: 20,
    marginBottom: 20,
    borderLeftWidth: 4,
  },
  warningText: {
    flex: 1,
    marginLeft: 10,
    fontSize: 14,
    fontWeight: '500',
  },
  securityTipsContainer: {
    borderRadius: 15,
    padding: 20,
    marginBottom: 30,
  },
  securityTipsTitle: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 10,
  },
  securityTip: {
    fontSize: 14,
    marginBottom: 6,
    lineHeight: 20,
  },
  continueButton: {
    paddingVertical: 15,
    paddingHorizontal: 30,
    borderRadius: 10,
    marginTop: 30,
  },
  continueButtonText: {
    fontSize: 18,
    fontWeight: '600',
    textAlign: 'center',
  },
  // Verification step styles
  verificationTitle: {
    fontSize: 24,
    fontWeight: 'bold',
    marginBottom: 10,
    textAlign: 'center',
  },
  verificationSubtitle: {
    fontSize: 16,
    marginBottom: 30,
    textAlign: 'center',
    lineHeight: 22,
  },
  verificationContainer: {
    marginBottom: 30,
  },
  verificationWordContainer: {
    marginBottom: 15,
  },
  verificationLabel: {
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 8,
  },
  verificationSlot: {
    borderWidth: 2,
    borderStyle: 'dashed',
    borderRadius: 10,
    paddingVertical: 15,
    paddingHorizontal: 20,
    alignItems: 'center',
  },
  verificationSlotText: {
    fontSize: 16,
  },
  wordOptionsContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    marginBottom: 30,
  },
  wordOption: {
    width: '30%',
    borderRadius: 8,
    paddingVertical: 12,
    paddingHorizontal: 10,
    marginBottom: 10,
    alignItems: 'center',
    borderWidth: 1,
  },
  wordOptionText: {
    fontSize: 14,
    fontWeight: '500',
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
});
