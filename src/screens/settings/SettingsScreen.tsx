import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Alert,
  ScrollView,
  Switch,
  Modal,
  Pressable,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { StackNavigationProp } from '@react-navigation/stack';
import { SettingsStackParamList } from '@/navigation/AppNavigator';
import {
  useActiveAccount,
  useAccounts,
  useWalletStore,
  useWalletSettings,
} from '@/store/walletStore';
import { useAuth } from '@/contexts/AuthContext';
import UniversalHeader from '@/components/common/UniversalHeader';
import AccountListModal from '@/components/account/AccountListModal';
import AddAccountModal from '@/components/account/AddAccountModal';
import RenameAccountModal from '@/components/account/RenameAccountModal';
import ThemeSwitcher from '@/components/common/ThemeSwitcher';
import LocaleSwitcher from '@/components/common/LocaleSwitcher';
import { formatAddress } from '@/utils/address';
import { AccountMetadata, AccountType } from '@/types/wallet';
import {
  useCurrentNetworkConfig,
  useIsCurrentNetworkHealthy,
} from '@/store/networkStore';
import NetworkSwitcher from '@/components/network/NetworkSwitcher';
import NetworkIndicator from '@/components/network/NetworkIndicator';
import * as LocalAuthentication from 'expo-local-authentication';
import { useTheme } from '@/contexts/ThemeContext';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';

type SettingsScreenNavigationProp = StackNavigationProp<SettingsStackParamList>;



