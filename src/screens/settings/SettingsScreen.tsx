import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Alert,
  ScrollView,
  Pressable,
} from 'react-native';
import Slider from '@react-native-community/slider';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
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
import UniversalHeader from '@/components/common/UniversalHeader';
import AccountListModal from '@/components/account/AccountListModal';
import AddAccountModal from '@/components/account/AddAccountModal';
import RenameAccountModal from '@/components/account/RenameAccountModal';
import DeleteAccountModal from '@/components/account/DeleteAccountModal';
import { isListDeletionProtected } from '@/services/wallet/listDeletionProtection';
import { probeOwnKey } from '@/services/wallet/ownKeyCustody';
import { formatAddress } from '@/utils/address';
import { AccountMetadata, AccountType, isBackupVerified } from '@/types/wallet';
import { useIsCurrentNetworkHealthy } from '@/store/networkStore';
import NetworkIndicator from '@/components/network/NetworkIndicator';
import { useTheme } from '@/contexts/ThemeContext';
import { useThemedStyles, useThemeColors } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import { GlassCard } from '@/components/common/GlassCard';
import { NFTBackground } from '@/components/common/NFTBackground';
import { springConfigs } from '@/utils/animations';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

type SettingsScreenNavigationProp =
  NativeStackNavigationProp<SettingsStackParamList>;

// Reusable settings row component with glass styling
interface SettingsRowProps {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  value?: string;
  onPress: () => void;
  danger?: boolean;
  showChevron?: boolean;
  rightElement?: React.ReactNode;
  disabled?: boolean;
  subtitle?: string;
}

