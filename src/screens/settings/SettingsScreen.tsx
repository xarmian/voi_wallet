import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Alert,
  ScrollView,
  Modal,
  Pressable,
} from 'react-native';
import Slider from '@react-native-community/slider';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { StackNavigationProp } from '@react-navigation/stack';
import { Ionicons } from '@expo/vector-icons';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
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
import NFTThemeSelector from '@/components/common/NFTThemeSelector';
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
import { useThemedStyles, useThemeColors } from '@/hooks/useThemedStyles';
import { Theme, ThemeMode } from '@/constants/themes';
import { GlassCard } from '@/components/common/GlassCard';
import { NFTBackground } from '@/components/common/NFTBackground';
import { springConfigs } from '@/utils/animations';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

type SettingsScreenNavigationProp = StackNavigationProp<SettingsStackParamList>;

// Reusable settings row component with glass styling
interface SettingsRowProps {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  value?: string;
  onPress: () => void;
  danger?: boolean;
  showChevron?: boolean;
  rightElement?: React.ReactNode;
}

function SettingsRow({
  icon,
  label,
  value,
  onPress,
  danger = false,
  showChevron = true,
  rightElement,
}: SettingsRowProps) {
  const { theme } = useTheme();
  const themeColors = useThemeColors();
  const scale = useSharedValue(1);

  const handlePressIn = useCallback(() => {
    scale.value = withSpring(0.98, springConfigs.snappy);
  }, [scale]);

  const handlePressOut = useCallback(() => {
    scale.value = withSpring(1, springConfigs.snappy);
  }, [scale]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  // Use a more visible red for danger actions - darker in light mode for contrast
  const dangerColor = theme.mode === 'light' ? '#DC2626' : '#EF4444';
  const textColor = danger ? dangerColor : themeColors.text;
  const iconColor = danger ? dangerColor : theme.colors.primary;

  return (
    <AnimatedPressable
      onPress={onPress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      style={animatedStyle}
    >
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          paddingVertical: theme.spacing.md,
          paddingHorizontal: theme.spacing.md,
          borderBottomWidth: 1,
          borderBottomColor: theme.colors.glassBorder,
        }}
      >
        <View
          style={{
            width: 32,
            height: 32,
            borderRadius: theme.borderRadius.sm,
            backgroundColor: danger
              ? `${dangerColor}20`
              : `${theme.colors.primary}15`,
            alignItems: 'center',
            justifyContent: 'center',
            marginRight: theme.spacing.md,
          }}
        >
          <Ionicons name={icon} size={18} color={iconColor} />
        </View>
        <Text
          style={{
            flex: 1,
            fontSize: theme.typography.body.fontSize,
            fontWeight: '600',
            color: textColor,
          }}
        >
          {label}
        </Text>
        {value && (
          <Text
            style={{
              fontSize: theme.typography.bodySmall.fontSize,
              color: themeColors.textMuted,
              marginRight: theme.spacing.sm,
              maxWidth: 150,
            }}
            numberOfLines={1}
          >
            {value}
          </Text>
        )}
        {rightElement}
        {showChevron && (
          <Ionicons
            name="chevron-forward"
            size={18}
            color={themeColors.textMuted}
          />
        )}
      </View>
    </AnimatedPressable>
  );
}

