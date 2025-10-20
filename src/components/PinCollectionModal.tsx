import React, { useState } from 'react';
import {
  Modal,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { useTheme } from '@/contexts/ThemeContext';
import { useThemeColors } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import { AccountSecureStorage } from '@/services/secure';
import KeyboardAwareScrollView from '@/components/common/KeyboardAwareScrollView';

interface PinCollectionModalProps {
  visible: boolean;
  onSuccess: (pin: string) => void;
  onCancel: () => void;
  title?: string;
  message?: string;
}

export default function PinCollectionModal({
  visible,
  onSuccess,
  onCancel,
  title = 'Enter PIN',
  message = 'Please enter your PIN to authorize this transaction',
}: PinCollectionModalProps) {
  const { theme } = useTheme();
  const themeColors = useThemeColors();
  const styles = useThemedStyles(createStyles);
  const [pin, setPin] = useState('');
  const [isVerifying, setIsVerifying] = useState(false);
  const [attempts, setAttempts] = useState(0);

  const handleVerify = async () => {
    if (pin.length !== 6) {
      Alert.alert('Error', 'PIN must be 6 digits');
      return;
    }

    setIsVerifying(true);

    try {
      const isValid = await AccountSecureStorage.verifyPin(pin);

      if (isValid) {
        const verifiedPin = pin; // Capture PIN before clearing
        setPin('');
        setAttempts(0);
        setIsVerifying(false);
        onSuccess(verifiedPin); // Pass the PIN to the success handler
      } else {
        const newAttempts = attempts + 1;
        setAttempts(newAttempts);
        setPin('');

        if (newAttempts >= 5) {
          Alert.alert(
            'Too Many Attempts',
            'Too many failed PIN attempts. Please try again later.',
            [{ text: 'OK', onPress: onCancel }]
          );
        } else {
          Alert.alert(
            'Incorrect PIN',
            `Incorrect PIN. ${5 - newAttempts} attempts remaining.`
          );
        }
      }
    } catch (error) {
      console.error('PIN verification error:', error);
      Alert.alert('Error', 'Failed to verify PIN');
    } finally {
      setIsVerifying(false);
    }
  };

  const handleCancel = () => {
    setPin('');
    setAttempts(0);
    onCancel();
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={handleCancel}
    >
      <View style={styles.overlay}>
        <KeyboardAwareScrollView
          contentContainerStyle={styles.keyboardScrollContainer}
          extraScrollHeight={50}
        >
          <View style={styles.modal}>
            <Text style={styles.title}>{title}</Text>
            <Text style={styles.message}>{message}</Text>

            <View style={styles.inputContainer}>
              <TextInput
                style={styles.pinInput}
                value={pin}
                onChangeText={setPin}
                keyboardType="numeric"
                maxLength={6}
                secureTextEntry
                placeholder="••••••"
                placeholderTextColor={themeColors.placeholder}
                editable={!isVerifying}
                autoFocus
              />
            </View>

            <View style={styles.buttonContainer}>
              <TouchableOpacity
                style={[styles.button, styles.cancelButton]}
                onPress={handleCancel}
                disabled={isVerifying}
              >
                <Text style={styles.cancelButtonText}>Cancel</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[
                  styles.button,
                  styles.verifyButton,
                  { opacity: pin.length === 6 && !isVerifying ? 1 : 0.5 },
                ]}
                onPress={handleVerify}
                disabled={pin.length !== 6 || isVerifying}
              >
                {isVerifying ? (
                  <ActivityIndicator size="small" color="white" />
                ) : (
                  <Text style={styles.verifyButtonText}>Authorize</Text>
                )}
              </TouchableOpacity>
            </View>

            {attempts > 0 && (
              <Text style={styles.attemptsText}>
                Failed attempts: {attempts}/5
              </Text>
            )}
          </View>
        </KeyboardAwareScrollView>
      </View>
    </Modal>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    overlay: {
      flex: 1,
      backgroundColor: theme.colors.overlay,
      justifyContent: 'center',
      alignItems: 'center',
      paddingHorizontal: theme.spacing.lg,
    },
    keyboardScrollContainer: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      paddingHorizontal: theme.spacing.lg,
    },
    modal: {
      backgroundColor: theme.colors.modalBackground,
      borderRadius: theme.borderRadius.xl,
      padding: theme.spacing.xl,
      width: '100%',
      maxWidth: 400,
      ...theme.shadows.lg,
    },
    title: {
      fontSize: 20,
      fontWeight: 'bold',
      color: theme.colors.text,
      textAlign: 'center',
      marginBottom: theme.spacing.sm,
    },
    message: {
      fontSize: 16,
      color: theme.colors.textSecondary,
      textAlign: 'center',
      marginBottom: theme.spacing.xl,
      lineHeight: 22,
    },
    inputContainer: {
      marginBottom: theme.spacing.xl,
    },
    pinInput: {
      backgroundColor: theme.colors.inputBackground,
      borderRadius: theme.borderRadius.lg,
      padding: theme.spacing.lg,
      fontSize: 24,
      textAlign: 'center',
      letterSpacing: 8,
      borderWidth: 1,
      borderColor: theme.colors.inputBorder,
      color: theme.colors.text,
    },
    buttonContainer: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      gap: theme.spacing.lg,
    },
    button: {
      flex: 1,
      paddingVertical: theme.spacing.lg,
      borderRadius: theme.borderRadius.lg,
      alignItems: 'center',
    },
    cancelButton: {
      backgroundColor: theme.colors.surface,
      borderWidth: 1,
      borderColor: theme.colors.border,
    },
    cancelButtonText: {
      color: theme.colors.textSecondary,
      fontSize: 16,
      fontWeight: '600',
    },
    verifyButton: {
      backgroundColor: theme.colors.primary,
    },
    verifyButtonText: {
      color: theme.colors.buttonText,
      fontSize: 16,
      fontWeight: '600',
    },
    attemptsText: {
      fontSize: 12,
      color: theme.colors.error,
      textAlign: 'center',
      marginTop: theme.spacing.sm,
    },
  });
