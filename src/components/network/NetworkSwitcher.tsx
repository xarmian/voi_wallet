import React, { useState, useEffect, useMemo } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Modal,
  FlatList,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { NetworkId } from '@/types/network';
import {
  getNetworkConfig,
  getNetworkDisplayName,
} from '@/services/network/config';
import {
  useNetworkStore,
  useCurrentNetwork,
  useIsNetworkSwitching,
  useAvailableNetworks,
} from '@/store/networkStore';
import { useWalletStore } from '@/store/walletStore';
import { Theme } from '@/constants/themes';
import { EdgeInsets, useSafeAreaInsets } from 'react-native-safe-area-context';

interface NetworkSwitcherProps {
  visible: boolean;
  onClose: () => void;
  onNetworkSwitch?: (networkId: NetworkId) => void;
  theme: Theme;
}

interface NetworkItemProps {
  networkId: NetworkId;
  isSelected: boolean;
  isHealthy: boolean;
  onSelect: (networkId: NetworkId) => void;
  theme: Theme;
  styles: ReturnType<typeof createStyles>;
}

const NetworkItem: React.FC<NetworkItemProps> = ({
  networkId,
  isSelected,
  isHealthy,
  onSelect,
  theme,
  styles,
}) => {
  const config = getNetworkConfig(networkId);

  return (
    <TouchableOpacity
      style={[styles.networkItem, isSelected && styles.selectedNetworkItem]}
      onPress={() => onSelect(networkId)}
      disabled={isSelected}
    >
      <View style={styles.networkItemContent}>
        {/* Network Icon/Color */}
        <View
          style={[styles.networkIndicator, { backgroundColor: config.color }]}
        />

        {/* Network Info */}
        <View style={styles.networkInfo}>
          <Text
            style={[
              styles.networkName,
              isSelected && styles.selectedNetworkText,
            ]}
          >
            {config.name}
          </Text>
          <Text style={styles.networkCurrency}>
            {config.currencyName} ({config.currency})
          </Text>

          {/* Network Features */}
          <View style={styles.featuresRow}>
            {config.features.mimir && (
              <Text style={styles.featureTag}>ARC-200</Text>
            )}
            {config.features.envoi && (
              <Text style={styles.featureTag}>Names</Text>
            )}
            {config.features.pricing && (
              <Text style={styles.featureTag}>Pricing</Text>
            )}
          </View>
        </View>

        {/* Status and Selection */}
        <View style={styles.networkStatus}>
          {/* Health Status */}
          <View
            style={[
              styles.statusIndicator,
              {
                backgroundColor: isHealthy
                  ? theme.colors.success
                  : theme.colors.error,
              },
            ]}
          />

          {/* Selected Indicator */}
          {isSelected && (
            <Ionicons
              name="checkmark-circle"
              size={24}
              color={theme.colors.primary}
              style={styles.selectedIcon}
            />
          )}
        </View>
      </View>
    </TouchableOpacity>
  );
};

