import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { NetworkId } from '@/types/network';
import { getNetworkConfig } from '@/services/network/config';
import { useAvailableNetworks } from '@/store/networkStore';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import { BlurredContainer } from '@/components/common/BlurredContainer';

interface NetworkSelectorProps {
  selectedNetworkId: NetworkId;
  onNetworkChange: (networkId: NetworkId) => void;
  disabled?: boolean;
  networks?: NetworkId[]; // Optional: filter to specific networks
}

export default function NetworkSelector({
  selectedNetworkId,
  onNetworkChange,
  disabled = false,
  networks,
}: NetworkSelectorProps) {
  const availableNetworks = useAvailableNetworks();
  const styles = useThemedStyles(createStyles);

  // Use provided networks filter or fall back to all available networks
  // Handle case where networks prop is an empty array
  const networksToShow = networks?.length ? networks : availableNetworks;

  return (
    <View style={styles.container}>
      <Text style={styles.label}>Network</Text>
      <View style={styles.networkButtons}>
        {networksToShow.map((networkId) => {
          const config = getNetworkConfig(networkId);
          const isSelected = networkId === selectedNetworkId;

          // Shorten network name
          const shortName = config.name
            .replace(' Network', '')
            .replace(' Mainnet', '')
            .replace(' Testnet', '')
            .trim();

          return (
            <TouchableOpacity
              key={networkId}
              onPress={() => onNetworkChange(networkId)}
              disabled={disabled}
              activeOpacity={0.7}
              style={[styles.networkButtonWrapper, disabled && styles.networkButtonDisabled]}
            >
              <BlurredContainer
                variant={isSelected ? 'medium' : 'light'}
                borderRadius={styles.networkButton.borderRadius}
                style={[
                  styles.networkButton,
                  isSelected && { borderColor: config.color },
                ]}
              >
                <View style={styles.networkButtonContent}>
                  <View
                    style={[
                      styles.networkIndicator,
                      { backgroundColor: config.color },
                    ]}
                  />
                  <Text
                    style={[
                      styles.networkButtonText,
                      isSelected && styles.networkButtonTextSelected,
                      !isSelected && styles.networkButtonTextMuted,
                      disabled && styles.networkButtonTextDisabled,
                    ]}
                  >
                    {shortName}
                  </Text>
                </View>
              </BlurredContainer>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    container: {
      marginBottom: theme.spacing.lg,
    },
    label: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.text,
      marginBottom: theme.spacing.sm,
      // Text shadow for readability over NFT backgrounds
      textShadowColor: theme.mode === 'dark'
        ? 'rgba(0, 0, 0, 0.8)'
        : 'rgba(255, 255, 255, 0.9)',
      textShadowOffset: { width: 0, height: 0 },
      textShadowRadius: 10,
    },
    networkButtons: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: theme.spacing.sm,
    },
    networkButtonWrapper: {
      flex: 1,
      minWidth: 100,
    },
    networkButton: {
      borderWidth: 2,
      borderColor: 'transparent',
      borderRadius: theme.borderRadius.md,
      paddingVertical: theme.spacing.sm,
      paddingHorizontal: theme.spacing.md,
    },
    networkButtonContent: {
      flexDirection: 'row',
      alignItems: 'center',
    },
    networkButtonDisabled: {
      opacity: 0.5,
    },
    networkIndicator: {
      width: 10,
      height: 10,
      borderRadius: 5,
      marginRight: theme.spacing.xs,
    },
    networkButtonText: {
      fontSize: 14,
      fontWeight: '600',
      color: theme.colors.text,
    },
    networkButtonTextSelected: {
      color: theme.colors.text,
      fontWeight: '700',
    },
    networkButtonTextMuted: {
      color: theme.colors.textMuted,
      fontWeight: '500',
    },
    networkButtonTextDisabled: {
      color: theme.colors.textMuted,
    },
  });
