/**
 * GlassCard - Premium liquid-glass container component
 *
 * A sophisticated card component with frosted glass effects, subtle borders,
 * and optional glow/animation effects. Works seamlessly with NFT background
 * theming and adapts to light/dark modes.
 */

import React, { useMemo, useCallback } from 'react';
import {
  View,
  StyleSheet,
  Platform,
  Pressable,
  ViewStyle,
  StyleProp,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, {
  useAnimatedStyle,
  withSpring,
  withTiming,
  useSharedValue,
} from 'react-native-reanimated';
import { useTheme } from '@/contexts/ThemeContext';
import { SafeBlurView } from './SafeBlurView';
import { springConfigs, timingConfigs } from '@/utils/animations';

export type GlassVariant = 'light' | 'medium' | 'heavy' | 'chromatic';

interface GlassCardProps {
  /** Glass intensity variant */
  variant?: GlassVariant;
  /** Enable border glow effect */
  borderGlow?: boolean;
  /** Glow color (defaults to primary) */
  glowColor?: string;
  /** Enable press animation */
  animated?: boolean;
  /** Press handler */
  onPress?: () => void;
  /** Long press handler */
  onLongPress?: () => void;
  /** Additional container style */
  style?: StyleProp<ViewStyle>;
  /** Children content */
  children: React.ReactNode;
  /** Border radius override */
  borderRadius?: number;
  /** Padding preset */
  padding?: 'none' | 'sm' | 'md' | 'lg';
  /** Disable the top highlight gradient */
  noHighlight?: boolean;
  /** Border color (no border when undefined) */
  borderColor?: string;
  /** Test ID for testing */
  testID?: string;
}

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export const GlassCard: React.FC<GlassCardProps> = ({
  variant = 'medium',
  borderGlow = false,
  glowColor,
  animated = true,
  onPress,
  onLongPress,
  style,
  children,
  borderRadius,
  padding = 'md',
  noHighlight = false,
  borderColor,
  testID,
}) => {
  const { theme } = useTheme();
  const hasNFTBackground = !!theme.backgroundImageUrl;

  // Animation values
  const scale = useSharedValue(1);
  const pressOpacity = useSharedValue(1);

  // Get glass config from theme
  const glassConfig = theme.glass[variant];
  const resolvedBorderRadius = borderRadius ?? theme.borderRadius.lg;
  const resolvedGlowColor = glowColor ?? theme.colors.primary;

  // Padding values based on preset
  const paddingValue = useMemo(() => {
    switch (padding) {
      case 'none': return 0;
      case 'sm': return theme.spacing.sm;
      case 'md': return theme.spacing.md;
      case 'lg': return theme.spacing.lg;
      default: return theme.spacing.md;
    }
  }, [padding, theme.spacing]);

  // Press handlers
  const handlePressIn = useCallback(() => {
    if (!animated) return;
    scale.value = withSpring(0.98, springConfigs.snappy);
    pressOpacity.value = withTiming(0.92, timingConfigs.instant);
  }, [animated, scale, pressOpacity]);

  const handlePressOut = useCallback(() => {
    if (!animated) return;
    scale.value = withSpring(1, springConfigs.snappy);
    pressOpacity.value = withTiming(1, timingConfigs.fast);
  }, [animated, scale, pressOpacity]);

  // Animated styles
  const animatedContainerStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
    opacity: pressOpacity.value,
  }));

  // Glow shadow style
  const glowShadowStyle = useMemo((): ViewStyle => {
    if (!borderGlow) return {};

    return {
      shadowColor: resolvedGlowColor,
      shadowOffset: { width: 0, height: 0 },
      shadowOpacity: theme.mode === 'dark' ? 0.5 : 0.35,
      shadowRadius: 16,
      elevation: 4,
    };
  }, [borderGlow, resolvedGlowColor, theme.mode]);

  // Container styles
  const containerStyles = useMemo(() => [
    styles.container,
    {
      borderRadius: resolvedBorderRadius,
      ...(borderColor && {
        borderWidth: 1,
        borderColor,
      }),
    },
    glowShadowStyle,
    style,
  ], [resolvedBorderRadius, borderColor, glowShadowStyle, style]);

  // Blur tint based on variant and theme mode
  const blurTint = useMemo(() => {
    if (variant === 'chromatic') {
      return theme.mode === 'dark' ? 'dark' : 'light';
    }
    return theme.mode === 'dark' ? 'dark' : 'light';
  }, [variant, theme.mode]);

  // Background overlay color (for when blur is not available or NFT theme)
  const overlayBackgroundColor = useMemo(() => {
    if (hasNFTBackground) {
      // Light overlay on top of blur for glass tint effect
      return theme.mode === 'dark'
        ? 'rgba(0, 0, 0, 0.25)'
        : 'rgba(255, 255, 255, 0.05)';
    }
    return theme.colors.glassBackground;
  }, [hasNFTBackground, theme.mode, theme.colors.glassBackground]);

  // Highlight gradient colors (subtle top edge highlight for depth)
  const highlightGradientColors = useMemo(() => {
    if (noHighlight) return ['transparent', 'transparent'];
    return theme.mode === 'dark'
      ? ['rgba(255, 255, 255, 0.12)', 'rgba(255, 255, 255, 0)']
      : ['rgba(255, 255, 255, 0.5)', 'rgba(255, 255, 255, 0)'];
  }, [noHighlight, theme.mode]);

  // Render the card content with glass effect
  const renderContent = () => (
    <>
      {/* Blur layer (only when NFT background is present) */}
      {hasNFTBackground && (
        <SafeBlurView
          intensity={glassConfig.blur}
          tint={blurTint}
          style={StyleSheet.absoluteFill}
        />
      )}

      {/* Semi-transparent overlay for consistent glass effect */}
      <View
        style={[
          styles.overlay,
          { backgroundColor: overlayBackgroundColor },
        ]}
        pointerEvents="none"
      />

      {/* Top highlight gradient for glass depth effect */}
      <LinearGradient
        colors={highlightGradientColors as [string, string]}
        style={[
          styles.highlightGradient,
          { borderTopLeftRadius: resolvedBorderRadius - 1, borderTopRightRadius: resolvedBorderRadius - 1 },
        ]}
        start={{ x: 0, y: 0 }}
        end={{ x: 0, y: 1 }}
        pointerEvents="none"
      />

      {/* Inner border highlight for glass edge effect */}
      <View
        style={[
          {
            borderRadius: resolvedBorderRadius - 1,
            borderColor: theme.colors.glassHighlight,
          },
        ]}
        pointerEvents="none"
      />

      {/* Content */}
      <View style={[styles.content, { padding: paddingValue }]}>
        {children}
      </View>
    </>
  );

  // If pressable, wrap in AnimatedPressable
  if (onPress || onLongPress) {
    return (
      <AnimatedPressable
        onPress={onPress}
        onLongPress={onLongPress}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        style={[containerStyles, animatedContainerStyle]}
        testID={testID}
      >
        {renderContent()}
      </AnimatedPressable>
    );
  }

  // Non-pressable version
  if (animated) {
    return (
      <Animated.View style={[containerStyles, animatedContainerStyle]} testID={testID}>
        {renderContent()}
      </Animated.View>
    );
  }

  return (
    <View style={containerStyles} testID={testID}>
      {renderContent()}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    overflow: 'hidden',
    position: 'relative',
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
  },
  highlightGradient: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 48,
  },
  content: {
    position: 'relative',
    zIndex: 1,
  },
});

export default GlassCard;
