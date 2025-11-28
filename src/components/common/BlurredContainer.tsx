import React, { useMemo } from 'react';
import { View, StyleSheet, Platform, ViewStyle } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useTheme } from '@/contexts/ThemeContext';
import { SafeBlurView } from './SafeBlurView';
import { GlassEffect } from '@/constants/themes';

export type BlurVariant = 'light' | 'medium' | 'heavy' | 'chromatic';

interface BlurredContainerProps {
  children: React.ReactNode;
  /** Glass intensity variant - uses theme presets */
  variant?: BlurVariant;
  /** Custom intensity (overrides variant) */
  intensity?: number;
  style?: any;
  borderRadius?: number;
  /** Deprecated - use variant instead */
  opacity?: number;
  tint?: 'light' | 'dark' | 'default';
  /** Show top highlight gradient for glass depth effect */
  showHighlight?: boolean;
  /** Show inner border for glass edge effect */
  showInnerBorder?: boolean;
  /** Custom background color (overrides glass effect) */
  backgroundColor?: string;
  /** Disable blur (use inside FlatList/VirtualizedList to avoid Android crashes) */
  disableBlur?: boolean;
}

/**
 * BlurredContainer - Enhanced glass morphism container
 *
 * A container component that applies frosted glass effects over NFT backgrounds.
 * Supports multiple intensity variants and optional highlight/border effects
 * for premium liquid-glass aesthetic.
 *
 * Falls back to solid color background if no NFT theme is active.
 */
