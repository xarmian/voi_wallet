import React, { useState, useEffect, useCallback } from 'react';
import {
  Modal,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useThemedStyles, useThemeColors } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import KeyboardAwareScrollView from '@/components/common/KeyboardAwareScrollView';
import {
  validatePasswordStrength,
  getPasswordStrengthLabel,
  getPasswordStrengthColor,
} from '@/services/backup';

interface PasswordInputModalProps {
  visible: boolean;
  mode: 'create' | 'enter';
  title?: string;
  subtitle?: string;
  onCancel: () => void;
  onConfirm: (password: string) => void;
  isSubmitting?: boolean;
  error?: string;
}

export default function PasswordInputModal({
  visible,
  mode,
  title,
  subtitle,
  onCancel,
  onConfirm,
  isSubmitting = false,
  error,
}: PasswordInputModalProps) {
  const styles = useThemedStyles(createStyles);
  const colors = useThemeColors();
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [hasEdited, setHasEdited] = useState(false);

  // Reset state when modal becomes visible
  useEffect(() => {
    if (visible) {
      setPassword('');
      setConfirmPassword('');
      setShowPassword(false);
      setShowConfirmPassword(false);
      setHasEdited(false);
    }
  }, [visible]);

  const passwordStrength = validatePasswordStrength(password);
  const passwordsMatch = password === confirmPassword;

  const isValid =
    mode === 'create'
      ? passwordStrength.isValid && passwordsMatch && confirmPassword.length > 0
      : password.length > 0;

  const handleConfirm = useCallback(() => {
    setHasEdited(true);
    if (!isValid || isSubmitting) {
      return;
    }
    onConfirm(password);
  }, [isValid, isSubmitting, password, onConfirm]);

  const getValidationMessage = (): string | undefined => {
    if (!hasEdited) return undefined;

    if (mode === 'create') {
      if (!passwordStrength.isValid) {
        return passwordStrength.feedback[0];
      }
      if (confirmPassword.length > 0 && !passwordsMatch) {
        return 'Passwords do not match';
      }
    } else {
      if (password.length === 0) {
        return 'Please enter your backup password';
      }
    }
    return undefined;
  };

  const validationMessage = getValidationMessage();

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onCancel}
    >
      <View style={styles.overlay}>
        <KeyboardAwareScrollView
          contentContainerStyle={styles.keyboardScrollContainer}
          extraScrollHeight={50}
        >
          <View style={styles.modal}>
            <Text style={styles.title}>
              {title || (mode === 'create' ? 'Create Backup Password' : 'Enter Backup Password')}
            </Text>
            <Text style={styles.message}>
              {subtitle ||
                (mode === 'create'
                  ? 'This password will encrypt your backup. Make sure to remember it - you will need it to restore your wallet.'
                  : 'Enter the password you used when creating this backup.')}
            </Text>

            {mode === 'create' && (
              <View style={styles.warningContainer}>
                <Ionicons name="warning" size={18} color={colors.warning} />
                <Text style={styles.warningText}>
                  If you forget this password, you will not be able to restore your backup.
                </Text>
              </View>
            )}

            {/* Password Input */}
            <View style={styles.inputContainer}>
              <TextInput
                style={[
                  styles.input,
                  (validationMessage || error) && hasEdited && styles.inputError,
                ]}
                value={password}
                onChangeText={(text) => {
                  setPassword(text);
                  if (!hasEdited) setHasEdited(true);
                }}
                placeholder="Password"
                placeholderTextColor={colors.placeholder}
                secureTextEntry={!showPassword}
                autoFocus
                editable={!isSubmitting}
                autoCapitalize="none"
                autoCorrect={false}
              />
              <TouchableOpacity
                style={styles.eyeButton}
                onPress={() => setShowPassword(!showPassword)}
              >
                <Ionicons
                  name={showPassword ? 'eye-off' : 'eye'}
                  size={22}
                  color={colors.textMuted}
                />
              </TouchableOpacity>
            </View>

            {/* Password Strength (create mode only) */}
            {mode === 'create' && password.length > 0 && (
              <View style={styles.strengthContainer}>
                <View style={styles.strengthBar}>
                  {[0, 1, 2, 3].map((index) => (
                    <View
                      key={index}
                      style={[
                        styles.strengthSegment,
                        {
                          backgroundColor:
                            index < passwordStrength.score
                              ? getPasswordStrengthColor(passwordStrength.score)
                              : colors.borderLight,
                        },
                      ]}
                    />
                  ))}
                </View>
                <Text
                  style={[
                    styles.strengthText,
                    { color: getPasswordStrengthColor(passwordStrength.score) },
                  ]}
                >
                  {getPasswordStrengthLabel(passwordStrength.score)}
                </Text>
              </View>
            )}

            {/* Confirm Password (create mode only) */}
            {mode === 'create' && (
              <View style={styles.inputContainer}>
                <TextInput
                  style={[
                    styles.input,
                    !passwordsMatch &&
                      confirmPassword.length > 0 &&
                      styles.inputError,
                  ]}
                  value={confirmPassword}
                  onChangeText={setConfirmPassword}
                  placeholder="Confirm password"
                  placeholderTextColor={colors.placeholder}
                  secureTextEntry={!showConfirmPassword}
                  editable={!isSubmitting}
                  autoCapitalize="none"
                  autoCorrect={false}
                  returnKeyType="done"
                  onSubmitEditing={handleConfirm}
                />
                <TouchableOpacity
                  style={styles.eyeButton}
                  onPress={() => setShowConfirmPassword(!showConfirmPassword)}
                >
                  <Ionicons
                    name={showConfirmPassword ? 'eye-off' : 'eye'}
                    size={22}
                    color={colors.textMuted}
                  />
                </TouchableOpacity>
              </View>
            )}

            {/* Validation/Error Message */}
            {(validationMessage || error) && (
              <Text style={styles.errorText}>{error || validationMessage}</Text>
            )}

            {/* Buttons */}
            <View style={styles.buttons}>
              <TouchableOpacity
                style={[styles.button, styles.cancelButton]}
                onPress={onCancel}
                disabled={isSubmitting}
              >
                <Text style={styles.cancelButtonText}>Cancel</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[
                  styles.button,
                  styles.confirmButton,
                  (!isValid || isSubmitting) && styles.buttonDisabled,
                ]}
                onPress={handleConfirm}
                disabled={!isValid || isSubmitting}
              >
                {isSubmitting ? (
                  <ActivityIndicator size="small" color="#FFFFFF" />
                ) : (
                  <Text style={styles.confirmButtonText}>
                    {mode === 'create' ? 'Create Backup' : 'Decrypt'}
                  </Text>
                )}
              </TouchableOpacity>
            </View>
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
    },
    keyboardScrollContainer: {
      flexGrow: 1,
      justifyContent: 'center',
      paddingHorizontal: theme.spacing.lg,
    },
    modal: {
      backgroundColor: theme.colors.modalBackground,
      borderRadius: theme.borderRadius.xl,
      paddingHorizontal: theme.spacing.lg,
      paddingVertical: 28,
      ...theme.shadows.lg,
    },
    title: {
      fontSize: 20,
      fontWeight: '600',
      color: theme.colors.text,
      textAlign: 'center',
    },
    message: {
      fontSize: 14,
      color: theme.colors.textSecondary,
      textAlign: 'center',
      marginTop: theme.spacing.sm,
      marginBottom: theme.spacing.md,
      lineHeight: 20,
    },
    warningContainer: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      backgroundColor:
        theme.mode === 'dark' ? 'rgba(255, 159, 10, 0.1)' : '#FFF3CD',
      padding: theme.spacing.md,
      borderRadius: theme.borderRadius.lg,
      marginBottom: theme.spacing.lg,
      borderLeftWidth: 3,
      borderLeftColor: theme.colors.warning,
    },
    warningText: {
      flex: 1,
      marginLeft: theme.spacing.sm,
      fontSize: 13,
      color: theme.mode === 'dark' ? theme.colors.warning : '#856404',
      lineHeight: 18,
    },
    inputContainer: {
      position: 'relative',
      marginBottom: theme.spacing.md,
    },
    input: {
      backgroundColor: theme.colors.inputBackground,
      borderRadius: theme.borderRadius.lg,
      borderWidth: 1,
      borderColor: theme.colors.inputBorder,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.md,
      paddingRight: 50,
      fontSize: 16,
      color: theme.colors.text,
    },
    inputError: {
      borderColor: theme.colors.error,
    },
    eyeButton: {
      position: 'absolute',
      right: theme.spacing.md,
      top: 0,
      bottom: 0,
      justifyContent: 'center',
    },
    strengthContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: theme.spacing.md,
      marginTop: -theme.spacing.sm,
    },
    strengthBar: {
      flex: 1,
      flexDirection: 'row',
      gap: 4,
    },
    strengthSegment: {
      flex: 1,
      height: 4,
      borderRadius: 2,
    },
    strengthText: {
      marginLeft: theme.spacing.md,
      fontSize: 12,
      fontWeight: '500',
    },
    errorText: {
      color: theme.colors.error,
      fontSize: 13,
      marginTop: -theme.spacing.sm,
      marginBottom: theme.spacing.sm,
    },
    buttons: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      marginTop: theme.spacing.md,
    },
    button: {
      minWidth: 96,
      paddingVertical: theme.spacing.md,
      paddingHorizontal: theme.spacing.lg,
      borderRadius: theme.borderRadius.lg,
      alignItems: 'center',
      justifyContent: 'center',
    },
    cancelButton: {
      backgroundColor: theme.colors.surface,
      marginRight: theme.spacing.md,
    },
    cancelButtonText: {
      color: theme.colors.textSecondary,
      fontSize: 15,
      fontWeight: '500',
    },
    confirmButton: {
      backgroundColor: theme.colors.primary,
    },
    confirmButtonText: {
      color: theme.colors.buttonText,
      fontSize: 15,
      fontWeight: '600',
    },
    buttonDisabled: {
      opacity: 0.6,
    },
  });
