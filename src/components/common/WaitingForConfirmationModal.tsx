import React from 'react';
import { ActivityIndicator, Modal, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { useTheme } from '@/contexts/ThemeContext';
import { Theme } from '@/constants/themes';

interface WaitingForConfirmationModalProps {
  visible: boolean;
  title?: string;
  message?: string;
  subMessage?: string;
}

/**
 * Displays a blocking modal while we wait for network confirmation.
 * Keeps users on the current screen but communicates that we are still submitting.
 */
export default function WaitingForConfirmationModal({
  visible,
  title = 'Waiting for confirmation',
  message = 'Your transaction has been submitted to the network.',
  subMessage = 'This may take a few seconds.',
}: WaitingForConfirmationModalProps) {
  const styles = useThemedStyles(createStyles);
  const { theme } = useTheme();
  const colors = createColors(theme);

  return (
    <Modal
      visible={visible}
      animationType="fade"
      transparent
      statusBarTranslucent
    >
      <View style={styles.overlay}>
        <View style={styles.container}>
          <Ionicons
            name="time-outline"
            size={48}
            color={colors.iconColor}
            style={styles.icon}
          />
          <Text style={styles.title}>{title}</Text>
          <Text style={styles.message}>{message}</Text>
          <Text style={styles.subMessage}>{subMessage}</Text>
          <ActivityIndicator
            size="large"
            color={colors.spinnerColor}
            style={styles.spinner}
          />
        </View>
      </View>
    </Modal>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    overlay: {
      flex: 1,
      backgroundColor: 'rgba(15, 23, 42, 0.65)',
      alignItems: 'center',
      justifyContent: 'center',
      padding: theme.spacing.lg,
    },
    container: {
      width: '100%',
      borderRadius: theme.borderRadius.xl,
      padding: theme.spacing.xl,
      backgroundColor: theme.colors.card,
      alignItems: 'center',
    },
    icon: {
      marginBottom: theme.spacing.md,
    },
    title: {
      fontSize: 20,
      fontWeight: '700',
      color: theme.colors.text,
      textAlign: 'center',
      marginBottom: theme.spacing.sm,
    },
    message: {
      fontSize: 16,
      color: theme.colors.textSecondary,
      textAlign: 'center',
    },
    subMessage: {
      fontSize: 14,
      color: theme.colors.textSecondary,
      opacity: 0.8,
      textAlign: 'center',
      marginTop: theme.spacing.xs,
    },
    spinner: {
      marginTop: theme.spacing.lg,
    },
  });

// Raw color strings kept out of StyleSheet.create (RN NamedStyles rejects
// string values); referenced directly as color props.
const createColors = (theme: Theme) => ({
  iconColor: theme.colors.primary,
  spinnerColor: theme.colors.primary,
});
