import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import LedgerConnectionModal from './ConnectionModal';
import { useTheme } from '@/contexts/ThemeContext';
import { useThemedStyles, useThemeColors } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import { formatAddress } from '@/utils/address';
import type {
  LedgerAccountMetadata,
  LedgerSigningInfo,
} from '@/types/wallet';
import {
  ledgerTransportService,
  LedgerDeviceInfo,
} from '@/services/ledger/transport';
import { SecureKeyManager } from '@/services/secure/keyManager';

export interface RekeyToLedgerProps {
  ledgerAccounts: LedgerAccountMetadata[];
  selectedAccountId?: string | null;
  onSelectAccount: (account: LedgerAccountMetadata | null) => void;
  onStatusUpdate?: (payload: {
    accountId: string | null;
    info: LedgerSigningInfo | null;
    isReady: boolean;
  }) => void;
  onImportLedgerAccounts?: () => void;
  isBusy?: boolean;
}

type LedgerStatusMap = Record<string, LedgerSigningInfo | null>;

type StatusIntent = 'connected' | 'available' | 'unavailable';
type StatusIconName = 'radio-button-on' | 'alert-circle' | 'close-circle';

const statusIntentColors: Record<StatusIntent, string> = {
  connected: '#10B981',
  available: '#F59E0B',
  unavailable: '#EF4444',
};

const statusIntentIcons: Record<StatusIntent, StatusIconName> = {
  connected: 'radio-button-on',
  available: 'alert-circle',
  unavailable: 'close-circle',
};

