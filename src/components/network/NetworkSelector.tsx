import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { NetworkId } from '@/types/network';
import { getNetworkConfig } from '@/services/network/config';
import { useAvailableNetworks } from '@/store/networkStore';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';

interface NetworkSelectorProps {
  selectedNetworkId: NetworkId;
  onNetworkChange: (networkId: NetworkId) => void;
  disabled?: boolean;
}

export default function NetworkSelector({
  selectedNetworkId,
  onNetworkChange,
  disabled = false,
}: NetworkSelectorProps) {
  const availableNetworks = useAvailableNetworks();
  const styles = useThemedStyles(createStyles);

  return (
    <View style={styles.container}>
      <Text style={styles.label}>Network</Text>
      <View style={styles.networkButtons}>
        {availableNetworks.map((networkId) => {
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
              style={[
                styles.networkButton,
                isSelected && styles.networkButtonSelected,
                disabled && styles.networkButtonDisabled,
              ]}
              onPress={() => !disabled && onNetworkChange(networkId)}
              disabled={disabled}
              activeOpacity={0.7}
            >
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
                  disabled && styles.networkButtonTextDisabled,
                ]}
              >
                {shortName}
              </Text>
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
    },
    networkButtons: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: theme.spacing.sm,
    },
    networkButton: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: theme.colors.surface,
      borderWidth: 2,
      borderColor: theme.colors.border,
      borderRadius: theme.borderRadius.md,
      paddingVertical: theme.spacing.sm,
      paddingHorizontal: theme.spacing.md,
      minWidth: 100,
    },
    networkButtonSelected: {
      borderColor: theme.colors.primary,
      backgroundColor: theme.colors.card,
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
      fontWeight: '500',
      color: theme.colors.textSecondary,
    },
    networkButtonTextSelected: {
      color: theme.colors.primary,
      fontWeight: '600',
    },
    networkButtonTextDisabled: {
      color: theme.colors.textMuted,
    },
  });
