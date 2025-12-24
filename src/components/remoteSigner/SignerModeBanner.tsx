/**
 * SignerModeBanner - Prominent banner shown on HomeScreen when device is in signer mode
 *
 * Displays a visual indicator that the device is in "Signing Mode" with a primary
 * call-to-action button to scan signing requests.
 */

import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
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

interface SignerModeBannerProps {
  /** Called when scan button is pressed */
  onScanPress: () => void;
}

export default function SignerModeBanner({ onScanPress }: SignerModeBannerProps) {
  const styles = useThemedStyles(createStyles);
  const iconPulse = useSharedValue(1);

  // Subtle pulsing animation on the shield icon
  useEffect(() => {
    iconPulse.value = withRepeat(
      withSequence(
        withTiming(1.05, { duration: 1200 }),
        withTiming(1, { duration: 1200 })
      ),
      -1,
      true
    );
  }, [iconPulse]);

  const iconAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: iconPulse.value }],
  }));

  return (
    <Animated.View
      entering={FadeInDown.duration(400).springify()}
      style={styles.container}
    >
      <GlassCard
        variant="medium"
        borderGlow
        glowColor={styles.glowColor.color}
        padding="md"
      >
        <View style={styles.content}>
          {/* Mode indicator */}
          <View style={styles.modeRow}>
            <Animated.View style={[styles.iconContainer, iconAnimatedStyle]}>
              <Ionicons name="shield-checkmark" size={24} color={styles.icon.color} />
            </Animated.View>
            <View style={styles.textContainer}>
              <Text style={styles.title}>Signing Mode</Text>
              <Text style={styles.subtitle}>Air-gapped transaction signing</Text>
            </View>
          </View>

          {/* Scan button */}
          <TouchableOpacity
            style={styles.scanButton}
            onPress={onScanPress}
            activeOpacity={0.8}
          >
            <Ionicons name="scan-outline" size={20} color={styles.scanButtonText.color} />
            <Text style={styles.scanButtonText}>Scan Signing Request</Text>
          </TouchableOpacity>
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
      gap: 14,
    },
    modeRow: {
      flexDirection: 'row',
      alignItems: 'center',
    },
    iconContainer: {
      width: 44,
      height: 44,
      borderRadius: 22,
      backgroundColor: theme.colors.warning + '25',
      justifyContent: 'center',
      alignItems: 'center',
      marginRight: 12,
    },
    icon: {
      color: theme.colors.warning,
    },
    textContainer: {
      flex: 1,
    },
    title: {
      fontSize: 17,
      fontWeight: '700',
      color: theme.colors.text,
      marginBottom: 2,
    },
    subtitle: {
      fontSize: 13,
      color: theme.colors.textSecondary,
    },
    scanButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      backgroundColor: theme.colors.primary,
      paddingVertical: 14,
      paddingHorizontal: 20,
      borderRadius: theme.borderRadius.lg,
    },
    scanButtonText: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.buttonText,
    },
    glowColor: {
      color: theme.colors.warning,
    },
  });
