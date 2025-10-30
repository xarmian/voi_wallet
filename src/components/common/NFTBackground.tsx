import React from 'react';
import { View, StyleSheet, Image } from 'react-native';
import { useTheme } from '@/contexts/ThemeContext';

interface NFTBackgroundProps {
  children: React.ReactNode;
}

/**
 * Full-screen background component that displays the NFT image
 * Falls back to solid color if no NFT theme is active or background is disabled
 */
export const NFTBackground: React.FC<NFTBackgroundProps> = ({ children }) => {
  const { theme, nftBackgroundEnabled } = useTheme();
  // Show background only if theme has backgroundImageUrl (which is already conditional on nftBackgroundEnabled)
  const hasNFTBackground = !!theme.backgroundImageUrl && nftBackgroundEnabled;

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      {/* NFT Background Image - only render if enabled and available */}
      {hasNFTBackground && (
        <Image
          source={{ uri: theme.backgroundImageUrl }}
          style={styles.backgroundImage}
          resizeMode="cover"
        />
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
  content: {
    flex: 1,
    position: 'relative',
    zIndex: 1,
  },
});
