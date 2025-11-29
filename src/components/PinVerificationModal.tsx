import React, { useState } from 'react';
import {
  Modal,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Platform,
} from 'react-native';

// Cross-platform alert helper
const showAlert = (title: string, message: string, buttons?: Array<{text: string, onPress?: () => void}>) => {
  if (Platform.OS === 'web') {
    window.alert(`${title}\n\n${message}`);
    buttons?.[0]?.onPress?.();
  } else {
    const { Alert } = require('react-native');
    Alert.alert(title, message, buttons);
  }
};
import { useThemedStyles, useThemeColors } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import KeyboardAwareScrollView from '@/components/common/KeyboardAwareScrollView';
import { AccountSecureStorage } from '@/services/secure';

interface PinVerificationModalProps {
  visible: boolean;
  onSuccess: () => void;
  onCancel: () => void;
  title?: string;
  message?: string;
}

export default function PinVerificationModal({
  visible,
  onSuccess,
  onCancel,
  title = 'Enter PIN',
  message = 'Please enter your PIN to continue',
}: PinVerificationModalProps) {
  const [pin, setPin] = useState('');
  const [isVerifying, setIsVerifying] = useState(false);
  const [attempts, setAttempts] = useState(0);

  const handleVerify = async () => {
    if (pin.length !== 6) {
      showAlert('Error', 'PIN must be 6 digits');
      return;
    }

    setIsVerifying(true);

    try {
      const isValid = await AccountSecureStorage.verifyPin(pin);

      if (isValid) {
        setPin('');
        setAttempts(0);
        setIsVerifying(false);
        onSuccess();
      } else {
        const newAttempts = attempts + 1;
        setAttempts(newAttempts);
        setPin('');

        if (newAttempts >= 5) {
          showAlert(
            'Too Many Attempts',
            'Too many failed PIN attempts. Please try again later.',
            [{ text: 'OK', onPress: onCancel }]
          );
        } else {
          showAlert(
            'Incorrect PIN',
            `Incorrect PIN. ${5 - newAttempts} attempts remaining.`
          );
        }
      }
    } catch (error) {
      console.error('PIN verification error:', error);
      showAlert('Error', 'Failed to verify PIN');
    } finally {
      setIsVerifying(false);
    }
  };

  const handleCancel = () => {
    setPin('');
    setAttempts(0);
    onCancel();
  };

  const styles = useThemedStyles(createStyles);
  const colors = useThemeColors();

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
              placeholderTextColor={colors.placeholder}
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
                <ActivityIndicator size="small" color={colors.buttonText} />
              ) : (
                <Text style={styles.verifyButtonText}>Verify</Text>
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
    },
    keyboardScrollContainer: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
    },
    modal: {
      backgroundColor: theme.colors.modalBackground,
      borderRadius: 15,
      padding: 25,
      width: '85%',
      maxWidth: 400,
      ...theme.shadows.lg,
    },
    title: {
      fontSize: 20,
      fontWeight: 'bold',
      color: theme.colors.text,
      textAlign: 'center',
      marginBottom: theme.spacing.sm + 2,
    },
    message: {
      fontSize: 16,
      color: theme.colors.textSecondary,
      textAlign: 'center',
      marginBottom: 25,
      lineHeight: 22,
    },
    inputContainer: {
      marginBottom: 25,
    },
    pinInput: {
      backgroundColor: theme.colors.inputBackground,
      borderRadius: theme.spacing.sm + 2,
      padding: 15,
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
      gap: 15,
    },
    button: {
      flex: 1,
      paddingVertical: theme.spacing.sm + 4,
      borderRadius: theme.borderRadius.sm + 4,
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
      backgroundColor: theme.colors.buttonBackground,
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
      marginTop: theme.spacing.sm + 2,
    },
  });
