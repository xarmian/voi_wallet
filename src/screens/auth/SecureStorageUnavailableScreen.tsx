import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { useTheme } from '@/contexts/ThemeContext';
import { Theme } from '@/constants/themes';
import { AccountSecureStorage } from '@/services/secure';
import { MultiAccountWalletService } from '@/services/wallet';

// Cross-platform confirm dialog (mirrors LockScreen.showAlert): on web there is
// no native Alert, so fall back to window.confirm for the multi-button
// (destructive) case and window.alert otherwise.
const showAlert = (
  title: string,
  message: string,
  buttons?: { text: string; onPress?: () => void; style?: string }[]
) => {
  if (Platform.OS === 'web') {
    if (buttons && buttons.length > 1) {
      const confirmed = window.confirm(`${title}\n\n${message}`);
      if (confirmed) {
        const confirmButton =
          buttons.find((b) => b.style === 'destructive') ||
          buttons[buttons.length - 1];
        confirmButton?.onPress?.();
      }
    } else {
      window.alert(`${title}\n\n${message}`);
      buttons?.[0]?.onPress?.();
    }
  } else {
    const { Alert } = require('react-native');
    Alert.alert(title, message, buttons);
  }
};

interface SecureStorageUnavailableScreenProps {
  /**
   * Re-run the auth-init check. Wired to AuthContext.recheckAuthState so a
   * transient keychain/keystore failure can recover WITHOUT a full app restart:
   * if secure storage is readable again the check clears securityUnavailable and
   * this screen unmounts; if it still fails, the recovery state is re-entered.
   */
  onRetry: () => Promise<void>;
}

/**
 * Fail-closed recovery screen (TASK-213). Rendered ONLY when the strict,
 * lock-determining secure-storage reads at boot still fail after bounded retry
 * (authState.securityUnavailable === true) — i.e. secure storage is genuinely
 * unreadable. It grants ZERO wallet access: it is neither the unlocked setup
 * state nor the normal PIN lock, and it exposes no path into the wallet.
 *
 * Two actions, in priority order:
 *  - Retry: re-run the check. Recovers a TRANSIENT failure with no data loss.
 *  - Reset & restore: the escape hatch for a PERSISTENT failure (a permanently
 *    desynced keystore or an irrecoverably corrupt local blob) that Retry can
 *    never clear. It wipes ONLY local data — the on-chain accounts are untouched
 *    and are recoverable from the user's recovery phrase — then re-runs the check
 *    so the app lands in Onboarding (restore-from-phrase). Without this the user
 *    would be permanently stranded here (Retry re-failing forever). Guarded by a
 *    double confirmation because it is destructive to un-backed-up local state.
 */