const RekeyToLedger: React.FC<RekeyToLedgerProps> = ({
  ledgerAccounts,
  selectedAccountId,
  onSelectAccount,
  onStatusUpdate,
  onImportLedgerAccounts,
  isBusy = false,
}) => {
  const { theme } = useTheme();
  const colors = useThemeColors();
  const styles = useThemedStyles(createStyles);

  const [statusMap, setStatusMap] = useState<LedgerStatusMap>({});
  const [isLoadingStatuses, setIsLoadingStatuses] = useState(false);
  const [connectionModalVisible, setConnectionModalVisible] = useState(false);
  const [selectedDevice, setSelectedDevice] = useState<LedgerDeviceInfo | null>(
    () => ledgerTransportService.getConnectedDevice() || null
  );
  const refreshCounterRef = useRef(0);

  const selectedAccount = useMemo(() => {
    if (!selectedAccountId) {
      return null;
    }
    return ledgerAccounts.find((account) => account.id === selectedAccountId) || null;
  }, [ledgerAccounts, selectedAccountId]);

  const selectedStatus = useMemo(() => {
    if (!selectedAccount) {
      return null;
    }
    return statusMap[selectedAccount.id] ?? null;
  }, [selectedAccount, statusMap]);

  const connectedDevice = useMemo(
    () => ledgerTransportService.getConnectedDevice() || selectedDevice,
    [selectedDevice]
  );

  const refreshStatuses = useCallback(async () => {
    const refreshId = ++refreshCounterRef.current;

    if (ledgerAccounts.length === 0) {
      setStatusMap({});
      return;
    }

    setIsLoadingStatuses(true);
    try {
      const entries = await Promise.all(
        ledgerAccounts.map(async (account) => {
          try {
            const info = await SecureKeyManager.getLedgerSigningInfo(account.id, {
              lookupByAddress: false,
            });
            return [account.id, info] as const;
          } catch (error) {
            console.warn('Failed to load Ledger status:', error);
            return [account.id, null] as const;
          }
        })
      );

      if (refreshId === refreshCounterRef.current) {
        const nextStatusMap = entries.reduce<LedgerStatusMap>((acc, [id, info]) => {
          acc[id] = info;
          return acc;
        }, {});
        setStatusMap(nextStatusMap);
      }
    } finally {
      if (refreshId === refreshCounterRef.current) {
        setIsLoadingStatuses(false);
      }
    }
  }, [ledgerAccounts]);

  useEffect(() => {
    refreshStatuses();
  }, [refreshStatuses]);

  useEffect(() => {
    const unsubscribeConnected = ledgerTransportService.on(
      'connected',
      (device) => {
        setSelectedDevice(device);
        refreshStatuses();
      }
    );

    const unsubscribeDisconnected = ledgerTransportService.on(
      'disconnected',
      () => {
        setSelectedDevice(null);
        refreshStatuses();
      }
    );

    return () => {
      unsubscribeConnected?.();
      unsubscribeDisconnected?.();
    };
  }, [refreshStatuses]);

  useEffect(() => {
    if (!onStatusUpdate) {
      return;
    }
    const info = selectedStatus ?? null;
    const isReady = !!info && (info.isDeviceConnected || info.isDeviceAvailable);
    onStatusUpdate({
      accountId: selectedAccount?.id ?? null,
      info,
      isReady,
    });
  }, [onStatusUpdate, selectedAccount, selectedStatus]);

  const resolveStatusIntent = useCallback(
    (status: LedgerSigningInfo | null | undefined): StatusIntent => {
      if (!status) {
        return 'unavailable';
      }
      if (status.isDeviceConnected) {
        return 'connected';
      }
      if (status.isDeviceAvailable) {
        return 'available';
      }
      return 'unavailable';
    },
    []
  );

  const handleAccountPress = useCallback(
    (account: LedgerAccountMetadata) => {
      if (isBusy) {
        return;
      }
      onSelectAccount(account);
      if (account.deviceId) {
        const device = ledgerTransportService
          .getDevices()
          .find((item) => item.id === account.deviceId);
        if (device) {
          setSelectedDevice(device);
        }
      }
    },
    [isBusy, onSelectAccount]
  );

  const handleConnectPress = useCallback(() => {
    setConnectionModalVisible(true);
  }, []);

  const handleModalClose = useCallback(() => {
    setConnectionModalVisible(false);
  }, []);

  const handleModalConnected = useCallback(
    (device: LedgerDeviceInfo) => {
      setSelectedDevice(device);
      setConnectionModalVisible(false);
      refreshStatuses();
    },
    [refreshStatuses]
  );

  const handleModalDisconnected = useCallback(() => {
    refreshStatuses();
  }, [refreshStatuses]);

  const renderStatusPill = useCallback(
    (account: LedgerAccountMetadata) => {
      const status = statusMap[account.id];
      const intent = resolveStatusIntent(status);
      const color = statusIntentColors[intent];
      const icon = statusIntentIcons[intent];

      let label = 'Device unavailable';
      if (intent === 'connected') {
        label = 'Device connected';
      } else if (intent === 'available') {
        label = 'Connect device to continue';
      }

      return (
        <View
          key={`${account.id}-status`}
          style={[styles.statusPill, { backgroundColor: theme.colors.surface }]}
        >
          <Ionicons name={icon} size={14} color={color} />
          <Text style={[styles.statusText, { color }]}>{label}</Text>
        </View>
      );
    },
    [resolveStatusIntent, statusMap, styles, theme.colors.surface]
  );

  if (ledgerAccounts.length === 0) {
    return (
      <View style={[styles.emptyContainer, { borderColor: theme.colors.border }]}>
        <Ionicons name="hardware-chip-outline" size={32} color={colors.textSecondary} />
        <Text style={[styles.emptyTitle, { color: colors.text }]}>
          No Ledger accounts available
        </Text>
        <Text style={[styles.emptySubtitle, { color: colors.textSecondary }]}>
          Import a Ledger account first, then rekey to it.
        </Text>
        {onImportLedgerAccounts ? (
          <TouchableOpacity
            style={[styles.importButton, { backgroundColor: theme.colors.primary }]}
            onPress={onImportLedgerAccounts}
          >
            <Text style={[styles.importButtonText, { color: theme.colors.buttonText }]}>
              Import from Ledger
            </Text>
          </TouchableOpacity>
        ) : null}
      </View>
    );
  }

  return (
    <View style={[styles.container, { borderColor: theme.colors.border }]}>
      <View style={styles.headerRow}>
        <View style={styles.titleGroup}>
          <Text style={[styles.title, { color: colors.text }]}>Ledger Signing Account</Text>
          <Text style={[styles.subtitle, { color: colors.textSecondary }]}>
            Select the Ledger account that will control this address
          </Text>
        </View>
        <TouchableOpacity
          style={[styles.connectButton, { borderColor: theme.colors.borderLight }]}
          onPress={handleConnectPress}
        >
          <Ionicons name="bluetooth" size={16} color={colors.text} />
          <Text style={[styles.connectButtonText, { color: colors.text }]}>Connect Ledger</Text>
        </TouchableOpacity>
      </View>

      {connectedDevice ? (
        <View style={[styles.deviceBanner, { backgroundColor: theme.colors.primaryLight }]}>
          <Ionicons
            name="hardware-chip-outline"
            size={18}
            color={theme.colors.primary}
          />
          <View style={styles.deviceBannerText}>
            <Text style={[styles.deviceBannerTitle, { color: theme.colors.primary }]}>
              {connectedDevice.name || 'Ledger Device'}
            </Text>
            <Text style={[styles.deviceBannerSubtitle, { color: colors.textSecondary }]}>
              {connectedDevice.type === 'ble' ? 'Bluetooth' : 'USB'} · {connectedDevice.id}
            </Text>
          </View>
        </View>
      ) : null}

      <View style={styles.listContainer}>
        {isLoadingStatuses ? (
          <View style={styles.loadingRow}>
            <ActivityIndicator color={theme.colors.primary} size="small" />
            <Text style={[styles.loadingText, { color: colors.textSecondary }]}>Checking Ledger status...</Text>
          </View>
        ) : null}

        {ledgerAccounts.map((account) => {
          const isSelected = selectedAccount?.id === account.id;
          const status = statusMap[account.id];
          const intent = resolveStatusIntent(status);
          const borderColor = isSelected
            ? theme.colors.success
            : theme.colors.borderLight;

          return (
            <TouchableOpacity
              key={account.id}
              style={[
                styles.accountCard,
                {
                  borderColor,
                  backgroundColor: isSelected
                    ? theme.colors.successLight
                    : theme.colors.card,
                },
              ]}
              onPress={() => handleAccountPress(account)}
            >
              <View style={styles.accountHeader}>
                <Text style={[styles.accountLabel, { color: colors.text }]}>
                  {account.label || 'Ledger Account'}
                </Text>
                <View style={styles.intentBadge}>
                  <View
                    style={[
                      styles.intentDot,
                      { backgroundColor: statusIntentColors[intent] },
                    ]}
                  />
                  <Text style={[styles.intentText, { color: colors.textSecondary }]}>
                    {intent === 'connected'
                      ? 'Connected'
                      : intent === 'available'
                      ? 'Needs connection'
                      : 'Unavailable'}
                  </Text>
                </View>
              </View>

              <Text style={[styles.accountAddress, { color: colors.textSecondary }]}>
                {formatAddress(account.address)}
              </Text>
              <Text style={[styles.accountMeta, { color: colors.textMuted }]}>
                Path {account.derivationPath} · Index #{account.derivationIndex}
              </Text>

              {renderStatusPill(account)}
            </TouchableOpacity>
          );
        })}
      </View>

      <LedgerConnectionModal
        visible={connectionModalVisible}
        onClose={handleModalClose}
        onConnected={handleModalConnected}
        onDisconnected={handleModalDisconnected}
        initialDeviceId={selectedAccount?.deviceId}
        title="Connect Ledger"
        description="Connect the Ledger device that controls the selected account."
      />
    </View>
  );
};

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    container: {
      borderWidth: 1,
      borderRadius: theme.borderRadius.xl,
      padding: theme.spacing.lg,
      gap: theme.spacing.lg,
    },
    headerRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'flex-start',
      gap: theme.spacing.md,
    },
    titleGroup: {
      flex: 1,
      gap: theme.spacing.xs,
    },
    title: {
      fontSize: 18,
      fontWeight: '600',
    },
    subtitle: {
      fontSize: 13,
    },
    connectButton: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.xs,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.xs,
      borderRadius: theme.borderRadius.lg,
      borderWidth: 1,
    },
    connectButtonText: {
      fontSize: 13,
      fontWeight: '500',
    },
    deviceBanner: {
      flexDirection: 'row',
      alignItems: 'center',
      borderRadius: theme.borderRadius.lg,
      padding: theme.spacing.md,
      gap: theme.spacing.sm,
    },
    deviceBannerText: {
      flex: 1,
    },
    deviceBannerTitle: {
      fontSize: 14,
      fontWeight: '600',
    },
    deviceBannerSubtitle: {
      fontSize: 12,
    },
    listContainer: {
      gap: theme.spacing.sm,
    },
    accountCard: {
      borderWidth: 1,
      borderRadius: theme.borderRadius.lg,
      padding: theme.spacing.md,
      gap: theme.spacing.sm,
    },
    accountHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
    },
    accountLabel: {
      fontSize: 16,
      fontWeight: '600',
    },
    accountAddress: {
      fontSize: 13,
      fontFamily: 'monospace',
    },
    accountMeta: {
      fontSize: 12,
    },
    statusPill: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.xs,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.xs,
      borderRadius: theme.borderRadius.lg,
      alignSelf: 'flex-start',
    },
    statusText: {
      fontSize: 12,
      fontWeight: '600',
    },
    loadingRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.sm,
      paddingVertical: theme.spacing.sm,
    },
    loadingText: {
      fontSize: 13,
    },
    intentBadge: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.xs,
    },
    intentDot: {
      width: 8,
      height: 8,
      borderRadius: 4,
    },
    intentText: {
      fontSize: 12,
      fontWeight: '500',
    },
    emptyContainer: {
      borderWidth: 1,
      borderRadius: theme.borderRadius.xl,
      padding: theme.spacing.lg,
      alignItems: 'center',
      gap: theme.spacing.md,
    },
    emptyTitle: {
      fontSize: 16,
      fontWeight: '600',
      textAlign: 'center',
    },
    emptySubtitle: {
      fontSize: 13,
      textAlign: 'center',
    },
    importButton: {
      borderRadius: theme.borderRadius.lg,
      paddingHorizontal: theme.spacing.lg,
      paddingVertical: theme.spacing.sm,
    },
    importButtonText: {
      fontSize: 14,
      fontWeight: '600',
    },
  });

export default RekeyToLedger;
