/**
 * GlassButton - Premium liquid-glass button component
 *
 * A sophisticated button with glass morphism effects, animated press states,
 * and optional glow effects. Supports multiple variants and sizes.
 */

import React, { useMemo, useCallback, useEffect } from 'react';
import {
  View,
  StyleSheet,
  Pressable,
  ActivityIndicator,
  ViewStyle,
  TextStyle,
  StyleProp,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
  withRepeat,
  withSequence,
  Easing,
} from 'react-native-reanimated';
import { useTheme } from '@/contexts/ThemeContext';
import { SafeBlurView } from './SafeBlurView';
import { springConfigs, timingConfigs } from '@/utils/animations';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

interface GlassButtonProps {
  /** Button style variant */
  variant?: ButtonVariant;
  /** Button size */
  size?: ButtonSize;
  /** Ionicon name */
  icon?: keyof typeof Ionicons.glyphMap;
  /** Icon position */
  iconPosition?: 'left' | 'right';
  /** Button label */
  label: string;
  /** Loading state */
  loading?: boolean;
  /** Disabled state */
  disabled?: boolean;
  /** Enable glow effect */
  glow?: boolean;
  /** Make button full width */
  fullWidth?: boolean;
  /** Use pill shape (full rounded) */
  pill?: boolean;
  /** Color tint for secondary buttons (e.g., '#007AFF' or 'rgba(0, 122, 255, 0.15)') */
  tint?: string;
  /** Press handler */
  onPress: () => void;
  /** Long press handler */
  onLongPress?: () => void;
  /** Additional container style */
  style?: StyleProp<ViewStyle>;
  /** Additional label style */
  labelStyle?: StyleProp<TextStyle>;
  /** Test ID */
  testID?: string;
}

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
const AnimatedText = Animated.Text;

