import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  Alert,
  ActivityIndicator,
  Switch,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { StackNavigationProp } from '@react-navigation/stack';
import { RouteProp } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
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
import UniversalHeader from '@/components/common/UniversalHeader';
import { NFTBackground } from '@/components/common/NFTBackground';
import { GlassCard } from '@/components/common/GlassCard';
import { GlassButton } from '@/components/common/GlassButton';
import { GlassInput } from '@/components/common/GlassInput';

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
    <NFTBackground>
      <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
        <UniversalHeader
          title="Security Setup"
          showBackButton
          onBackPress={() => navigation.goBack()}
          showAccountSelector={false}
          onAccountSelectorPress={() => {}}
        />
        <KeyboardAwareScrollView
          style={styles.scrollView}
          contentContainerStyle={styles.content}
        >
          <Text style={[styles.subtitle, { color: theme.colors.textMuted }]}>
            {source === 'qr'
              ? 'Secure your imported accounts with a PIN and optional biometric authentication'
              : source === 'watch'
                ? 'Secure your watch account with a PIN and optional biometric authentication'
                : source === 'ledger'
                  ? 'Secure access to your Ledger accounts with a PIN and optional biometric authentication'
                  : 'Secure your wallet with a PIN and optional biometric authentication'}
          </Text>

          <GlassCard variant="medium" style={styles.formCard}>
            {(source === 'create' || source === 'mnemonic') && (
              <GlassInput
                label="Account Name (optional)"
                placeholder="Wallet account name"
                value={accountLabel}
                onChangeText={setAccountLabel}
                returnKeyType="done"
                autoCapitalize="words"
                autoCorrect={false}
                leftIcon="person-outline"
              />
            )}

            <GlassInput
              label="Create 6-digit PIN"
              placeholder="Enter PIN"
              value={pin}
              onChangeText={setPin}
              keyboardType="numeric"
              maxLength={6}
              secureTextEntry
              leftIcon="lock-closed-outline"
            />

            <GlassInput
              label="Confirm PIN"
              placeholder="Confirm PIN"
              value={confirmPin}
              onChangeText={setConfirmPin}
              keyboardType="numeric"
              maxLength={6}
              secureTextEntry
              leftIcon="lock-closed-outline"
            />

            {biometricAvailable && (
              <View style={styles.biometricContainer}>
                <View style={styles.biometricLeft}>
                  <View style={[styles.biometricIcon, { backgroundColor: `${theme.colors.primary}15` }]}>
                    <Ionicons name="finger-print" size={20} color={theme.colors.primary} />
                  </View>
                  <Text style={[styles.biometricLabel, { color: theme.colors.text }]}>
                    Enable Biometric Authentication
                  </Text>
                </View>
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
          </GlassCard>

          <GlassButton
            variant="primary"
            label={submitting ? (setupStep || 'Setting up...') : 'Complete Setup'}
            icon={submitting ? undefined : 'checkmark-circle'}
            loading={submitting}
            disabled={!pin || !confirmPin || submitting}
            onPress={handleComplete}
            fullWidth
            glow
            size="lg"
          />
        </KeyboardAwareScrollView>
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
      flexGrow: 1,
      paddingHorizontal: theme.spacing.lg,
      paddingVertical: theme.spacing.lg,
    },
    subtitle: {
      fontSize: theme.typography.body.fontSize,
      marginBottom: theme.spacing.xl,
      textAlign: 'center',
      lineHeight: 22,
    },
    formCard: {
      borderRadius: theme.borderRadius.xxl,
      marginBottom: theme.spacing.xl,
      gap: theme.spacing.md,
    },
    biometricContainer: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingTop: theme.spacing.md,
      marginTop: theme.spacing.sm,
      borderTopWidth: 1,
      borderTopColor: theme.colors.glassBorder,
    },
    biometricLeft: {
      flexDirection: 'row',
      alignItems: 'center',
      flex: 1,
    },
    biometricIcon: {
      width: 36,
      height: 36,
      borderRadius: theme.borderRadius.md,
      alignItems: 'center',
      justifyContent: 'center',
      marginRight: theme.spacing.md,
    },
    biometricLabel: {
      fontSize: theme.typography.body.fontSize,
      fontWeight: '500',
      flex: 1,
    },
  });
