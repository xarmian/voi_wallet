import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import DeviceDiscovery from './DeviceDiscovery';
import { DebugLogsModal } from '@/components/debug/DebugLogsModal';
import { useTheme } from '@/contexts/ThemeContext';
import { useThemedStyles, useThemeColors } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import {
  ledgerTransportService,
  LedgerDeviceInfo,
  LedgerPermissionsStatus,
} from '@/services/ledger/transport';
import { debugLogger } from '@/services/debug/logger';

export interface LedgerConnectionModalProps {
  visible: boolean;
  onClose: () => void;
  onConnected?: (device: LedgerDeviceInfo) => void;
  onDisconnected?: () => void;
  initialDeviceId?: string;
  title?: string;
  description?: string;
}

type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'failed';

const LedgerConnectionModal: React.FC<LedgerConnectionModalProps> = ({
  visible,
  onClose,
  onConnected,
  onDisconnected,
  initialDeviceId,
  title = 'Connect Ledger Device',
  description = 'Select your Ledger device to pair with Voi Wallet. Make sure the device is unlocked and the Algorand app is open.',
}) => {
  const { theme } = useTheme();
  const colors = useThemeColors();
  const styles = useThemedStyles(createStyles);

  const [selectedDevice, setSelectedDevice] = useState<LedgerDeviceInfo | null>(
    null
  );
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>('idle');
  const [statusMessage, setStatusMessage] = useState<string>('');
  const [permissionStatus, setPermissionStatus] =
    useState<LedgerPermissionsStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showDebugLogs, setShowDebugLogs] = useState<boolean>(false);

  const connectedDevice = ledgerTransportService.getConnectedDevice();

  useEffect(() => {
    if (!visible) {
      setConnectionStatus('idle');
      setStatusMessage('');
      setError(null);
      return;
    }

    if (initialDeviceId) {
      const initial = ledgerTransportService
        .getDevices()
        .find((device) => device.id === initialDeviceId);
      if (initial) {
        setSelectedDevice(initial);
      }
    } else if (connectedDevice) {
      setSelectedDevice(connectedDevice);
      setConnectionStatus('connected');
    }
  }, [visible, initialDeviceId, connectedDevice]);

  useEffect(() => {
    if (!visible) {
      return;
    }

    const unsubConnected = ledgerTransportService.on('connected', (device) => {
      setConnectionStatus('connected');
      setStatusMessage('Connected to Ledger device');
      setSelectedDevice(device);
      setError(null);
      onConnected?.(device);
    });

    const unsubDisconnected = ledgerTransportService.on(
      'disconnected',
      (info) => {
        setConnectionStatus('idle');
        setStatusMessage('Ledger device disconnected');
        onDisconnected?.();

        if (
          selectedDevice &&
          ('id' in info ? info.id === selectedDevice.id : true)
        ) {
          setSelectedDevice(null);
        }
      }
    );

    return () => {
      unsubConnected?.();
      unsubDisconnected?.();
    };
  }, [onConnected, onDisconnected, selectedDevice, visible]);

  const handleDeviceSelect = useCallback((device: LedgerDeviceInfo) => {
    setSelectedDevice(device);
    setError(null);
    if (device.connected) {
      setConnectionStatus('connected');
      setStatusMessage('Device already connected');
    } else {
      setConnectionStatus('idle');
      setStatusMessage('');
    }
  }, []);

  const handlePermissionsChange = useCallback(
    (status: LedgerPermissionsStatus) => {
      setPermissionStatus(status);
    },
    []
  );

  const connectToDevice = useCallback(async () => {
    if (!selectedDevice) {
      return;
    }

    setConnectionStatus('connecting');
    setStatusMessage('Connecting to Ledger device...');
    setError(null);

    // Add debug entry for connection attempt
    debugLogger.addDebugEntry('Connection attempt started', {
      deviceId: selectedDevice.id,
      deviceName: selectedDevice.name,
      transportType: selectedDevice.type,
    });

    try {
      await ledgerTransportService.connect(selectedDevice.id, {
        transportType: selectedDevice.type,
      });
      const refreshedDevice = ledgerTransportService.getConnectedDevice();
      if (refreshedDevice) {
        setConnectionStatus('connected');
        setSelectedDevice(refreshedDevice);
        setStatusMessage('Ledger device connected');
        debugLogger.addDebugEntry('Connection successful', { device: refreshedDevice });
        onConnected?.(refreshedDevice);
      } else {
        throw new Error('Ledger device connection lost during initialization');
      }
    } catch (err) {
      setConnectionStatus('failed');
      const message =
        err instanceof Error
          ? err.message
          : 'Failed to connect to Ledger device';
      setStatusMessage('');
      setError(message);
      debugLogger.addDebugEntry('Connection failed', { error: message, deviceId: selectedDevice.id });
    }
  }, [onConnected, selectedDevice]);

  const disconnectDevice = useCallback(async () => {
    try {
      await ledgerTransportService.disconnect();
      setConnectionStatus('idle');
      setStatusMessage('Device disconnected');
      onDisconnected?.();
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : 'Failed to disconnect Ledger device';
      setError(message);
    }
  }, [onDisconnected]);

  const connectionButtonLabel = useMemo(() => {
    switch (connectionStatus) {
      case 'connecting':
        return 'Connecting...';
      case 'connected':
        return 'Connected';
      case 'failed':
      case 'idle':
      default:
        return 'Connect';
    }
  }, [connectionStatus]);

  const connectionDisabled = useMemo(() => {
    if (!selectedDevice) {
      return true;
    }

    if (connectionStatus === 'connecting') {
      return true;
    }

    if (selectedDevice.connected && connectionStatus === 'connected') {
      return true;
    }

    return false;
  }, [connectionStatus, selectedDevice]);

  const showPermissionWarning = useMemo(() => {
    if (!permissionStatus) {
      return false;
    }
    return !permissionStatus.bluetoothAuthorized;
  }, [permissionStatus]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <View style={styles.overlay}>
        <View style={styles.modalContainer}>
          <Text style={styles.title}>{title}</Text>
          <Text style={styles.description}>{description}</Text>

          {showPermissionWarning && (
            <View style={styles.permissionBanner}>
              <Text style={styles.permissionBannerText}>
                Bluetooth permissions are required to discover Ledger devices.
                Please enable Bluetooth for Voi Wallet in your device settings.
              </Text>
            </View>
          )}

          <DeviceDiscovery
            selectedDeviceId={selectedDevice?.id}
            onSelectDevice={handleDeviceSelect}
            onPermissionsChange={handlePermissionsChange}
            onError={setError}
          />

          {statusMessage ? (
            <Text style={styles.statusMessage}>{statusMessage}</Text>
          ) : null}

          {error ? (
            <View style={styles.errorContainer}>
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : null}

          <View style={styles.buttonRow}>
            <TouchableOpacity
              style={[styles.button, styles.secondaryButton]}
              onPress={onClose}
            >
              <Text style={styles.secondaryButtonText}>Close</Text>
            </TouchableOpacity>

            {/*
            <TouchableOpacity
              style={[styles.button, styles.debugButton]}
              onPress={() => setShowDebugLogs(true)}
            >
              <Text style={styles.debugButtonText}>Debug</Text>
            </TouchableOpacity>
            */}

            <TouchableOpacity
              style={[
                styles.button,
                styles.primaryButton,
                connectionDisabled && styles.buttonDisabled,
              ]}
              onPress={
                selectedDevice?.connected ? disconnectDevice : connectToDevice
              }
              disabled={connectionDisabled && !selectedDevice?.connected}
            >
              {connectionStatus === 'connecting' ? (
                <ActivityIndicator size="small" color={colors.buttonText} />
              ) : (
                <Text style={styles.primaryButtonText}>
                  {selectedDevice?.connected
                    ? 'Disconnect'
                    : connectionButtonLabel}
                </Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </View>

      <DebugLogsModal
        visible={showDebugLogs}
        onClose={() => setShowDebugLogs(false)}
      />
    </Modal>
  );
};

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    overlay: {
      flex: 1,
      backgroundColor: theme.colors.overlay,
      padding: theme.spacing.lg,
      justifyContent: 'center',
    },
    modalContainer: {
      backgroundColor: theme.colors.modalBackground,
      borderRadius: theme.borderRadius.xl,
      padding: theme.spacing.xl,
      ...theme.shadows.lg,
      maxHeight: '90%',
    },
    title: {
      fontSize: 20,
      fontWeight: '700',
      color: theme.colors.text,
    },
    description: {
      fontSize: 15,
      color: theme.colors.textSecondary,
      marginTop: theme.spacing.sm,
      marginBottom: theme.spacing.lg,
      lineHeight: 20,
    },
    permissionBanner: {
      backgroundColor:
        theme.mode === 'light'
          ? 'rgba(255, 149, 0, 0.1)'
          : 'rgba(255, 159, 10, 0.22)',
      borderRadius: theme.borderRadius.md,
      padding: theme.spacing.md,
      marginBottom: theme.spacing.md,
    },
    permissionBannerText: {
      color: theme.colors.warning,
      fontSize: 14,
      lineHeight: 18,
    },
    statusMessage: {
      marginTop: theme.spacing.md,
      color: theme.colors.textSecondary,
      fontSize: 14,
    },
    errorContainer: {
      marginTop: theme.spacing.md,
      padding: theme.spacing.md,
      borderRadius: theme.borderRadius.md,
      backgroundColor:
        theme.mode === 'light'
          ? 'rgba(255, 59, 48, 0.1)'
          : 'rgba(255, 69, 58, 0.22)',
    },
    errorText: {
      color: theme.colors.error,
      fontSize: 14,
    },
    buttonRow: {
      flexDirection: 'row',
      gap: theme.spacing.sm,
      marginTop: theme.spacing.lg,
    },
    button: {
      flex: 1,
      paddingVertical: theme.spacing.md,
      borderRadius: theme.borderRadius.lg,
      alignItems: 'center',
      justifyContent: 'center',
    },
    primaryButton: {
      backgroundColor: theme.colors.primary,
    },
    primaryButtonText: {
      color: theme.colors.buttonText,
      fontWeight: '600',
    },
    secondaryButton: {
      backgroundColor: theme.colors.card,
      borderWidth: 1,
      borderColor: theme.colors.border,
    },
    secondaryButtonText: {
      color: theme.colors.text,
      fontWeight: '600',
    },
    debugButton: {
      backgroundColor: theme.colors.background,
      borderWidth: 1,
      borderColor: '#007AFF',
      flex: 0.7, // Make debug button smaller
    },
    debugButtonText: {
      color: '#007AFF',
      fontWeight: '500',
      fontSize: 14,
    },
    buttonDisabled: {
      opacity: 0.6,
    },
  });

export default LedgerConnectionModal;
