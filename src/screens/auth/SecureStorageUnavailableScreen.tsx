import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { useTheme } from '@/contexts/ThemeContext';
import { Theme } from '@/constants/themes';

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
 * state nor the normal PIN lock, and it exposes no path into the wallet. The
 * only actions are Retry (re-run the check) and the hint to restart the app.
 */
export default function SecureStorageUnavailableScreen({
  onRetry,
}: SecureStorageUnavailableScreenProps) {
  const { theme } = useTheme();
  const styles = useThemedStyles(createStyles);
  const [isRetrying, setIsRetrying] = useState(false);
  // Avoid a setState-after-unmount warning: on a SUCCESSFUL retry this screen
  // unmounts (securityUnavailable cleared) before the handler resumes.
  const mountedRef = useRef(true);
  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const handleRetry = async () => {
    if (isRetrying) return;
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
            was kept locked to protect your accounts. This is usually temporary.
          </Text>
        </View>

        <TouchableOpacity
          style={[styles.retryButton, isRetrying && styles.retryButtonDisabled]}
          onPress={handleRetry}
          disabled={isRetrying}
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
          If this keeps happening, fully close and reopen the app. Your wallet
          data has not been lost.
        </Text>
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
    retryButtonDisabled: {
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
  });
