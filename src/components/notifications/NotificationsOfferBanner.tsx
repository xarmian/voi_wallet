/**
 * NotificationsOfferBanner — Home banner offering push notifications while the
 * permission is not granted (TASK-565). Tapping the body opens the
 * notification settings; the X dismisses the offer.
 *
 * The card itself is static, so the body and the X are separate buttons a
 * screen reader reaches on their own.
 */

import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import { GlassCard } from '@/components/common/GlassCard';

interface NotificationsOfferBannerProps {
  /** Opens the notification settings. */
  onPress: () => void;
  /** Hides the offer for good. */
  onDismiss: () => void;
}

export default function NotificationsOfferBanner({
  onPress,
  onDismiss,
}: NotificationsOfferBannerProps) {
  const styles = useThemedStyles(createStyles);

  return (
    <Animated.View entering={FadeInDown.duration(300)}>
      <GlassCard
        variant="light"
        style={styles.card}
        padding="none"
        testID="home-notifications-offer-banner"
      >
        <View style={styles.row}>
          <Pressable
            onPress={onPress}
            style={({ pressed }) => [styles.body, pressed && styles.pressed]}
            accessibilityRole="button"
            accessibilityLabel="Turn on notifications"
            accessibilityHint="Opens notification settings"
          >
            <View style={styles.iconContainer}>
              <Ionicons
                name="notifications"
                size={20}
                color={styles.icon.color}
              />
            </View>
            <View style={styles.textContainer}>
              <Text style={styles.title}>Turn on notifications</Text>
              <Text style={styles.message}>
                Get alerts for payments and messages.
              </Text>
            </View>
          </Pressable>
          <Pressable
            onPress={onDismiss}
            style={({ pressed }) => [styles.close, pressed && styles.pressed]}
            accessibilityRole="button"
            accessibilityLabel="Dismiss notifications offer"
          >
            <Ionicons name="close" size={20} color={styles.closeIcon.color} />
          </Pressable>
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
    body: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: theme.spacing.md,
      paddingLeft: theme.spacing.md,
    },
    pressed: {
      opacity: 0.7,
    },
    iconContainer: {
      width: 36,
      height: 36,
      borderRadius: theme.borderRadius.md,
      alignItems: 'center',
      justifyContent: 'center',
      marginRight: theme.spacing.md,
      backgroundColor: `${theme.colors.primary}20`,
    },
    icon: {
      color: theme.colors.primary,
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
    close: {
      minWidth: 44,
      minHeight: 44,
      alignItems: 'center',
      justifyContent: 'center',
      marginHorizontal: theme.spacing.xs,
    },
    closeIcon: {
      color: theme.colors.textMuted,
    },
  });
