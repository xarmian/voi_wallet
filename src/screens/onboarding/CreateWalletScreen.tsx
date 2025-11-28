import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { StackNavigationProp } from '@react-navigation/stack';
import { RootStackParamList } from '@/navigation/AppNavigator';
import { WalletService } from '@/services/wallet';
import MnemonicDisplay from '@/components/wallet/MnemonicDisplay';
import KeyboardAwareScrollView from '@/components/common/KeyboardAwareScrollView';
import UniversalHeader from '@/components/common/UniversalHeader';
import { useTheme } from '@/contexts/ThemeContext';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import { NFTBackground } from '@/components/common/NFTBackground';
import { GlassCard } from '@/components/common/GlassCard';
import { GlassButton } from '@/components/common/GlassButton';

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
    <NFTBackground>
      <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
        <UniversalHeader
          title="Create New Wallet"
          showBackButton
          onBackPress={handleBack}
          showAccountSelector={false}
          onAccountSelectorPress={() => {}}
        />

        <KeyboardAwareScrollView
          style={styles.scrollView}
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
        >
          <Text style={[styles.title, { color: theme.colors.text }]}>
            Your Recovery Phrase
          </Text>
          <Text style={[styles.subtitle, { color: theme.colors.textMuted }]}>
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

              <GlassCard variant="light" style={styles.warningContainer}>
                <View style={[styles.warningIconContainer, { backgroundColor: `${theme.colors.warning}20` }]}>
                  <Ionicons name="warning" size={20} color={theme.colors.warning} />
                </View>
                <Text style={[styles.warningText, { color: theme.colors.text }]}>
                  Never share your recovery phrase with anyone. Store it safely
                  offline.
                </Text>
              </GlassCard>

              <GlassButton
                variant="primary"
                label="I've Saved My Recovery Phrase"
                icon="checkmark-circle"
                onPress={handleContinue}
                fullWidth
                glow
                size="lg"
              />
            </>
          ) : (
            <Text style={[styles.loading, { color: theme.colors.textMuted }]}>
              Generating your wallet...
            </Text>
          )}
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
      padding: theme.spacing.lg,
      paddingBottom: 100,
    },
    title: {
      fontSize: theme.typography.heading1.fontSize,
      fontWeight: '700',
      marginBottom: theme.spacing.sm,
      textAlign: 'center',
    },
    subtitle: {
      fontSize: theme.typography.body.fontSize,
      marginBottom: theme.spacing.xl,
      textAlign: 'center',
      lineHeight: 22,
    },
    loading: {
      fontSize: theme.typography.body.fontSize,
      textAlign: 'center',
      marginTop: theme.spacing.xxl,
    },
    warningContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      borderRadius: theme.borderRadius.xl,
      marginTop: theme.spacing.lg,
      marginBottom: theme.spacing.xl,
    },
    warningIconContainer: {
      width: 36,
      height: 36,
      borderRadius: theme.borderRadius.md,
      alignItems: 'center',
      justifyContent: 'center',
      marginRight: theme.spacing.md,
    },
    warningText: {
      fontSize: theme.typography.bodySmall.fontSize,
      flex: 1,
      lineHeight: 18,
      fontWeight: '500',
    },
  });