export default function SettingsScreen() {
  const navigation = useNavigation<SettingsScreenNavigationProp>();
  const activeAccount = useActiveAccount();
  const accounts = useAccounts();
  const deleteAccount = useWalletStore((state) => state.deleteAccount);
  const updateAccountLabel = useWalletStore(
    (state) => state.updateAccountLabel
  );
  const updateWalletSettings = useWalletStore(
    (state) => state.updateWalletSettings
  );
  const walletSettings = useWalletSettings();
  const { authState, enableBiometrics } = useAuth();
  const currentNetworkConfig = useCurrentNetworkConfig();
  const isNetworkHealthy = useIsCurrentNetworkHealthy();
  const { theme, themeMode, setThemeMode } = useTheme();
  const styles = useThemedStyles(createStyles);
  const [isAccountModalVisible, setIsAccountModalVisible] = useState(false);
  const [isAddAccountModalVisible, setIsAddAccountModalVisible] =
    useState(false);
  const [accountToRename, setAccountToRename] =
    useState<AccountMetadata | null>(null);
  const [isRenamingAccount, setIsRenamingAccount] = useState(false);
  const [isBiometricAvailable, setIsBiometricAvailable] = useState(false);
  const [isTogglingBiometric, setIsTogglingBiometric] = useState(false);
  const [isNetworkSwitcherVisible, setIsNetworkSwitcherVisible] =
    useState(false);
  const [isLocaleModalVisible, setIsLocaleModalVisible] = useState(false);
  const [isThemeModalVisible, setIsThemeModalVisible] = useState(false);
  const currentLocaleValue = walletSettings?.numberLocale ?? null;
  const localeDisplayText = (() => {
    const options = [
      { label: 'System Default', value: null },
      { label: 'English (United States)', value: 'en-US' },
      { label: 'English (United Kingdom)', value: 'en-GB' },
      { label: 'French (France)', value: 'fr-FR' },
      { label: 'German (Germany)', value: 'de-DE' },
      { label: 'Spanish (Spain)', value: 'es-ES' },
      { label: 'Japanese (Japan)', value: 'ja-JP' },
    ];
    return options.find((option) => option.value === currentLocaleValue)?.label ?? 'System Default';
  })();

  const getAccountDisplayName = (account: AccountMetadata) =>
    account.label?.trim() || formatAddress(account.address);

  useEffect(() => {
    checkBiometricAvailability();
  }, []);

  const checkBiometricAvailability = async () => {
    try {
      const hasHardware = await LocalAuthentication.hasHardwareAsync();
      const isEnrolled = await LocalAuthentication.isEnrolledAsync();
      setIsBiometricAvailable(hasHardware && isEnrolled);
    } catch (error) {
      console.warn('Failed to check biometric availability:', error);
      setIsBiometricAvailable(false);
    }
  };

  const handleAccountSelectorPress = () => {
    setIsAccountModalVisible(true);
  };

  const handleAccountModalClose = () => {
    setIsAccountModalVisible(false);
  };

  const handleAddAccount = () => {
    setIsAccountModalVisible(false);
    setIsAddAccountModalVisible(true);
  };

  const handleRenameAccountPress = () => {
    if (!activeAccount) {
      Alert.alert('No Active Account', 'Please select an account to rename.');
      return;
    }

    setAccountToRename(activeAccount);
  };

  const handleRekeyAccountPress = () => {
    if (!activeAccount) {
      Alert.alert('No Active Account', 'Please select an account to rename.');
      return;
    }

    // Only allow rekeying of standard accounts and rekeyed accounts that we control
    if (activeAccount.type === AccountType.WATCH) {
      Alert.alert(
        'Cannot Rekey Watch Account',
        'Watch-only accounts cannot be rekeyed. You can only rekey accounts where you control the private key.'
      );
      return;
    }

    navigation.navigate('RekeyAccount', { accountId: activeAccount.id });
  };

  const handleRenameAccountFromList = (accountId: string) => {
    const targetAccount = accounts.find((account) => account.id === accountId);

    if (!targetAccount) {
      Alert.alert(
        'Account Not Found',
        'Unable to locate the selected account.'
      );
      return;
    }

    setIsAccountModalVisible(false);
    setAccountToRename(targetAccount);
  };

  const handleRenameModalClose = () => {
    if (isRenamingAccount) {
      return;
    }

    setAccountToRename(null);
  };

  const handleConfirmAccountRename = async (newLabel: string) => {
    if (!accountToRename) {
      return;
    }

    setIsRenamingAccount(true);

    try {
      await updateAccountLabel(accountToRename.id, newLabel);
      setAccountToRename(null);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Failed to rename the account.';
      Alert.alert('Rename Failed', message);
    } finally {
      setIsRenamingAccount(false);
    }
  };

  const handleShowRecoveryPhrase = () => {
    if (!activeAccount) {
      Alert.alert(
        'Error',
        'No active account found. Please select an account first.'
      );
      return;
    }

    // Show a confirmation before navigating
    Alert.alert(
      'Show Recovery Phrase',
      'Your 25-word recovery phrase will be displayed. Make sure you are in a private location.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Continue',
          onPress: () => {
            navigation.navigate('ShowRecoveryPhrase', {
              accountAddress: activeAccount.address,
            });
          },
        },
      ]
    );
  };

  const handleChangePin = () => {
    navigation.navigate('ChangePin');
  };

  const handleSecuritySettings = () => {
    navigation.navigate('SecuritySettings');
  };

  const handleBiometricToggle = async (enabled: boolean) => {
    if (!isBiometricAvailable) {
      Alert.alert(
        'Biometric Authentication Unavailable',
        'Biometric authentication is not available on this device or no biometric data is enrolled. Please set up biometric authentication in your device settings.'
      );
      return;
    }

    setIsTogglingBiometric(true);

    try {
      await enableBiometrics(enabled);

      const message = enabled
        ? 'Biometric authentication has been enabled'
        : 'Biometric authentication has been disabled';

      Alert.alert('Success', message);
    } catch (error) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : 'Failed to update biometric setting';
      Alert.alert('Error', errorMessage);
    } finally {
      setIsTogglingBiometric(false);
    }
  };

  const handleWalletConnectSessions = () => {
    navigation.navigate('WalletConnectSessions');
  };

  const handleBackupWallet = () => {
    Alert.alert('Backup Wallet', 'Backup functionality will be implemented');
  };

  const handleNetworkPress = () => {
    setIsNetworkSwitcherVisible(true);
  };

  const handleNetworkSwitcherClose = () => {
    setIsNetworkSwitcherVisible(false);
  };

  const handleDeleteActiveAccount = () => {
    if (!activeAccount) {
      Alert.alert('No Active Account', 'Please select an account to delete.');
      return;
    }

    const accountId = activeAccount.id;
    const accountName =
      activeAccount.label?.trim() || formatAddress(activeAccount.address);

    Alert.alert(
      'Delete Account',
      `Are you sure you want to delete ${accountName}? This action cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              await deleteAccount(accountId);
              Alert.alert(
                'Account Deleted',
                `${accountName} has been removed.`
              );
            } catch (error) {
              const message =
                error instanceof Error
                  ? error.message
                  : 'Failed to delete the account.';
              Alert.alert('Delete Failed', message);
            }
          },
        },
      ]
    );
  };

  const handleAbout = () => {
    navigation.navigate('AboutScreen');
  };

  const handleTermsOfService = () => {
    navigation.navigate('WebView', {
      url: 'https://getvoi.app/terms-of-service',
      title: 'Terms of Service',
    });
  };

  const handlePrivacyPolicy = () => {
    navigation.navigate('WebView', {
      url: 'https://getvoi.app/privacy-policy',
      title: 'Privacy Policy',
    });
  };

  const handleThemePress = () => {
    setIsThemeModalVisible(true);
  };

  const getThemeDisplayText = () => {
    switch (themeMode) {
      case 'light':
        return 'Light';
      case 'dark':
        return 'Dark';
      case 'system':
        return 'System Default';
      default:
        return 'System Default';
    }
  };

  const handleLocalePress = () => {
    setIsLocaleModalVisible(true);
  };

  const handleLocaleSelect = async (value: string | null) => {
    setIsLocaleModalVisible(false);

    try {
      await updateWalletSettings({ numberLocale: value ?? null });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Failed to update number format setting.';
      Alert.alert('Error', message);
    }
  };

  const handleThemeSelect = (value: 'light' | 'dark' | 'system') => {
    setIsThemeModalVisible(false);
    setThemeMode(value);
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <UniversalHeader
        title="Settings"
        onAccountSelectorPress={handleAccountSelectorPress}
      />
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Account</Text>

          <TouchableOpacity
            style={styles.settingItem}
            onPress={handleRenameAccountPress}
          >
            <Text style={styles.settingText}>Rename Account</Text>
            <Text style={styles.arrow}>→</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.settingItem}
            onPress={handleRekeyAccountPress}
          >
            <Text style={styles.settingText}>Rekey Account</Text>
            <Text style={styles.arrow}>→</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Security</Text>

          <TouchableOpacity
            style={styles.settingItem}
            onPress={handleSecuritySettings}
          >
            <Text style={styles.settingText}>Security Settings</Text>
            <Text style={styles.arrow}>→</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.settingItem}
            onPress={handleShowRecoveryPhrase}
          >
            <Text style={styles.settingText}>Show Recovery Phrase</Text>
            <Text style={styles.arrow}>→</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Network</Text>

          <TouchableOpacity
            style={styles.settingItem}
            onPress={handleNetworkPress}
          >
            <View style={styles.networkSettingContent}>
              <Text style={styles.settingText}>Current Network</Text>
              <View style={styles.networkInfo}>
                <NetworkIndicator showName={true} size="small" />
                <View
                  style={[
                    styles.networkStatusIndicator,
                    {
                      backgroundColor: isNetworkHealthy ? '#10B981' : '#EF4444',
                    },
                  ]}
                />
              </View>
            </View>
            <Text style={styles.arrow}>→</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Appearance</Text>

          <TouchableOpacity
            style={styles.settingItem}
            onPress={handleThemePress}
          >
            <Text style={styles.settingText}>Theme</Text>
            <View style={styles.themeDisplayContainer}>
              <Text style={styles.themeDisplayText}>
                {getThemeDisplayText()}
              </Text>
              <Text style={styles.arrow}>→</Text>
            </View>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.settingItem}
            onPress={handleLocalePress}
          >
            <Text style={styles.settingText}>Number Format</Text>
            <View style={styles.themeDisplayContainer}>
              <Text style={styles.themeDisplayText}>{localeDisplayText}</Text>
              <Text style={styles.arrow}>→</Text>
            </View>
          </TouchableOpacity>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>WalletConnect</Text>

          <TouchableOpacity
            style={styles.settingItem}
            onPress={handleWalletConnectSessions}
          >
            <Text style={styles.settingText}>Connected dApps</Text>
            <Text style={styles.arrow}>→</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Backup</Text>

          <TouchableOpacity
            style={styles.settingItem}
            onPress={handleBackupWallet}
          >
            <Text style={styles.settingText}>Backup Wallet</Text>
            <Text style={styles.arrow}>→</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>About</Text>

          <TouchableOpacity style={styles.settingItem} onPress={handleAbout}>
            <Text style={styles.settingText}>About Voi Wallet</Text>
            <Text style={styles.arrow}>→</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.settingItem}
            onPress={handleTermsOfService}
          >
            <Text style={styles.settingText}>Terms of Service</Text>
            <Text style={styles.arrow}>→</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.settingItem}
            onPress={handlePrivacyPolicy}
          >
            <Text style={styles.settingText}>Privacy Policy</Text>
            <Text style={styles.arrow}>→</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.dangerSection}>
          <TouchableOpacity
            style={styles.dangerItem}
            onPress={handleDeleteActiveAccount}
          >
            <Text style={styles.dangerText}>
              {activeAccount
                ? `Delete Account (${activeAccount.label?.trim() || formatAddress(activeAccount.address)})`
                : 'Delete Account'}
            </Text>
          </TouchableOpacity>
        </View>
      </ScrollView>

      <LocaleSwitcher
        visible={isLocaleModalVisible}
        onClose={() => setIsLocaleModalVisible(false)}
        currentLocale={currentLocaleValue}
        onLocaleSelect={handleLocaleSelect}
        theme={theme}
      />

      <ThemeSwitcher
        visible={isThemeModalVisible}
        onClose={() => setIsThemeModalVisible(false)}
        currentTheme={themeMode}
        onThemeSelect={handleThemeSelect}
        theme={theme}
      />

      <AccountListModal
        isVisible={isAccountModalVisible}
        onClose={handleAccountModalClose}
        onAddAccount={handleAddAccount}
        onEditAccount={handleRenameAccountFromList}
      />

      {/* Add Account Modal */}
      <AddAccountModal
        isVisible={isAddAccountModalVisible}
        onClose={() => setIsAddAccountModalVisible(false)}
        onCreateAccount={() => {
          console.log('SettingsScreen: onCreateAccount called');
          setIsAddAccountModalVisible(false);
          console.log('SettingsScreen: navigating to CreateAccount');
          navigation.navigate('CreateAccount');
          console.log('SettingsScreen: navigation.navigate called');
        }}
        onImportAccount={() => {
          setIsAddAccountModalVisible(false);
          navigation.navigate('MnemonicImport');
        }}
        onImportLedgerAccount={() => {
          setIsAddAccountModalVisible(false);
          navigation.getParent()?.navigate('LedgerAccountImport');
        }}
        onImportQRAccount={() => {
          setIsAddAccountModalVisible(false);
          navigation.getParent()?.navigate('QRAccountImport');
        }}
        onAddWatchAccount={() => {
          setIsAddAccountModalVisible(false);
          navigation.navigate('AddWatchAccount');
        }}
      />

      <RenameAccountModal
        visible={!!accountToRename}
        initialName={accountToRename?.label ?? ''}
        accountDisplayName={
          accountToRename ? getAccountDisplayName(accountToRename) : undefined
        }
        onCancel={handleRenameModalClose}
        onConfirm={handleConfirmAccountRename}
        isSubmitting={isRenamingAccount}
      />

      {isNetworkSwitcherVisible && (
        <SafeNetworkSwitcher
          visible={isNetworkSwitcherVisible}
          onClose={handleNetworkSwitcherClose}
          theme={theme}
        />
      )}
    </SafeAreaView>
  );
}

// Safe wrapper for NetworkSwitcher that handles theme context errors
function SafeNetworkSwitcher({
  visible,
  onClose,
  theme,
}: {
  visible: boolean;
  onClose: () => void;
  theme: Theme;
}) {
  try {
    return (
      <NetworkSwitcher visible={visible} onClose={onClose} theme={theme} />
    );
  } catch (error) {
    console.error('NetworkSwitcher theme context error:', error);
    // Return a simple modal with error message
    return (
      <Modal
        visible={visible}
        transparent
        animationType="fade"
        onRequestClose={onClose}
      >
        <View
          style={{
            flex: 1,
            backgroundColor: 'rgba(0,0,0,0.5)',
            justifyContent: 'center',
            alignItems: 'center',
          }}
        >
          <View
            style={{
              backgroundColor: 'white',
              padding: 20,
              borderRadius: 10,
              margin: 20,
              minWidth: 250,
            }}
          >
            <Text
              style={{ fontSize: 16, marginBottom: 10, fontWeight: 'bold' }}
            >
              Network Switcher Error
            </Text>
            <Text style={{ marginBottom: 20, color: '#666' }}>
              Theme context not available. Please try again.
            </Text>
            <TouchableOpacity
              style={{
                backgroundColor: '#007AFF',
                padding: 12,
                borderRadius: 8,
                alignItems: 'center',
              }}
              onPress={onClose}
            >
              <Text style={{ color: 'white', fontWeight: '600' }}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    );
  }
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: theme.colors.background,
    },
    content: {
      flexGrow: 1,
      paddingHorizontal: theme.spacing.sm,
      paddingVertical: theme.spacing.sm,
    },
    section: {
      backgroundColor: theme.colors.card,
      borderRadius: 15,
      marginBottom: 20,
      overflow: 'hidden',
    },
    sectionTitle: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.textMuted,
      paddingHorizontal: 20,
      paddingVertical: 15,
      backgroundColor: theme.colors.surface,
    },
    settingItem: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingHorizontal: 20,
      paddingVertical: 15,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.borderLight,
    },
    settingText: {
      fontSize: 16,
      color: theme.colors.text,
    },
    arrow: {
      fontSize: 18,
      color: theme.colors.textMuted,
    },
    switchSettingItem: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingHorizontal: 20,
      paddingVertical: 15,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.borderLight,
    },
    disabledText: {
      color: theme.colors.textMuted,
    },
    dangerSection: {
      backgroundColor: theme.colors.card,
      borderRadius: 15,
      overflow: 'hidden',
      marginBottom: theme.spacing.md,
    },
    dangerItem: {
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.md,
    },
    dangerText: {
      fontSize: 16,
      color: theme.colors.error,
      textAlign: 'center',
      fontWeight: '500',
    },
    networkSettingContent: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    networkInfo: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    networkStatusIndicator: {
      width: 8,
      height: 8,
      borderRadius: 4,
    },
    themeDisplayContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    themeDisplayText: {
      fontSize: 16,
      color: theme.colors.textSecondary,
    },
  });