export const BlurredContainer: React.FC<BlurredContainerProps> = ({
  children,
  variant = 'medium',
  intensity,
  style,
  borderRadius = 0,
  opacity,
  tint = 'default',
  showHighlight = false,
  showInnerBorder = false,
  backgroundColor,
  disableBlur = false,
}) => {
  const { theme } = useTheme();
  // Disable blur when requested (e.g., inside FlatList) to avoid Android crashes
  const hasNFTBackground = !disableBlur && !!theme.backgroundImageUrl;

  // Get glass config from theme based on variant
  const glassConfig: GlassEffect = theme.glass[variant];
  const resolvedIntensity = intensity ?? glassConfig.blur;
  const resolvedBorderRadius = borderRadius ?? theme.borderRadius.lg;

  // Determine blur tint based on variant and theme mode
  const blurTint = useMemo(() => {
    if (tint !== 'default') return tint;
    if (variant === 'chromatic') {
      return theme.mode === 'dark' ? 'dark' : 'light';
    }
    return theme.mode === 'dark' ? 'dark' : 'light';
  }, [tint, variant, theme.mode]);

  // Remove backgroundColor and shadow properties to avoid conflicts with blurred background
  const removeVisualConflicts = (styleObj: any) => {
    if (!styleObj) return {};
    const {
      backgroundColor: _bg,
      shadowColor,
      shadowOffset,
      shadowOpacity,
      shadowRadius,
      elevation,
      ...rest
    } = styleObj;
    return rest;
  };

  // Extract layout properties for content, spacing/sizing for BlurView
  const extractLayoutProps = (styleObj: any) => {
    if (!styleObj) return {};
    const {
      flexDirection,
      justifyContent,
      alignItems,
      alignSelf,
      flexWrap,
      gap,
      ...rest
    } = styleObj;
    return { flexDirection, justifyContent, alignItems, alignSelf, flexWrap, gap };
  };

  const containerStyle = style
    ? Array.isArray(style)
      ? style.map((s) => removeVisualConflicts(s)).filter((s) => s && Object.keys(s).length > 0)
      : removeVisualConflicts(style)
    : {};

  const layoutStyle = style
    ? Array.isArray(style)
      ? Object.assign({}, ...style.map((s) => extractLayoutProps(s)))
      : extractLayoutProps(style)
    : {};

  // Overlay background color with glass effect
  const overlayBackgroundColor = useMemo(() => {
    if (backgroundColor) return backgroundColor;
    if (!hasNFTBackground) return glassConfig.backgroundColor;

    // Enhanced overlay for NFT backgrounds
    return theme.mode === 'dark'
      ? `rgba(0, 0, 0, ${Platform.OS === 'android' ? 0.5 : 0.35})`
      : `rgba(255, 255, 255, ${Platform.OS === 'android' ? 0.6 : 0.45})`;
  }, [backgroundColor, hasNFTBackground, glassConfig.backgroundColor, theme.mode]);

  // Highlight gradient colors (subtle top edge highlight for depth)
  const highlightGradientColors = useMemo((): [string, string] => {
    if (!showHighlight) return ['transparent', 'transparent'];
    return theme.mode === 'dark'
      ? ['rgba(255, 255, 255, 0.1)', 'rgba(255, 255, 255, 0)']
      : ['rgba(255, 255, 255, 0.4)', 'rgba(255, 255, 255, 0)'];
  }, [showHighlight, theme.mode]);

  // Inner border style
  const innerBorderStyle: ViewStyle | null = useMemo(() => {
    if (!showInnerBorder) return null;
    return {
      position: 'absolute' as const,
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      borderRadius: resolvedBorderRadius - 1,
      borderWidth: 1,
      borderColor: theme.colors.glassHighlight,
      opacity: 0.5,
    };
  }, [showInnerBorder, resolvedBorderRadius, theme.colors.glassHighlight]);

  // Non-NFT background fallback with glass styling
  if (!hasNFTBackground) {
    return (
      <View
        style={[
          styles.container,
          {
            borderRadius: resolvedBorderRadius,
            backgroundColor: backgroundColor ?? theme.colors.glassBackground,
          },
          containerStyle,
          style,
        ]}
      >
        {/* Top highlight gradient */}
        {showHighlight && (
          <LinearGradient
            colors={highlightGradientColors}
            style={[
              styles.highlightGradient,
              {
                borderTopLeftRadius: resolvedBorderRadius - 1,
                borderTopRightRadius: resolvedBorderRadius - 1,
              },
            ]}
            start={{ x: 0, y: 0 }}
            end={{ x: 0, y: 1 }}
            pointerEvents="none"
          />
        )}

        {/* Inner border */}
        {innerBorderStyle && <View style={innerBorderStyle} pointerEvents="none" />}

        {/* Content */}
        <View style={[styles.content, layoutStyle]}>
          {children}
        </View>
      </View>
    );
  }

  // NFT background version with blur
  return (
    <SafeBlurView
      intensity={resolvedIntensity}
      tint={blurTint}
      style={[
        styles.container,
        {
          borderRadius: resolvedBorderRadius,
        },
        containerStyle,
      ]}
    >
      {/* Semi-transparent overlay for consistent glass effect */}
      <View
        style={[
          styles.overlay,
          {
            borderRadius: resolvedBorderRadius,
            backgroundColor: overlayBackgroundColor,
          },
        ]}
        pointerEvents="none"
      />

      {/* Top highlight gradient for glass depth effect */}
      {showHighlight && (
        <LinearGradient
          colors={highlightGradientColors}
          style={[
            styles.highlightGradient,
            {
              borderTopLeftRadius: resolvedBorderRadius - 1,
              borderTopRightRadius: resolvedBorderRadius - 1,
            },
          ]}
          start={{ x: 0, y: 0 }}
          end={{ x: 0, y: 1 }}
          pointerEvents="none"
        />
      )}

      {/* Inner border for glass edge effect */}
      {innerBorderStyle && <View style={innerBorderStyle} pointerEvents="none" />}

      {/* Content - positioned above overlay */}
      <View style={[styles.content, layoutStyle]}>
        {children}
      </View>
    </SafeBlurView>
  );
};

const styles = StyleSheet.create({
  container: {
    position: 'relative',
    overflow: 'hidden',
  },
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  highlightGradient: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 40,
  },
  content: {
    position: 'relative',
    zIndex: 1,
    width: '100%',
  },
});
