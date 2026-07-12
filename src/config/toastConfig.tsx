import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { BaseToast, ErrorToast, InfoToast } from 'react-native-toast-message';
import { Ionicons } from '@expo/vector-icons';
import type { Theme } from '../constants/themes';

/**
 * Build the react-native-toast-message config for the active theme.
 *
 * Previously this was a static object with hardcoded light-mode colors
 * (#FFFFFF backgrounds, #1F2937/#4B5563 text, #EFF6FF badge), so every toast
 * rendered as a bright white card in dark mode. It is now a factory of the
 * current Theme; App.tsx memoizes it on `theme`, so toasts shown after a theme
 * change pick up the correct palette (react-native-toast-message reads the
 * config when a toast is displayed).
 */
export const createToastConfig = (theme: Theme) => {
  const { colors } = theme;
  const styles = createStyles(theme);

  return {
    success: (props: any) => (
      <BaseToast
        {...props}
        style={styles.successToast}
        contentContainerStyle={styles.contentContainer}
        text1Style={styles.text1}
        text2Style={styles.text2}
        text1NumberOfLines={2}
        text2NumberOfLines={3}
        renderLeadingIcon={() => (
          <View style={styles.iconContainer}>
            <Ionicons
              name="checkmark-circle"
              size={32}
              color={colors.success}
            />
          </View>
        )}
      />
    ),

    error: (props: any) => (
      <ErrorToast
        {...props}
        style={styles.errorToast}
        contentContainerStyle={styles.contentContainer}
        text1Style={styles.text1}
        text2Style={styles.text2}
        text1NumberOfLines={2}
        text2NumberOfLines={3}
        renderLeadingIcon={() => (
          <View style={styles.iconContainer}>
            <Ionicons name="close-circle" size={32} color={colors.error} />
          </View>
        )}
      />
    ),

    info: (props: any) => (
      <InfoToast
        {...props}
        style={styles.infoToast}
        contentContainerStyle={styles.contentContainer}
        text1Style={styles.text1}
        text2Style={styles.text2}
        text1NumberOfLines={2}
        text2NumberOfLines={3}
        renderLeadingIcon={() => (
          <View style={styles.iconContainer}>
            <Ionicons name="information-circle" size={32} color={colors.info} />
          </View>
        )}
      />
    ),

    walletConnectSuccess: ({ text1, text2, props }: any) => (
      <View style={styles.customToast}>
        <View style={styles.customHeader}>
          <Ionicons name="checkmark-circle" size={36} color={colors.success} />
          <Text style={styles.customTitle}>{text1}</Text>
        </View>
        <Text style={styles.customMessage}>{text2}</Text>
        {props?.queueSize > 0 && (
          <View style={styles.queueBadge}>
            <Ionicons name="list" size={16} color={colors.info} />
            <Text style={styles.queueText}>
              {props.queueSize} more request{props.queueSize > 1 ? 's' : ''}{' '}
              pending
            </Text>
          </View>
        )}
      </View>
    ),

    walletConnectRejected: ({ text1, text2, props }: any) => (
      <View style={[styles.customToast, styles.rejectedToast]}>
        <View style={styles.customHeader}>
          <Ionicons name="close-circle" size={36} color={colors.warning} />
          <Text style={styles.customTitle}>{text1}</Text>
        </View>
        <Text style={styles.customMessage}>{text2}</Text>
        {props?.queueSize > 0 && (
          <View style={styles.queueBadge}>
            <Ionicons name="list" size={16} color={colors.info} />
            <Text style={styles.queueText}>
              {props.queueSize} more request{props.queueSize > 1 ? 's' : ''}{' '}
              pending
            </Text>
          </View>
        )}
      </View>
    ),
  };
};

const createStyles = (theme: Theme) => {
  const { colors } = theme;

  return StyleSheet.create({
    successToast: {
      backgroundColor: colors.card,
      borderLeftColor: colors.success,
      borderLeftWidth: 6,
      height: 'auto',
      minHeight: 80,
      width: '90%',
      paddingVertical: 16,
      borderRadius: 12,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.15,
      shadowRadius: 8,
      elevation: 6,
    },
    errorToast: {
      backgroundColor: colors.card,
      borderLeftColor: colors.error,
      borderLeftWidth: 6,
      height: 'auto',
      minHeight: 80,
      width: '90%',
      paddingVertical: 16,
      borderRadius: 12,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.15,
      shadowRadius: 8,
      elevation: 6,
    },
    infoToast: {
      backgroundColor: colors.card,
      borderLeftColor: colors.info,
      borderLeftWidth: 6,
      height: 'auto',
      minHeight: 80,
      width: '90%',
      paddingVertical: 16,
      borderRadius: 12,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.15,
      shadowRadius: 8,
      elevation: 6,
    },
    contentContainer: {
      paddingHorizontal: 16,
      paddingVertical: 4,
    },
    iconContainer: {
      justifyContent: 'center',
      alignItems: 'center',
      paddingLeft: 16,
    },
    text1: {
      fontSize: 18,
      fontWeight: '700',
      color: colors.text,
      marginBottom: 4,
    },
    text2: {
      fontSize: 15,
      fontWeight: '500',
      color: colors.textSecondary,
      lineHeight: 20,
    },
    customToast: {
      width: '90%',
      backgroundColor: colors.card,
      borderRadius: 16,
      padding: 20,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 6 },
      shadowOpacity: 0.2,
      shadowRadius: 12,
      elevation: 8,
      borderLeftWidth: 6,
      borderLeftColor: colors.success,
    },
    rejectedToast: {
      borderLeftColor: colors.warning,
    },
    customHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: 12,
      gap: 12,
    },
    customTitle: {
      fontSize: 20,
      fontWeight: '700',
      color: colors.text,
      flex: 1,
    },
    customMessage: {
      fontSize: 16,
      fontWeight: '500',
      color: colors.textSecondary,
      lineHeight: 22,
      marginBottom: 8,
    },
    queueBadge: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: colors.infoLight,
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderRadius: 8,
      marginTop: 8,
      gap: 8,
    },
    queueText: {
      fontSize: 14,
      fontWeight: '600',
      color: colors.info,
    },
  });
};
