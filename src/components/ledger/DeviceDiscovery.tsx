import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import {
  ledgerTransportService,
  LedgerDeviceInfo,
  LedgerPermissionsStatus,
} from '@/services/ledger/transport';
import { useThemedStyles, useThemeColors } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';

export interface DeviceDiscoveryProps {
  selectedDeviceId?: string;
  onSelectDevice?: (device: LedgerDeviceInfo) => void;
  onPermissionsChange?: (status: LedgerPermissionsStatus) => void;
  onError?: (message: string) => void;
  showConnectionStatus?: boolean;
  autoInitialize?: boolean;
}

interface DeviceItemProps {
  device: LedgerDeviceInfo;
  isSelected: boolean;
  isConnected: boolean;
  onPress: (device: LedgerDeviceInfo) => void;
  styles: ReturnType<typeof createStyles>;
}

const DeviceItem = ({
  device,
  isSelected,
  isConnected,
  onPress,
  styles,
}: DeviceItemProps) => {
  // Determine if this is a recently discovered device (within last 30 seconds)
  const isRecentlyDiscovered = useMemo(() => {
    const lastSeenTime = new Date(device.lastSeen).getTime();
    const now = Date.now();
    return (now - lastSeenTime) < 30000; // 30 seconds
  }, [device.lastSeen]);

  // Format last connected/seen info
  const lastConnectionInfo = useMemo(() => {
    if (device.lastConnected) {
      const lastConnected = new Date(device.lastConnected);
      const now = new Date();
      const diffMs = now.getTime() - lastConnected.getTime();
      const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

      if (diffDays === 0) {
        return 'Connected today';
      } else if (diffDays === 1) {
        return 'Connected yesterday';
      } else if (diffDays < 7) {
        return `Connected ${diffDays} days ago`;
      } else {
        return 'Previously connected';
      }
    }
    return null;
  }, [device.lastConnected]);

  return (
    <TouchableOpacity
      style={[styles.deviceRow, isSelected && styles.deviceRowSelected]}
      onPress={() => onPress(device)}
      accessibilityRole="button"
    >
      <View style={styles.deviceInfo}>
        <Text style={styles.deviceName} numberOfLines={1}>
          {device.name || 'Ledger Device'}
        </Text>
        <Text style={styles.deviceMeta} numberOfLines={1}>
          {device.type === 'ble' ? 'Bluetooth' : 'USB'} · {device.id}
        </Text>
        {lastConnectionInfo && (
          <Text style={styles.deviceLastSeen} numberOfLines={1}>
            {lastConnectionInfo}
          </Text>
        )}
      </View>
      <View style={styles.deviceStatusContainer}>
        {isConnected ? (
          <Text style={styles.connectedBadge}>Connected</Text>
        ) : isRecentlyDiscovered ? (
          <Text style={styles.availableBadge}>Available</Text>
        ) : (
          <Text style={styles.rememberedBadge}>Remembered</Text>
        )}
      </View>
    </TouchableOpacity>
  );
};

