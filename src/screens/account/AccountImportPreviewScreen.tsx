import React, { useState, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  FlatList,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { StackNavigationProp } from '@react-navigation/stack';
import { RouteProp } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { RootStackParamList } from '@/navigation/AppNavigator';
import {
  ScannedAccount,
  getAccountSecret,
  clearAccountSecret,
  clearAccountSecrets,
} from '@/utils/accountQRParser';
import { MultiAccountWalletService } from '@/services/wallet';
import {
  ImportAccountRequest,
  AddWatchAccountRequest,
  AccountType,
} from '@/types/wallet';
import { AccountSecureStorage } from '@/services/secure';
import AccountImportItem from '@/components/account/AccountImportItem';
import { useTheme } from '@/contexts/ThemeContext';

type AccountImportPreviewScreenNavigationProp = StackNavigationProp<
  RootStackParamList,
  'AccountImportPreview'
>;
type AccountImportPreviewScreenRouteProp = RouteProp<
  RootStackParamList,
  'AccountImportPreview'
>;

interface Props {
  navigation: AccountImportPreviewScreenNavigationProp;
  route: AccountImportPreviewScreenRouteProp;
}

interface ImportResult {
  success: number;
  failed: number;
  skipped: number;
  errors: Array<{ account: string; error: string }>;
}

export default function AccountImportPreviewScreen({
  navigation,
  route,
}: Props) {
  const { accounts: initialAccounts, source } = route.params;
  const { theme } = useTheme();

  const [accounts, setAccounts] = useState<ScannedAccount[]>(initialAccounts);
  const [selectedAccountIds, setSelectedAccountIds] = useState<Set<string>>(
    new Set(
      initialAccounts
        .filter((acc) => acc.isValid && (!acc.isDuplicate || acc.isUpgrade))
        .map((acc) => acc.id)
    )
  );
  const [isImporting, setIsImporting] = useState(false);

  useEffect(() => {
    return () => {
      clearAccountSecrets(initialAccounts.map((acc) => acc.secretId));
    };
  }, [initialAccounts]);

  const handleClose = () => {
    navigation.goBack();
  };

  const handleToggleSelection = useCallback((accountId: string) => {
    setSelectedAccountIds((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(accountId)) {
        newSet.delete(accountId);
      } else {
        newSet.add(accountId);
      }
      return newSet;
    });
  }, []);

  const handleNameChange = useCallback((accountId: string, name: string) => {
    setAccounts((prev) =>
      prev.map((acc) => (acc.id === accountId ? { ...acc, name } : acc))
    );
  }, []);

  const getSelectedAccounts = () => {
    return accounts.filter((acc) => selectedAccountIds.has(acc.id));
  };

  const getValidAccountsCount = () => {
    return accounts.filter((acc) => acc.isValid && (!acc.isDuplicate || acc.isUpgrade)).length;
  };

  const handleImportAccounts = async () => {
    const selectedAccounts = getSelectedAccounts();

    if (selectedAccounts.length === 0) {
      Alert.alert(
        'No Accounts Selected',
        'Please select at least one account to import.'
      );
      return;
    }

    const upgradeCount = selectedAccounts.filter((acc) => acc.isUpgrade).length;
    const newCount = selectedAccounts.length - upgradeCount;

    let message = '';
    if (upgradeCount > 0 && newCount > 0) {
      message = `Import ${newCount} new account${newCount === 1 ? '' : 's'} and upgrade ${upgradeCount} watch account${upgradeCount === 1 ? '' : 's'}?`;
    } else if (upgradeCount > 0) {
      message = `Upgrade ${upgradeCount} watch account${upgradeCount === 1 ? '' : 's'} to full account${upgradeCount === 1 ? '' : 's'}?`;
    } else {
      message = `Import ${selectedAccounts.length} selected account${selectedAccounts.length === 1 ? '' : 's'}?`;
    }

    Alert.alert(
      upgradeCount > 0 ? 'Import & Upgrade Accounts' : 'Import Accounts',
      message,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: upgradeCount > 0 && newCount === 0 ? 'Upgrade' : 'Import', onPress: performImport },
      ]
    );
  };

  const performImport = async () => {
    setIsImporting(true);
    const selectedAccounts = getSelectedAccounts();

    try {
      // Check if PIN is already set up
      const hasPin = await AccountSecureStorage.hasPin();

      if (!hasPin) {
        // No PIN setup - route through SecuritySetupScreen
        setIsImporting(false);
        navigation.navigate('SecuritySetup', {
          accounts: selectedAccounts,
          source: 'qr',
        });
        return;
      }

      // PIN exists - proceed with direct import
      const results: ImportResult = {
        success: 0,
        failed: 0,
        skipped: 0,
        errors: [],
      };

      for (const account of selectedAccounts) {
        try {
          if (account.type === 'standard') {
            // Import as standard account
            const secret = account.secretId
              ? getAccountSecret(account.secretId)
              : undefined;

            if (!secret || (!secret.mnemonic && !secret.privateKey)) {
              throw new Error('Secure account data unavailable for import');
            }

            // If upgrading from watch account, delete the watch account first
            if (account.isUpgrade && account.existingAccountId) {
              await MultiAccountWalletService.deleteAccount(account.existingAccountId);
            }

            const request: ImportAccountRequest = {
              type: AccountType.STANDARD,
              label:
                account.name ||
                `Imported Account ${new Date().toLocaleDateString()}`,
            };

            if (secret.mnemonic) {
              request.mnemonic = secret.mnemonic;
            } else if (secret.privateKey) {
              request.privateKey = secret.privateKey;
            }

            await MultiAccountWalletService.importStandardAccount(request);
            results.success++;
            clearAccountSecret(account.secretId);
          } else {
            // Add as watch account
            const request: AddWatchAccountRequest = {
              type: AccountType.WATCH,
              address: account.address,
              label:
                account.name ||
                `Watch Account ${new Date().toLocaleDateString()}`,
            };

            await MultiAccountWalletService.addWatchAccount(request);
            results.success++;
          }
        } catch (error) {
          console.error(`Failed to import account ${account.address}:`, error);
          results.failed++;
          results.errors.push({
            account: account.address,
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }
      }

      // Show results
      if (results.success > 0) {
        let message = `Successfully imported ${results.success} account${results.success === 1 ? '' : 's'}`;

        if (results.failed > 0) {
          message += `\n\n${results.failed} account${results.failed === 1 ? '' : 's'} failed to import`;
          if (results.errors.length > 0) {
            message += '\n\nErrors:';
            results.errors.forEach((err) => {
              message += `\n• ${err.account}: ${err.error}`;
            });
          }
        }

        Alert.alert('Import Complete', message, [
          {
            text: 'OK',
            onPress: () =>
              navigation.navigate('Main' as any, { screen: 'Home' }),
          },
        ]);
      } else {
        Alert.alert(
          'Import Failed',
          'Failed to import any accounts. Please check the error details and try again.',
          [{ text: 'OK' }]
        );
      }
    } catch (error) {
      console.error('Import process error:', error);
      Alert.alert(
        'Import Error',
        'An unexpected error occurred during import. Please try again.',
        [{ text: 'OK' }]
      );
    } finally {
      setIsImporting(false);
    }
  };

  const renderAccount = ({ item }: { item: ScannedAccount }) => (
    <AccountImportItem
      account={item}
      isSelected={selectedAccountIds.has(item.id)}
      onToggleSelection={handleToggleSelection}
      onNameChange={handleNameChange}
    />
  );

  const renderHeader = () => (
    <View
      style={[styles.summaryContainer, { backgroundColor: theme.colors.card }]}
    >
      <Text style={[styles.summaryTitle, { color: theme.colors.text }]}>
        Review Accounts
      </Text>
      <Text style={[styles.summaryText, { color: theme.colors.textSecondary }]}>
        Found {accounts.length} account{accounts.length === 1 ? '' : 's'} in QR
        code
      </Text>

      {getValidAccountsCount() < accounts.length && (
        <View
          style={[
            styles.warningContainer,
            { backgroundColor: theme.colors.warningLight },
          ]}
        >
          <Ionicons name="warning" size={16} color={theme.colors.warning} />
          <Text style={[styles.warningText, { color: theme.colors.warning }]}>
            {accounts.length - getValidAccountsCount()} account
            {accounts.length - getValidAccountsCount() === 1 ? '' : 's'} cannot
            be imported
          </Text>
        </View>
      )}

      <View
        style={[styles.statsContainer, { borderColor: theme.colors.border }]}
      >
        <View style={styles.statItem}>
          <Text style={[styles.statNumber, { color: theme.colors.text }]}>
            {accounts.filter((acc) => acc.type === 'standard').length}
          </Text>
          <Text
            style={[styles.statLabel, { color: theme.colors.textSecondary }]}
          >
            Full Accounts
          </Text>
        </View>
        <View
          style={[styles.statDivider, { backgroundColor: theme.colors.border }]}
        />
        <View style={styles.statItem}>
          <Text style={[styles.statNumber, { color: theme.colors.text }]}>
            {accounts.filter((acc) => acc.type === 'watch').length}
          </Text>
          <Text
            style={[styles.statLabel, { color: theme.colors.textSecondary }]}
          >
            Watch Accounts
          </Text>
        </View>
        <View
          style={[styles.statDivider, { backgroundColor: theme.colors.border }]}
        />
        <View style={styles.statItem}>
          <Text style={[styles.statNumber, { color: theme.colors.text }]}>
            {accounts.filter((acc) => acc.isDuplicate).length}
          </Text>
          <Text
            style={[styles.statLabel, { color: theme.colors.textSecondary }]}
          >
            Duplicates
          </Text>
        </View>
      </View>
    </View>
  );

  const renderFooter = () => <View style={styles.footerSpacing} />;

  return (
    <SafeAreaView
      style={[styles.container, { backgroundColor: theme.colors.background }]}
      edges={['top', 'bottom']}
    >
      {/* Header */}
      <View
        style={[
          styles.header,
          {
            backgroundColor: theme.colors.card,
            borderBottomColor: theme.colors.border,
          },
        ]}
      >
        <TouchableOpacity style={styles.backButton} onPress={handleClose}>
          <Ionicons name="arrow-back" size={24} color={theme.colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: theme.colors.text }]}>
          Import Preview
        </Text>
        <View style={styles.headerSpacer} />
      </View>

      {/* Account List */}
      <FlatList
        data={accounts}
        renderItem={renderAccount}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.listContent}
        ListHeaderComponent={renderHeader}
        ListFooterComponent={renderFooter}
        showsVerticalScrollIndicator={false}
      />

      {/* Bottom Action Bar */}
      <View
        style={[
          styles.bottomBar,
          {
            backgroundColor: theme.colors.card,
            borderTopColor: theme.colors.border,
          },
        ]}
      >
        <View style={styles.selectionSummary}>
          <Text
            style={[
              styles.selectionText,
              { color: theme.colors.textSecondary },
            ]}
          >
            {selectedAccountIds.size} of {getValidAccountsCount()} selected
          </Text>
        </View>

        <TouchableOpacity
          style={[
            styles.importButton,
            {
              backgroundColor:
                selectedAccountIds.size === 0 || isImporting
                  ? theme.colors.disabled
                  : theme.colors.primary,
            },
          ]}
          onPress={handleImportAccounts}
          disabled={selectedAccountIds.size === 0 || isImporting}
        >
          {isImporting ? (
            <>
              <ActivityIndicator size="small" color={theme.colors.buttonText} />
              <Text
                style={[
                  styles.importButtonText,
                  { color: theme.colors.buttonText },
                ]}
              >
                Importing...
              </Text>
            </>
          ) : (
            <>
              <Ionicons
                name="download"
                size={20}
                color={theme.colors.buttonText}
              />
              <Text
                style={[
                  styles.importButtonText,
                  { color: theme.colors.buttonText },
                ]}
              >
                Import Selected
              </Text>
            </>
          )}
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
  },
  backButton: {
    padding: 4,
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '600',
  },
  headerSpacer: {
    width: 32,
  },
  listContent: {
    paddingHorizontal: 20,
  },
  summaryContainer: {
    borderRadius: 12,
    padding: 20,
    marginVertical: 20,
    alignItems: 'center',
  },
  summaryTitle: {
    fontSize: 20,
    fontWeight: '600',
    marginBottom: 8,
  },
  summaryText: {
    fontSize: 16,
    marginBottom: 16,
  },
  warningContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    marginBottom: 16,
  },
  warningText: {
    fontSize: 14,
    marginLeft: 6,
  },
  statsContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 20,
  },
  statItem: {
    alignItems: 'center',
    flex: 1,
  },
  statNumber: {
    fontSize: 20,
    fontWeight: '700',
  },
  statLabel: {
    fontSize: 12,
    marginTop: 4,
  },
  statDivider: {
    width: 1,
    height: 30,
    marginHorizontal: 16,
  },
  footerSpacing: {
    height: 100,
  },
  bottomBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderTopWidth: 1,
  },
  selectionSummary: {
    flex: 1,
  },
  selectionText: {
    fontSize: 14,
    fontWeight: '500',
  },
  importButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 8,
  },
  importButtonText: {
    fontSize: 16,
    fontWeight: '600',
    marginLeft: 8,
  },
});