export default function SecureStorageUnavailableScreen({
  onRetry,
}: SecureStorageUnavailableScreenProps) {
  const { theme } = useTheme();
  const styles = useThemedStyles(createStyles);
  const [isRetrying, setIsRetrying] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  // Type-RESET friction (Dave's decision, TASK-213): the destructive wipe stays
  // disabled until the user types the exact word RESET — stronger intent than a
  // checkbox, ON TOP OF the existing double confirmation.
  const [resetConfirmText, setResetConfirmText] = useState('');
  // FIX 3(a): "reset didn't resolve it" signal. Set when a reset attempt starts.
  // On a SUCCESSFUL reset the recheck clears securityUnavailable and this screen
  // UNMOUNTS, destroying this state — so the message never shows. If the reset
  // does NOT resolve the failure the screen stays mounted, this stays true, and
  // the guidance renders (no silent loop). This survives-by-unmount design needs
  // no fragile post-await timing check.
  const [resetAttempted, setResetAttempted] = useState(false);
  const RESET_CONFIRM_WORD = 'RESET';
  const canReset = resetConfirmText === RESET_CONFIRM_WORD;
  // Avoid a setState-after-unmount warning: on a SUCCESSFUL retry/reset this
  // screen unmounts (securityUnavailable cleared) before the handler resumes.
  const mountedRef = useRef(true);
  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const busy = isRetrying || isResetting;

  const handleRetry = async () => {
    if (busy) return;
    setIsRetrying(true);
    try {
      await onRetry();
    } catch (error) {
      // recheckAuthState fails closed internally; nothing to surface here.
      console.error('Retry of auth-init check failed:', error);
    } finally {
      if (mountedRef.current) {
        setIsRetrying(false);
      }
    }
  };

  const performReset = async () => {
    setIsResetting(true);
    // Mark the attempt BEFORE the wipe. A SUCCESSFUL reset unmounts this screen
    // (securityUnavailable cleared), discarding this flag; if we stay mounted the
    // reset did NOT resolve the failure and the guidance below renders.
    setResetAttempted(true);
    try {
      // Best-effort local wipe. Each step is isolated so a throw in one (a broken
      // keystore can make key-material deletion fail) still lets the wallet-
      // metadata wipe run — that AsyncStorage removal is what makes the next
      // strict boot read resolve "no wallet" and route to Onboarding, and on
      // Android it also clears the secure-store presence sentinel so hasPinStrict
      // reads genuine ABSENCE (not a fail-closed throw) afterward.
      try {
        await AccountSecureStorage.clearAll();
      } catch (error) {
        console.error('Reset: clearAll failed (continuing):', error);
      }
      try {
        await MultiAccountWalletService.clearAllWallets();
      } catch (error) {
        console.error('Reset: clearAllWallets failed (continuing):', error);
      }
      // Re-run the auth check: with local data wiped it resolves to genuine
      // absence ⇒ unlocked setup ⇒ Onboarding (restore-from-recovery-phrase).
      await onRetry();
    } catch (error) {
      // A throw here (or a recheck that re-lands on recovery without throwing)
      // leaves this screen mounted; resetAttempted stays true and the inline
      // "reset didn't resolve it" guidance renders — no silent loop.
      console.error('Reset of secure storage state failed:', error);
    } finally {
      if (mountedRef.current) {
        setIsResetting(false);
      }
    }
  };

  const confirmReset = () => {
    // Gate on both the typed-RESET word and the not-busy state, so this can never
    // be triggered before the friction is satisfied.
    if (busy || !canReset) return;
    showAlert(
      'Reset and start over?',
      'This permanently erases ALL local wallet data on this device. Only accounts backed by a recovery phrase you personally hold can be restored — each from its own phrase. Watch-only, Ledger, and remote-signer accounts must be re-added manually. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Continue',
          style: 'destructive',
          onPress: () =>
            showAlert(
              'Are you sure?',
              'Make sure you have EVERY recovery phrase before continuing. All local wallet data on this device will be permanently erased.',
              [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Erase and restore',
                  style: 'destructive',
                  onPress: () => {
                    void performReset();
                  },
                },
              ]
            ),
        },
      ]
    );
  };

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <View style={styles.content}>
        <View style={styles.header}>
          <Ionicons
            name="warning-outline"
            size={48}
            color={theme.colors.error}
          />
          <Text style={styles.title}>Secure storage unavailable</Text>
          <Text style={styles.subtitle}>
            Your device&apos;s secure storage could not be read, so the wallet
            was kept locked to protect your accounts. This is often temporary —
            try again first.
          </Text>
        </View>

        <TouchableOpacity
          style={[styles.retryButton, busy && styles.buttonDisabled]}
          onPress={handleRetry}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel="Retry secure storage check"
        >
          <Ionicons
            name="refresh-outline"
            size={20}
            color={theme.colors.buttonText}
          />
          <Text style={styles.retryButtonText}>
            {isRetrying ? 'Checking…' : 'Retry'}
          </Text>
        </TouchableOpacity>

        <Text style={styles.hint}>
          If retrying doesn&apos;t help, your device&apos;s secure storage may
          be permanently reset (for example after changing your device passcode
          or restoring your phone from a backup). Resetting erases ALL local
          wallet data on this device. Only accounts you hold a recovery phrase
          for can be restored — each from its own phrase. Watch-only, Ledger,
          and remote-signer accounts, and account names, are not covered by a
          recovery phrase and must be re-added manually. Make sure you have
          every recovery phrase before continuing.
        </Text>

        <Text style={styles.resetPrompt}>
          Type {RESET_CONFIRM_WORD} below to enable erasing all local data.
        </Text>
        <TextInput
          style={styles.resetInput}
          value={resetConfirmText}
          onChangeText={setResetConfirmText}
          editable={!busy}
          autoCapitalize="characters"
          autoCorrect={false}
          placeholder={RESET_CONFIRM_WORD}
          placeholderTextColor={theme.colors.textMuted}
          accessibilityLabel="Type RESET to enable erasing all local data"
        />

        {resetAttempted && !busy ? (
          <Text
            style={styles.resetFailedNotice}
            accessibilityLiveRegion="polite"
          >
            Reset didn&apos;t resolve the problem. Fully restart your device and
            reopen the app. If it keeps happening, contact support.
          </Text>
        ) : null}

        <TouchableOpacity
          style={[
            styles.resetButton,
            (busy || !canReset) && styles.buttonDisabled,
          ]}
          onPress={confirmReset}
          disabled={busy || !canReset}
          accessibilityRole="button"
          accessibilityState={{ disabled: busy || !canReset }}
          accessibilityLabel="Reset app and restore from recovery phrase"
        >
          <Ionicons name="trash-outline" size={18} color={theme.colors.error} />
          <Text style={styles.resetButtonText}>
            {isResetting
              ? 'Resetting…'
              : 'Reset & restore from recovery phrase'}
          </Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: theme.colors.background,
    },
    content: {
      flex: 1,
      paddingHorizontal: theme.spacing.lg,
      justifyContent: 'center',
      alignItems: 'center',
    },
    header: {
      alignItems: 'center',
      marginBottom: theme.spacing.xxl,
    },
    title: {
      fontSize: 24,
      fontWeight: 'bold',
      color: theme.colors.text,
      marginTop: theme.spacing.lg,
      marginBottom: theme.spacing.sm,
      textAlign: 'center',
    },
    subtitle: {
      fontSize: 16,
      color: theme.colors.textSecondary,
      textAlign: 'center',
      lineHeight: 22,
    },
    retryButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.colors.primary,
      borderRadius: theme.borderRadius.lg,
      paddingVertical: theme.spacing.md,
      paddingHorizontal: theme.spacing.xxl,
      gap: theme.spacing.sm,
      minWidth: 180,
    },
    buttonDisabled: {
      opacity: 0.6,
    },
    retryButtonText: {
      color: theme.colors.buttonText,
      fontSize: 16,
      fontWeight: '600',
    },
    hint: {
      fontSize: 13,
      color: theme.colors.textMuted,
      textAlign: 'center',
      marginTop: theme.spacing.xl,
      lineHeight: 18,
      paddingHorizontal: theme.spacing.lg,
    },
    resetButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 1,
      borderColor: theme.colors.error,
      borderRadius: theme.borderRadius.lg,
      paddingVertical: theme.spacing.sm,
      paddingHorizontal: theme.spacing.lg,
      gap: theme.spacing.sm,
      marginTop: theme.spacing.lg,
    },
    resetButtonText: {
      color: theme.colors.error,
      fontSize: 14,
      fontWeight: '600',
    },
    resetPrompt: {
      fontSize: 13,
      color: theme.colors.textSecondary,
      textAlign: 'center',
      marginTop: theme.spacing.xl,
      marginBottom: theme.spacing.sm,
      paddingHorizontal: theme.spacing.lg,
    },
    resetInput: {
      alignSelf: 'stretch',
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: theme.borderRadius.md,
      paddingVertical: theme.spacing.sm,
      paddingHorizontal: theme.spacing.md,
      marginHorizontal: theme.spacing.lg,
      color: theme.colors.text,
      fontSize: 16,
      textAlign: 'center',
      letterSpacing: 2,
    },
    resetFailedNotice: {
      fontSize: 13,
      color: theme.colors.error,
      textAlign: 'center',
      marginTop: theme.spacing.lg,
      lineHeight: 18,
      paddingHorizontal: theme.spacing.lg,
    },
  });
