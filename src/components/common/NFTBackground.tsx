import React, { useMemo } from 'react';
import { View, StyleSheet, Image, Dimensions, Platform } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useTheme } from '@/contexts/ThemeContext';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

interface NFTBackgroundProps {
  children: React.ReactNode;
  /** Show vignette overlay around edges */
  showVignette?: boolean;
  /** Vignette intensity (0-1) */
  vignetteIntensity?: number;
  /** Show subtle color overlay for better readability */
  showOverlay?: boolean;
  /** Overlay opacity (0-1) */
  overlayOpacity?: number;
  /** Show bottom gradient fade for navigation area */
  showBottomFade?: boolean;
}

/**
 * NFTBackground - Premium full-screen background with liquid-glass effects
 *
 * Displays the NFT image with optional vignette, overlay, and gradient effects
 * for a sophisticated, premium aesthetic. Falls back to solid color if no
 * NFT theme is active or background is disabled.
 */
export const NFTBackground: React.FC<NFTBackgroundProps> = ({
  children,
  showVignette = true,
  vignetteIntensity = 0.65,
  showOverlay = true,
  overlayOpacity = 0.15,
  showBottomFade = true,
}) => {
  const { theme, nftBackgroundEnabled, nftOverlayIntensity } = useTheme();
  const isDark = theme.mode === 'dark';

  // Show background only if theme has backgroundImageUrl (which is already conditional on nftBackgroundEnabled)
  const hasNFTBackground = !!theme.backgroundImageUrl && nftBackgroundEnabled;

  // Overlay color based on theme mode and user-configured intensity
  // Dark mode: darken the image (black overlay, max 0.8 opacity)
  // Light mode: lighten the image (white overlay, max 0.7 opacity)
  const overlayColor = useMemo(() => {
    if (!showOverlay) return 'transparent';
    const intensity = nftOverlayIntensity;
    return isDark
      ? `rgba(10, 10, 15, ${intensity * 0.8})`
      : `rgba(255, 255, 255, ${intensity * 0.7})`;
  }, [showOverlay, isDark, nftOverlayIntensity]);

  // Vignette gradient colors (radial effect simulated with linear gradients)
  const vignetteColors = useMemo((): [string, string, string] => {
    if (!showVignette) return ['transparent', 'transparent', 'transparent'];
    const baseColor = isDark ? '0, 0, 0' : '0, 0, 0';
    return [
      `rgba(${baseColor}, 0)`,
      `rgba(${baseColor}, ${vignetteIntensity * 0.3})`,
      `rgba(${baseColor}, ${vignetteIntensity})`,
    ];
  }, [showVignette, isDark, vignetteIntensity]);

  // Bottom fade gradient colors for navigation area
  const bottomFadeColors = useMemo((): [string, string] => {
    if (!showBottomFade) return ['transparent', 'transparent'];
    return isDark
      ? ['rgba(10, 10, 15, 0)', 'rgba(10, 10, 15, 0.9)']
      : ['rgba(245, 245, 247, 0)', 'rgba(245, 245, 247, 0.85)'];
  }, [showBottomFade, isDark]);

  // Top fade gradient for header area
  const topFadeColors = useMemo((): [string, string] => {
    return isDark
      ? ['rgba(10, 10, 15, 0.7)', 'rgba(10, 10, 15, 0)']
      : ['rgba(255, 255, 255, 0.5)', 'rgba(255, 255, 255, 0)'];
  }, [isDark]);

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      {/* NFT Background Image - only render if enabled and available */}
      {hasNFTBackground && (
        <>
          <Image
            source={{ uri: theme.backgroundImageUrl }}
            style={styles.backgroundImage}
            resizeMode="cover"
          />

          {/* Color overlay for better readability */}
          <View
            style={[
              styles.colorOverlay,
              { backgroundColor: overlayColor },
            ]}
            pointerEvents="none"
          />

          {/* Top vignette gradient (for header area) */}
          <LinearGradient
            colors={topFadeColors}
            style={styles.topGradient}
            start={{ x: 0.5, y: 0 }}
            end={{ x: 0.5, y: 1 }}
            pointerEvents="none"
          />

          {/* Left vignette edge */}
          {showVignette && (
            <LinearGradient
              colors={[vignetteColors[2], vignetteColors[1], vignetteColors[0]]}
              style={styles.leftVignette}
              start={{ x: 0, y: 0.5 }}
              end={{ x: 1, y: 0.5 }}
              pointerEvents="none"
            />
          )}

          {/* Right vignette edge */}
          {showVignette && (
            <LinearGradient
              colors={[vignetteColors[0], vignetteColors[1], vignetteColors[2]]}
              style={styles.rightVignette}
              start={{ x: 0, y: 0.5 }}
              end={{ x: 1, y: 0.5 }}
              pointerEvents="none"
            />
          )}

          {/* Bottom vignette/fade for navigation */}
          <LinearGradient
            colors={bottomFadeColors}
            style={styles.bottomGradient}
            start={{ x: 0.5, y: 0 }}
            end={{ x: 0.5, y: 1 }}
            pointerEvents="none"
          />

          {/* Corner vignettes for extra depth */}
          {showVignette && (
            <>
              <LinearGradient
                colors={[vignetteColors[2], 'transparent']}
                style={styles.topLeftCorner}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                pointerEvents="none"
              />
              <LinearGradient
                colors={[vignetteColors[2], 'transparent']}
                style={styles.topRightCorner}
                start={{ x: 1, y: 0 }}
                end={{ x: 0, y: 1 }}
                pointerEvents="none"
              />
              <LinearGradient
                colors={['transparent', vignetteColors[2]]}
                style={styles.bottomLeftCorner}
                start={{ x: 1, y: 0 }}
                end={{ x: 0, y: 1 }}
                pointerEvents="none"
              />
              <LinearGradient
                colors={['transparent', vignetteColors[2]]}
                style={styles.bottomRightCorner}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                pointerEvents="none"
              />
            </>
          )}
        </>
      )}

      {/* Content */}
      <View style={styles.content}>
        {children}
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    position: 'relative',
  },
  backgroundImage: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    width: '100%',
    height: '100%',
  },
  colorOverlay: {
    ...StyleSheet.absoluteFillObject,
  },
  topGradient: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 120,
  },
  bottomGradient: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 160,
  },
  leftVignette: {
    position: 'absolute',
    top: 0,
    left: 0,
    bottom: 0,
    width: 80,
  },
  rightVignette: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    width: 80,
  },
  topLeftCorner: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: 150,
    height: 150,
  },
  topRightCorner: {
    position: 'absolute',
    top: 0,
    right: 0,
    width: 150,
    height: 150,
  },
  bottomLeftCorner: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    width: 150,
    height: 150,
  },
  bottomRightCorner: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    width: 150,
    height: 150,
  },
  content: {
    flex: 1,
    position: 'relative',
    zIndex: 1,
  },
});
