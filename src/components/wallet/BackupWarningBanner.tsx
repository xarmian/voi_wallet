/**
 * BackupWarningBanner — Home banner shown while the active account's recovery
 * phrase has not been confirmed on this device (TASK-45 / DR-10).
 *
 * Driven by the persisted `backupVerified` flag, read through
 * `isBackupVerified()` so it fails closed: a legacy record, a restored account,
 * or a skipped quiz all keep the warning up. Deliberately NOT dismissible —
 * tapping it opens the verification flow, which is the only thing that clears
 * it. Follows the screen-local banner precedent (SignerModeBanner /
 * UpdateBanner / ClaimableBanner).
 */

import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import { GlassCard } from '@/components/common/GlassCard';

interface BackupWarningBannerProps {
  /** Opens the recovery-phrase verification flow. */
  onPress: () => void;
}

export default function BackupWarningBanner({
  onPress,
}: BackupWarningBannerProps) {
  const styles = useThemedStyles(createStyles);

  return (
    <Animated.View entering={FadeInDown.duration(300)}>
      <GlassCard
        variant="light"
        style={styles.card}
        onPress={onPress}
        testID="home-backup-warning-banner"
        accessibilityRole="button"
        accessibilityLabel="Recovery phrase not confirmed. Tap to back up this account."
      >
        <View style={styles.row}>
          <View style={styles.iconContainer}>
            <Ionicons name="warning" size={20} style={styles.icon} />
          </View>
          <View style={styles.textContainer}>
            <Text style={styles.title}>Back up your recovery phrase</Text>
            <Text style={styles.message}>
              This account is not backed up. If you lose this device, the funds
              in it are gone.
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={18} style={styles.chevron} />
        </View>
      </GlassCard>
    </Animated.View>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    card: {
      marginBottom: theme.spacing.md,
      borderRadius: theme.borderRadius.xl,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
    },
    iconContainer: {
      width: 36,
      height: 36,
      borderRadius: theme.borderRadius.md,
      alignItems: 'center',
      justifyContent: 'center',
      marginRight: theme.spacing.md,
      backgroundColor: `${theme.colors.warning}20`,
    },
    icon: {
      color: theme.colors.warning,
    },
    textContainer: {
      flex: 1,
    },
    title: {
      fontSize: theme.typography.body.fontSize,
      fontWeight: '600',
      color: theme.colors.text,
      marginBottom: 2,
    },
    message: {
      fontSize: theme.typography.bodySmall.fontSize,
      color: theme.colors.textMuted,
      lineHeight: 18,
    },
    chevron: {
      color: theme.colors.textMuted,
      marginLeft: theme.spacing.sm,
    },
  });
