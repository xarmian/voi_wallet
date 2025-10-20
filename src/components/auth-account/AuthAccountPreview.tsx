import React from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { Ionicons } from '@expo/vector-icons';

import { NetworkAuthAccount } from '@/types/wallet';
import { Theme } from '@/constants/themes';
import { useThemedStyles, useThemeColors } from '@/hooks/useThemedStyles';
import NetworkBadge from '@/components/NetworkBadge';

interface AuthAccountPreviewProps {
  account?: NetworkAuthAccount;
  selectedCount: number;
  onImportAccounts?: () => void;
  isImporting?: boolean;
  importDisabled?: boolean;
}

const AuthAccountPreview: React.FC<AuthAccountPreviewProps> = ({
  account,
  selectedCount,
  onImportAccounts,
  isImporting = false,
  importDisabled = false,
}) => {
  const styles = useThemedStyles(createStyles);
  const colors = useThemeColors();

  const handleCopyAddress = (address: string) => {
    Clipboard.setStringAsync(address).catch(() => undefined);
  };

  const formatBalance = (balance?: number | bigint) => {
    if (balance === undefined) return 'N/A';
    const balanceNum = typeof balance === 'bigint' ? Number(balance) : balance;
    const normalizedBalance = balanceNum / 1000000; // Convert microunits to base units
    if (normalizedBalance < 0.001) return '< 0.001';
    return normalizedBalance.toFixed(6);
  };

  const formatDate = (timestamp?: number) => {
    if (!timestamp) return 'Unknown';
    return new Date(timestamp).toLocaleDateString();
  };

  if (!account) {
    return (
      <View style={styles.placeholderContainer}>
        <Ionicons
          name="shield-checkmark-outline"
          size={48}
          color={colors.textMuted}
          style={styles.placeholderIcon}
        />
        <Text style={styles.placeholderTitle}>
          Select an auth account to preview
        </Text>
        <Text style={styles.placeholderSubtitle}>
          Choose one or more auth accounts from the list above to view details
          and import them into your wallet.
        </Text>
      </View>
    );
  }

  const currencySymbol = account.networkName === 'Voi Network' ? 'VOI' : 'ALGO';

  return (
    <View style={styles.previewContainer}>
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>Auth Account Details</Text>
        <NetworkBadge networkId={account.networkId} size="medium" />
      </View>

      <View style={styles.row}>
        <Text style={styles.label}>Network</Text>
        <Text style={styles.value}>{account.networkName}</Text>
      </View>

      <View style={styles.addressContainer}>
        <Text style={styles.label}>Account Address</Text>
        <TouchableOpacity
          style={styles.addressBox}
          onPress={() => handleCopyAddress(account.address)}
        >
          <Text style={styles.addressText} numberOfLines={3}>
            {account.address}
          </Text>
          <Text style={styles.addressHint}>Tap to copy</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.addressContainer}>
        <Text style={styles.label}>Auth Address (Ledger)</Text>
        <TouchableOpacity
          style={styles.addressBox}
          onPress={() => handleCopyAddress(account.authAddress)}
        >
          <Text style={styles.addressText} numberOfLines={3}>
            {account.authAddress}
          </Text>
          <Text style={styles.addressHint}>Tap to copy</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.row}>
        <Text style={styles.label}>Balance</Text>
        <Text style={styles.value}>
          {formatBalance(account.balance)} {currencySymbol}
        </Text>
      </View>

      {account.assetCount !== undefined && (
        <View style={styles.row}>
          <Text style={styles.label}>Assets</Text>
          <Text style={styles.value}>
            {account.assetCount} asset{account.assetCount === 1 ? '' : 's'}
          </Text>
        </View>
      )}

      {account.firstSeen && (
        <View style={styles.row}>
          <Text style={styles.label}>First Seen</Text>
          <Text style={styles.value}>{formatDate(account.firstSeen)}</Text>
        </View>
      )}

      <View style={styles.statusContainer}>
        <Text style={styles.label}>Status</Text>
        {account.existsInWallet ? (
          <Text style={styles.importedStatus}>Already imported</Text>
        ) : (
          <Text style={styles.pendingStatus}>Ready to import</Text>
        )}
      </View>

      <View style={styles.infoBox}>
        <Ionicons
          name="information-circle-outline"
          size={20}
          color={colors.primary}
          style={styles.infoIcon}
        />
        <Text style={styles.infoText}>
          This account has been rekeyed to use your Ledger device for signing.
          You'll be able to manage this account using your Ledger hardware wallet.
        </Text>
      </View>

      <View style={styles.actionsContainer}>
        <TouchableOpacity
          style={[
            styles.importButton,
            (importDisabled || isImporting || selectedCount === 0) &&
              styles.buttonDisabled,
          ]}
          onPress={onImportAccounts}
          disabled={importDisabled || isImporting || selectedCount === 0}
        >
          {isImporting ? (
            <ActivityIndicator size="small" color={colors.buttonText} />
          ) : (
            <Text style={styles.importButtonText}>
              {selectedCount > 1
                ? `Import ${selectedCount} Auth Accounts`
                : 'Import Auth Account'}
            </Text>
          )}
        </TouchableOpacity>
      </View>

      {selectedCount > 1 && (
        <Text style={styles.selectionHint}>
          {selectedCount} accounts selected. Imported accounts will be added to
          your wallet as rekeyed accounts.
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
      lineHeight: 20,
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
    importedStatus: {
      fontSize: 14,
      color: theme.colors.textSecondary,
    },
    pendingStatus: {
      fontSize: 14,
      color: theme.colors.primary,
      fontWeight: '600',
    },
    infoBox: {
      flexDirection: 'row',
      backgroundColor:
        theme.mode === 'light'
          ? 'rgba(0, 122, 255, 0.08)'
          : 'rgba(10, 132, 255, 0.18)',
      borderRadius: theme.borderRadius.lg,
      padding: theme.spacing.md,
      gap: theme.spacing.sm,
    },
    infoIcon: {
      marginTop: 2,
    },
    infoText: {
      flex: 1,
      fontSize: 13,
      color: theme.colors.textSecondary,
      lineHeight: 18,
    },
    actionsContainer: {
      marginTop: theme.spacing.sm,
    },
    importButton: {
      borderRadius: theme.borderRadius.lg,
      backgroundColor: theme.colors.primary,
      paddingVertical: theme.spacing.md,
      alignItems: 'center',
      justifyContent: 'center',
    },
    importButtonText: {
      color: theme.colors.buttonText,
      fontWeight: '600',
      fontSize: 15,
    },
    buttonDisabled: {
      opacity: 0.6,
    },
    selectionHint: {
      fontSize: 13,
      color: theme.colors.textSecondary,
      textAlign: 'center',
      marginTop: theme.spacing.xs,
    },
    placeholderContainer: {
      borderWidth: 1,
      borderColor: theme.colors.borderLight,
      borderRadius: theme.borderRadius.xl,
      padding: theme.spacing.xl,
      backgroundColor: theme.colors.card,
      alignItems: 'center',
      gap: theme.spacing.md,
    },
    placeholderIcon: {
      marginBottom: theme.spacing.sm,
    },
    placeholderTitle: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.text,
      textAlign: 'center',
    },
    placeholderSubtitle: {
      fontSize: 14,
      color: theme.colors.textSecondary,
      textAlign: 'center',
      lineHeight: 20,
    },
  });

export default AuthAccountPreview;