export default function NetworkSwitcher({
  visible,
  onClose,
  onNetworkSwitch,
  theme,
}: NetworkSwitcherProps) {
  const currentNetwork = useCurrentNetwork();
  const availableNetworks = useAvailableNetworks();
  const isNetworkSwitching = useIsNetworkSwitching();
  const { switchNetwork, refreshNetworkStatus } = useNetworkStore();
  const refreshAllBalances = useWalletStore(
    (state) => state.refreshAllBalances
  );
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => createStyles(theme, insets), [theme, insets]);

  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    if (visible) {
      // Refresh network statuses when modal opens
      handleRefresh();
    }
  }, [visible]);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      // Refresh status for all networks
      await Promise.all(
        availableNetworks.map((networkId) => refreshNetworkStatus(networkId))
      );
    } catch (error) {
      console.error('Failed to refresh network status:', error);
    } finally {
      setRefreshing(false);
    }
  };

  const handleNetworkSelect = async (networkId: NetworkId) => {
    if (networkId === currentNetwork || isNetworkSwitching) {
      return;
    }

    try {
      Alert.alert(
        'Switch Network',
        `Switch to ${getNetworkDisplayName(networkId)}?`,
        [
          {
            text: 'Cancel',
            style: 'cancel',
          },
          {
            text: 'Switch',
            onPress: async () => {
              try {
                await switchNetwork(networkId);
                // Refresh all balances after network switch since balances will be different
                await refreshAllBalances();
                onNetworkSwitch?.(networkId);
                onClose();
              } catch (error) {
                Alert.alert(
                  'Network Switch Failed',
                  error instanceof Error
                    ? error.message
                    : 'Failed to switch network',
                  [{ text: 'OK' }]
                );
              }
            },
          },
        ]
      );
    } catch (error) {
      console.error('Network switch error:', error);
    }
  };

  const getNetworkHealth = (networkId: NetworkId): boolean => {
    // Get status from the store directly instead of using hooks inside function
    const { status } = useNetworkStore.getState();
    const networkStatus = status[networkId];
    return networkStatus?.isConnected && networkStatus?.indexerHealth;
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View style={styles.container}>
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.title}>Networks</Text>

          <View style={styles.headerActions}>
            <TouchableOpacity
              style={styles.refreshButton}
              onPress={handleRefresh}
              disabled={refreshing}
            >
              {refreshing ? (
                <ActivityIndicator size="small" color={theme.colors.primary} />
              ) : (
                <Ionicons
                  name="refresh"
                  size={24}
                  color={theme.colors.primary}
                />
              )}
            </TouchableOpacity>

            <TouchableOpacity style={styles.closeButton} onPress={onClose}>
              <Ionicons name="close" size={24} color={theme.colors.text} />
            </TouchableOpacity>
          </View>
        </View>

        {/* Network List */}
        <FlatList
          data={availableNetworks}
          keyExtractor={(item) => item}
          renderItem={({ item: networkId }) => (
            <NetworkItem
              networkId={networkId}
              isSelected={networkId === currentNetwork}
              isHealthy={getNetworkHealth(networkId)}
              onSelect={handleNetworkSelect}
              theme={theme}
              styles={styles}
            />
          )}
          contentContainerStyle={styles.listContainer}
        />

        {/* Switching Indicator */}
        {isNetworkSwitching && (
          <View style={styles.switchingOverlay}>
            <View style={styles.switchingCard}>
              <ActivityIndicator size="large" color={theme.colors.primary} />
              <Text style={styles.switchingText}>Switching Network...</Text>
            </View>
          </View>
        )}
      </View>
    </Modal>
  );
}

const createStyles = (theme: Theme, insets: EdgeInsets) =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: theme.colors.background,
      paddingTop: insets.top,
    },
    header: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingHorizontal: 20,
      paddingTop: 20,
      paddingBottom: 16,
      backgroundColor: theme.colors.surface,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
    },
    title: {
      fontSize: 24,
      fontWeight: '600',
      color: theme.colors.text,
    },
    headerActions: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 16,
    },
    refreshButton: {
      padding: 4,
    },
    closeButton: {
      padding: 4,
    },
    listContainer: {
      paddingTop: 16,
      paddingBottom: 16 + insets.bottom,
    },
    networkItem: {
      backgroundColor: theme.colors.surface,
      marginHorizontal: 16,
      marginVertical: 4,
      borderRadius: 12,
      padding: 16,
      borderWidth: 1,
      borderColor: theme.colors.border,
    },
    selectedNetworkItem: {
      borderColor: theme.colors.primary,
      backgroundColor: theme.colors.surface,
    },
    networkItemContent: {
      flexDirection: 'row',
      alignItems: 'center',
    },
    networkIndicator: {
      width: 12,
      height: 12,
      borderRadius: 6,
      marginRight: 12,
    },
    networkInfo: {
      flex: 1,
    },
    networkName: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.text,
      marginBottom: 2,
    },
    selectedNetworkText: {
      color: theme.colors.primary,
    },
    networkCurrency: {
      fontSize: 14,
      color: theme.colors.textMuted,
      marginBottom: 8,
    },
    featuresRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 6,
    },
    featureTag: {
      fontSize: 10,
      color: theme.colors.success,
      backgroundColor: theme.colors.surface,
      paddingHorizontal: 6,
      paddingVertical: 2,
      borderRadius: 4,
      fontWeight: '500',
    },
    networkStatus: {
      alignItems: 'center',
      gap: 8,
    },
    statusIndicator: {
      width: 8,
      height: 8,
      borderRadius: 4,
    },
    selectedIcon: {
      marginTop: 4,
    },
    switchingOverlay: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: theme.colors.overlay,
      justifyContent: 'center',
      alignItems: 'center',
    },
    switchingCard: {
      backgroundColor: theme.colors.surface,
      borderRadius: 12,
      padding: 24,
      alignItems: 'center',
      minWidth: 160,
      ...theme.shadows.small,
    },
    switchingText: {
      fontSize: 16,
      fontWeight: '500',
      color: theme.colors.text,
      marginTop: 12,
    },
  });
