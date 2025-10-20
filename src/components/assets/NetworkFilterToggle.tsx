import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useAssetNetworkFilter, useWalletStore } from '@/store/walletStore';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';

export default function NetworkFilterToggle() {
  const assetNetworkFilter = useAssetNetworkFilter();
  const setAssetNetworkFilter = useWalletStore((state) => state.setAssetNetworkFilter);
  const styles = useThemedStyles(createStyles);

  const filters: Array<{ key: 'all' | 'voi' | 'algorand'; label: string }> = [
    { key: 'all', label: 'All' },
    { key: 'voi', label: 'Voi' },
    { key: 'algorand', label: 'Algo' },
  ];

  return (
    <View style={styles.container}>
      {filters.map((filter) => (
        <TouchableOpacity
          key={filter.key}
          style={[
            styles.filterButton,
            assetNetworkFilter === filter.key && styles.activeFilterButton,
          ]}
          onPress={() => setAssetNetworkFilter(filter.key)}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel={`Filter assets by ${filter.label}`}
          accessibilityState={{ selected: assetNetworkFilter === filter.key }}
        >
          <Text
            style={[
              styles.filterText,
              assetNetworkFilter === filter.key && styles.activeFilterText,
            ]}
          >
            {filter.label}
          </Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    container: {
      flexDirection: 'row',
      backgroundColor: theme.colors.surface,
      borderRadius: theme.borderRadius.md,
      padding: 2,
      gap: 2,
    },
    filterButton: {
      paddingVertical: 4,
      paddingHorizontal: 10,
      borderRadius: theme.borderRadius.sm,
      minWidth: 42,
      alignItems: 'center',
      justifyContent: 'center',
    },
    activeFilterButton: {
      backgroundColor: theme.colors.primary,
    },
    filterText: {
      fontSize: 12,
      fontWeight: '500',
      color: theme.colors.textSecondary,
    },
    activeFilterText: {
      color: theme.colors.buttonText,
      fontWeight: '600',
    },
  });
