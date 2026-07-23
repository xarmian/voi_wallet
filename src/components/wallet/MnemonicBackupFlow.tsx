import React, { useState, useRef, useEffect } from 'react';
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
import MnemonicVerification from './MnemonicVerification';
import { useTheme } from '@/contexts/ThemeContext';
import { useSecureScreen } from '@/hooks/useSecureScreen';
import {
  scheduleClipboardClear,
  ClipboardClearHandle,
} from '@/utils/clipboardAutoClear';

/**
 * Outcome of the backup step, handed to the host so it can persist
 * `backupVerified` correctly (DR-11).
 *
 * `verified` is true ONLY when the user completed the word quiz. Skipping, or
 * a plain "I've saved it" acknowledgement, reports false — the host must then
 * persist the account as un-backed-up and surface the Home warning banner.
 */
export interface MnemonicBackupResult {
  verified: boolean;
}

interface MnemonicBackupFlowProps {
  mnemonic: string;
  onBackupConfirmed: (result: MnemonicBackupResult) => void;
  title?: string;
  subtitle?: string;
  showCopyOption?: boolean;
  requireVerification?: boolean;
  /**
   * When verification is required, also offer a "Skip for now" escape (DR-2).
   * Skipping still completes the flow, but reports `verified: false`.
   */
  allowSkipVerification?: boolean;
  onBack?: () => void;
}

export default function MnemonicBackupFlow({
  mnemonic,
  onBackupConfirmed,
  title = 'Your Recovery Phrase',
  subtitle = 'Your recovery phrase is the key to your wallet. Keep it safe and secure.',
  showCopyOption = false,
  requireVerification = false,
  allowSkipVerification = true,
  onBack,
}: MnemonicBackupFlowProps) {
  const [hasCopied, setHasCopied] = useState(false);
  const [isVerificationStep, setIsVerificationStep] = useState(false);
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
  // Serializes every clipboard read/write/clear for this component so native
  // ops can't complete out of order. Each copy chains onto the previous.
  const clipboardOpLock = useRef<Promise<void>>(Promise.resolve());

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

  const handleCopy = async () => {
    // Assign this tap's generation synchronously (before the serialized body
    // runs) so rapid taps are ordered and a superseded tap bails without ever
    // touching the clipboard or showing duplicate UI.
    const gen = ++copyGenRef.current;

    // Chain the whole copy onto the op-lock so clipboard writes for this
    // component are strictly serialized (no out-of-order native writes).
    clipboardOpLock.current = clipboardOpLock.current
      .catch(() => {}) // a prior op's failure must not break the chain
      .then(async () => {
        // Superseded by a newer tap before we got our turn → do nothing.
        if (gen !== copyGenRef.current) return;

        // Cancel any previously scheduled clear before we overwrite the
        // clipboard, so a stale handle can never wipe the fresh content.
        clipboardClearRef.current?.cancel();
        clipboardClearRef.current = null;

        try {
          await Clipboard.setStringAsync(mnemonic);

          // A newer copy superseded this one while we awaited → do nothing (the
          // newer tap owns the clipboard + its clear handle; bailing avoids a
          // double-schedule / leaked timer).
          if (gen !== copyGenRef.current) return;

          if (!mountedRef.current) {
            // Unmounted mid-copy: the phrase is on the clipboard but our unmount
            // cleanup already ran. Wipe it now (check-then-clear) and don't
            // schedule a timer that would outlive this component.
            void scheduleClipboardClear(mnemonic, 0).clearNow();
            return;
          }

          // Keep only ONE "Copied!" UI timer pending at a time.
          if (hasCopiedTimeoutRef.current) {
            clearTimeout(hasCopiedTimeoutRef.current);
          }
          setHasCopied(true);
          Alert.alert('Copied!', 'Recovery phrase copied to clipboard');

          // Auto-clear from the OS clipboard after 60s unless the user copied
          // something else. The generation token guarantees this is the only
          // live handle.
          clipboardClearRef.current = scheduleClipboardClear(mnemonic);

          hasCopiedTimeoutRef.current = setTimeout(
            () => setHasCopied(false),
            3000
          );
        } catch (error) {
          Alert.alert('Error', 'Failed to copy to clipboard');
        }
      });

    // Await this copy's turn (the body handles its own errors, so this never
    // rejects).
    await clipboardOpLock.current;
  };

  const handleVerified = () => {
    Alert.alert(
      'Verification Successful!',
      'You have successfully backed up your recovery phrase.',
      [
        {
          text: 'Continue',
          onPress: () => onBackupConfirmed({ verified: true }),
        },
      ]
    );
  };

  const handleSkipVerification = () => {
    Alert.alert(
      'Skip verification?',
      'Your account will be marked as not backed up until you confirm your recovery phrase. Anyone who loses this device without the phrase written down loses the funds in this account.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Skip for now',
          style: 'destructive',
          onPress: () => onBackupConfirmed({ verified: false }),
        },
      ]
    );
  };

  const handleContinue = () => {
    if (requireVerification) {
      setIsVerificationStep(true);
    } else {
      Alert.alert(
        'Backup Confirmation',
        'Have you safely written down your recovery phrase? You will need it to recover your wallet if you lose access to this device.',
        [
          { text: 'Not Yet', style: 'cancel' },
          {
            text: "Yes, I've Saved It",
            // Self-attestation is NOT verification (DR-11).
            onPress: () => onBackupConfirmed({ verified: false }),
          },
        ]
      );
    }
  };

  if (isVerificationStep) {
    // DR-12: the quiz body lives in MnemonicVerification, whose selection logic
    // is position-indexed so a phrase with a repeated word stays completable.
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
          <TouchableOpacity
            style={styles.backButton}
            accessibilityRole="button"
            accessibilityLabel="Back to recovery phrase"
            testID="backup-verification-back"
            onPress={() => setIsVerificationStep(false)}
          >
            <Ionicons
              name="arrow-back"
              size={24}
              color={theme.colors.primary}
            />
          </TouchableOpacity>
          <Text style={[styles.headerTitle, { color: theme.colors.text }]}>
            Verify Backup
          </Text>
          <View style={styles.placeholder} />
        </View>

        <ScrollView
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
        >
          <MnemonicVerification
            mnemonic={mnemonic}
            onVerified={handleVerified}
            onSkip={allowSkipVerification ? handleSkipVerification : undefined}
            testIDPrefix="backup-verification"
          />
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
          testID="backup-continue"
          accessibilityRole="button"
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
});
