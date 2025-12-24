/**
 * ClaimableBanner - Banner shown on HomeScreen when claimable tokens are available
 */

import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Animated, {
  FadeInDown,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import { GlassCard } from '@/components/common/GlassCard';
import { useEffect } from 'react';

interface ClaimableBannerProps {
  /** Number of claimable tokens */
  count: number;
  /** Called when banner is pressed */
  onPress: () => void;
}

export default function ClaimableBanner({ count, onPress }: ClaimableBannerProps) {
  const styles = useThemedStyles(createStyles);
  const iconScale = useSharedValue(1);

  // Subtle pulsing animation on the icon
  useEffect(() => {
    iconScale.value = withRepeat(
      withSequence(
        withTiming(1.1, { duration: 800 }),
        withTiming(1, { duration: 800 })
      ),
      -1, // Repeat indefinitely
      true // Reverse each cycle
    );
  }, [iconScale]);

  const iconAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: iconScale.value }],
  }));

  const getMessage = () => {
    if (count === 1) {
      return 'You have 1 token to claim';
    }
    return `You have ${count} tokens to claim`;
  };

  return (
    <Animated.View
      entering={FadeInDown.duration(400).springify()}
      style={styles.container}
    >
      <GlassCard
        variant="medium"
        onPress={onPress}
        borderGlow
        glowColor={styles.glowColor.color}
        padding="md"
      >
        <View style={styles.content}>
          <Animated.View style={[styles.iconContainer, iconAnimatedStyle]}>
            <Ionicons name="gift" size={28} color={styles.icon.color} />
          </Animated.View>
          <View style={styles.textContainer}>
            <Text style={styles.title}>{getMessage()}</Text>
            <Text style={styles.subtitle}>Tap to view and claim</Text>
          </View>
          <Ionicons
            name="chevron-forward"
            size={20}
            color={styles.chevron.color}
          />
        </View>
      </GlassCard>
    </Animated.View>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    container: {
      marginBottom: 16,
    },
    content: {
      flexDirection: 'row',
      alignItems: 'center',
    },
    iconContainer: {
      width: 48,
      height: 48,
      borderRadius: 24,
      backgroundColor: theme.colors.primary + '20',
      justifyContent: 'center',
      alignItems: 'center',
      marginRight: 14,
    },
    icon: {
      color: theme.colors.primary,
    },
    textContainer: {
      flex: 1,
    },
    title: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.text,
      marginBottom: 2,
    },
    subtitle: {
      fontSize: 13,
      color: theme.colors.textSecondary,
    },
    chevron: {
      color: theme.colors.textMuted,
    },
    glowColor: {
      color: theme.colors.primary,
    },
  });
