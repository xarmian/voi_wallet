import React from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { Ionicons } from '@expo/vector-icons';

import { LedgerAccountDiscoveryResult } from '@/types/wallet';
import { LedgerDeviceInfo } from '@/services/ledger/transport';
import { Theme } from '@/constants/themes';
import { useThemedStyles, useThemeColors } from '@/hooks/useThemedStyles';

interface LedgerAccountPreviewProps {
  account?: LedgerAccountDiscoveryResult;
  device?: LedgerDeviceInfo | null;
  onVerifyAddress?: (account: LedgerAccountDiscoveryResult) => void;
  onImportAccounts?: () => void;
  selectedCount: number;
  isVerifying?: boolean;
  isImporting?: boolean;
  importDisabled?: boolean;
  accountLabel?: string;
  onAccountLabelChange?: (value: string) => void;
}

const LedgerAccountPreview: React.FC<LedgerAccountPreviewProps> = ({
  account,
  device,
  selectedCount,
  onVerifyAddress,
  onImportAccounts,
  isVerifying = false,
  isImporting = false,
  importDisabled = false,
  accountLabel,
  onAccountLabelChange,
}) => {
  const styles = useThemedStyles(createStyles);
  const colors = useThemeColors();

  const handleCopyAddress = () => {
    if (account) {
      Clipboard.setStringAsync(account.address).catch(() => undefined);
    }
  };

  if (!account) {
    return (
      <View style={styles.placeholderContainer}>
        <Text style={styles.placeholderTitle}>
          Select an account to preview
        </Text>
        <Text style={styles.placeholderSubtitle}>
          Scan your Ledger device and choose one or more accounts to import.
          Account details and verification options will appear here.
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.previewContainer}>
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>Selected Account</Text>
        <Ionicons
          name="hardware-chip-outline"
          size={18}
          color={colors.textMuted}
        />
      </View>

      <View style={styles.row}>
        <Text style={styles.label}>Derivation Index</Text>
        <Text style={styles.value}>#{account.derivationIndex}</Text>
      </View>

      <View style={styles.row}>
        <Text style={styles.label}>Derivation Path</Text>
        <Text style={styles.value}>{account.derivationPath}</Text>
      </View>

      <View style={styles.addressContainer}>
        <Text style={styles.label}>Address</Text>
        <TouchableOpacity style={styles.addressBox} onPress={handleCopyAddress}>
          <Text style={styles.addressText} numberOfLines={3}>
            {account.address}
          </Text>
          <Text style={styles.addressHint}>Tap to copy</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.statusContainer}>
        <Text style={styles.label}>Status</Text>
        {account.existsInWallet ? (
          <Text style={styles.importedStatus}>Already imported</Text>
        ) : (
          <Text style={styles.pendingStatus}>Ready to import</Text>
        )}
      </View>

      {!account.existsInWallet && onAccountLabelChange && (
        <View style={styles.nameInputContainer}>
          <Text style={styles.nameInputLabel}>Account Name (optional)</Text>
          <TextInput
            style={[styles.nameInput, { color: colors.text }]}
            value={accountLabel ?? ''}
            onChangeText={onAccountLabelChange}
            placeholder={`Ledger Account ${account.derivationIndex}`}
            placeholderTextColor={colors.placeholder}
            autoCapitalize="words"
            autoCorrect={false}
            returnKeyType="done"
          />
        </View>
      )}

      {device ? (
        <View style={styles.deviceInfo}>
          <Text style={styles.devicesLabel}>Device</Text>
          <Text style={styles.deviceName}>
            {device.name || 'Ledger Device'}
          </Text>
          <Text style={styles.deviceMeta}>
            {device.type === 'ble' ? 'Bluetooth' : 'USB'} · {device.id}
          </Text>
        </View>
      ) : null}

      <View style={styles.actionsRow}>
        <TouchableOpacity
          style={[styles.secondaryButton, isVerifying && styles.buttonDisabled]}
          onPress={() => account && onVerifyAddress?.(account)}
          disabled={!onVerifyAddress || isVerifying}
        >
          {isVerifying ? (
            <ActivityIndicator size="small" color={colors.text} />
          ) : (
            <Text style={styles.secondaryButtonText}>Verify on Device</Text>
          )}
        </TouchableOpacity>

        <TouchableOpacity
          style={[
            styles.primaryButton,
            (importDisabled || isImporting || selectedCount === 0) &&
              styles.buttonDisabled,
          ]}
          onPress={onImportAccounts}
          disabled={importDisabled || isImporting || selectedCount === 0}
        >
          {isImporting ? (
            <ActivityIndicator size="small" color={colors.buttonText} />
          ) : (
            <Text style={styles.primaryButtonText}>
              {selectedCount > 1
                ? `Import ${selectedCount} Accounts`
                : 'Import Account'}
            </Text>
          )}
        </TouchableOpacity>
      </View>

      {selectedCount > 1 && (
        <Text style={styles.selectionHint}>
          {selectedCount} accounts selected. Imported accounts will be added to
          your wallet in sequence.
        </Text>
      )}
    </View>
  );
};

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    previewContainer: {
      borderWidth: 1,
      borderColor: theme.colors.borderLight,
      borderRadius: theme.borderRadius.xl,
      padding: theme.spacing.lg,
      backgroundColor: theme.colors.card,
      gap: theme.spacing.md,
    },
    sectionHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    sectionTitle: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.text,
    },
    row: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
    },
    label: {
      fontSize: 14,
      color: theme.colors.textSecondary,
    },
    value: {
      fontSize: 15,
      fontWeight: '600',
      color: theme.colors.text,
    },
    addressContainer: {
      gap: theme.spacing.xs,
    },
    addressBox: {
      borderWidth: 1,
      borderColor: theme.colors.borderLight,
      borderRadius: theme.borderRadius.lg,
      padding: theme.spacing.md,
      backgroundColor: theme.colors.surface,
    },
    addressText: {
      fontFamily: 'Menlo',
      fontSize: 14,
      color: theme.colors.text,
    },
    addressHint: {
      fontSize: 12,
      color: theme.colors.textSecondary,
      marginTop: theme.spacing.xs,
    },
    statusContainer: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
    },
    nameInputContainer: {
      marginTop: theme.spacing.md,
      gap: theme.spacing.xs,
    },
    nameInputLabel: {
      fontSize: 13,
      fontWeight: '500',
      color: theme.colors.textSecondary,
    },
    nameInput: {
      borderWidth: 1,
      borderColor: theme.colors.borderLight,
      borderRadius: theme.borderRadius.lg,
      paddingVertical: theme.spacing.sm,
      paddingHorizontal: theme.spacing.md,
      backgroundColor: theme.colors.surface,
      fontSize: 16,
    },
    importedStatus: {
      fontSize: 14,
      color: theme.colors.textSecondary,
    },
    pendingStatus: {
      fontSize: 14,
      color: theme.colors.primary,
      fontWeight: '600',
    },
    deviceInfo: {
      borderRadius: theme.borderRadius.md,
      backgroundColor:
        theme.mode === 'light'
          ? 'rgba(0, 122, 255, 0.08)'
          : 'rgba(10, 132, 255, 0.18)',
      padding: theme.spacing.md,
    },
    devicesLabel: {
      fontSize: 12,
      color: theme.colors.textSecondary,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
    },
    deviceName: {
      fontSize: 15,
      fontWeight: '600',
      color: theme.colors.text,
      marginTop: theme.spacing.xs,
    },
    deviceMeta: {
      fontSize: 12,
      color: theme.colors.textSecondary,
      marginTop: theme.spacing.xs,
    },
    actionsRow: {
      flexDirection: 'row',
      gap: theme.spacing.md,
    },
    primaryButton: {
      flex: 1,
      borderRadius: theme.borderRadius.lg,
      backgroundColor: theme.colors.primary,
      paddingVertical: theme.spacing.md,
      alignItems: 'center',
      justifyContent: 'center',
    },
    primaryButtonText: {
      color: theme.colors.buttonText,
      fontWeight: '600',
    },
    secondaryButton: {
      flex: 1,
      borderRadius: theme.borderRadius.lg,
      borderWidth: 1,
      borderColor: theme.colors.border,
      paddingVertical: theme.spacing.md,
      alignItems: 'center',
      justifyContent: 'center',
    },
    secondaryButtonText: {
      color: theme.colors.text,
      fontWeight: '600',
    },
    buttonDisabled: {
      opacity: 0.6,
    },
    selectionHint: {
      fontSize: 13,
      color: theme.colors.textSecondary,
    },
    placeholderContainer: {
      borderWidth: 1,
      borderColor: theme.colors.borderLight,
      borderRadius: theme.borderRadius.xl,
      padding: theme.spacing.lg,
      backgroundColor: theme.colors.card,
      alignItems: 'center',
      gap: theme.spacing.sm,
    },
    placeholderTitle: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.text,
    },
    placeholderSubtitle: {
      fontSize: 14,
      color: theme.colors.textSecondary,
      textAlign: 'center',
      lineHeight: 20,
    },
  });

export default LedgerAccountPreview;
