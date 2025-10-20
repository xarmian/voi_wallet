import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  Alert,
  ActivityIndicator,
  Switch,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { StackNavigationProp } from '@react-navigation/stack';
import { RouteProp } from '@react-navigation/native';
import * as LocalAuthentication from 'expo-local-authentication';
import { RootStackParamList } from '@/navigation/AppNavigator';
import { MultiAccountWalletService } from '@/services/wallet';
import { AccountSecureStorage } from '@/services/secure';
import {
  AccountType,
  ImportAccountRequest,
  AddWatchAccountRequest,
} from '@/types/wallet';
import {
  ScannedAccount,
  getAccountSecret,
  clearAccountSecret,
  clearAccountSecrets,
} from '@/utils/accountQRParser';
import { useTheme } from '@/contexts/ThemeContext';
import { useThemeColors } from '@/hooks/useThemedStyles';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import KeyboardAwareScrollView from '@/components/common/KeyboardAwareScrollView';

type SecuritySetupScreenNavigationProp = StackNavigationProp<
  RootStackParamList,
  'SecuritySetup'
>;

type SecuritySetupScreenRouteProp = RouteProp<
  RootStackParamList,
  'SecuritySetup'
>;

interface Props {
  navigation: SecuritySetupScreenNavigationProp;
  route: SecuritySetupScreenRouteProp;
}

