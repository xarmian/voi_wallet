import React, { useCallback, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Alert,
  TextInput,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { WalletService } from '@/services/wallet';
import { useWalletStore } from '@/store/walletStore';
import { AccountType } from '@/types/wallet';
import MnemonicBackupFlow from '@/components/wallet/MnemonicBackupFlow';
import { useThemedStyles, useThemeColors } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import KeyboardAwareScrollView from '@/components/common/KeyboardAwareScrollView';

export default function CreateAccountScreen() {
  const styles = useThemedStyles(createStyles);
  const themeColors = useThemeColors();
  const navigation = useNavigation();
  const [step, setStep] = useState<'generate' | 'backup'>('generate');
  const [mnemonic, setMnemonic] = useState<string>('');
  const [accountLabel, setAccountLabel] = useState('');
  const importAccount = useWalletStore((state) => state.importAccount);
  const setActiveAccount = useWalletStore((state) => state.setActiveAccount);

  useFocusEffect(
    useCallback(() => {
      const state = navigation.getState() as
        | {
            type?: string;
            index?: number;
            routes?: Array<{ name: string; params?: unknown }>;
          }
        | undefined;

      if (
        state?.type === 'stack' &&
        state.routes?.length === 1 &&
        state.routes[0]?.name === 'CreateAccount'
      ) {
        const currentParams = state.routes[0]?.params as Readonly<object | undefined>;

        navigation.reset({
          index: 1,
          routes: [
            { name: 'SettingsMain' as never },
            { name: 'CreateAccount' as never, params: currentParams },
          ],
        });
      }

      return undefined;
    }, [navigation])
  );

  const generateWallet = () => {
    try {
      const wallet = WalletService.generateWallet();
      setMnemonic(wallet.mnemonic);
      setStep('backup');
    } catch (error) {
      Alert.alert('Error', 'Failed to generate wallet');
    }
  };

  const handleBackupConfirmed = async () => {
    try {
      // Import the account with the generated mnemonic
      const normalizedLabel = accountLabel.trim();

      const newAccount = await importAccount({
        type: AccountType.STANDARD,
        label: normalizedLabel || `Account ${Date.now()}`,
        mnemonic,
      });

      // Set the new account as active
      await setActiveAccount(newAccount.id);

      Alert.alert('Success', 'New account created successfully!', [
        {
          text: 'OK',
          onPress: () => {
            // Navigate to Home tab
            navigation.reset({
              index: 0,
              routes: [
                { name: 'Main' as never, params: { screen: 'Home' } as any },
              ],
            });
          },
        },
      ]);
    } catch (error) {
      console.error('Failed to create account:', error);
      Alert.alert('Error', 'Failed to create new account');
    }
  };

  const handleBack = () => {
    if (step === 'backup') {
      Alert.alert(
        'Warning',
        'If you go back now, you will lose this recovery phrase. Are you sure?',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Go Back',
            style: 'destructive',
            onPress: () => setStep('generate'),
          },
        ]
      );
    } else {
      navigation.goBack();
    }
  };

  if (step === 'backup') {
    return (
      <MnemonicBackupFlow
        mnemonic={mnemonic}
        onBackupConfirmed={handleBackupConfirmed}
        title="Backup New Account"
        subtitle="This is the recovery phrase for your new account. Write it down and store it safely."
        showCopyOption={true}
        requireVerification={false}
        onBack={handleBack}
      />
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backButton} onPress={handleBack}>
          <Ionicons
            name="arrow-back"
            size={24}
            color={themeColors.primary}
          />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Create New Account</Text>
        <View style={styles.placeholder} />
      </View>

      <KeyboardAwareScrollView
        style={styles.scrollContainer}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.iconContainer}>
          <Ionicons name="add-circle" size={80} color={themeColors.primary} />
        </View>

        <Text style={styles.title}>Create New Account</Text>
        <Text style={styles.subtitle}>
          Generate a new account with its own unique recovery phrase. Each
          account has independent assets and transaction history.
        </Text>

        <View style={styles.infoContainer}>
          <View style={styles.infoItem}>
            <Ionicons
              name="shield-checkmark"
              size={24}
              color={themeColors.success}
            />
            <View style={styles.infoTextContainer}>
              <Text style={styles.infoTitle}>Secure Generation</Text>
              <Text style={styles.infoText}>
                Your account will be generated using cryptographically secure
                methods
              </Text>
            </View>
          </View>

          <View style={styles.infoItem}>
            <Ionicons name="key" size={24} color={themeColors.primary} />
            <View style={styles.infoTextContainer}>
              <Text style={styles.infoTitle}>Unique Recovery Phrase</Text>
              <Text style={styles.infoText}>
                You'll receive a unique 25-word recovery phrase for this account
              </Text>
            </View>
          </View>

          <View style={styles.infoItem}>
            <Ionicons name="archive" size={24} color={themeColors.warning} />
            <View style={styles.infoTextContainer}>
              <Text style={styles.infoTitle}>Backup Required</Text>
              <Text style={styles.infoText}>
                You must backup your recovery phrase to secure your account
              </Text>
            </View>
          </View>
        </View>

        <View style={styles.nameInputSection}>
          <Text style={styles.nameInputLabel}>Account Name (optional)</Text>
          <TextInput
            style={styles.nameInput}
            value={accountLabel}
            onChangeText={setAccountLabel}
            placeholder="New account name"
            placeholderTextColor={themeColors.placeholder}
            autoCapitalize="words"
            autoCorrect={false}
            returnKeyType="done"
          />
        </View>

        <TouchableOpacity
          style={styles.generateButton}
          onPress={generateWallet}
        >
          <Text style={styles.generateButtonText}>Generate New Account</Text>
        </TouchableOpacity>

        <View style={styles.warningContainer}>
          <Ionicons
            name="information-circle"
            size={20}
            color={themeColors.primary}
          />
          <Text style={styles.warningText}>
            This will create a completely new account separate from your
            existing accounts. Make sure to backup the recovery phrase that will
            be shown next.
          </Text>
        </View>
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
    header: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingHorizontal: theme.spacing.lg,
      paddingVertical: 15,
      backgroundColor: theme.colors.card,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
    },
    backButton: {
      padding: theme.spacing.sm,
    },
    headerTitle: {
      fontSize: 18,
      fontWeight: '600',
      color: theme.colors.text,
    },
    placeholder: {
      width: 40,
    },
    scrollContainer: {
      flex: 1,
    },
    content: {
      paddingHorizontal: theme.spacing.lg,
      paddingVertical: 40,
      paddingBottom: 60,
    },
    iconContainer: {
      alignItems: 'center',
      marginBottom: 30,
    },
    title: {
      fontSize: 28,
      fontWeight: 'bold',
      color: theme.colors.text,
      marginBottom: 10,
      textAlign: 'center',
    },
    subtitle: {
      fontSize: 16,
      color: theme.colors.textSecondary,
      marginBottom: 40,
      textAlign: 'center',
      lineHeight: 22,
    },
    infoContainer: {
      backgroundColor: theme.colors.card,
      borderRadius: 15,
      padding: theme.spacing.lg,
      marginBottom: 30,
    },
    infoItem: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      marginBottom: theme.spacing.lg,
    },
    infoTextContainer: {
      flex: 1,
      marginLeft: 15,
    },
    infoTitle: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.text,
      marginBottom: 4,
    },
    infoText: {
      fontSize: 14,
      color: theme.colors.textSecondary,
      lineHeight: 20,
    },
    nameInputSection: {
      width: '100%',
      marginBottom: theme.spacing.lg,
      gap: theme.spacing.xs,
    },
    nameInputLabel: {
      fontSize: 14,
      fontWeight: '500',
      color: theme.colors.textSecondary,
    },
    nameInput: {
      width: '100%',
      paddingVertical: theme.spacing.sm,
      paddingHorizontal: theme.spacing.md,
      borderRadius: theme.borderRadius.md,
      borderWidth: 1,
      borderColor: theme.colors.borderLight,
      backgroundColor: theme.colors.surface,
      fontSize: 16,
      color: theme.colors.text,
    },
    generateButton: {
      backgroundColor: theme.colors.primary,
      paddingVertical: 15,
      paddingHorizontal: 30,
      borderRadius: theme.borderRadius.md,
      marginBottom: theme.spacing.lg,
    },
    generateButtonText: {
      color: theme.colors.buttonText,
      fontSize: 18,
      fontWeight: '600',
      textAlign: 'center',
    },
    warningContainer: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      backgroundColor: theme.colors.surface,
      padding: 15,
      borderRadius: theme.borderRadius.md,
      borderLeftWidth: 4,
      borderLeftColor: theme.colors.primary,
    },
    warningText: {
      flex: 1,
      marginLeft: 10,
      fontSize: 14,
      color: theme.colors.primary,
      lineHeight: 20,
    },
    // no non-style color constants here; use themeColors in component where needed
  });
