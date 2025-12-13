/**
 * AirgapHomeScreen - Dedicated home screen for airgap/signer mode
 *
 * A minimal, offline-first home screen for devices operating in signer mode.
 * No network requests, no balance display - focused purely on transaction signing.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import Animated, {
  FadeIn,
  FadeInDown,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { useThemedStyles, useThemeColors } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import { useTheme } from '@/contexts/ThemeContext';
import { GlassCard } from '@/components/common/GlassCard';
import { GlassButton } from '@/components/common/GlassButton';
import { NFTBackground } from '@/components/common/NFTBackground';
import AccountListModal from '@/components/account/AccountListModal';
import AddAccountModal from '@/components/account/AddAccountModal';
import AccountAvatar from '@/components/account/AccountAvatar';
import { useSignableAccounts, useActiveAccount, useWalletStore } from '@/store/walletStore';
import { AccountMetadata, AccountType } from '@/types/wallet';

type AirgapStackParamList = {
  AirgapHome: undefined;
  ExportAccounts: undefined;
  SignRequestScanner: undefined;
  SettingsMain: undefined;
};

type NavigationProp = NativeStackNavigationProp<AirgapStackParamList>;

export default function AirgapHomeScreen() {
  const navigation = useNavigation<NavigationProp>();
  const styles = useThemedStyles(createStyles);
  const colors = useThemeColors();
  const { theme } = useTheme();

  // State
  const [isAccountListVisible, setIsAccountListVisible] = useState(false);
  const [isAddAccountVisible, setIsAddAccountVisible] = useState(false);

  // Store data - only signable accounts (STANDARD, LEDGER)
  const signableAccounts = useSignableAccounts();
  const activeAccount = useActiveAccount();
  const initialize = useWalletStore((state) => state.initialize);
  const isWalletInitialized = useWalletStore((state) => state.isInitialized);

  // Initialize wallet store on mount (loads accounts from storage)
  useEffect(() => {
    if (!isWalletInitialized) {
      initialize();
    }
  }, [isWalletInitialized, initialize]);

  // Animation for the shield icon
  const iconPulse = useSharedValue(1);

  useEffect(() => {
    iconPulse.value = withRepeat(
      withSequence(
        withTiming(1.08, { duration: 1500 }),
        withTiming(1, { duration: 1500 })
      ),
      -1,
      true
    );
  }, [iconPulse]);

  const iconAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: iconPulse.value }],
  }));

  // Handlers
  const handleScanSigningRequest = useCallback(() => {
    navigation.navigate('SignRequestScanner');
  }, [navigation]);

  const handleExportAccounts = useCallback(() => {
    navigation.navigate('ExportAccounts');
  }, [navigation]);

  const handleOpenSettings = useCallback(() => {
    // Navigate to settings tab
    (navigation as any).navigate('Settings', { screen: 'SettingsMain' });
  }, [navigation]);
  const handleEditAccount = useCallback((accountId: string) => {
    // For now, just close the modal - edit functionality can be accessed via Settings
    setIsAccountListVisible(false);
  }, []);

  const handleAddAccountOption = useCallback(
    (type: 'create' | 'import' | 'ledger' | 'qr') => {
      setIsAddAccountVisible(false);
      // Navigate to appropriate screen based on type
      switch (type) {
        case 'create':
          (navigation as any).navigate('CreateAccount');
          break;
        case 'import':
          (navigation as any).navigate('ImportAccount');
          break;
        case 'ledger':
          (navigation as any).navigate('LedgerAccountImport');
          break;
        case 'qr':
          (navigation as any).navigate('QRImportScanner');
          break;
      }
    },
    [navigation]
  );

  // Format address for display
  const formatAddress = (address: string) => {
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
  };

  // Get account type label
  const getAccountTypeLabel = (type: AccountType) => {
    switch (type) {
      case AccountType.LEDGER:
        return 'Ledger';
      default:
        return null;
    }
  };

  // Render account list item (non-selectable, just for display)
  const renderAccountItem = useCallback(
    ({ item, index }: { item: AccountMetadata; index: number }) => {
      const typeLabel = getAccountTypeLabel(item.type);

      return (
        <Animated.View key={item.id} entering={FadeInDown.delay(100 + index * 50).springify()}>
          <View style={styles.accountItem}>
            <AccountAvatar
              address={item.address}
              size={40}
              account={item}
            />
            <View style={styles.accountInfo}>
              <View style={styles.accountNameRow}>
                <Text style={styles.accountName} numberOfLines={1}>
                  {item.label || 'Account'}
                </Text>
                {typeLabel && <Text style={styles.accountTypeLabel}>{typeLabel}</Text>}
              </View>
              <Text style={styles.accountAddress}>{formatAddress(item.address)}</Text>
            </View>
          </View>
        </Animated.View>
      );
    },
    [styles]
  );

  return (
    <NFTBackground>
      <SafeAreaView style={styles.container} edges={['top']}>
        <ScrollView
          style={styles.scrollView}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          {/* Header with account selector */}
          <Animated.View entering={FadeIn.duration(300)} style={styles.header}>
            <View style={styles.headerContent}>
              <Text style={styles.headerTitle}>Voi Signer</Text>
              <Text style={styles.headerSubtitle}>Air-gapped Signing Device</Text>
            </View>
            <TouchableOpacity
              style={styles.accountButton}
              onPress={() => setIsAccountListVisible(true)}
            >
              {activeAccount ? (
                <AccountAvatar
                  address={activeAccount.address}
                  size={36}
                  account={activeAccount}
                />
              ) : (
                <View style={styles.accountButtonPlaceholder}>
                  <Ionicons name="person-outline" size={20} color={colors.textMuted} />
                </View>
              )}
            </TouchableOpacity>
          </Animated.View>

          {/* Hero section - Mode indicator */}
          <Animated.View entering={FadeInDown.delay(100).springify()}>
            <GlassCard variant="medium" borderGlow glowColor={colors.warning} padding="lg">
              <View style={styles.heroContent}>
                <Animated.View style={[styles.heroIconContainer, iconAnimatedStyle]}>
                  <Ionicons name="shield-checkmark" size={48} color={colors.warning} />
                </Animated.View>
                <Text style={styles.heroTitle}>Air-gapped Signer</Text>
                <Text style={styles.heroSubtitle}>
                  Offline transaction signing device.{'\n'}
                  Keep this device disconnected from the internet.
                </Text>
              </View>
            </GlassCard>
          </Animated.View>

          {/* Primary action - Scan Signing Request */}
          <Animated.View entering={FadeInDown.delay(200).springify()}>
            <GlassButton
              variant="primary"
              size="lg"
              icon="scan-outline"
              label="Scan Signing Request"
              onPress={handleScanSigningRequest}
              fullWidth
              glow
              style={styles.primaryButton}
            />
          </Animated.View>

          {/* Secondary actions */}
          <Animated.View
            entering={FadeInDown.delay(300).springify()}
            style={styles.secondaryActions}
          >
            <View style={styles.secondaryButtonWrapper}>
              <GlassButton
                variant="secondary"
                size="md"
                icon="share-outline"
                label="Export Accounts"
                onPress={handleExportAccounts}
                fullWidth
              />
            </View>
            <View style={styles.secondaryButtonWrapper}>
              <GlassButton
                variant="secondary"
                size="md"
                icon="settings-outline"
                label="Settings"
                onPress={handleOpenSettings}
                fullWidth
              />
            </View>
          </Animated.View>

          {/* Signable accounts section */}
          <Animated.View entering={FadeInDown.delay(400).springify()}>
            <GlassCard variant="light" padding="md">
              <View style={styles.accountsHeader}>
                <Text style={styles.accountsTitle}>
                  Signing Accounts ({signableAccounts.length})
                </Text>
                <TouchableOpacity
                  style={styles.addAccountButton}
                  onPress={() => setIsAddAccountVisible(true)}
                >
                  <Ionicons name="add" size={18} color={colors.buttonText} />
                  <Text style={styles.addAccountText}>Add</Text>
                </TouchableOpacity>
              </View>

              {signableAccounts.length === 0 ? (
                <View style={styles.emptyState}>
                  <Ionicons
                    name="wallet-outline"
                    size={48}
                    color={colors.textMuted}
                    style={styles.emptyIcon}
                  />
                  <Text style={styles.emptyTitle}>No Signable Accounts</Text>
                  <Text style={styles.emptySubtitle}>
                    Create or import an account to use this device for signing.
                  </Text>
                </View>
              ) : (
                <View style={styles.accountsList}>
                  {signableAccounts.map((account, index) =>
                    renderAccountItem({ item: account, index })
                  )}
                </View>
              )}
            </GlassCard>
          </Animated.View>

          {/* Info card */}
          <Animated.View entering={FadeInDown.delay(500).springify()}>
            <View style={styles.infoCard}>
              <Ionicons name="information-circle-outline" size={20} color={colors.textMuted} />
              <Text style={styles.infoText}>
                This device operates offline. Scan QR codes from your online wallet to sign
                transactions securely.
              </Text>
            </View>
          </Animated.View>
        </ScrollView>

        {/* Account List Modal */}
        <AccountListModal
          isVisible={isAccountListVisible}
          onClose={() => setIsAccountListVisible(false)}
          onAddAccount={() => {
            setIsAccountListVisible(false);
            setIsAddAccountVisible(true);
          }}
          onEditAccount={handleEditAccount}
          onAccountSelect={() => setIsAccountListVisible(false)}
          filterSignable
          hideBalances
        />

        {/* Add Account Modal */}
        <AddAccountModal
          isVisible={isAddAccountVisible}
          onClose={() => setIsAddAccountVisible(false)}
          onCreateAccount={() => handleAddAccountOption('create')}
          onImportAccount={() => handleAddAccountOption('import')}
          onImportQRAccount={() => handleAddAccountOption('qr')}
          onAddWatchAccount={() => {}}
          onImportLedgerAccount={() => handleAddAccountOption('ledger')}
          airgapMode
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
    scrollView: {
      flex: 1,
    },
    scrollContent: {
      padding: theme.spacing.lg,
      gap: theme.spacing.lg,
    },
    header: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
    },
    headerContent: {
      flex: 1,
    },
    headerTitle: {
      fontSize: 28,
      fontWeight: '700',
      color: theme.colors.text,
    },
    headerSubtitle: {
      fontSize: 14,
      color: theme.colors.textSecondary,
      marginTop: 2,
    },
    accountButton: {
      padding: 4,
    },
    accountButtonPlaceholder: {
      width: 36,
      height: 36,
      borderRadius: 18,
      backgroundColor: theme.glass.light.backgroundColor,
      borderWidth: 1,
      borderColor: theme.colors.glassBorder,
      justifyContent: 'center',
      alignItems: 'center',
    },
    heroContent: {
      alignItems: 'center',
      paddingVertical: theme.spacing.md,
    },
    heroIconContainer: {
      width: 88,
      height: 88,
      borderRadius: 44,
      backgroundColor: theme.colors.warning + '20',
      justifyContent: 'center',
      alignItems: 'center',
      marginBottom: theme.spacing.md,
    },
    heroTitle: {
      fontSize: 24,
      fontWeight: '700',
      color: theme.colors.text,
      marginBottom: theme.spacing.sm,
    },
    heroSubtitle: {
      fontSize: 15,
      color: theme.colors.textSecondary,
      textAlign: 'center',
      lineHeight: 22,
    },
    primaryButton: {
      marginTop: theme.spacing.sm,
    },
    secondaryActions: {
      flexDirection: 'row',
      gap: theme.spacing.md,
    },
    secondaryButtonWrapper: {
      flex: 1,
      flexBasis: 0,
      borderRadius: theme.borderRadius.lg,
      backgroundColor:
        theme.mode === 'dark'
          ? 'rgba(40, 40, 50, 0.9)'
          : 'rgba(255, 255, 255, 0.85)',
      overflow: 'hidden',
    },
    accountsHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: theme.spacing.md,
    },
    accountsTitle: {
      fontSize: 17,
      fontWeight: '600',
      color: theme.colors.text,
    },
    addAccountButton: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: theme.colors.primary,
      borderRadius: theme.borderRadius.pill,
      paddingVertical: theme.spacing.xs + 2,
      paddingHorizontal: theme.spacing.sm + 2,
      gap: theme.spacing.xs,
    },
    addAccountText: {
      color: theme.colors.buttonText,
      fontSize: 13,
      fontWeight: '600',
    },
    accountsList: {
      gap: theme.spacing.sm,
    },
    accountItem: {
      flexDirection: 'row',
      alignItems: 'center',
      padding: theme.spacing.sm + 2,
      borderRadius: theme.borderRadius.lg,
      backgroundColor:
        theme.mode === 'dark'
          ? 'rgba(50, 50, 60, 0.95)'
          : 'rgba(255, 255, 255, 0.8)',
      borderWidth: 1,
      borderColor:
        theme.mode === 'dark'
          ? 'rgba(255, 255, 255, 0.15)'
          : theme.colors.glassBorder,
    },
    accountInfo: {
      flex: 1,
      marginLeft: theme.spacing.sm + 2,
      marginRight: theme.spacing.sm,
    },
    accountNameRow: {
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: 2,
    },
    accountName: {
      fontSize: 15,
      fontWeight: '500',
      color: theme.colors.text,
    },
    accountTypeLabel: {
      fontSize: 11,
      fontWeight: '500',
      color: theme.colors.textMuted,
      backgroundColor: theme.colors.surface,
      paddingHorizontal: 6,
      paddingVertical: 2,
      borderRadius: theme.borderRadius.sm,
      marginLeft: theme.spacing.sm,
    },
    accountAddress: {
      fontSize: 12,
      fontFamily: 'monospace',
      color: theme.colors.textMuted,
    },
    emptyState: {
      alignItems: 'center',
      paddingVertical: theme.spacing.xl,
    },
    emptyIcon: {
      marginBottom: theme.spacing.md,
      opacity: 0.5,
    },
    emptyTitle: {
      fontSize: 17,
      fontWeight: '600',
      color: theme.colors.text,
      marginBottom: theme.spacing.xs,
    },
    emptySubtitle: {
      fontSize: 14,
      color: theme.colors.textSecondary,
      textAlign: 'center',
      lineHeight: 20,
    },
    infoCard: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      padding: theme.spacing.md,
      backgroundColor: theme.glass.light.backgroundColor,
      borderRadius: theme.borderRadius.lg,
      borderWidth: 1,
      borderColor: theme.colors.glassBorder,
      gap: theme.spacing.sm,
    },
    infoText: {
      flex: 1,
      fontSize: 13,
      color: theme.colors.textSecondary,
      lineHeight: 18,
    },
  });
