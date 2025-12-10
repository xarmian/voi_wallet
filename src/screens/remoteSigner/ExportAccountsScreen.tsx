/**
 * Export Accounts Screen (Signer Mode)
 *
 * This screen allows users in signer mode to export their accounts
 * via QR code so they can be imported as REMOTE_SIGNER accounts
 * in the wallet app on another device.
 */

import React, { useState, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import QRCode from 'react-native-qrcode-svg';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { useTheme } from '@/contexts/ThemeContext';
import { Theme } from '@/constants/themes';
import { useWalletStore } from '@/store/walletStore';
import { useRemoteSignerStore, useSignerConfig } from '@/store/remoteSignerStore';
import { RemoteSignerService } from '@/services/remoteSigner';
import { AccountType, AccountMetadata } from '@/types/wallet';
import { formatAddress } from '@/utils/address';

export default function ExportAccountsScreen() {
  const { theme } = useTheme();
  const styles = useThemedStyles(createStyles);
  const navigation = useNavigation();

  const accounts = useWalletStore((state) => state.wallet?.accounts ?? []);
  const signerConfig = useSignerConfig();

  // Get signable accounts (STANDARD type only - we have their private keys)
  const signableAccounts = useMemo(() => {
    return accounts.filter(
      (acc: AccountMetadata) => acc.type === AccountType.STANDARD
    );
  }, [accounts]);

  // Track selected accounts
  const [selectedAccountIds, setSelectedAccountIds] = useState<Set<string>>(
    () => new Set(signableAccounts.map((a: AccountMetadata) => a.id))
  );

  // Generate QR code data
  const qrData = useMemo(() => {
    if (!signerConfig || selectedAccountIds.size === 0) return null;

    const selectedAccounts = signableAccounts.filter((acc: AccountMetadata) =>
      selectedAccountIds.has(acc.id)
    );

    const accountsForPairing = selectedAccounts.map((acc: AccountMetadata) => ({
      address: acc.address,
      publicKey: acc.publicKey,
      label: acc.label,
    }));

    const pairing = RemoteSignerService.createPairingPayload(
      signerConfig.deviceId,
      signerConfig.deviceName,
      accountsForPairing
    );

    return RemoteSignerService.encodePayload(pairing);
  }, [signerConfig, selectedAccountIds, signableAccounts]);

  const toggleAccount = (accountId: string) => {
    setSelectedAccountIds((prev) => {
      const next = new Set(prev);
      if (next.has(accountId)) {
        next.delete(accountId);
      } else {
        next.add(accountId);
      }
      return next;
    });
  };

  const selectAll = () => {
    setSelectedAccountIds(new Set(signableAccounts.map((a: AccountMetadata) => a.id)));
  };

  const selectNone = () => {
    setSelectedAccountIds(new Set());
  };

  // Cross-platform alert helper
  const showAlert = (title: string, message: string) => {
    if (Platform.OS === 'web') {
      window.alert(`${title}\n\n${message}`);
    } else {
      const { Alert } = require('react-native');
      Alert.alert(title, message);
    }
  };

  if (!signerConfig) {
    return (
      <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
        <View style={styles.header}>
          <TouchableOpacity
            style={styles.backButton}
            onPress={() => navigation.goBack()}
          >
            <Ionicons name="arrow-back" size={24} color={theme.colors.text} />
          </TouchableOpacity>
          <Text style={styles.title}>Export Accounts</Text>
          <View style={styles.placeholder} />
        </View>
        <View style={styles.emptyState}>
          <Ionicons
            name="warning-outline"
            size={48}
            color={theme.colors.warning}
          />
          <Text style={styles.emptyText}>
            Signer mode not configured. Please set up signer mode first.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  if (signableAccounts.length === 0) {
    return (
      <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
        <View style={styles.header}>
          <TouchableOpacity
            style={styles.backButton}
            onPress={() => navigation.goBack()}
          >
            <Ionicons name="arrow-back" size={24} color={theme.colors.text} />
          </TouchableOpacity>
          <Text style={styles.title}>Export Accounts</Text>
          <View style={styles.placeholder} />
        </View>
        <View style={styles.emptyState}>
          <Ionicons
            name="wallet-outline"
            size={48}
            color={theme.colors.textSecondary}
          />
          <Text style={styles.emptyText}>
            No signable accounts found. Create or import an account first.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backButton}
          onPress={() => navigation.goBack()}
        >
          <Ionicons name="arrow-back" size={24} color={theme.colors.text} />
        </TouchableOpacity>
        <Text style={styles.title}>Export Accounts</Text>
        <View style={styles.placeholder} />
      </View>

      <ScrollView
        style={styles.content}
        contentContainerStyle={styles.scrollContent}
      >
        {/* Info Card */}
        <View style={styles.infoCard}>
          <Ionicons
            name="qr-code-outline"
            size={24}
            color={theme.colors.primary}
            style={styles.infoIcon}
          />
          <View style={styles.infoContent}>
            <Text style={styles.infoTitle}>Export to Wallet</Text>
            <Text style={styles.infoDescription}>
              Scan this QR code with your online wallet device to import these
              accounts as remote signer accounts. You'll be able to approve
              transactions from this device.
            </Text>
          </View>
        </View>

        {/* Device Info */}
        <View style={styles.deviceInfo}>
          <Text style={styles.deviceLabel}>Signer Device</Text>
          <Text style={styles.deviceName}>{signerConfig.deviceName}</Text>
          <Text style={styles.deviceId}>ID: {signerConfig.deviceId}</Text>
        </View>

        {/* Account Selection */}
        <View style={styles.accountSection}>
          <View style={styles.accountHeader}>
            <Text style={styles.sectionTitle}>
              Select Accounts ({selectedAccountIds.size}/{signableAccounts.length})
            </Text>
            <View style={styles.selectButtons}>
              <TouchableOpacity onPress={selectAll} style={styles.selectButton}>
                <Text style={styles.selectButtonText}>All</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={selectNone} style={styles.selectButton}>
                <Text style={styles.selectButtonText}>None</Text>
              </TouchableOpacity>
            </View>
          </View>

          {signableAccounts.map((account: AccountMetadata) => (
            <TouchableOpacity
              key={account.id}
              style={[
                styles.accountItem,
                selectedAccountIds.has(account.id) && styles.accountItemSelected,
              ]}
              onPress={() => toggleAccount(account.id)}
            >
              <View style={styles.accountCheckbox}>
                {selectedAccountIds.has(account.id) ? (
                  <Ionicons
                    name="checkbox"
                    size={24}
                    color={theme.colors.primary}
                  />
                ) : (
                  <Ionicons
                    name="square-outline"
                    size={24}
                    color={theme.colors.textSecondary}
                  />
                )}
              </View>
              <View style={styles.accountInfo}>
                <Text style={styles.accountName}>{account.label || formatAddress(account.address)}</Text>
                <Text style={styles.accountAddress}>
                  {formatAddress(account.address)}
                </Text>
              </View>
            </TouchableOpacity>
          ))}
        </View>

        {/* QR Code Display */}
        {qrData && selectedAccountIds.size > 0 && (
          <View style={styles.qrSection}>
            <Text style={styles.sectionTitle}>Scan with Wallet Device</Text>
            <View style={styles.qrContainer}>
              <QRCode
                value={qrData}
                size={220}
                backgroundColor="white"
                color="#000000"
              />
            </View>
            <Text style={styles.qrHint}>
              Open the Voi Wallet app on your online device and scan this QR code
              to import these accounts.
            </Text>
          </View>
        )}

        {selectedAccountIds.size === 0 && (
          <View style={styles.noSelectionHint}>
            <Ionicons
              name="information-circle-outline"
              size={20}
              color={theme.colors.textSecondary}
            />
            <Text style={styles.noSelectionText}>
              Select at least one account to generate the QR code
            </Text>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: theme.colors.surface,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: theme.spacing.lg,
      paddingVertical: theme.spacing.md,
      backgroundColor: theme.colors.card,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
    },
    backButton: {
      padding: theme.spacing.xs,
    },
    title: {
      fontSize: 18,
      fontWeight: '600',
      color: theme.colors.text,
    },
    placeholder: {
      width: 32,
    },
    content: {
      flex: 1,
    },
    scrollContent: {
      padding: theme.spacing.lg,
    },
    emptyState: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      padding: theme.spacing.xl,
    },
    emptyText: {
      fontSize: 16,
      color: theme.colors.textSecondary,
      textAlign: 'center',
      marginTop: theme.spacing.md,
    },
    infoCard: {
      flexDirection: 'row',
      backgroundColor: theme.colors.card,
      borderRadius: theme.borderRadius.lg,
      padding: theme.spacing.md,
      marginBottom: theme.spacing.lg,
      borderWidth: 1,
      borderColor: theme.colors.border,
    },
    infoIcon: {
      marginRight: theme.spacing.md,
      marginTop: 2,
    },
    infoContent: {
      flex: 1,
    },
    infoTitle: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.primary,
      marginBottom: 4,
    },
    infoDescription: {
      fontSize: 14,
      color: theme.colors.textSecondary,
      lineHeight: 20,
    },
    deviceInfo: {
      backgroundColor: theme.colors.card,
      borderRadius: theme.borderRadius.lg,
      padding: theme.spacing.md,
      marginBottom: theme.spacing.lg,
      borderWidth: 1,
      borderColor: theme.colors.border,
    },
    deviceLabel: {
      fontSize: 12,
      color: theme.colors.textSecondary,
      marginBottom: 4,
    },
    deviceName: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.text,
    },
    deviceId: {
      fontSize: 12,
      color: theme.colors.textMuted,
      marginTop: 4,
      fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    },
    accountSection: {
      marginBottom: theme.spacing.lg,
    },
    accountHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: theme.spacing.md,
    },
    sectionTitle: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.text,
    },
    selectButtons: {
      flexDirection: 'row',
      gap: theme.spacing.sm,
    },
    selectButton: {
      paddingHorizontal: theme.spacing.sm,
      paddingVertical: theme.spacing.xs,
      backgroundColor: theme.colors.card,
      borderRadius: theme.borderRadius.md,
      borderWidth: 1,
      borderColor: theme.colors.border,
    },
    selectButtonText: {
      fontSize: 14,
      color: theme.colors.primary,
    },
    accountItem: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: theme.colors.card,
      borderRadius: theme.borderRadius.lg,
      padding: theme.spacing.md,
      marginBottom: theme.spacing.sm,
      borderWidth: 1,
      borderColor: theme.colors.border,
    },
    accountItemSelected: {
      borderColor: theme.colors.primary,
      backgroundColor: `${theme.colors.primary}15`,
    },
    accountCheckbox: {
      marginRight: theme.spacing.md,
    },
    accountInfo: {
      flex: 1,
    },
    accountName: {
      fontSize: 16,
      fontWeight: '500',
      color: theme.colors.text,
    },
    accountAddress: {
      fontSize: 14,
      color: theme.colors.textSecondary,
      fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
      marginTop: 2,
    },
    qrSection: {
      alignItems: 'center',
      marginTop: theme.spacing.md,
    },
    qrContainer: {
      backgroundColor: 'white',
      borderRadius: theme.borderRadius.xl,
      padding: theme.spacing.lg,
      marginTop: theme.spacing.md,
      marginBottom: theme.spacing.md,
    },
    qrHint: {
      fontSize: 14,
      color: theme.colors.textSecondary,
      textAlign: 'center',
      paddingHorizontal: theme.spacing.lg,
      lineHeight: 20,
    },
    noSelectionHint: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      padding: theme.spacing.lg,
      gap: theme.spacing.sm,
    },
    noSelectionText: {
      fontSize: 14,
      color: theme.colors.textSecondary,
    },
  });
