import React, { useState } from 'react';
import {
  Modal,
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
} from 'react-native';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import KeyboardAwareScrollView from '@/components/common/KeyboardAwareScrollView';

export default function DeleteAccountModal({
  accountName,
  onCancel,
  onConfirm,
}: {
  accountName: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const styles = useThemedStyles(createStyles);
  const [text, setText] = useState('');
  const enabled = text.trim() === 'DELETE';
  return (
    <Modal
      testID="delete-account-modal"
      visible
      transparent
      animationType="fade"
      onRequestClose={onCancel}
    >
      <KeyboardAwareScrollView
        contentContainerStyle={styles.overlay}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.modal} accessibilityViewIsModal>
          <Text style={styles.title} accessibilityRole="header">
            Delete account
          </Text>
          <Text style={styles.message}>
            Type DELETE to delete {accountName}.
          </Text>
          <TextInput
            accessibilityLabel="Type DELETE to confirm account deletion"
            style={styles.input}
            value={text}
            onChangeText={setText}
            autoCorrect={false}
            autoCapitalize="none"
            autoFocus
          />
          <View style={styles.buttons}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Cancel account deletion"
              onPress={onCancel}
              style={styles.button}
            >
              <Text style={styles.message}>Cancel</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Delete account"
              accessibilityState={{ disabled: !enabled }}
              disabled={!enabled}
              onPress={() => {
                if (enabled) onConfirm();
              }}
              style={[
                styles.button,
                styles.destructive,
                !enabled && styles.disabled,
              ]}
            >
              <Text style={styles.deleteText}>Delete account</Text>
            </Pressable>
          </View>
        </View>
      </KeyboardAwareScrollView>
    </Modal>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    overlay: {
      flexGrow: 1,
      justifyContent: 'center',
      alignItems: 'center',
      padding: theme.spacing.lg,
      backgroundColor: theme.colors.overlay,
    },
    modal: {
      width: '100%',
      maxWidth: 420,
      padding: theme.spacing.lg,
      borderRadius: theme.borderRadius.xl,
      backgroundColor: theme.colors.modalBackground,
    },
    title: { fontSize: 20, fontWeight: '600', color: theme.colors.text },
    message: { color: theme.colors.text, marginVertical: theme.spacing.md },
    input: {
      color: theme.colors.text,
      backgroundColor: theme.colors.inputBackground,
      borderColor: theme.colors.inputBorder,
      borderWidth: 1,
      borderRadius: theme.borderRadius.lg,
      padding: theme.spacing.md,
    },
    buttons: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      marginTop: theme.spacing.md,
    },
    button: {
      paddingHorizontal: theme.spacing.md,
      minHeight: 48,
      justifyContent: 'center',
      borderRadius: theme.borderRadius.lg,
    },
    destructive: { backgroundColor: theme.colors.error },
    deleteText: { color: theme.colors.buttonText, fontWeight: '600' },
    disabled: { opacity: 0.5 },
  });
