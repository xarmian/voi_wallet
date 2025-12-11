/**
 * UpdateBanner - Banner shown on HomeScreen when an OTA update is available
 */

import React, { useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Animated, {
  FadeInDown,
  FadeOutUp,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import { GlassCard } from '@/components/common/GlassCard';

interface UpdateBannerProps {
  /** Called when user taps to install the update */
  onInstall: () => void;
  /** Called when user dismisses the banner */
  onDismiss: () => void;
  /** Whether the update is currently being installed */
  isInstalling?: boolean;
}

export default function UpdateBanner({
  onInstall,
  onDismiss,
  isInstalling = false,
}: UpdateBannerProps) {
  const styles = useThemedStyles(createStyles);
  const iconScale = useSharedValue(1);

  // Subtle pulsing animation on the icon (only when not installing)
  useEffect(() => {
    if (!isInstalling) {
      iconScale.value = withRepeat(
        withSequence(
          withTiming(1.1, { duration: 800 }),
          withTiming(1, { duration: 800 })
        ),
        -1,
        true
      );
    } else {
      iconScale.value = 1;
    }
  }, [iconScale, isInstalling]);

  const iconAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: iconScale.value }],
  }));

  const handlePress = () => {
    if (!isInstalling) {
      onInstall();
    }
  };

  const handleDismiss = () => {
    if (!isInstalling) {
      onDismiss();
    }
  };

  return (
    <Animated.View
      entering={FadeInDown.duration(400).springify()}
      exiting={FadeOutUp.duration(300)}
      style={styles.container}
    >
      <GlassCard
        variant="medium"
        onPress={handlePress}
        borderGlow
        glowColor={styles.glowColor.color}
        padding="md"
      >
        <View style={styles.content}>
          <Animated.View style={[styles.iconContainer, iconAnimatedStyle]}>
            {isInstalling ? (
              <ActivityIndicator size="small" color={styles.icon.color} />
            ) : (
              <Ionicons name="download" size={28} color={styles.icon.color} />
            )}
          </Animated.View>
          <View style={styles.textContainer}>
            <Text style={styles.title}>
              {isInstalling ? 'Installing update...' : 'Update available'}
            </Text>
            <Text style={styles.subtitle}>
              {isInstalling ? 'Please wait' : 'Tap to install and restart'}
            </Text>
          </View>
          {!isInstalling && (
            <TouchableOpacity
              onPress={handleDismiss}
              style={styles.dismissButton}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
              <Ionicons
                name="close"
                size={20}
                color={styles.dismissIcon.color}
              />
            </TouchableOpacity>
          )}
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
      backgroundColor: theme.colors.success + '20',
      justifyContent: 'center',
      alignItems: 'center',
      marginRight: 14,
    },
    icon: {
      color: theme.colors.success,
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
    dismissButton: {
      padding: 4,
    },
    dismissIcon: {
      color: theme.colors.textMuted,
    },
    glowColor: {
      color: theme.colors.success,
    },
  });