// Section header component
function SectionHeader({ title, icon }: { title: string; icon: keyof typeof Ionicons.glyphMap }) {
  const { theme } = useTheme();
  const themeColors = useThemeColors();

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: theme.spacing.md,
        paddingVertical: theme.spacing.sm,
        backgroundColor: theme.colors.glassBackground,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.glassBorder,
      }}
    >
      <Ionicons
        name={icon}
        size={16}
        color={theme.colors.primary}
        style={{ marginRight: theme.spacing.sm }}
      />
      <Text
        style={{
          fontSize: theme.typography.caption.fontSize,
          fontWeight: '600',
          color: themeColors.textMuted,
          textTransform: 'uppercase',
          letterSpacing: 0.5,
        }}
      >
        {title}
      </Text>
    </View>
  );
}

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
  const {
    theme,
    themeMode,
    setThemeMode,
    nftThemeData,
    nftThemeEnabled,
    nftBackgroundEnabled,
    nftOverlayIntensity,
    setNFTOverlayIntensity,
  } = useTheme();
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
  const [isNFTThemeModalVisible, setIsNFTThemeModalVisible] = useState(false);
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

  const handleRemoteSignerSettings = () => {
    navigation.navigate('RemoteSignerSettings');
  };

  const handleBackupWallet = () => {
    navigation.navigate('BackupWallet');
  };

  const handleRestoreWallet = () => {
    navigation.navigate('RestoreWallet');
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
    let baseTheme = '';
    switch (themeMode) {
      case 'light':
        baseTheme = 'Light';
        break;
      case 'dark':
        baseTheme = 'Dark';
        break;
      case 'system':
        baseTheme = 'System Default';
        break;
      default:
        baseTheme = 'System Default';
    }

    // Append NFT theme info if enabled
    if (nftThemeEnabled && nftThemeData) {
      return `${baseTheme} • ${nftThemeData.nftName || 'NFT Theme'}`;
    }

    return baseTheme;
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

  const handleThemeSelect = (value: ThemeMode) => {
    setThemeMode(value);
  };

  const handleOpenNFTSelector = () => {
    // Close the theme switcher modal first, then open NFT selector
    setIsThemeModalVisible(false);
    // Use setTimeout to ensure the first modal closes before opening the second
    setTimeout(() => {
      setIsNFTThemeModalVisible(true);
    }, 300);
  };

  const handleNFTThemeModalClose = () => {
    setIsNFTThemeModalVisible(false);
    // Reopen the theme modal after NFT selector closes
    setTimeout(() => {
      setIsThemeModalVisible(true);
    }, 300);
  };

  return (
    <NFTBackground>
      <SafeAreaView style={styles.container} edges={['top']}>
        <UniversalHeader
          title="Settings"
          onAccountSelectorPress={handleAccountSelectorPress}
        />
        <ScrollView
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
        >
          {/* Account Section */}
          <GlassCard variant="medium" style={styles.section} padding="none">
            <SectionHeader title="Account" icon="person-outline" />
            <SettingsRow
              icon="pencil-outline"
              label="Rename Account"
              onPress={handleRenameAccountPress}
            />
            <SettingsRow
              icon="key-outline"
              label="Rekey Account"
              onPress={handleRekeyAccountPress}
            />
          </GlassCard>

          {/* Security Section */}
          <GlassCard variant="medium" style={styles.section} padding="none">
            <SectionHeader title="Security" icon="shield-outline" />
            <SettingsRow
              icon="settings-outline"
              label="Security Settings"
              onPress={handleSecuritySettings}
            />
            <SettingsRow
              icon="document-text-outline"
              label="Show Recovery Phrase"
              onPress={handleShowRecoveryPhrase}
            />
            <SettingsRow
              icon="save-outline"
              label="Backup Wallet"
              onPress={handleBackupWallet}
            />
            <SettingsRow
              icon="cloud-download-outline"
              label="Restore from Backup"
              onPress={handleRestoreWallet}
            />
          </GlassCard>

          {/* Network & Connections Section */}
          <GlassCard variant="medium" style={styles.section} padding="none">
            <SectionHeader title="Network & Connections" icon="globe-outline" />
            <SettingsRow
              icon="wifi-outline"
              label="Current Network"
              onPress={handleNetworkPress}
              showChevron={true}
              rightElement={
                <View style={styles.networkInfo}>
                  <NetworkIndicator showName={true} size="small" />
                  <View
                    style={[
                      styles.networkStatusIndicator,
                      {
                        backgroundColor: isNetworkHealthy
                          ? theme.colors.success
                          : theme.colors.error,
                      },
                    ]}
                  />
                </View>
              }
            />
            <SettingsRow
              icon="apps-outline"
              label="Connected dApps"
              onPress={handleWalletConnectSessions}
            />
            <SettingsRow
              icon="qr-code-outline"
              label="Air-gapped Signing"
              onPress={handleRemoteSignerSettings}
            />
          </GlassCard>

          {/* Preferences Section */}
          <GlassCard variant="medium" style={styles.section} padding="none">
            <SectionHeader title="Preferences" icon="options-outline" />
            <SettingsRow
              icon="moon-outline"
              label="Theme"
              value={getThemeDisplayText()}
              onPress={handleThemePress}
            />
            {nftThemeEnabled && nftBackgroundEnabled && (
              <View style={styles.sliderRow}>
                <View style={styles.sliderHeader}>
                  <View style={styles.sliderIconContainer}>
                    <Ionicons
                      name={theme.mode === 'dark' ? 'moon' : 'sunny'}
                      size={18}
                      color={theme.colors.primary}
                    />
                  </View>
                  <Text style={styles.sliderLabel}>Background Dim</Text>
                  <Text style={styles.sliderValue}>
                    {Math.round(nftOverlayIntensity * 100)}%
                  </Text>
                </View>
                <Slider
                  style={styles.slider}
                  minimumValue={0}
                  maximumValue={1}
                  value={nftOverlayIntensity}
                  onValueChange={setNFTOverlayIntensity}
                  minimumTrackTintColor={theme.colors.primary}
                  maximumTrackTintColor={theme.colors.glassBorder}
                  thumbTintColor={theme.colors.primary}
                />
              </View>
            )}
            <SettingsRow
              icon="calculator-outline"
              label="Number Format"
              value={localeDisplayText}
              onPress={handleLocalePress}
            />
            <SettingsRow
              icon="notifications-outline"
              label="Push Notifications"
              onPress={() => navigation.navigate('NotificationSettings')}
            />
            <SettingsRow
              icon="flask-outline"
              label="Experimental Features"
              onPress={() => navigation.navigate('ExperimentalFeatures')}
            />
          </GlassCard>

          {/* About Section */}
          <GlassCard variant="medium" style={styles.section} padding="none">
            <SectionHeader title="About" icon="information-circle-outline" />
            <SettingsRow
              icon="help-circle-outline"
              label="About Voi Wallet"
              onPress={handleAbout}
            />
            <SettingsRow
              icon="document-outline"
              label="Terms of Service"
              onPress={handleTermsOfService}
            />
            <SettingsRow
              icon="lock-closed-outline"
              label="Privacy Policy"
              onPress={handlePrivacyPolicy}
            />
          </GlassCard>

          {/* Danger Zone */}
          <GlassCard variant="light" style={styles.dangerSection} padding="none">
            <SettingsRow
              icon="trash-outline"
              label={
                activeAccount
                  ? `Delete "${activeAccount.label?.trim() || formatAddress(activeAccount.address)}"`
                  : 'Delete Account'
              }
              onPress={handleDeleteActiveAccount}
              danger
              showChevron={false}
            />
          </GlassCard>
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
        onNFTThemeSelect={handleOpenNFTSelector}
        theme={theme}
      />

      <NFTThemeSelector
        visible={isNFTThemeModalVisible}
        onClose={handleNFTThemeModalClose}
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
    </NFTBackground>
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
            <Pressable
              style={{
                backgroundColor: '#007AFF',
                padding: 12,
                borderRadius: 8,
                alignItems: 'center',
              }}
              onPress={onClose}
            >
              <Text style={{ color: 'white', fontWeight: '600' }}>Close</Text>
            </Pressable>
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
    },
    content: {
      flexGrow: 1,
      paddingHorizontal: theme.spacing.md,
      paddingTop: theme.spacing.md,
      paddingBottom: theme.spacing.xxl,
    },
    section: {
      marginBottom: theme.spacing.md,
      borderRadius: theme.borderRadius.xl,
      overflow: 'hidden',
    },
    dangerSection: {
      marginBottom: theme.spacing.xl,
      marginTop: theme.spacing.md,
      borderRadius: theme.borderRadius.xl,
      overflow: 'hidden',
    },
    networkInfo: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.sm,
      marginRight: theme.spacing.sm,
    },
    networkStatusIndicator: {
      width: 8,
      height: 8,
      borderRadius: 4,
    },
    sliderRow: {
      paddingVertical: theme.spacing.md,
      paddingHorizontal: theme.spacing.md,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.glassBorder,
    },
    sliderHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: theme.spacing.sm,
    },
    sliderIconContainer: {
      width: 32,
      height: 32,
      borderRadius: theme.borderRadius.sm,
      backgroundColor: `${theme.colors.primary}15`,
      alignItems: 'center',
      justifyContent: 'center',
      marginRight: theme.spacing.md,
    },
    sliderLabel: {
      flex: 1,
      fontSize: theme.typography.body.fontSize,
      fontWeight: '600',
      color: theme.colors.text,
    },
    sliderValue: {
      fontSize: theme.typography.bodySmall.fontSize,
      color: theme.colors.textMuted,
      minWidth: 40,
      textAlign: 'right',
    },
    slider: {
      width: '100%',
      height: 40,
    },
  });
