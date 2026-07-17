import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  Pressable,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { AccountSecureStorage } from '@/services/secure';
import type { SecretSource } from '@/services/secure/SessionKeyVault';
import UniversalHeader from '@/components/common/UniversalHeader';
import KeyboardAwareScrollView from '@/components/common/KeyboardAwareScrollView';
import { PassphraseStrengthMeter } from '@/components/common/PassphraseStrengthMeter';
import { useTheme } from '@/contexts/ThemeContext';
import { useThemeColors, useThemedStyles } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import { useAuth } from '@/contexts/AuthContext';

const PASSPHRASE_MIN = AccountSecureStorage.PASSPHRASE_MIN_LENGTH;

type PinStep = 'current' | 'new' | 'confirm';

/** Format-valid for a kind: PIN = exactly 6 digits, passphrase = min length. */
function isValidFor(source: SecretSource, value: string): boolean {
  return source === 'passphrase'
    ? value.length >= PASSPHRASE_MIN
    : value.length === 6 && /^\d{6}$/.test(value);
}

const noun = (s: SecretSource) => (s === 'passphrase' ? 'passphrase' : 'PIN');

export default function ChangePinScreen() {
  const navigation = useNavigation();
  const { theme } = useTheme();
  const themeColors = useThemeColors();
  const styles = useThemedStyles(createStyles);
  const { recheckAuthState } = useAuth();
  const [currentStep, setCurrentStep] = useState<PinStep>('current');
  const [currentPin, setCurrentPin] = useState('');
  const [newPin, setNewPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [attempts, setAttempts] = useState(0);
  const [isInitialSetup, setIsInitialSetup] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  // The EXISTING credential kind (drives the 'current' step input) and the kind
  // the user is switching TO (drives 'new'/'confirm'). Default both to 'pin'.
  const [currentSource, setCurrentSource] = useState<SecretSource>('pin');
  const [newSource, setNewSource] = useState<SecretSource>('pin');

  // On mount: is there a credential yet, and of what kind?
  useEffect(() => {
    const load = async () => {
      try {
        const source = await AccountSecureStorage.getCredentialSource();
        if (!source) {
          setIsInitialSetup(true);
          setCurrentStep('new'); // Skip the 'current' step
        } else {
          setCurrentSource(source);
          setNewSource(source); // default: keep the same kind
        }
      } finally {
        setIsLoading(false);
      }
    };
    load();
  }, []);

  // Which kind the ACTIVE step's input is for.
  const stepSource: SecretSource =
    currentStep === 'current' ? currentSource : newSource;
  const isPassphraseStep = stepSource === 'passphrase';

  const getCurrentPinValue = () => {
    switch (currentStep) {
      case 'current':
        return currentPin;
      case 'new':
        return newPin;
      case 'confirm':
        return confirmPin;
      default:
        return '';
    }
  };

  const setCurrentPinValue = (value: string) => {
    switch (currentStep) {
      case 'current':
        setCurrentPin(value);
        break;
      case 'new':
        setNewPin(value);
        break;
      case 'confirm':
        setConfirmPin(value);
        break;
    }
  };

  const getStepTitle = () => {
    switch (currentStep) {
      case 'current':
        return `Enter Current ${noun(currentSource) === 'PIN' ? 'PIN' : 'Passphrase'}`;
      case 'new':
        return isInitialSetup
          ? `Create ${isPassphraseStep ? 'Passphrase' : 'PIN'}`
          : `Enter New ${isPassphraseStep ? 'Passphrase' : 'PIN'}`;
      case 'confirm':
        return `Confirm ${isPassphraseStep ? 'Passphrase' : 'PIN'}`;
      default:
        return '';
    }
  };

  const getStepMessage = () => {
    switch (currentStep) {
      case 'current':
        return `Enter your current ${noun(currentSource)} to verify your identity`;
      case 'new':
        return isPassphraseStep
          ? `Choose a passphrase (at least ${PASSPHRASE_MIN} characters). Longer is stronger.`
          : 'Choose a 6-digit PIN for your wallet';
      case 'confirm':
        return `Re-enter your ${isPassphraseStep ? 'passphrase' : 'PIN'} to confirm`;
      default:
        return '';
    }
  };

  const handleNext = async () => {
    const value = getCurrentPinValue();

    if (!isValidFor(stepSource, value)) {
      Alert.alert(
        'Error',
        isPassphraseStep
          ? `Passphrase must be at least ${PASSPHRASE_MIN} characters`
          : 'PIN must be 6 digits'
      );
      return;
    }

    if (currentStep === 'current') {
      setIsSubmitting(true);
      try {
        const isValid = await AccountSecureStorage.verifyPin(value);
        if (isValid) {
          setCurrentStep('new');
          setAttempts(0);
        } else {
          const newAttempts = attempts + 1;
          setAttempts(newAttempts);
          setCurrentPin('');
          if (newAttempts >= 5) {
            Alert.alert(
              'Too Many Attempts',
              'Too many failed attempts. Please try again later.',
              [{ text: 'OK', onPress: () => navigation.goBack() }]
            );
          } else {
            Alert.alert(
              `Incorrect ${noun(currentSource)}`,
              `${5 - newAttempts} attempts remaining.`
            );
          }
        }
      } catch (error) {
        Alert.alert('Error', 'Failed to verify. Please try again.');
        setCurrentPin('');
      } finally {
        setIsSubmitting(false);
      }
    } else if (currentStep === 'new') {
      if (!isInitialSetup && value === currentPin) {
        Alert.alert(
          'Error',
          `New ${noun(newSource)} must be different from the current one`
        );
        setNewPin('');
        return;
      }
      setCurrentStep('confirm');
    } else if (currentStep === 'confirm') {
      if (value !== newPin) {
        Alert.alert('Error', 'Entries do not match. Please try again.');
        setConfirmPin('');
        return;
      }

      setIsSubmitting(true);
      try {
        if (isInitialSetup) {
          // First-secret setup — atomic rewrap of any pre-existing device-key
          // accounts under the new secret (DOC-137 §5.4).
          await AccountSecureStorage.setupPin(newPin, newSource);
        } else {
          // Change / convert — re-wraps every account from the OLD secret to the
          // NEW secret+kind byte-identically (DOC-137 §5.3); a PIN↔passphrase
          // switch keeps every account's key bytes (and Algorand address) intact.
          await AccountSecureStorage.changePin(currentPin, newPin, newSource);
        }

        await recheckAuthState();

        Alert.alert(
          isInitialSetup ? 'Security Set' : 'Updated',
          isInitialSetup
            ? `Your ${noun(newSource)} has been set up.`
            : `Your wallet is now secured with a ${noun(newSource)}.`,
          [{ text: 'OK', onPress: () => navigation.goBack() }]
        );
      } catch (error) {
        Alert.alert(
          'Error',
          `Failed to update: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
      } finally {
        setIsSubmitting(false);
      }
    }
  };

  const handleBack = () => {
    if (currentStep === 'current') {
      navigation.goBack();
    } else if (currentStep === 'new') {
      if (isInitialSetup) {
        navigation.goBack();
      } else {
        setCurrentStep('current');
        setNewPin('');
      }
    } else if (currentStep === 'confirm') {
      setCurrentStep('new');
      setConfirmPin('');
    }
  };

  const getProgress = () => {
    if (isInitialSetup) {
      return currentStep === 'new'
        ? '1 of 2'
        : currentStep === 'confirm'
          ? '2 of 2'
          : '';
    }
    switch (currentStep) {
      case 'current':
        return '1 of 3';
      case 'new':
        return '2 of 3';
      case 'confirm':
        return '3 of 3';
      default:
        return '';
    }
  };

  const value = getCurrentPinValue();
  const canProceed = isValidFor(stepSource, value) && !isSubmitting;

  if (isLoading) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <UniversalHeader
          title="Security"
          showBackButton
          onBackPress={() => navigation.goBack()}
        />
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={theme.colors.primary} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <UniversalHeader
        title={isInitialSetup ? 'Set Up Security' : 'Change PIN / Passphrase'}
        showBackButton
        onBackPress={handleBack}
      />

      <KeyboardAwareScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.content}
      >
        <View style={styles.progressContainer}>
          <Text style={styles.progressText}>Step {getProgress()}</Text>
        </View>

        <View style={styles.headerContainer}>
          <Text style={styles.title}>{getStepTitle()}</Text>
          <Text style={styles.message}>{getStepMessage()}</Text>
        </View>

        {/* Choose the NEW credential kind at the 'new' step. Switching clears the
            in-progress entries so a half-typed PIN can't leak into a passphrase. */}
        {currentStep === 'new' && (
          <View style={styles.modeToggle}>
            {(['pin', 'passphrase'] as const).map((m) => {
              const active = newSource === m;
              return (
                <Pressable
                  key={m}
                  onPress={() => {
                    if (newSource === m) return;
                    setNewSource(m);
                    setNewPin('');
                    setConfirmPin('');
                  }}
                  style={[
                    styles.modeOption,
                    active && { backgroundColor: theme.colors.primary },
                  ]}
                >
                  <Text
                    style={[
                      styles.modeOptionText,
                      {
                        color: active
                          ? theme.colors.buttonText
                          : theme.colors.text,
                      },
                    ]}
                  >
                    {m === 'pin' ? '6-digit PIN' : 'Passphrase'}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        )}

        <View style={styles.inputContainer}>
          <TextInput
            style={isPassphraseStep ? styles.passphraseInput : styles.pinInput}
            value={value}
            onChangeText={setCurrentPinValue}
            keyboardType={isPassphraseStep ? 'default' : 'numeric'}
            maxLength={isPassphraseStep ? undefined : 6}
            secureTextEntry
            autoCapitalize={isPassphraseStep ? 'none' : 'sentences'}
            autoCorrect={false}
            placeholder={isPassphraseStep ? 'Enter passphrase' : '••••••'}
            placeholderTextColor={themeColors.placeholder}
            editable={!isSubmitting}
            onSubmitEditing={() => {
              if (canProceed) handleNext();
            }}
            returnKeyType={currentStep === 'confirm' ? 'go' : 'next'}
            autoFocus
          />
          {isPassphraseStep && currentStep === 'new' && (
            <PassphraseStrengthMeter
              secret={value}
              minLength={PASSPHRASE_MIN}
            />
          )}
        </View>

        <TouchableOpacity
          style={[styles.nextButton, { opacity: canProceed ? 1 : 0.5 }]}
          onPress={handleNext}
          disabled={!canProceed}
        >
          {isSubmitting ? (
            <ActivityIndicator size="small" color="white" />
          ) : (
            <Text style={styles.nextButtonText}>
              {currentStep === 'confirm'
                ? isInitialSetup
                  ? 'Set'
                  : 'Update'
                : 'Next'}
            </Text>
          )}
        </TouchableOpacity>

        {attempts > 0 && currentStep === 'current' && (
          <Text style={styles.attemptsText}>Failed attempts: {attempts}/5</Text>
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
    loadingContainer: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
    },
    scrollView: {
      flex: 1,
    },
    content: {
      flexGrow: 1,
      paddingHorizontal: theme.spacing.lg,
      paddingVertical: theme.spacing.lg,
      alignItems: 'center',
    },
    progressContainer: {
      alignSelf: 'stretch',
      alignItems: 'center',
      marginBottom: theme.spacing.xl,
    },
    progressText: {
      fontSize: 14,
      color: theme.colors.textMuted,
      fontWeight: '500',
    },
    headerContainer: {
      alignItems: 'center',
      marginBottom: theme.spacing.xxl,
    },
    title: {
      fontSize: 24,
      fontWeight: 'bold',
      color: theme.colors.text,
      marginBottom: theme.spacing.sm,
      textAlign: 'center',
    },
    message: {
      fontSize: 16,
      color: theme.colors.textMuted,
      textAlign: 'center',
      lineHeight: 22,
    },
    modeToggle: {
      flexDirection: 'row',
      gap: theme.spacing.xs,
      backgroundColor: theme.colors.glassBorder,
      borderRadius: theme.borderRadius.lg,
      padding: theme.spacing.xs,
      width: '100%',
      maxWidth: 300,
      marginBottom: theme.spacing.lg,
    },
    modeOption: {
      flex: 1,
      paddingVertical: theme.spacing.sm,
      borderRadius: theme.borderRadius.md,
      alignItems: 'center',
    },
    modeOptionText: {
      fontSize: 15,
      fontWeight: '600',
    },
    inputContainer: {
      width: '100%',
      maxWidth: 300,
      marginBottom: theme.spacing.xl,
    },
    pinInput: {
      backgroundColor: theme.colors.inputBackground,
      borderRadius: theme.borderRadius.xl,
      padding: theme.spacing.lg,
      fontSize: 28,
      textAlign: 'center',
      letterSpacing: 8,
      borderWidth: 2,
      borderColor: theme.colors.inputBorder,
      fontWeight: '600',
      color: theme.colors.text,
    },
    passphraseInput: {
      backgroundColor: theme.colors.inputBackground,
      borderRadius: theme.borderRadius.xl,
      padding: theme.spacing.lg,
      fontSize: 18,
      borderWidth: 2,
      borderColor: theme.colors.inputBorder,
      fontWeight: '500',
      color: theme.colors.text,
    },
    nextButton: {
      backgroundColor: theme.colors.primary,
      paddingVertical: theme.spacing.md,
      paddingHorizontal: theme.spacing.xxl,
      borderRadius: theme.borderRadius.lg,
      minWidth: 120,
      alignItems: 'center',
      marginBottom: theme.spacing.lg,
    },
    nextButtonText: {
      color: theme.colors.buttonText,
      fontSize: 18,
      fontWeight: '600',
    },
    attemptsText: {
      fontSize: 14,
      color: theme.colors.error,
      textAlign: 'center',
      marginBottom: theme.spacing.lg,
    },
  });
