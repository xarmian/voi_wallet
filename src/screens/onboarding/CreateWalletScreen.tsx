import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { StackNavigationProp } from '@react-navigation/stack';
import { RootStackParamList } from '@/navigation/AppNavigator';
import { WalletService } from '@/services/wallet';
import MnemonicDisplay from '@/components/wallet/MnemonicDisplay';
import KeyboardAwareScrollView from '@/components/common/KeyboardAwareScrollView';
import { useTheme } from '@/contexts/ThemeContext';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';

type CreateWalletScreenNavigationProp = StackNavigationProp<
  RootStackParamList,
  'CreateWallet'
>;

interface Props {
  navigation: CreateWalletScreenNavigationProp;
}

export default function CreateWalletScreen({ navigation }: Props) {
  const { theme } = useTheme();
  const styles = useThemedStyles(createStyles);
  const [mnemonic, setMnemonic] = useState<string>('');

  React.useEffect(() => {
    // Generate wallet immediately when component mounts
    try {
      const wallet = WalletService.generateWallet();
      setMnemonic(wallet.mnemonic);
    } catch (error) {
      Alert.alert('Error', 'Failed to generate wallet');
    }
  }, []);

  const handleContinue = () => {
    if (!mnemonic) {
      Alert.alert('Error', 'Please generate a wallet first');
      return;
    }

    Alert.alert(
      'Backup Confirmation',
      'Have you safely written down your recovery phrase? You will need it to recover your wallet if you lose access to this device.',
      [
        { text: 'Not Yet', style: 'cancel' },
        {
          text: "Yes, I've Saved It",
          onPress: () =>
            navigation.navigate('SecuritySetup', {
              mnemonic,
              source: 'create',
            }),
        },
      ]
    );
  };

  const handleBack = () => {
    Alert.alert(
      'Warning',
      'If you go back now, you will lose this recovery phrase. Are you sure?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Go Back',
          style: 'destructive',
          onPress: () => navigation.goBack(),
        },
      ]
    );
  };

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.backButton} onPress={handleBack}>
          <Ionicons name="arrow-back" size={24} color={theme.colors.primary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Create New Wallet</Text>
        <View style={styles.placeholder} />
      </View>

      <KeyboardAwareScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.title}>Your Recovery Phrase</Text>
        <Text style={styles.subtitle}>
          Write down these 25 words in order and store them safely. This is the
          only way to recover your wallet.
        </Text>

        {mnemonic ? (
          <>
            <MnemonicDisplay
              mnemonic={mnemonic}
              layout="grid"
              showCopyButton={true}
            />

            <View style={styles.warningContainer}>
              <Ionicons name="warning" size={20} color={theme.colors.warning} />
              <Text style={styles.warningText}>
                Never share your recovery phrase with anyone. Store it safely
                offline.
              </Text>
            </View>

            <TouchableOpacity
              style={styles.continueButton}
              onPress={handleContinue}
            >
              <Text style={styles.continueButtonText}>
                I've Saved My Recovery Phrase
              </Text>
            </TouchableOpacity>
          </>
        ) : (
          <Text style={styles.loading}>Generating your wallet...</Text>
        )}
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
      paddingVertical: theme.spacing.md,
      backgroundColor: theme.colors.card,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.borderLight,
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
    scrollView: {
      flex: 1,
    },
    content: {
      padding: theme.spacing.lg,
      paddingBottom: 100,
    },
    title: {
      fontSize: 24,
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
    loading: {
      fontSize: 16,
      color: theme.colors.textMuted,
      textAlign: 'center',
      marginTop: theme.spacing.xxl,
    },
    warningContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor:
        theme.mode === 'dark' ? 'rgba(255, 159, 10, 0.1)' : '#FFF3CD',
      padding: theme.spacing.md,
      borderRadius: theme.borderRadius.lg,
      marginTop: theme.spacing.lg,
      marginBottom: theme.spacing.xl,
      borderLeftWidth: 4,
      borderLeftColor: theme.colors.warning,
    },
    warningText: {
      fontSize: 14,
      color: theme.mode === 'dark' ? theme.colors.warning : '#856404',
      marginLeft: theme.spacing.sm,
      flex: 1,
      lineHeight: 18,
      fontWeight: '500',
    },
    continueButton: {
      backgroundColor: theme.colors.success,
      paddingVertical: theme.spacing.md,
      paddingHorizontal: theme.spacing.xl,
      borderRadius: theme.borderRadius.lg,
      alignSelf: 'center',
    },
    continueButtonText: {
      color: theme.colors.buttonText,
      fontSize: 18,
      fontWeight: '600',
    },
  });
