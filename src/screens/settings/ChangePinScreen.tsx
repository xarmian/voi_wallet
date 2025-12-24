import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { AccountSecureStorage } from '@/services/secure';
import UniversalHeader from '@/components/common/UniversalHeader';
import KeyboardAwareScrollView from '@/components/common/KeyboardAwareScrollView';
import { useTheme } from '@/contexts/ThemeContext';
import { useThemeColors } from '@/hooks/useThemedStyles';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import { useAuth } from '@/contexts/AuthContext';

type PinStep = 'current' | 'new' | 'confirm';

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

  // Check if this is initial PIN setup (no existing PIN) on mount
  useEffect(() => {
    const checkPinExists = async () => {
      try {
        const hasPin = await AccountSecureStorage.hasPin();
        if (!hasPin) {
          setIsInitialSetup(true);
          setCurrentStep('new'); // Skip 'current' step
        }
      } finally {
        setIsLoading(false);
      }
    };
    checkPinExists();
  }, []);

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
        return 'Enter Current PIN';
      case 'new':
        return isInitialSetup ? 'Create PIN' : 'Enter New PIN';
      case 'confirm':
        return isInitialSetup ? 'Confirm PIN' : 'Confirm New PIN';
      default:
        return '';
    }
  };

  const getStepMessage = () => {
    switch (currentStep) {
      case 'current':
        return 'Please enter your current 6-digit PIN';
      case 'new':
        return isInitialSetup
          ? 'Choose a 6-digit PIN to secure your wallet'
          : 'Choose a new 6-digit PIN for your wallet';
      case 'confirm':
        return isInitialSetup
          ? 'Re-enter your PIN to confirm'
          : 'Re-enter your new PIN to confirm';
      default:
        return '';
    }
  };

  const handleNext = async () => {
    const pinValue = getCurrentPinValue();

    if (pinValue.length !== 6) {
      Alert.alert('Error', 'PIN must be 6 digits');
      return;
    }

    if (currentStep === 'current') {
      setIsSubmitting(true);
      try {
        const isValid = await AccountSecureStorage.verifyPin(pinValue);
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
              'Too many failed PIN attempts. Please try again later.',
              [{ text: 'OK', onPress: () => navigation.goBack() }]
            );
          } else {
            Alert.alert(
              'Incorrect PIN',
              `Incorrect PIN. ${5 - newAttempts} attempts remaining.`
            );
          }
        }
      } catch (error) {
        Alert.alert('Error', 'Failed to verify PIN. Please try again.');
        setCurrentPin('');
      } finally {
        setIsSubmitting(false);
      }
    } else if (currentStep === 'new') {
      // Only check against current PIN if changing (not initial setup)
      if (!isInitialSetup && pinValue === currentPin) {
        Alert.alert('Error', 'New PIN must be different from current PIN');
        setNewPin('');
        return;
      }
      setCurrentStep('confirm');
    } else if (currentStep === 'confirm') {
      if (pinValue !== newPin) {
        Alert.alert('Error', 'PINs do not match. Please try again.');
        setConfirmPin('');
        return;
      }

      setIsSubmitting(true);
      try {
        if (isInitialSetup) {
          // Initial PIN setup - use storePin
          await AccountSecureStorage.storePin(newPin);
        } else {
          // Changing existing PIN - use changePin
          await AccountSecureStorage.changePin(currentPin, newPin);
        }

        // Update AuthContext to reflect new PIN state
        await recheckAuthState();

        Alert.alert(
          isInitialSetup ? 'PIN Set Successfully' : 'PIN Changed Successfully',
          isInitialSetup
            ? 'Your PIN has been set up successfully.'
            : 'Your PIN has been updated successfully.',
          [
            {
              text: 'OK',
              onPress: () => navigation.goBack(),
            },
          ]
        );
      } catch (error) {
        Alert.alert(
          'Error',
          `Failed to ${isInitialSetup ? 'set' : 'change'} PIN: ${error instanceof Error ? error.message : 'Unknown error'}`
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
        // In initial setup, 'new' is the first step - go back to settings
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
      // 2-step flow for initial setup
      switch (currentStep) {
        case 'new':
          return '1 of 2';
        case 'confirm':
          return '2 of 2';
        default:
          return '';
      }
    } else {
      // 3-step flow for changing existing PIN
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
    }
  };

  // Show loading state while checking if PIN exists
  if (isLoading) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <UniversalHeader title="PIN" showBack onBack={() => navigation.goBack()} />
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={theme.colors.primary} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <UniversalHeader title={isInitialSetup ? 'Set PIN' : 'Change PIN'} showBack onBack={handleBack} />

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

        <View style={styles.inputContainer}>
          <TextInput
            style={styles.pinInput}
            value={getCurrentPinValue()}
            onChangeText={setCurrentPinValue}
            keyboardType="numeric"
            maxLength={6}
            secureTextEntry
            placeholder="••••••"
            placeholderTextColor={themeColors.placeholder}
            editable={!isSubmitting}
            autoFocus
          />
        </View>

        <TouchableOpacity
          style={[
            styles.nextButton,
            {
              opacity:
                getCurrentPinValue().length === 6 && !isSubmitting ? 1 : 0.5,
            },
          ]}
          onPress={handleNext}
          disabled={getCurrentPinValue().length !== 6 || isSubmitting}
        >
          {isSubmitting ? (
            <ActivityIndicator size="small" color="white" />
          ) : (
            <Text style={styles.nextButtonText}>
              {currentStep === 'confirm' ? (isInitialSetup ? 'Set PIN' : 'Change PIN') : 'Next'}
            </Text>
          )}
        </TouchableOpacity>

        {attempts > 0 && currentStep === 'current' && (
          <Text style={styles.attemptsText}>Failed attempts: {attempts}/5</Text>
        )}

        <View style={styles.helpContainer}>
          <Text style={styles.helpText}>
            {currentStep === 'current' &&
              'Enter your current PIN to verify your identity'}
            {currentStep === 'new' &&
              'Choose a secure 6-digit PIN that you can remember'}
            {currentStep === 'confirm' && 'Make sure both PINs match exactly'}
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
    helpContainer: {
      marginTop: theme.spacing.lg,
      paddingHorizontal: theme.spacing.lg,
    },
    helpText: {
      fontSize: 14,
      color: theme.colors.textMuted,
      textAlign: 'center',
      lineHeight: 20,
    },
  });
