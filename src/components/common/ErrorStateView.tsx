/**
 * ErrorStateView — shared "this failed, here's why, try again" surface
 * (TASK-40 / U-03).
 *
 * The audit finding it closes: data-load failures were caught with
 * `console.error` only, so a failed fetch rendered exactly like a successful
 * fetch of an empty account. In a wallet that is alarming — "No Transactions"
 * on an account you know has transactions reads as lost funds. Every load
 * failure must be visibly a *failure*, and must offer a retry.
 *
 * All user-facing wording comes from the central mapper (`@/utils/errorMapping`,
 * TASK-41) so the phrasing, redaction and retryability rules are the same
 * everywhere. Nothing here formats a raw error itself.
 */

import React, { useMemo } from 'react';
import {
  Pressable,
  StyleProp,
  StyleSheet,
  Text,
  View,
  ViewStyle,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/contexts/ThemeContext';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import { mapError, type MappedErrorType } from '@/utils/errorMapping';

interface ErrorStateViewProps {
  /** Raw thrown value or stored error message — mapped internally. */
  error: unknown;
  /**
   * Called when the user taps Retry. Retry is offered whenever this is
   * provided, including for errors the mapper marks non-retryable: re-running
   * a read is always safe, and the user having no way forward is the defect
   * being fixed.
   */
  onRetry?: () => void;
  retryLabel?: string;
  /** Operation-specific wording for unmapped failures. */
  fallbackMessage?: string;
  /**
   * `block` (default) is the full-height state used in place of a list's empty
   * state; `inline` is the compact one-line notice used inside cards and as a
   * list footer.
   */
  variant?: 'block' | 'inline';
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

const ICON_BY_TYPE: Partial<
  Record<MappedErrorType, React.ComponentProps<typeof Ionicons>['name']>
> = {
  offline: 'cloud-offline-outline',
  timeout: 'time-outline',
  rate_limited: 'hourglass-outline',
  server_error: 'server-outline',
  not_found: 'help-circle-outline',
};

export const ErrorStateView: React.FC<ErrorStateViewProps> = ({
  error,
  onRetry,
  retryLabel = 'Retry',
  fallbackMessage,
  variant = 'block',
  style,
  testID,
}) => {
  const styles = useThemedStyles(createStyles);
  const { theme } = useTheme();

  const mapped = useMemo(
    () => mapError(error, { fallbackMessage }),
    [error, fallbackMessage]
  );

  const iconName = ICON_BY_TYPE[mapped.type] ?? 'alert-circle-outline';
  const isInline = variant === 'inline';

  return (
    <View
      style={[isInline ? styles.inlineContainer : styles.container, style]}
      accessibilityRole="alert"
      testID={testID}
    >
      <Ionicons
        name={iconName}
        size={isInline ? 18 : 44}
        color={theme.colors.error}
      />
      <View style={isInline ? styles.inlineTextGroup : styles.textGroup}>
        <Text style={isInline ? styles.inlineMessage : styles.message}>
          {mapped.message}
        </Text>
        {!isInline && !!mapped.userAction && (
          <Text style={styles.action}>{mapped.userAction}</Text>
        )}
      </View>
      {!!onRetry && (
        <Pressable
          onPress={onRetry}
          style={({ pressed }) => [
            isInline ? styles.inlineRetryButton : styles.retryButton,
            pressed && styles.retryButtonPressed,
          ]}
          accessibilityRole="button"
          accessibilityLabel={retryLabel}
          testID={testID ? `${testID}-retry` : undefined}
        >
          <Ionicons name="refresh" size={16} color={theme.colors.primary} />
          <Text style={styles.retryText}>{retryLabel}</Text>
        </Pressable>
      )}
    </View>
  );
};

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    container: {
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: theme.spacing.xl,
      paddingHorizontal: theme.spacing.lg,
      gap: theme.spacing.sm,
    },
    inlineContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: theme.spacing.sm,
      paddingHorizontal: theme.spacing.sm,
      borderRadius: theme.borderRadius.md,
      backgroundColor: theme.colors.errorLight,
      gap: theme.spacing.sm,
    },
    textGroup: {
      alignItems: 'center',
      gap: theme.spacing.xs,
    },
    inlineTextGroup: {
      flex: 1,
    },
    message: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.text,
      textAlign: 'center',
    },
    inlineMessage: {
      fontSize: 13,
      color: theme.colors.text,
    },
    action: {
      fontSize: 14,
      color: theme.colors.textMuted,
      textAlign: 'center',
      lineHeight: 20,
    },
    retryButton: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.xs,
      marginTop: theme.spacing.xs,
      paddingVertical: theme.spacing.sm,
      paddingHorizontal: theme.spacing.lg,
      borderRadius: theme.borderRadius.md,
      borderWidth: 1,
      borderColor: theme.colors.primary,
    },
    inlineRetryButton: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.xs,
      paddingVertical: theme.spacing.xs,
      paddingHorizontal: theme.spacing.sm,
      borderRadius: theme.borderRadius.sm,
      borderWidth: 1,
      borderColor: theme.colors.primary,
    },
    retryButtonPressed: {
      opacity: 0.6,
    },
    retryText: {
      fontSize: 14,
      fontWeight: '600',
      color: theme.colors.primary,
    },
  });

export default ErrorStateView;
