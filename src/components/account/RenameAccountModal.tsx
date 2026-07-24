import React, { useMemo, useState } from 'react';
import {
  Modal,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { useTheme } from '@/contexts/ThemeContext';
import { Theme } from '@/constants/themes';
import KeyboardAwareScrollView from '@/components/common/KeyboardAwareScrollView';

interface RenameAccountModalProps {
  visible: boolean;
  initialName?: string;
  onCancel: () => void;
  onConfirm: (name: string) => void;
  isSubmitting?: boolean;
  accountDisplayName?: string;
}

export default function RenameAccountModal({
  visible,
  initialName = '',
  onCancel,
  onConfirm,
  isSubmitting = false,
  accountDisplayName,
}: RenameAccountModalProps) {
  const styles = useThemedStyles(createStyles);
  const { theme } = useTheme();
  const colors = createColors(theme);
  const [name, setName] = useState(initialName);
  const [hasEdited, setHasEdited] = useState(false);

  // Reset the editable fields the moment the modal transitions to visible (or
  // its initialName changes while open) by adjusting state during render off a
  // tracked previous value — the React-canonical replacement for the old
  // reset-in-effect. Resets at the exact same logical moment the effect did
  // (visible/initialName change) without the extra post-paint render pass.
  const [prevResetKey, setPrevResetKey] = useState<string | null>(null);
  const resetKey = visible ? `open:${initialName}` : null;
  if (resetKey !== null && resetKey !== prevResetKey) {
    setPrevResetKey(resetKey);
    setName(initialName);
    setHasEdited(false);
  } else if (resetKey === null && prevResetKey !== null) {
    setPrevResetKey(null);
  }

  const trimmedName = useMemo(() => name.trim(), [name]);
  const isNameValid = trimmedName.length > 0;

  const handleConfirm = () => {
    setHasEdited(true);
    if (!isNameValid || isSubmitting) {
      return;
    }

    onConfirm(trimmedName);
  };

  const validationMessage =
    !isNameValid && hasEdited ? 'Account name cannot be empty.' : undefined;

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
            <Text style={styles.title}>Rename Account</Text>
            <Text style={styles.message}>
              Choose a new name for this account.
            </Text>
            {accountDisplayName && (
              <Text style={styles.accountDetailsText} numberOfLines={2}>
                {accountDisplayName}
              </Text>
            )}

            <TextInput
              style={[
                styles.input,
                !isNameValid && hasEdited && styles.inputError,
              ]}
              value={name}
              onChangeText={(text) => {
                setName(text);
                if (!hasEdited) {
                  setHasEdited(true);
                }
              }}
              placeholder="Account name"
              placeholderTextColor={colors.placeholderColor}
              autoFocus
              editable={!isSubmitting}
              maxLength={40}
              returnKeyType="done"
              onSubmitEditing={handleConfirm}
            />

            {validationMessage && (
              <Text style={styles.validationText}>{validationMessage}</Text>
            )}

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
                  (!isNameValid || isSubmitting) && styles.buttonDisabled,
                ]}
                onPress={handleConfirm}
                disabled={!isNameValid || isSubmitting}
              >
                {isSubmitting ? (
                  <ActivityIndicator
                    size="small"
                    color={theme.colors.buttonText}
                  />
                ) : (
                  <Text style={styles.confirmButtonText}>Save</Text>
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
      width: '100%',
      maxWidth: 420,
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
      fontSize: 16,
      color: theme.colors.textSecondary,
      textAlign: 'center',
      marginTop: theme.spacing.sm,
      marginBottom: theme.spacing.lg,
    },
    accountDetailsText: {
      fontSize: 15,
      color: theme.colors.text,
      textAlign: 'center',
      marginBottom: theme.spacing.md,
    },
    input: {
      backgroundColor: theme.colors.inputBackground,
      borderRadius: theme.borderRadius.lg,
      borderWidth: 1,
      borderColor: theme.colors.inputBorder,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.lg,
      fontSize: 16,
      color: theme.colors.text,
    },
    inputError: {
      borderColor: theme.colors.error,
    },
    validationText: {
      color: theme.colors.error,
      fontSize: 13,
      marginTop: 6,
    },
    buttons: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      marginTop: theme.spacing.lg,
    },
    button: {
      minWidth: 96,
      paddingVertical: theme.spacing.lg,
      paddingHorizontal: theme.spacing.lg,
      borderRadius: theme.borderRadius.lg,
      alignItems: 'center',
      justifyContent: 'center',
    },
    cancelButton: {
      backgroundColor: theme.colors.surface,
      marginRight: theme.spacing.lg,
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

// Raw color string kept out of StyleSheet.create (RN NamedStyles rejects
// string values); referenced directly as a color prop.
const createColors = (theme: Theme) => ({
  placeholderColor: theme.colors.placeholder,
});
