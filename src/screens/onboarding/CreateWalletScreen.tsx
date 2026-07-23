import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, View, Text, StyleSheet, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { StackNavigationProp } from '@react-navigation/stack';
import { RootStackParamList } from '@/navigation/AppNavigator';
import { WalletService } from '@/services/wallet';
import MnemonicDisplay from '@/components/wallet/MnemonicDisplay';
import MnemonicVerification from '@/components/wallet/MnemonicVerification';
import KeyboardAwareScrollView from '@/components/common/KeyboardAwareScrollView';
import UniversalHeader from '@/components/common/UniversalHeader';
import { useTheme } from '@/contexts/ThemeContext';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { useSecureScreen } from '@/hooks/useSecureScreen';
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

  // Block OS screenshots / screen recordings while the new wallet's recovery
  // phrase is displayed (no-op on the web/extension target).
  useSecureScreen();

  const [mnemonic, setMnemonic] = useState<string>('');
  // TASK-45: 'display' shows the phrase, 'verify' runs the confirmation quiz.
  const [step, setStep] = useState<'display' | 'verify'>('display');
  // Set immediately before a navigation we ourselves initiated, so the
  // beforeRemove guard below lets that dispatch through instead of re-prompting.
  const leavingIntentionallyRef = useRef(false);

  // Cross-platform alert helper
  const showAlert = (
    title: string,
    message: string,
    buttons?: {
      text: string;
      onPress?: () => void;
      style?: 'default' | 'cancel' | 'destructive';
    }[]
  ) => {
    if (Platform.OS === 'web') {
      if (buttons && buttons.length > 1) {
        // For confirmation dialogs
        const confirmed = window.confirm(`${title}\n\n${message}`);
        if (confirmed) {
          const confirmButton =
            buttons.find(
              (b) => b.style !== 'cancel' && b.style !== 'destructive'
            ) || buttons[buttons.length - 1];
          confirmButton?.onPress?.();
        }
      } else {
        window.alert(`${title}\n\n${message}`);
        buttons?.[0]?.onPress?.();
      }
    } else {
      Alert.alert(title, message, buttons);
    }
  };

  React.useEffect(() => {
    // Generate wallet immediately when component mounts
    try {
      const wallet = WalletService.generateWallet();
      setMnemonic(wallet.mnemonic);
    } catch {
      showAlert('Error', 'Failed to generate wallet');
    }
  }, []);

  // Navigate on to PIN/passphrase setup. `backupVerified` is a BOOLEAN route
  // param (DR-11 carrier #1) — SecuritySetupScreen consumes it at import time.
  // It is not key material, so it does not widen the DR-9 mnemonic-in-nav-state
  // exposure that TASK-224 will remediate.
  const goToSecuritySetup = useCallback(
    (backupVerified: boolean) => {
      leavingIntentionallyRef.current = true;
      navigation.navigate('SecuritySetup', {
        mnemonic,
        source: 'create',
        backupVerified,
      });
    },
    [mnemonic, navigation]
  );

  const handleContinue = () => {
    if (!mnemonic) {
      showAlert('Error', 'Please generate a wallet first');
      return;
    }
    // The quiz IS the confirmation now — the old self-attestation dialog was a
    // two-tap path to an unrecoverable wallet (U-10).
    setStep('verify');
  };

  const handleSkipVerification = () => {
    showAlert(
      'Skip verification?',
      'Your wallet will be marked as not backed up until you confirm your recovery phrase. If you lose this device without the phrase written down, the funds are gone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Skip for now',
          style: 'destructive',
          onPress: () => goToSecuritySetup(false),
        },
      ]
    );
  };

  const confirmDiscard = useCallback((onConfirm: () => void) => {
    const title = 'Warning';
    const message =
      'If you go back now, you will lose this recovery phrase and the wallet it belongs to. Are you sure?';
    if (Platform.OS === 'web') {
      if (window.confirm(`${title}\n\n${message}`)) {
        onConfirm();
      }
      return;
    }
    Alert.alert(title, message, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Go Back', style: 'destructive', onPress: onConfirm },
    ]);
  }, []);

  // U-10: the header back button was the ONLY guarded exit. `beforeRemove` fires
  // for every pop path — header back, iOS swipe-back, Android hardware back — so
  // none of them can silently destroy the only copy of the phrase. (The screen
  // also sets gestureEnabled: false in AppNavigator; native-stack needs that for
  // the swipe gesture to be reliably interceptable.) Forward navigation to
  // SecuritySetup is a PUSH, so this listener does not fire for it; the ref is a
  // belt-and-braces escape for any dispatch we initiate ourselves.
  useEffect(() => {
    const unsubscribe = navigation.addListener('beforeRemove', (event) => {
      if (leavingIntentionallyRef.current) return;
      event.preventDefault();
      confirmDiscard(() => {
        leavingIntentionallyRef.current = true;
        navigation.dispatch(event.data.action);
      });
    });
    return unsubscribe;
  }, [navigation, confirmDiscard]);

  // Re-arm the guard whenever this screen becomes active again. Pushing
  // SecuritySetup leaves CreateWallet mounted underneath with the escape flag
  // set; if the user comes BACK here, that stale flag would let the next
  // hardware-back silently discard the phrase.
  useEffect(() => {
    const unsubscribe = navigation.addListener('focus', () => {
      leavingIntentionallyRef.current = false;
    });
    return unsubscribe;
  }, [navigation]);

  const handleBack = () => {
    // In the quiz step, "back" returns to the phrase rather than leaving.
    if (step === 'verify') {
      setStep('display');
      return;
    }
    // Let the beforeRemove listener own the confirmation so the header button,
    // the swipe gesture and the hardware button all share one code path.
    navigation.goBack();
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
          {step === 'verify' && mnemonic ? (
            <MnemonicVerification
              mnemonic={mnemonic}
              onVerified={() => goToSecuritySetup(true)}
              // TASK-226: the challenge restarts itself after too many wrong
              // answers; put the phrase back on screen so the user can actually
              // write it down rather than grinding guesses against the board.
              onFailed={() => setStep('display')}
              onSkip={handleSkipVerification}
              testIDPrefix="create-wallet-verification"
            />
          ) : (
            <>
              <Text style={[styles.title, { color: theme.colors.text }]}>
                Your Recovery Phrase
              </Text>
              <Text
                style={[styles.subtitle, { color: theme.colors.textMuted }]}
              >
                Write down these 25 words in order and store them safely. This
                is the only way to recover your wallet.
              </Text>

              {mnemonic ? (
                <>
                  <MnemonicDisplay
                    mnemonic={mnemonic}
                    layout="grid"
                    showCopyButton={true}
                  />

                  <GlassCard variant="light" style={styles.warningContainer}>
                    <View
                      style={[
                        styles.warningIconContainer,
                        { backgroundColor: `${theme.colors.warning}20` },
                      ]}
                    >
                      <Ionicons
                        name="warning"
                        size={20}
                        color={theme.colors.warning}
                      />
                    </View>
                    <Text
                      style={[styles.warningText, { color: theme.colors.text }]}
                    >
                      Never share your recovery phrase with anyone. Store it
                      safely offline.
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
                <Text
                  style={[styles.loading, { color: theme.colors.textMuted }]}
                >
                  Generating your wallet...
                </Text>
              )}
            </>
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
