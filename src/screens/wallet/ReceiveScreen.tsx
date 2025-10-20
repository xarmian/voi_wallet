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
import { useThemedStyles, useThemeColors } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import { useActiveAccount, useActiveAccountBalance } from '@/store/walletStore';
import { formatVoiBalance } from '@/utils/bigint';
import AccountSelector from '@/components/account/AccountSelector';
import AccountListModal from '@/components/account/AccountListModal';
import AddAccountModal from '@/components/account/AddAccountModal';
import UniversalHeader from '@/components/common/UniversalHeader';

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

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <UniversalHeader
        title={contextAssetName ? `Receive ${contextAssetName}` : 'Receive VOI'}
        subtitle={
          contextAssetName
            ? `Share your address to receive ${contextAssetName}`
            : 'Share your address to receive VOI payments'
        }
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
          <View style={styles.balanceContainer}>
            <Text style={styles.balanceLabel}>Current Balance</Text>
            <Text style={styles.balanceAmount}>
              {formatBalance(accountBalance.amount)} VOI
            </Text>
          </View>
        )}

        {activeAccount && (
          <>
            <View style={styles.qrContainer}>
              <QRCode
                value={activeAccount.address}
                size={180}
                backgroundColor={themeColors.card}
                color={themeColors.text}
              />
            </View>

            <View style={styles.addressContainer}>
              <Text style={styles.addressLabel}>Your Address</Text>
              <TouchableOpacity style={styles.addressBox} onPress={copyAddress}>
                <Text style={styles.address}>{activeAccount.address}</Text>
                <Text style={styles.tapToCopy}>Tap to copy</Text>
              </TouchableOpacity>
            </View>

            <View style={styles.buttonContainer}>
              <TouchableOpacity style={styles.copyButton} onPress={copyAddress}>
                <Text style={styles.buttonText}>Copy Address</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.shareButton}
                onPress={shareAddress}
              >
                <Text style={styles.buttonText}>Share Address</Text>
              </TouchableOpacity>
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
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: theme.colors.background,
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
      backgroundColor: theme.colors.card,
      borderRadius: theme.borderRadius.md,
      padding: theme.spacing.md,
      marginBottom: theme.spacing.lg,
      alignItems: 'center',
      width: '100%',
      ...theme.shadows.sm,
    },
    balanceLabel: {
      fontSize: 14,
      color: theme.colors.textSecondary,
      marginBottom: theme.spacing.xs,
    },
    balanceAmount: {
      fontSize: 18,
      fontWeight: 'bold',
      color: theme.colors.text,
    },
    qrContainer: {
      backgroundColor: theme.colors.card,
      borderRadius: theme.borderRadius.lg,
      padding: theme.spacing.xl,
      marginBottom: theme.spacing.xl,
      alignItems: 'center',
      ...theme.shadows.md,
    },
    addressContainer: {
      width: '100%',
      marginBottom: theme.spacing.xl,
    },
    addressLabel: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.text,
      marginBottom: theme.spacing.sm,
      textAlign: 'center',
    },
    addressBox: {
      backgroundColor: theme.colors.card,
      borderRadius: theme.borderRadius.md,
      padding: theme.spacing.lg,
      borderWidth: 1,
      borderColor: theme.colors.border,
      ...theme.shadows.sm,
    },
    address: {
      fontSize: 14,
      color: theme.colors.text,
      textAlign: 'center',
      fontFamily: 'monospace',
      lineHeight: 20,
      marginBottom: theme.spacing.xs,
    },
    tapToCopy: {
      fontSize: 12,
      color: theme.colors.primary,
      textAlign: 'center',
      fontStyle: 'italic',
    },
    buttonContainer: {
      width: '100%',
      flexDirection: 'row',
      justifyContent: 'space-between',
      gap: theme.spacing.md,
    },
    copyButton: {
      flex: 1,
      backgroundColor: theme.colors.primary,
      paddingVertical: theme.spacing.md,
      borderRadius: theme.borderRadius.md,
      ...theme.shadows.sm,
    },
    shareButton: {
      flex: 1,
      backgroundColor: theme.colors.success,
      paddingVertical: theme.spacing.md,
      borderRadius: theme.borderRadius.md,
      ...theme.shadows.sm,
    },
    buttonText: {
      color: 'white',
      fontSize: 16,
      fontWeight: '600',
      textAlign: 'center',
    },
  });