export default function SecuritySetupScreen({ navigation, route }: Props) {
  const { theme } = useTheme();
  const themeColors = useThemeColors();
  const styles = useThemedStyles(createStyles);
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [biometricAvailable, setBiometricAvailable] = useState(false);
  const [biometricEnabled, setBiometricEnabled] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [setupStep, setSetupStep] = useState('');
  const {
    mnemonic,
    accounts,
    source = 'create',
    accountLabel: initialAccountLabel,
  } = route.params;
  const [accountLabel, setAccountLabel] = useState(initialAccountLabel ?? '');

  React.useEffect(() => {
    checkBiometricAvailability();
  }, []);

  React.useEffect(() => {
    return () => {
      if (accounts) {
        clearAccountSecrets(accounts.map((acc) => acc.secretId));
      }
    };
  }, [accounts]);

  const checkBiometricAvailability = async () => {
    const available = await LocalAuthentication.hasHardwareAsync();
    const enrolled = await LocalAuthentication.isEnrolledAsync();
    setBiometricAvailable(available && enrolled);
  };

  const handleComplete = async () => {
    if (submitting) return;
    if (!pin || pin.length !== 6) {
      Alert.alert('Error', 'PIN must be 6 digits');
      return;
    }

    if (pin !== confirmPin) {
      Alert.alert('Error', 'PINs do not match');
      return;
    }

    try {
      setSubmitting(true);

      // Store PIN first
      setSetupStep('Setting up PIN...');
      await AccountSecureStorage.storePin(pin);

      // Store biometric preference
      setSetupStep('Configuring security...');
      await AccountSecureStorage.setBiometricEnabled(biometricEnabled);

      // Handle different onboarding sources
      if ((source === 'create' || source === 'mnemonic') && mnemonic) {
        // Standard wallet creation flow
        setSetupStep('Creating wallet...');
        const normalizedLabel = accountLabel.trim();
        const importedAccount =
          await MultiAccountWalletService.importStandardAccount({
            type: AccountType.STANDARD,
            mnemonic,
            label: normalizedLabel || 'Main Account',
          });
        console.log('Successfully created account:', importedAccount.address);
      } else if ((source === 'qr' || source === 'watch') && accounts) {
        // QR import or watch account flow - import the scanned accounts
        setSetupStep(
          source === 'qr' ? 'Importing accounts...' : 'Adding watch account...'
        );
        let successCount = 0;
        let failedCount = 0;

        for (const account of accounts) {
          try {
            if (account.type === 'standard') {
              const secret = account.secretId
                ? getAccountSecret(account.secretId)
                : undefined;

              if (!secret || (!secret.mnemonic && !secret.privateKey)) {
                throw new Error('Secure account data unavailable for import');
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
              clearAccountSecret(account.secretId);
            } else {
              const request: AddWatchAccountRequest = {
                type: AccountType.WATCH,
                address: account.address,
                label:
                  account.name ||
                  `Watch Account ${new Date().toLocaleDateString()}`,
              };
              await MultiAccountWalletService.addWatchAccount(request);
            }
            successCount++;
          } catch (error) {
            console.error(
              `Failed to import account ${account.address}:`,
              error
            );
            failedCount++;
          }
        }

        if (failedCount > 0) {
          Alert.alert(
            'Import Warning',
            `${successCount} accounts imported successfully. ${failedCount} accounts failed to import.`
          );
        }
      } else if (source === 'ledger') {
        // Ledger accounts are already imported prior to security setup
        setSetupStep('Saving security preferences...');
      }

      setSetupStep('Finalizing...');
      navigation.navigate('Main');
    } catch (error) {
      console.error('Security setup error:', error);
      Alert.alert(
        'Error',
        'Failed to setup wallet security: ' +
          (error instanceof Error ? error.message : 'Unknown error')
      );
    } finally {
      setSubmitting(false);
      setSetupStep('');
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <KeyboardAwareScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.content}
      >
        <Text style={styles.title}>Security Setup</Text>
        <Text style={styles.subtitle}>
          {source === 'qr'
            ? 'Secure your imported accounts with a PIN and optional biometric authentication'
            : source === 'watch'
              ? 'Secure your watch account with a PIN and optional biometric authentication'
              : source === 'ledger'
                ? 'Secure access to your Ledger accounts with a PIN and optional biometric authentication'
                : 'Secure your wallet with a PIN and optional biometric authentication'}
        </Text>

        {(source === 'create' || source === 'mnemonic') && (
          <View style={styles.inputContainer}>
            <Text style={styles.inputLabel}>Account Name (optional)</Text>
            <TextInput
              style={styles.accountNameInput}
              placeholder="Wallet account name"
              placeholderTextColor={themeColors.placeholder}
              value={accountLabel}
              onChangeText={setAccountLabel}
              returnKeyType="done"
              autoCapitalize="words"
              autoCorrect={false}
            />
          </View>
        )}

        <View style={styles.inputContainer}>
          <Text style={styles.inputLabel}>Create 6-digit PIN</Text>
          <TextInput
            style={styles.pinInput}
            placeholder="Enter PIN"
            placeholderTextColor={themeColors.placeholder}
            value={pin}
            onChangeText={setPin}
            keyboardType="numeric"
            maxLength={6}
            secureTextEntry
          />
        </View>

        <View style={styles.inputContainer}>
          <Text style={styles.inputLabel}>Confirm PIN</Text>
          <TextInput
            style={styles.pinInput}
            placeholder="Confirm PIN"
            placeholderTextColor={themeColors.placeholder}
            value={confirmPin}
            onChangeText={setConfirmPin}
            keyboardType="numeric"
            maxLength={6}
            secureTextEntry
          />
        </View>

        {biometricAvailable && (
          <View style={styles.biometricContainer}>
            <Text style={styles.biometricLabel}>
              Enable Biometric Authentication
            </Text>
            <Switch
              value={biometricEnabled}
              onValueChange={setBiometricEnabled}
              trackColor={{
                false: theme.colors.border,
                true: theme.colors.primary,
              }}
              thumbColor={theme.colors.buttonText}
            />
          </View>
        )}

        <TouchableOpacity
          style={[
            styles.completeButton,
            { opacity: pin && confirmPin && !submitting ? 1 : 0.5 },
          ]}
          onPress={handleComplete}
          disabled={!pin || !confirmPin || submitting}
        >
          {submitting ? (
            <View style={styles.loadingContainer}>
              <ActivityIndicator
                size="small"
                color="white"
                style={styles.loadingSpinner}
              />
              <Text style={styles.completeButtonText}>
                {setupStep || 'Setting up...'}
              </Text>
            </View>
          ) : (
            <Text style={styles.completeButtonText}>Complete Setup</Text>
          )}
        </TouchableOpacity>
      </KeyboardAwareScrollView>
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
      flexGrow: 1,
      paddingHorizontal: theme.spacing.lg,
      paddingVertical: theme.spacing.xxl,
    },
    title: {
      fontSize: 28,
      fontWeight: 'bold',
      color: theme.colors.text,
      marginBottom: theme.spacing.sm,
      textAlign: 'center',
    },
    subtitle: {
      fontSize: 16,
      color: theme.colors.textMuted,
      marginBottom: theme.spacing.xl,
      textAlign: 'center',
      lineHeight: 22,
    },
    inputContainer: {
      marginBottom: theme.spacing.lg,
    },
    inputLabel: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.text,
      marginBottom: theme.spacing.sm,
    },
    accountNameInput: {
      backgroundColor: theme.colors.inputBackground,
      borderRadius: theme.borderRadius.lg,
      padding: theme.spacing.md,
      fontSize: 16,
      borderWidth: 1,
      borderColor: theme.colors.inputBorder,
      color: theme.colors.text,
    },
    pinInput: {
      backgroundColor: theme.colors.inputBackground,
      borderRadius: theme.borderRadius.lg,
      padding: theme.spacing.md,
      fontSize: 18,
      textAlign: 'center',
      borderWidth: 1,
      borderColor: theme.colors.inputBorder,
      color: theme.colors.text,
    },
    biometricContainer: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      backgroundColor: theme.colors.card,
      borderRadius: theme.borderRadius.lg,
      padding: theme.spacing.md,
      marginBottom: theme.spacing.xl,
      borderWidth: 1,
      borderColor: theme.colors.borderLight,
    },
    biometricLabel: {
      fontSize: 16,
      fontWeight: '500',
      color: theme.colors.text,
    },
    completeButton: {
      backgroundColor: theme.colors.success,
      paddingVertical: theme.spacing.md,
      paddingHorizontal: theme.spacing.xl,
      borderRadius: theme.borderRadius.lg,
    },
    completeButtonText: {
      color: theme.colors.buttonText,
      fontSize: 18,
      fontWeight: '600',
      textAlign: 'center',
    },
    loadingContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
    },
    loadingSpinner: {
      marginRight: theme.spacing.sm,
    },
  });