function SettingsRow({
  icon,
  label,
  value,
  onPress,
  danger = false,
  showChevron = true,
  rightElement,
  disabled = false,
  subtitle,
}: SettingsRowProps) {
  const { theme } = useTheme();
  const themeColors = useThemeColors();
  const scale = useSharedValue(1);

  const handlePressIn = useCallback(() => {
    if (disabled) return;
    scale.value = withSpring(0.98, springConfigs.snappy);
  }, [scale, disabled]);

  const handlePressOut = useCallback(() => {
    if (disabled) return;
    scale.value = withSpring(1, springConfigs.snappy);
  }, [scale, disabled]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  // Use a more visible red for danger actions - darker in light mode for contrast
  const dangerColor = theme.mode === 'light' ? '#DC2626' : '#EF4444';
  const textColor = disabled
    ? themeColors.textMuted
    : danger
      ? dangerColor
      : themeColors.text;
  const iconColor = disabled
    ? themeColors.textMuted
    : danger
      ? dangerColor
      : theme.colors.primary;

  return (
    <AnimatedPressable
      onPress={disabled ? undefined : onPress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      disabled={disabled}
      style={[animatedStyle, disabled && { opacity: 0.5 }]}
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
            backgroundColor: disabled
              ? `${themeColors.textMuted}15`
              : danger
                ? `${dangerColor}20`
                : `${theme.colors.primary}15`,
            alignItems: 'center',
            justifyContent: 'center',
            marginRight: theme.spacing.md,
          }}
        >
          <Ionicons name={icon} size={18} color={iconColor} />
        </View>
        <View style={{ flex: 1 }}>
          <Text
            style={{
              fontSize: theme.typography.body.fontSize,
              fontWeight: '600',
              color: textColor,
            }}
          >
            {label}
          </Text>
          {subtitle && (
            <Text
              style={{
                fontSize: theme.typography.caption.fontSize,
                color: themeColors.textMuted,
                marginTop: 2,
              }}
            >
              {subtitle}
            </Text>
          )}
        </View>
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
function SectionHeader({
  title,
  icon,
}: {
  title: string;
  icon: keyof typeof Ionicons.glyphMap;
}) {
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

const deletionErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : 'Failed to delete the account.';

export default function SettingsScreen() {
  const navigation = useNavigation<SettingsScreenNavigationProp>();
  const activeAccount = useActiveAccount();
  const [phraseAccess, setPhraseAccess] = useState<{
    account: AccountMetadata;
    available: boolean;
  } | null>(null);
  // Revealing the phrase needs the key present now: originalOwner can outlive
  // it, and a probe error is not custody (TASK-425 U4).
  useEffect(() => {
    if (activeAccount?.type !== AccountType.REKEYED) return;
    let cancelled = false;
    void probeOwnKey(activeAccount).then((holding) => {
      if (!cancelled)
        setPhraseAccess({
          account: activeAccount,
          available: holding === 'present',
        });
    });
    return () => {
      cancelled = true;
    };
  }, [activeAccount]);
  const canShowPhrase =
    activeAccount?.type === AccountType.STANDARD ||
    (activeAccount?.type === AccountType.REKEYED &&
      phraseAccess?.account === activeAccount &&
      phraseAccess.available);
  const deletionBusy = useRef(false);
  // Latches one confirmation: rapid taps on the modal's button run it once.
  const deletionConfirming = useRef(false);
  const [deletionTarget, setDeletionTarget] = useState<AccountMetadata | null>(
    null
  );
  const accounts = useAccounts();
  const deleteAccount = useWalletStore((state) => state.deleteAccount);
  const updateAccountLabel = useWalletStore(
    (state) => state.updateAccountLabel
  );
  const walletSettings = useWalletSettings();
  const isNetworkHealthy = useIsCurrentNetworkHealthy();
  const {
    theme,
    themeMode,
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
    return (
      options.find((option) => option.value === currentLocaleValue)?.label ??
      'System Default'
    );
  })();

  const getAccountDisplayName = (account: AccountMetadata) =>
    account.label?.trim() || formatAddress(account.address);

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

    // No type gate: a WATCH record can be rekeyed to a key we hold, and
    // authority is per network, so the rekey screen's validation decides it
    // for the network chosen there (TASK-425 U3).
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

  const handleShowRecoveryPhrase = (account = activeAccount) => {
    if (!account) {
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
              accountAddress: account.address,
            });
          },
        },
      ]
    );
  };

  const handleSecuritySettings = () => {
    navigation.navigate('SecuritySettings');
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
    navigation.navigate('NetworkSettings');
  };

  const cancelDeletion = () => {
    deletionBusy.current = false;
    deletionConfirming.current = false;
    setDeletionTarget(null);
  };

  const confirmDeletion = async (
    target: AccountMetadata,
    keyHolding: boolean
  ) => {
    if (deletionConfirming.current) return;
    deletionConfirming.current = true;
    const current = () =>
      useWalletStore
        .getState()
        .wallet?.accounts.find((a) => a.id === target.id);
    const checked = current();
    // A formerly keyless account may have acquired a key while the alert was open.
    const gainedKey =
      !keyHolding && checked && (await isListDeletionProtected(checked));
    if (
      !checked ||
      checked.address !== target.address ||
      checked.type !== target.type ||
      current() !== checked ||
      gainedKey
    ) {
      cancelDeletion();
      Alert.alert(
        'Account not deleted',
        'This account was removed or changed while you were confirming. Please start again.'
      );
      return;
    }
    setDeletionTarget(null);
    // Computed outside the try: the React Compiler can't lower these
    // expressions inside a try block.
    const accountName = target.label?.trim() || formatAddress(target.address);
    try {
      await deleteAccount(target.id, {
        address: target.address,
        type: target.type,
        keyless: !keyHolding,
      });
      Alert.alert('Account Deleted', `${accountName} has been removed.`);
    } catch (error) {
      Alert.alert('Delete Failed', deletionErrorMessage(error));
    }
    cancelDeletion();
  };

  // Every deletion entry point (the Settings row, the keyless confirm, the
  // typed-confirm modal) ends here on an unexpected throw: reset the busy ref
  // and latch so Delete never goes dead, and tell the user. A promise catch,
  // not try/finally, which the React Compiler can't lower.
  const failDeletion = () => {
    cancelDeletion();
    Alert.alert('Delete Failed', 'Something went wrong. Please try again.');
  };

  const runDeletion = (target: AccountMetadata, keyHolding: boolean) => {
    void confirmDeletion(target, keyHolding).catch(failDeletion);
  };

  const handleDeleteActiveAccount = async () => {
    if (deletionBusy.current) return;
    if (!activeAccount) {
      Alert.alert('No Active Account', 'Please select an account to delete.');
      return;
    }
    deletionBusy.current = true;
    const target = { ...activeAccount };
    const accountName = target.label?.trim() || formatAddress(target.address);
    const phraseAvailable = canShowPhrase;
    const keyHolding = await isListDeletionProtected(target);
    if (keyHolding) {
      Alert.alert(
        'Back up your recovery phrase first',
        `Deleting ${accountName} removes its private key from this device. Without its 25-word recovery phrase, you'll permanently lose access to this account.` +
          (isBackupVerified(target)
            ? ''
            : " You haven't confirmed a backup of this phrase yet."),
        [
          { text: 'Cancel', style: 'cancel', onPress: cancelDeletion },
          ...(phraseAvailable
            ? [
                {
                  text: 'Show recovery phrase',
                  onPress: () => {
                    cancelDeletion();
                    handleShowRecoveryPhrase(target);
                  },
                },
              ]
            : []),
          {
            text: 'I have my phrase',
            onPress: () => setDeletionTarget(target),
          },
        ],
        { cancelable: true, onDismiss: cancelDeletion }
      );
    } else {
      Alert.alert(
        'Delete Account',
        `Are you sure you want to delete ${accountName}? This action cannot be undone.`,
        [
          { text: 'Cancel', style: 'cancel', onPress: cancelDeletion },
          {
            text: 'Delete',
            style: 'destructive',
            onPress: () => runDeletion(target, false),
          },
        ],
        { cancelable: true, onDismiss: cancelDeletion }
      );
    }
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
    navigation.navigate('ThemeSettings');
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
    navigation.navigate('NumberFormatSettings');
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
              onPress={() => handleShowRecoveryPhrase()}
              disabled={!canShowPhrase}
              subtitle={
                !canShowPhrase
                  ? 'Not available for this account type'
                  : undefined
              }
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
          <GlassCard
            variant="light"
            style={styles.dangerSection}
            padding="none"
          >
            <SettingsRow
              icon="trash-outline"
              label={
                activeAccount
                  ? `Delete "${activeAccount.label?.trim() || formatAddress(activeAccount.address)}"`
                  : 'Delete Account'
              }
              onPress={() =>
                void handleDeleteActiveAccount().catch(failDeletion)
              }
              danger
              showChevron={false}
            />
          </GlassCard>
        </ScrollView>

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

        {deletionTarget && (
          <DeleteAccountModal
            accountName={
              deletionTarget.label?.trim() ||
              formatAddress(deletionTarget.address)
            }
            onCancel={cancelDeletion}
            onConfirm={() => runDeletion(deletionTarget, true)}
          />
        )}
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
      </SafeAreaView>
    </NFTBackground>
  );
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
