import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { NetworkId } from '@/types/network';
import { getNetworkConfig } from '@/services/network/config';
import {
  useCurrentNetwork,
  useCurrentNetworkConfig,
  useAvailableNetworks,
} from '@/store/networkStore';
import { useIsMultiNetworkView } from '@/store/walletStore';
import { useTheme } from '@/contexts/ThemeContext';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';

interface NetworkIndicatorProps {
  onPress?: () => void;
  showName?: boolean;
  size?: 'small' | 'medium' | 'large';
  viewMode?: 'single-network' | 'multi-network'; // Optional override
}

export default function NetworkIndicator({
  onPress,
  showName = true,
  size = 'medium',
  viewMode,
}: NetworkIndicatorProps) {
  const currentNetwork = useCurrentNetwork();
  const networkConfig = useCurrentNetworkConfig();
  const availableNetworks = useAvailableNetworks();
  const isMultiNetworkView = useIsMultiNetworkView();
  const { theme } = useTheme();
  const styles = useThemedStyles(createStyles);

  // Use prop override or global state
  const effectiveViewMode = viewMode || (isMultiNetworkView ? 'multi-network' : 'single-network');
  const isShowingMultiNetwork = effectiveViewMode === 'multi-network';

  const sizeStyles = {
    small: {
      pill: { paddingHorizontal: 4, paddingVertical: 2, borderRadius: 8 },
      text: { fontSize: 9 },
      gap: 3,
    },
    medium: {
      pill: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 10 },
      text: { fontSize: 10 },
      gap: 4,
    },
    large: {
      pill: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 12 },
      text: { fontSize: 11 },
      gap: 6,
    },
  }[size];

  const Container = onPress ? TouchableOpacity : View;

  // Multi-network view: Show all network badges as pills
  if (isShowingMultiNetwork) {
    return (
      <Container style={[styles.container, styles.multiNetworkContainer]} onPress={onPress} disabled={!onPress}>
        <View style={[styles.pillsContainer, { gap: sizeStyles.gap }]}>
          {availableNetworks.map((networkId) => {
            const config = getNetworkConfig(networkId);
            // Shorten network name - remove "Network" and other long suffixes
            const shortName = config.name
              .replace(' Network', '')
              .replace(' Mainnet', '')
              .replace(' Testnet', '')
              .trim();
            return (
              <View
                key={networkId}
                style={[
                  styles.networkPill,
                  sizeStyles.pill,
                  { backgroundColor: config.color },
                ]}
              >
                {showName && (
                  <Text style={[styles.pillText, sizeStyles.text]}>
                    {shortName}
                  </Text>
                )}
              </View>
            );
          })}
        </View>
      </Container>
    );
  }

  // Single-network view: Show current network as pill
  const shortName = networkConfig.name
    .replace(' Network', '')
    .replace(' Mainnet', '')
    .replace(' Testnet', '')
    .trim();

  return (
    <Container style={styles.container} onPress={onPress} disabled={!onPress}>
      <View
        style={[
          styles.networkPill,
          sizeStyles.pill,
          { backgroundColor: networkConfig.color },
        ]}
      >
        {showName && (
          <Text style={[styles.pillText, sizeStyles.text]}>
            {shortName}
          </Text>
        )}
      </View>
    </Container>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    container: {
      flexDirection: 'row',
      alignItems: 'center',
    },
    multiNetworkContainer: {
      // Additional styles for multi-network view if needed
    },
    pillsContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      flexWrap: 'wrap',
    },
    networkPill: {
      // Size and color set dynamically
    },
    pillText: {
      color: '#FFFFFF',
      fontWeight: '600',
      textTransform: 'uppercase',
    },
  });
