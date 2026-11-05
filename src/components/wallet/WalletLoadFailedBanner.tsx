/**
 * WalletLoadFailedBanner (TASK-514, product ruling 11-05). Home notice for a
 * FAILED WALLET READ while accounts are already on screen: the store keeps the
 * wallet it had, so without this the user sees an older account list with no hint
 * that accounts they just added (a Settings restore, a QR import) may be missing.
 *
 *  - Shown only when the last wallet load failed (`walletLoadFailed`), never for a
 *    balance or network failure: those do not set it.
 *  - Dismissible. A dismissal covers the failure the user saw; it comes back only
 *    on the NEXT failed load (the failure count moves on). A successful load
 *    clears it. If Try again fails, the new failure keeps it showing.
 *  - Sits above the account view and replaces nothing; it never offers Get Started.
 */

import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import { GlassCard } from '@/components/common/GlassCard';

interface Props {
  /** The last wallet load could not tell whether (or which) accounts exist. */
  walletLoadFailed: boolean;
  /** How many loads have failed; a new failure moves it on. */
  failureCount: number;
  /** Runs a fresh load (the store's refresh). */
  onTryAgain: () => void;
}

export default function WalletLoadFailedBanner({
  walletLoadFailed,
  failureCount,
  onTryAgain,
}: Props) {
  const styles = useThemedStyles(createStyles);
  // The failure count the user dismissed; a newer failure shows the notice again.
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);

  if (!walletLoadFailed || dismissedAt === failureCount) return null;

  return (
    <GlassCard
      variant="light"
      style={styles.card}
      testID="home-wallet-load-failed-banner"
    >
      <View style={styles.row}>
        <Ionicons name="warning" size={20} style={styles.icon} />
        <View style={styles.textContainer}>
          <Text style={styles.message}>
            We couldn&apos;t refresh your accounts. Some accounts may not be
            showing.
          </Text>
          <TouchableOpacity
            onPress={onTryAgain}
            accessibilityRole="button"
            accessibilityLabel="Try again"
          >
            <Text style={styles.action}>Try again</Text>
          </TouchableOpacity>
        </View>
        <TouchableOpacity
          onPress={() => setDismissedAt(failureCount)}
          accessibilityRole="button"
          accessibilityLabel="Dismiss"
          hitSlop={12}
        >
          <Ionicons name="close" size={18} style={styles.dismiss} />
        </TouchableOpacity>
      </View>
    </GlassCard>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    card: {
      marginBottom: theme.spacing.md,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
    },
    icon: {
      color: theme.colors.warning,
      marginRight: theme.spacing.sm,
    },
    textContainer: {
      flex: 1,
    },
    message: {
      fontSize: theme.typography.body.fontSize,
      color: theme.colors.text,
    },
    action: {
      marginTop: theme.spacing.xs,
      fontSize: theme.typography.body.fontSize,
      fontWeight: '600',
      color: theme.colors.primary,
    },
    dismiss: {
      color: theme.colors.textMuted,
      marginLeft: theme.spacing.sm,
    },
  });
