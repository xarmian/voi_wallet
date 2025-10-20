import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import {
  AuthAccountDiscoveryRequest,
  AuthAccountDiscoveryResult,
  NetworkAuthAccount,
  LedgerAccountDiscoveryResult,
} from '@/types/wallet';
import { NetworkId } from '@/types/network';
import { Theme } from '@/constants/themes';
import { useThemedStyles, useThemeColors } from '@/hooks/useThemedStyles';
import AuthAccountDiscoveryService from '@/services/auth-account-discovery';
import { MultiAccountWalletService } from '@/services/wallet';
import { useWalletStore } from '@/store/walletStore';
import KeyboardAwareScrollView from '@/components/common/KeyboardAwareScrollView';
import AuthAccountList from './AuthAccountList';
import AuthAccountPreview from './AuthAccountPreview';

interface AuthAccountDiscoveryProps {
  ledgerAccounts: LedgerAccountDiscoveryResult[]; // The Ledger accounts that were imported
  onImportComplete?: (importedCount: number) => void;
  onSkip?: () => void;
  isVisible?: boolean;
}

const AuthAccountDiscovery: React.FC<AuthAccountDiscoveryProps> = ({
  ledgerAccounts,
  onImportComplete,
  onSkip,
  isVisible = true,
}) => {
  const styles = useThemedStyles(createStyles);
  const colors = useThemeColors();

  const [discoveryResult, setDiscoveryResult] = useState<AuthAccountDiscoveryResult | null>(null);
  const [selectedAddresses, setSelectedAddresses] = useState<Set<string>>(new Set());
  const [previewAccount, setPreviewAccount] = useState<NetworkAuthAccount | undefined>();
  const [isDiscovering, setIsDiscovering] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const refreshWallet = useWalletStore((state) => state.refresh);
  const refreshAllBalances = useWalletStore((state) => state.refreshAllBalances);

  // Extract Ledger addresses from the imported accounts
  const ledgerAddresses = ledgerAccounts.map(account => account.address);

  const handleDiscoverAuthAccounts = useCallback(async () => {
    if (ledgerAddresses.length === 0) {
      Alert.alert(
        'No Ledger Accounts',
        'No Ledger accounts found to search for auth accounts.'
      );
      return;
    }

    setIsDiscovering(true);
    setHasSearched(false);

    try {
      const request: AuthAccountDiscoveryRequest = {
        ledgerAddresses,
        networks: [NetworkId.VOI_MAINNET, NetworkId.ALGORAND_MAINNET],
        includeExisting: false, // Don't include already imported accounts
      };

      const result = await AuthAccountDiscoveryService.discoverAuthAccounts(request);
      setDiscoveryResult(result);

      // Auto-select non-existing accounts
      const newSelections = new Set<string>();
      let firstAccount: NetworkAuthAccount | undefined;

      result.authAccounts.forEach(account => {
        if (!account.existsInWallet) {
          newSelections.add(account.address);
          if (!firstAccount) {
            firstAccount = account;
          }
        }
      });

      setSelectedAddresses(newSelections);
      setPreviewAccount(firstAccount);
      setHasSearched(true);

      // Show summary alert
      const { totalFound, voiAccounts, algorandAccounts, errors } = result;
      if (totalFound === 0) {
        Alert.alert(
          'No Rekeyed Accounts Found',
          'No accounts were found that are rekeyed to your Ledger accounts on Voi or Algorand networks.'
        );
      } else {
        const voiCount = voiAccounts.length;
        const algoCount = algorandAccounts.length;
        let message = `Found ${totalFound} rekeyed account${totalFound === 1 ? '' : 's'}`;

        if (voiCount > 0 && algoCount > 0) {
          message += `:\n• ${voiCount} on Voi Network\n• ${algoCount} on Algorand Network`;
        } else if (voiCount > 0) {
          message += ` on Voi Network`;
        } else if (algoCount > 0) {
          message += ` on Algorand Network`;
        }

        if (errors && errors.length > 0) {
          message += '\n\nSome networks could not be searched completely.';
        }

        Alert.alert('Rekeyed Accounts Found', message);
      }
    } catch (error) {
      console.error('Failed to discover auth accounts:', error);
      let title = 'Discovery Failed';
      let message = 'Failed to search for auth accounts.';

      if (error instanceof Error) {
        if (error.message.includes('Rate limit')) {
          title = 'Rate Limit Exceeded';
          message = error.message + ' You can try again in a few minutes.';
        } else if (error.message.includes('Network service')) {
          title = 'Service Unavailable';
          message = error.message + ' This is usually temporary.';
        } else if (error.message.includes('timeout')) {
          title = 'Request Timed Out';
          message = 'The search took too long to complete. Please check your internet connection and try again.';
        } else if (error.message.includes('network')) {
          title = 'Network Error';
          message = 'Unable to connect to the blockchain indexer. Please check your internet connection.';
        } else {
          message = error.message;
        }
      }

      Alert.alert(title, message, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Try Again', onPress: handleDiscoverAuthAccounts },
      ]);
    } finally {
      setIsDiscovering(false);
    }
  }, [ledgerAddresses]);

  const handleToggleAccount = useCallback((account: NetworkAuthAccount) => {
    setSelectedAddresses(prev => {
      const next = new Set(prev);
      if (next.has(account.address)) {
        next.delete(account.address);
      } else {
        next.add(account.address);
      }
      return next;
    });
  }, []);

  const handlePreviewAccount = useCallback((account: NetworkAuthAccount) => {
    setPreviewAccount(account);
  }, []);

  const handleImportAuthAccounts = useCallback(async () => {
    if (!discoveryResult || selectedAddresses.size === 0) {
      Alert.alert(
        'No Accounts Selected',
        'Select at least one auth account to import.'
      );
      return;
    }

    const accountsToImport = discoveryResult.authAccounts.filter(
      account => selectedAddresses.has(account.address) && !account.existsInWallet
    );

    if (accountsToImport.length === 0) {
      Alert.alert(
        'No Valid Accounts',
        'No valid auth accounts selected for import.'
      );
      return;
    }

    setIsImporting(true);

    const results = {
      imported: 0,
      failed: 0,
    };

    const importedAccountIds: string[] = [];

    try {
      // Import accounts sequentially to avoid race conditions
      for (const authAccount of accountsToImport) {
        try {
          const importedAccount = await MultiAccountWalletService.importAuthAccount({
            authAccount,
            label: `Auth Account (${authAccount.networkName})`,
          });

          importedAccountIds.push(importedAccount.id);
          results.imported += 1;

          // Add small delay between imports to ensure wallet state consistency
          await new Promise(resolve => setTimeout(resolve, 100));
        } catch (error) {
          console.error(`Failed to import auth account ${authAccount.address}:`, error);
          results.failed += 1;
        }
      }

      try {
        await refreshWallet();

        await refreshAllBalances();
      } catch (refreshError) {
        console.warn('Failed to refresh wallet after importing auth accounts:', refreshError);
      }

      Alert.alert(
        'Import Complete',
        `Imported ${results.imported} auth account${results.imported === 1 ? '' : 's'}${
          results.failed ? `\nFailed: ${results.failed}` : ''
        }`,
        [
          {
            text: 'Done',
            onPress: () => onImportComplete?.(results.imported),
          },
        ]
      );
    } catch (error) {
      console.error('Auth account import error:', error);
      let title = 'Import Failed';
      let message = 'Failed to import auth accounts.';

      if (error instanceof Error) {
        if (error.message.includes('already exists')) {
          title = 'Account Already Exists';
          message = 'One or more accounts are already in your wallet.';
        } else if (error.message.includes('Invalid')) {
          title = 'Invalid Account Data';
          message = error.message;
        } else if (error.message.includes('network') || error.message.includes('timeout')) {
          title = 'Network Error';
          message = 'Unable to verify account information. Please check your connection and try again.';
        } else {
          message = error.message;
        }
      }

      Alert.alert(title, message, [
        { text: 'Cancel', style: 'cancel' },
        ...(results.imported > 0
          ? [{ text: 'Continue', onPress: () => onImportComplete?.(results.imported) }]
          : [{ text: 'Try Again', onPress: handleImportAuthAccounts }]
        ),
      ]);
    } finally {
      setIsImporting(false);
    }
  }, [discoveryResult, selectedAddresses, onImportComplete, refreshWallet, refreshAllBalances]);

  // Auto-start discovery when component becomes visible
  useEffect(() => {
    if (isVisible && !hasSearched && !isDiscovering) {
      handleDiscoverAuthAccounts();
    }
  }, [isVisible, hasSearched, isDiscovering, handleDiscoverAuthAccounts]);

  if (!isVisible) {
    return null;
  }

  const selectedCount = selectedAddresses.size;
  const authAccounts = discoveryResult?.authAccounts || [];

  return (
    <KeyboardAwareScrollView style={styles.container} contentContainerStyle={styles.scrollContent}>
      <View style={styles.header}>
        <View style={styles.headerContent}>
          <Ionicons
            name="shield-checkmark-outline"
            size={24}
            color={colors.primary}
            style={styles.headerIcon}
          />
          <View style={styles.headerText}>
            <Text style={styles.headerTitle}>Find Rekeyed Accounts</Text>
            <Text style={styles.headerSubtitle}>
              {isDiscovering
                ? 'Searching for accounts rekeyed to your Ledger...'
                : hasSearched
                ? `Found ${authAccounts.length} rekeyed account${authAccounts.length === 1 ? '' : 's'}`
                : 'Search for accounts that use your Ledger for signing'}
            </Text>
          </View>
        </View>

        {!isDiscovering && hasSearched && (
          <TouchableOpacity
            style={styles.refreshButton}
            onPress={handleDiscoverAuthAccounts}
          >
            <Ionicons name="refresh" size={20} color={colors.textSecondary} />
          </TouchableOpacity>
        )}
      </View>

      {hasSearched && discoveryResult && discoveryResult.errors && (
        <View style={styles.errorContainer}>
          <Ionicons
            name="warning-outline"
            size={16}
            color={colors.warning}
            style={styles.errorIcon}
          />
          <Text style={styles.errorText}>
            Some networks could not be searched completely. Results may be incomplete.
          </Text>
        </View>
      )}

      <AuthAccountList
        accounts={authAccounts}
        selectedAddresses={selectedAddresses}
        onToggleSelect={handleToggleAccount}
        onPreviewAccount={handlePreviewAccount}
        isLoading={isDiscovering}
        emptyMessage="No accounts found that are rekeyed to your Ledger accounts on Voi or Algorand networks."
      />

      <AuthAccountPreview
        account={previewAccount}
        selectedCount={selectedCount}
        onImportAccounts={handleImportAuthAccounts}
        isImporting={isImporting}
        importDisabled={false} // Since we filtered out existing accounts
      />

      {hasSearched && authAccounts.length === 0 && (
        <View style={styles.skipContainer}>
          <TouchableOpacity style={styles.skipButton} onPress={onSkip}>
            <Text style={styles.skipButtonText}>Continue - No Rekeyed Accounts Found</Text>
          </TouchableOpacity>
        </View>
      )}
    </KeyboardAwareScrollView>
  );
};

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    container: {
      flex: 1,
    },
    scrollContent: {
      padding: theme.spacing.lg,
      gap: theme.spacing.lg,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    headerContent: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
    },
    headerIcon: {
      marginRight: theme.spacing.md,
    },
    headerText: {
      flex: 1,
    },
    headerTitle: {
      fontSize: 18,
      fontWeight: '600',
      color: theme.colors.text,
    },
    headerSubtitle: {
      fontSize: 14,
      color: theme.colors.textSecondary,
      marginTop: 2,
    },
    refreshButton: {
      width: 32,
      height: 32,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: 16,
      backgroundColor: theme.colors.surface,
    },
    errorContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: theme.colors.warning + '20',
      borderRadius: theme.borderRadius.lg,
      padding: theme.spacing.md,
      gap: theme.spacing.sm,
    },
    errorIcon: {
      marginTop: 1,
    },
    errorText: {
      flex: 1,
      fontSize: 13,
      color: theme.colors.warning,
      lineHeight: 18,
    },
    skipContainer: {
      alignItems: 'center',
      marginTop: theme.spacing.lg,
    },
    skipButton: {
      paddingHorizontal: theme.spacing.lg,
      paddingVertical: theme.spacing.md,
      borderRadius: theme.borderRadius.lg,
      borderWidth: 1,
      borderColor: theme.colors.border,
    },
    skipButtonText: {
      color: theme.colors.textSecondary,
      fontWeight: '500',
    },
  });

export default AuthAccountDiscovery;