export const DeviceDiscovery: React.FC<DeviceDiscoveryProps> = ({
  selectedDeviceId,
  onSelectDevice,
  onPermissionsChange,
  onError,
  showConnectionStatus = true,
  autoInitialize = true,
}) => {
  const styles = useThemedStyles(createStyles);
  const colors = useThemeColors();

  const [devices, setDevices] = useState<LedgerDeviceInfo[]>(() =>
    ledgerTransportService.getDevices()
  );
  const [permissions, setPermissions] =
    useState<LedgerPermissionsStatus | null>(null);
  const [isInitializing, setIsInitializing] = useState<boolean>(autoInitialize);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const discoveryActiveRef = useRef(false);
  const discoveryStartPromiseRef = useRef<Promise<void> | null>(null);

  const handleError = useCallback(
    (message: string) => {
      setErrorMessage(message);
      if (onError) {
        onError(message);
      }
    },
    [onError]
  );

  const ensureDiscoveryActive = useCallback(async () => {
    if (discoveryActiveRef.current) {
      return;
    }

    if (!discoveryStartPromiseRef.current) {
      discoveryStartPromiseRef.current = ledgerTransportService
        .startDiscovery();

      discoveryStartPromiseRef.current
        .then(() => {
          discoveryActiveRef.current = true;
        })
        .catch((error) => {
          console.warn('Failed to start Ledger discovery', error);
        })
        .finally(() => {
          discoveryStartPromiseRef.current = null;
        });
    }

    await discoveryStartPromiseRef.current;
  }, []);

  const stopDiscoverySession = useCallback(() => {
    const stop = () => {
      if (!discoveryActiveRef.current) {
        return;
      }
      ledgerTransportService.stopDiscovery();
      discoveryActiveRef.current = false;
    };

    if (discoveryStartPromiseRef.current) {
      discoveryStartPromiseRef.current.finally(stop);
      return;
    }

    stop();
  }, []);

  const refreshDevicesState = useCallback(() => {
    setDevices([...ledgerTransportService.getDevices()]);
  }, []);

  const registerListeners = useCallback(() => {
    const unsubscribes = [
      ledgerTransportService.on('deviceDiscovered', () =>
        refreshDevicesState()
      ),
      ledgerTransportService.on('deviceUpdated', () => refreshDevicesState()),
      ledgerTransportService.on('deviceRemoved', () => refreshDevicesState()),
      ledgerTransportService.on('connected', () => refreshDevicesState()),
      ledgerTransportService.on('disconnected', () => refreshDevicesState()),
      ledgerTransportService.on('permissions', (status) => {
        setPermissions(status);
        onPermissionsChange?.(status);
      }),
      ledgerTransportService.on('error', (error) => {
        const message = error instanceof Error ? error.message : String(error);
        handleError(message);
      }),
    ];

    return () => {
      unsubscribes.forEach((unsub) => {
        try {
          unsub();
        } catch (error) {
          console.warn('Failed to remove Ledger listener', error);
        }
      });
    };
  }, [handleError, onPermissionsChange, refreshDevicesState]);

  const initializeTransports = useCallback(async () => {
    try {
      setIsInitializing(true);
      await ledgerTransportService.initialize();
      await ensureDiscoveryActive();
      refreshDevicesState();
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Failed to initialize Ledger transport';
      handleError(message);
    } finally {
      setIsInitializing(false);
    }
  }, [ensureDiscoveryActive, handleError, refreshDevicesState]);

  useEffect(() => {
    const cleanupListeners = registerListeners();
    if (autoInitialize) {
      initializeTransports();
    }
    return () => {
      cleanupListeners();
      stopDiscoverySession();
    };
  }, [autoInitialize, initializeTransports, registerListeners, stopDiscoverySession]);

  const handleRefresh = useCallback(async () => {
    try {
      setIsRefreshing(true);
      await ledgerTransportService.initialize();
      await ensureDiscoveryActive();
      refreshDevicesState();
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Unable to refresh Ledger devices';
      handleError(message);
    } finally {
      setIsRefreshing(false);
    }
  }, [ensureDiscoveryActive, handleError, refreshDevicesState]);

  const emptyMessage = useMemo(() => {
    if (permissions && !permissions.bluetoothAuthorized) {
      return 'Bluetooth permissions are required to discover Ledger devices. Please enable Bluetooth in your device settings.';
    }
    return 'No Ledger devices found. Make sure your device is powered on and the Algorand app is open.';
  }, [permissions]);

  return (
    <View style={styles.container}>
      {(isInitializing || isRefreshing) && devices.length === 0 ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={styles.loadingText}>Scanning for Ledger devices...</Text>
        </View>
      ) : (
        <FlatList
          data={devices}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <DeviceItem
              device={item}
              isSelected={item.id === selectedDeviceId}
              isConnected={showConnectionStatus && item.connected}
              onPress={(device) => onSelectDevice?.(device)}
              styles={styles}
            />
          )}
          contentContainerStyle={
            devices.length === 0 ? styles.emptyListContainer : undefined
          }
          ListEmptyComponent={
            <View style={styles.emptyState}>
              <Text style={styles.emptyStateTitle}>
                No Ledger Devices Detected
              </Text>
              <Text style={styles.emptyStateMessage}>{emptyMessage}</Text>
            </View>
          }
          refreshControl={
            <RefreshControl
              refreshing={isRefreshing}
              onRefresh={handleRefresh}
              tintColor={colors.primary}
            />
          }
        />
      )}

      {errorMessage && (
        <View style={styles.errorContainer}>
          <Text style={styles.errorText}>{errorMessage}</Text>
        </View>
      )}
    </View>
  );
};

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    container: {
      width: '100%',
      minHeight: 200,
    },
    loadingContainer: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: theme.spacing.xl,
      gap: theme.spacing.md,
    },
    loadingText: {
      color: theme.colors.textSecondary,
      fontSize: 16,
    },
    emptyListContainer: {
      flexGrow: 1,
      justifyContent: 'center',
      paddingVertical: theme.spacing.xl,
    },
    emptyState: {
      alignItems: 'center',
      paddingHorizontal: theme.spacing.lg,
      gap: theme.spacing.sm,
    },
    emptyStateTitle: {
      fontSize: 18,
      fontWeight: '600',
      color: theme.colors.text,
      textAlign: 'center',
    },
    emptyStateMessage: {
      fontSize: 15,
      color: theme.colors.textSecondary,
      textAlign: 'center',
      lineHeight: 20,
    },
    deviceRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      backgroundColor: theme.colors.card,
      borderRadius: theme.borderRadius.lg,
      padding: theme.spacing.lg,
      marginHorizontal: theme.spacing.xs,
      marginBottom: theme.spacing.md,
      borderWidth: 1,
      borderColor: theme.colors.border,
    },
    deviceRowSelected: {
      borderColor: theme.colors.primary,
      backgroundColor:
        theme.mode === 'light'
          ? 'rgba(0, 122, 255, 0.08)'
          : 'rgba(10, 132, 255, 0.2)',
    },
    deviceInfo: {
      flex: 1,
      marginRight: theme.spacing.md,
    },
    deviceName: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.text,
    },
    deviceMeta: {
      fontSize: 13,
      color: theme.colors.textSecondary,
      marginTop: 2,
    },
    deviceLastSeen: {
      fontSize: 12,
      color: theme.colors.textMuted,
      marginTop: 1,
      fontStyle: 'italic',
    },
    deviceStatusContainer: {
      alignItems: 'flex-end',
    },
    connectedBadge: {
      fontSize: 12,
      fontWeight: '600',
      color: theme.colors.success,
    },
    availableBadge: {
      fontSize: 12,
      color: theme.colors.textSecondary,
    },
    rememberedBadge: {
      fontSize: 12,
      color: theme.colors.textMuted,
      fontStyle: 'italic',
    },
    errorContainer: {
      marginTop: theme.spacing.md,
      padding: theme.spacing.md,
      borderRadius: theme.borderRadius.md,
      backgroundColor:
        theme.mode === 'light'
          ? 'rgba(255, 59, 48, 0.08)'
          : 'rgba(255, 69, 58, 0.18)',
    },
    errorText: {
      color: theme.colors.error,
      textAlign: 'center',
      fontSize: 14,
    },
  });

export default DeviceDiscovery;
