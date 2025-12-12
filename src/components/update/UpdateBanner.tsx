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
  /** Called when user taps to download and install the update */
  onInstall: () => void;
  /** Called when user dismisses the banner */
  onDismiss: () => void;
  /** Whether the update is currently being downloaded */
  isDownloading?: boolean;
  /** Whether the update is currently being installed */
  isInstalling?: boolean;
}

export default function UpdateBanner({
  onInstall,
  onDismiss,
  isDownloading = false,
  isInstalling = false,
}: UpdateBannerProps) {
  const styles = useThemedStyles(createStyles);
  const iconScale = useSharedValue(1);

  const isBusy = isDownloading || isInstalling;

  // Subtle pulsing animation on the icon (only when not busy)
  useEffect(() => {
    if (!isBusy) {
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
  }, [iconScale, isBusy]);

  const iconAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: iconScale.value }],
  }));

  const handlePress = () => {
    if (!isBusy) {
      onInstall();
    }
  };

  const handleDismiss = () => {
    if (!isBusy) {
      onDismiss();
    }
  };

  // Determine title and subtitle based on state
  const getTitle = () => {
    if (isDownloading) return 'Downloading update...';
    if (isInstalling) return 'Installing update...';
    return 'Update available';
  };

  const getSubtitle = () => {
    if (isDownloading) return 'Please wait';
    if (isInstalling) return 'Restarting app';
    return 'Tap to download and install';
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
            {isBusy ? (
              <ActivityIndicator size="small" color={styles.icon.color} />
            ) : (
              <Ionicons name="download" size={28} color={styles.icon.color} />
            )}
          </Animated.View>
          <View style={styles.textContainer}>
            <Text style={styles.title}>{getTitle()}</Text>
            <Text style={styles.subtitle}>{getSubtitle()}</Text>
          </View>
          {!isBusy && (
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
