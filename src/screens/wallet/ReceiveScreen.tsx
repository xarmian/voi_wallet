import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Alert,
  Share,
  ActivityIndicator,
  ScrollView,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  useRoute,
  useNavigation,
  CommonActions,
} from '@react-navigation/native';
import QRCode from 'react-native-qrcode-svg';
import { Ionicons } from '@expo/vector-icons';
import { useThemedStyles, useThemeColors } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import { useTheme } from '@/contexts/ThemeContext';
import { useActiveAccount, useActiveAccountBalance } from '@/store/walletStore';
import { formatVoiBalance } from '@/utils/bigint';
import AccountSelector from '@/components/account/AccountSelector';
import AccountListModal from '@/components/account/AccountListModal';
import AddAccountModal from '@/components/account/AddAccountModal';
import UniversalHeader from '@/components/common/UniversalHeader';
import { NFTBackground } from '@/components/common/NFTBackground';
import { GlassCard } from '@/components/common/GlassCard';
import { GlassButton } from '@/components/common/GlassButton';

interface ReceiveScreenRouteParams {
  assetName?: string;
  assetId?: number;
  accountId?: string;
}

export default function ReceiveScreen() {
  const styles = useThemedStyles(createStyles);
  const themeColors = useThemeColors();
  const navigation = useNavigation();
  const [isAccountModalVisible, setIsAccountModalVisible] = useState(false);
  const [isAddAccountModalVisible, setIsAddAccountModalVisible] =
    useState(false);

  const route = useRoute();
  const routeParams = route.params as ReceiveScreenRouteParams | undefined;
  const contextAssetName = routeParams?.assetName;
  const contextAssetId = routeParams?.assetId;

  const activeAccount = useActiveAccount();
  const activeAccountBalance = useActiveAccountBalance();

  // Extract values without destructuring to avoid infinite loops
  const accountBalance = activeAccountBalance.balance;
  const isLoading = activeAccountBalance.isLoading;
  const reloadBalance = activeAccountBalance.reload;

  // Removed problematic useEffect that was causing infinite balance reloading

  const copyAddress = async () => {
    if (activeAccount) {
      try {
        await Clipboard.setStringAsync(activeAccount.address);
        Alert.alert('Copied!', 'Address copied to clipboard');
      } catch (error) {
        console.error('Failed to copy address:', error);
        Alert.alert('Error', 'Failed to copy address');
      }
    }
  };

  const shareAddress = async () => {
    if (activeAccount) {
      try {
        await Share.share({
          message: `My Voi wallet address: ${activeAccount.address}`,
          title: 'Voi Wallet Address',
        });
      } catch (error) {
        console.error('Failed to share address:', error);
        Alert.alert('Error', 'Failed to share address');
      }
    }
  };

  const formatBalance = (amount: number | bigint) => {
    return formatVoiBalance(amount);
  };

  if (isLoading) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={themeColors.primary} />
          <Text style={styles.loadingText}>Loading wallet...</Text>
        </View>
      </SafeAreaView>
    );
  }

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

  const { theme } = useTheme();

  return (
    <NFTBackground>
      <SafeAreaView style={styles.container} edges={['top']}>
        <UniversalHeader
          title={contextAssetName ? `Receive ${contextAssetName}` : 'Receive VOI'}
          onAccountSelectorPress={handleAccountSelectorPress}
          showBackButton={true}
          onBackPress={() => navigation.goBack()}
        />

        <ScrollView
          style={styles.scrollView}
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {accountBalance && (
            <GlassCard variant="light" style={styles.balanceContainer}>
              <Text style={[styles.balanceLabel, { color: theme.colors.textSecondary }]}>
                Current Balance
              </Text>
              <Text style={[styles.balanceAmount, { color: theme.colors.text }]}>
                {formatBalance(accountBalance.amount)} VOI
              </Text>
            </GlassCard>
          )}

          {activeAccount && (
            <>
              <GlassCard variant="medium" style={styles.qrContainer} borderGlow>
                <QRCode
                  value={activeAccount.address}
                  size={180}
                  backgroundColor="white"
                  color="#000000"
                />
              </GlassCard>

              <View style={styles.addressContainer}>
                <Text style={[styles.addressLabel, { color: theme.colors.text }]}>
                  Your Address
                </Text>
                <GlassCard
                  variant="light"
                  style={styles.addressBox}
                  onPress={copyAddress}
                >
                  <Text style={[styles.address, { color: theme.colors.text }]}>
                    {activeAccount.address}
                  </Text>
                  <View style={styles.tapToCopyContainer}>
                    <Ionicons name="copy-outline" size={14} color={theme.colors.primary} />
                    <Text style={[styles.tapToCopy, { color: theme.colors.primary }]}>
                      Tap to copy
                    </Text>
                  </View>
                </GlassCard>
              </View>

              <View style={styles.buttonContainer}>
                <GlassButton
                  variant="primary"
                  label="Copy Address"
                  icon="copy-outline"
                  onPress={copyAddress}
                  style={styles.actionButton}
                />
                <GlassButton
                  variant="secondary"
                  label="Share Address"
                  icon="share-outline"
                  onPress={shareAddress}
                  style={styles.actionButton}
                />
              </View>
            </>
          )}
        </ScrollView>

        {/* Account List Modal */}
        <AccountListModal
          isVisible={isAccountModalVisible}
          onClose={handleAccountModalClose}
          onAddAccount={handleAddAccount}
        />
        {/* Add Account Modal */}
        <AddAccountModal
          isVisible={isAddAccountModalVisible}
          onClose={() => setIsAddAccountModalVisible(false)}
          onCreateAccount={() => {
            setIsAddAccountModalVisible(false);
            navigation.dispatch(
              CommonActions.navigate({
                name: 'Settings',
                params: {
                  screen: 'CreateAccount',
                },
              })
            );
          }}
          onImportAccount={() => {
            setIsAddAccountModalVisible(false);
            navigation.dispatch(
              CommonActions.navigate({
                name: 'Settings',
                params: {
                  screen: 'MnemonicImport',
                },
              })
            );
          }}
          onImportLedgerAccount={() => {
            setIsAddAccountModalVisible(false);
            navigation.navigate('LedgerAccountImport' as never);
          }}
          onImportQRAccount={() => {
            setIsAddAccountModalVisible(false);
            navigation.navigate('QRAccountImport' as never);
          }}
          onAddWatchAccount={() => {
            setIsAddAccountModalVisible(false);
            navigation.navigate(
              'Settings' as never,
              { screen: 'AddWatchAccount' } as never
            );
          }}
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
    content: {
      paddingHorizontal: theme.spacing.lg,
      paddingVertical: theme.spacing.xl,
      alignItems: 'center',
      minHeight: '100%',
    },
    loadingContainer: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
    },
    loadingText: {
      fontSize: 16,
      color: theme.colors.textSecondary,
      marginTop: theme.spacing.sm,
    },
    balanceContainer: {
      marginBottom: theme.spacing.lg,
      alignItems: 'center',
      width: '100%',
      borderRadius: theme.borderRadius.xl,
    },
    balanceLabel: {
      fontSize: theme.typography.caption.fontSize,
      marginBottom: theme.spacing.xs,
      // Text shadow for readability over NFT backgrounds
      textShadowColor: theme.mode === 'dark'
        ? 'rgba(0, 0, 0, 0.8)'
        : 'rgba(255, 255, 255, 0.9)',
      textShadowOffset: { width: 0, height: 0 },
      textShadowRadius: 10,
    },
    balanceAmount: {
      fontSize: theme.typography.heading2.fontSize,
      fontWeight: '700',
    },
    qrContainer: {
      borderRadius: theme.borderRadius.xxl,
      padding: theme.spacing.xl,
      marginBottom: theme.spacing.xl,
      alignItems: 'center',
    },
    addressContainer: {
      width: '100%',
      marginBottom: theme.spacing.xl,
    },
    addressLabel: {
      fontSize: theme.typography.body.fontSize,
      fontWeight: '600',
      marginBottom: theme.spacing.sm,
      textAlign: 'center',
      // Text shadow for readability over NFT backgrounds
      textShadowColor: theme.mode === 'dark'
        ? 'rgba(0, 0, 0, 0.8)'
        : 'rgba(255, 255, 255, 0.9)',
      textShadowOffset: { width: 0, height: 0 },
      textShadowRadius: 10,
    },
    addressBox: {
      borderRadius: theme.borderRadius.xl,
    },
    address: {
      fontSize: 13,
      textAlign: 'center',
      fontFamily: 'monospace',
      lineHeight: 20,
      marginBottom: theme.spacing.sm,
    },
    tapToCopyContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 4,
    },
    tapToCopy: {
      fontSize: 12,
      textAlign: 'center',
      fontWeight: '500',
    },
    buttonContainer: {
      width: '100%',
      flexDirection: 'row',
      justifyContent: 'space-between',
      gap: theme.spacing.md,
    },
    actionButton: {
      flex: 1,
    },
  });
