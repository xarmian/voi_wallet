import React from 'react';
import { View, StyleSheet, Platform } from 'react-native';
import { useTheme } from '@/contexts/ThemeContext';
import { SafeBlurView } from './SafeBlurView';

interface BlurredContainerProps {
  children: React.ReactNode;
  intensity?: number;
  style?: any;
  borderRadius?: number;
  opacity?: number;
  tint?: 'light' | 'dark' | 'default';
}

/**
 * Container component that blurs the background behind it
 * Used for cards/containers to make them readable over the NFT background
 * Falls back to solid color background if no NFT theme is active
 */
export const BlurredContainer: React.FC<BlurredContainerProps> = ({
  children,
  intensity = 20,
  style,
  borderRadius = 0,
  opacity = 0.5,
  tint = 'default',
}) => {
  const { theme } = useTheme();
  const hasNFTBackground = !!theme.backgroundImageUrl;

  if (!hasNFTBackground) {
    // Fallback to regular View with theme background color
    return (
      <View style={[style, { borderRadius }]}>
        {children}
      </View>
    );
  }

  // Determine blur tint based on theme mode
  const blurTint = tint === 'default' 
    ? (theme.mode === 'dark' ? 'dark' : 'light')
    : tint;

  // Remove backgroundColor and shadow properties to avoid conflicts with blurred background
  const removeVisualConflicts = (styleObj: any) => {
    if (!styleObj) return {};
    const {
      backgroundColor,
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

  const overlayBackgroundColor =
    theme.mode === 'dark'
      ? `rgba(0, 0, 0, ${Platform.OS === 'android' ? 0.6 : 0.3})`
      : `rgba(255, 255, 255, ${Platform.OS === 'android' ? 0.6 : 0.3})`;

  return (
    <SafeBlurView
      intensity={intensity}
      tint={blurTint}
      style={[
        styles.blurContainer,
        containerStyle,
        { borderRadius, overflow: 'hidden' },
      ]}
    >
      {/* Semi-transparent overlay for better contrast and readability */}
      <View
        style={[
          styles.overlay,
          {
            borderRadius,
            backgroundColor: overlayBackgroundColor,
          },
        ]}
        pointerEvents="none"
      />

      {/* Content - positioned above overlay */}
      <View style={[styles.content, layoutStyle, { opacity: 1 }]}>
        {children}
      </View>
    </SafeBlurView>
  );
};

const styles = StyleSheet.create({
  blurContainer: {
    position: 'relative',
  },
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  content: {
    position: 'relative',
    zIndex: 1,
    width: '100%',
  },
});