export const GlassButton: React.FC<GlassButtonProps> = ({
  variant = 'primary',
  size = 'md',
  icon,
  iconPosition = 'left',
  label,
  loading = false,
  disabled = false,
  glow = false,
  fullWidth = false,
  pill = false,
  tint,
  onPress,
  onLongPress,
  style,
  labelStyle,
  testID,
}) => {
  const { theme } = useTheme();
  const hasNFTBackground = !!theme.backgroundImageUrl;

  // Animation values
  const scale = useSharedValue(1);
  const pressOpacity = useSharedValue(1);
  const glowOpacity = useSharedValue(glow ? 0.4 : 0);

  // Start glow pulse if enabled
  useEffect(() => {
    if (glow && !disabled && !loading) {
      glowOpacity.value = withRepeat(
        withSequence(
          withTiming(0.6, { duration: 1200, easing: Easing.inOut(Easing.ease) }),
          withTiming(0.3, { duration: 1200, easing: Easing.inOut(Easing.ease) })
        ),
        -1,
        false
      );
    } else {
      glowOpacity.value = withTiming(0, timingConfigs.normal);
    }
  }, [glow, disabled, loading, glowOpacity]);

  // Size configurations
  const sizeConfig = useMemo(() => {
    switch (size) {
      case 'sm':
        return {
          height: 36,
          paddingHorizontal: theme.spacing.md,
          fontSize: 14,
          iconSize: 16,
          borderRadius: pill ? theme.borderRadius.pill : theme.borderRadius.md,
        };
      case 'lg':
        return {
          height: 56,
          paddingHorizontal: theme.spacing.xl,
          fontSize: 17,
          iconSize: 22,
          borderRadius: pill ? theme.borderRadius.pill : theme.borderRadius.xl,
        };
      default: // md
        return {
          height: 48,
          paddingHorizontal: theme.spacing.lg,
          fontSize: 16,
          iconSize: 20,
          borderRadius: pill ? theme.borderRadius.pill : theme.borderRadius.lg,
        };
    }
  }, [size, pill, theme.spacing, theme.borderRadius]);

  // Variant styles
  const variantConfig = useMemo(() => {
    // Parse tint color to get rgba values for blending
    const getTintedBackground = () => {
      if (!tint || variant !== 'secondary') {
        return theme.mode === 'dark'
          ? 'rgba(255, 255, 255, 0.1)'
          : 'rgba(255, 255, 255, 0.2)';
      }
      return theme.mode === 'dark'
        ? 'rgba(255, 255, 255, 0.1)'
        : 'rgba(255, 255, 255, 0.2)';
    };

    const getTintGradient = (): [string, string] => {
      if (!tint || variant !== 'secondary') {
        return ['transparent', 'transparent'];
      }
      // Create a subtle tint gradient overlay
      const tintOpacity = theme.mode === 'dark' ? 0.25 : 0.15;
      // Extract color and apply opacity
      if (tint.startsWith('rgba')) {
        return [tint, tint];
      }
      // Convert hex to rgba with opacity
      const hexToRgba = (hex: string, opacity: number) => {
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        return `rgba(${r}, ${g}, ${b}, ${opacity})`;
      };
      const tintColor = hexToRgba(tint, tintOpacity);
      return [tintColor, tintColor];
    };

    const configs = {
      primary: {
        backgroundColor: theme.colors.primary,
        textColor: '#FFFFFF',
        borderColor: 'transparent',
        glowColor: theme.colors.glowPrimary,
        gradientColors: theme.gradients.primary as [string, string],
        useGradient: true,
        tintGradient: null as [string, string] | null,
      },
      secondary: {
        backgroundColor: getTintedBackground(),
        textColor: theme.colors.text,
        borderColor: theme.mode === 'dark'
          ? 'rgba(255, 255, 255, 0.2)'
          : 'rgba(0, 0, 0, 0.1)',
        glowColor: tint || theme.colors.glowPrimary,
        gradientColors: ['transparent', 'transparent'] as [string, string],
        useGradient: false,
        tintGradient: getTintGradient(),
      },
      ghost: {
        backgroundColor: 'transparent',
        textColor: theme.colors.primary,
        borderColor: theme.colors.primary,
        glowColor: theme.colors.glowPrimary,
        gradientColors: ['transparent', 'transparent'] as [string, string],
        useGradient: false,
        tintGradient: null as [string, string] | null,
      },
      danger: {
        backgroundColor: theme.colors.error,
        textColor: '#FFFFFF',
        borderColor: 'transparent',
        glowColor: theme.colors.glowError,
        gradientColors: [theme.colors.error, '#CC3629'] as [string, string],
        useGradient: true,
        tintGradient: null as [string, string] | null,
      },
    };
    return configs[variant];
  }, [variant, theme.colors, theme.gradients, theme.mode, tint]);

  // Press handlers
  const handlePressIn = useCallback(() => {
    if (disabled || loading) return;
    scale.value = withSpring(0.97, springConfigs.snappy);
    pressOpacity.value = withTiming(0.85, timingConfigs.instant);
  }, [disabled, loading, scale, pressOpacity]);

  const handlePressOut = useCallback(() => {
    scale.value = withSpring(1, springConfigs.snappy);
    pressOpacity.value = withTiming(1, timingConfigs.fast);
  }, [scale, pressOpacity]);

  const handlePress = useCallback(() => {
    if (disabled || loading) return;
    onPress();
  }, [disabled, loading, onPress]);

  // Animated styles
  const animatedContainerStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
    opacity: pressOpacity.value,
  }));

  const animatedGlowStyle = useAnimatedStyle(() => ({
    opacity: glowOpacity.value,
  }));

  // Container styles
  const containerStyles = useMemo((): ViewStyle[] => [
    styles.container,
    {
      height: sizeConfig.height,
      borderRadius: sizeConfig.borderRadius,
      borderColor: variantConfig.borderColor,
      borderWidth: variant === 'ghost' ? 1.5 : (variant === 'secondary' ? 1 : 0),
      opacity: disabled ? 0.5 : 1,
    },
    fullWidth && styles.fullWidth,
    style as ViewStyle,
  ].filter(Boolean), [sizeConfig, variantConfig, variant, disabled, fullWidth, style]);

  // Text styles
  const textStyles = useMemo((): TextStyle[] => [
    styles.label,
    {
      fontSize: sizeConfig.fontSize,
      color: variantConfig.textColor,
      fontWeight: '600',
      letterSpacing: 0.3,
    },
    labelStyle as TextStyle,
  ].filter(Boolean), [sizeConfig.fontSize, variantConfig.textColor, labelStyle]);

  // Render icon
  const renderIcon = () => {
    if (!icon || loading) return null;
    return (
      <Ionicons
        name={icon}
        size={sizeConfig.iconSize}
        color={variantConfig.textColor}
        style={iconPosition === 'left' ? styles.iconLeft : styles.iconRight}
      />
    );
  };

  // Render button content
  const renderContent = () => (
    <>
      {/* Glow layer */}
      {glow && (
        <Animated.View
          style={[
            styles.glowLayer,
            {
              backgroundColor: variantConfig.glowColor,
              borderRadius: sizeConfig.borderRadius,
            },
            animatedGlowStyle,
          ]}
          pointerEvents="none"
        />
      )}

      {/* Background - Gradient or solid */}
      {variantConfig.useGradient ? (
        <LinearGradient
          colors={variantConfig.gradientColors}
          style={StyleSheet.absoluteFill}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
        />
      ) : (
        <View
          style={[
            StyleSheet.absoluteFill,
            { backgroundColor: variantConfig.backgroundColor },
          ]}
        />
      )}

      {/* Glass blur for secondary variant with NFT background */}
      {variant === 'secondary' && hasNFTBackground && (
        <SafeBlurView
          intensity={theme.glass.light.blur}
          tint={theme.mode === 'dark' ? 'dark' : 'light'}
          style={StyleSheet.absoluteFill}
        />
      )}

      {/* Tint overlay for secondary buttons */}
      {variantConfig.tintGradient && variantConfig.tintGradient[0] !== 'transparent' && (
        <LinearGradient
          colors={variantConfig.tintGradient}
          style={StyleSheet.absoluteFill}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          pointerEvents="none"
        />
      )}

      {/* Top highlight for depth */}
      <LinearGradient
        colors={
          theme.mode === 'dark'
            ? ['rgba(255, 255, 255, 0.15)', 'rgba(255, 255, 255, 0)']
            : ['rgba(255, 255, 255, 0.4)', 'rgba(255, 255, 255, 0)']
        }
        style={[styles.highlight, { borderTopLeftRadius: sizeConfig.borderRadius, borderTopRightRadius: sizeConfig.borderRadius }]}
        start={{ x: 0, y: 0 }}
        end={{ x: 0, y: 1 }}
        pointerEvents="none"
      />

      {/* Content */}
      <View
        style={[
          styles.content,
          { paddingHorizontal: sizeConfig.paddingHorizontal },
        ]}
      >
        {loading ? (
          <ActivityIndicator
            size="small"
            color={variantConfig.textColor}
          />
        ) : (
          <>
            {icon && iconPosition === 'left' && renderIcon()}
            <AnimatedText style={textStyles}>{label}</AnimatedText>
            {icon && iconPosition === 'right' && renderIcon()}
          </>
        )}
      </View>
    </>
  );

  return (
    <AnimatedPressable
      onPress={handlePress}
      onLongPress={onLongPress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      disabled={disabled || loading}
      style={[containerStyles, animatedContainerStyle]}
      testID={testID}
    >
      {renderContent()}
    </AnimatedPressable>
  );
};

const styles = StyleSheet.create({
  container: {
    overflow: 'hidden',
    position: 'relative',
    justifyContent: 'center',
    alignItems: 'center',
  },
  fullWidth: {
    width: '100%',
  },
  content: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1,
  },
  label: {
    textAlign: 'center',
  },
  iconLeft: {
    marginRight: 8,
  },
  iconRight: {
    marginLeft: 8,
  },
  highlight: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: '50%',
  },
  glowLayer: {
    ...StyleSheet.absoluteFillObject,
    transform: [{ scale: 1.15 }],
  },
});

export default GlassButton;
