/**
 * The consent screen of the forgotten-PIN step (TASK-504, DOC-507 5.3). Pure
 * display and two buttons; the caller runs the step. Nothing is written here:
 * Cancel leaves the device unchanged. On an incomplete file Cancel is the
 * default and the action is the secondary button, enabled only after the user
 * types the confirm word (product b0ca7d55).
 */
import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
} from 'react-native';
import { useThemedStyles, useThemeColors } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import type { BackupInfo } from '@/services/backup';
import {
  CANCEL_BUTTON_TEXT,
  CONFIRM_WORD,
  CONFIRM_WORD_HINT,
  REMOVE_BUTTON_TEXT,
  forgottenPinConsentText,
  forgottenPinIncompleteWarning,
  forgottenPinNotAddedRows,
  forgottenPinUnavailable,
} from '@/services/backup/forgottenPinCopy';

interface Props {
  info: BackupInfo;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ForgottenPinConsent({
  info,
  onConfirm,
  onCancel,
}: Props) {
  const styles = useThemedStyles(createStyles);
  const colors = useThemeColors();
  const [typed, setTyped] = useState('');
  const unavailable = forgottenPinUnavailable(info.restorePlan);
  const warning = forgottenPinIncompleteWarning(info);
  const rows = forgottenPinNotAddedRows(info.restorePlan);
  const armed = warning === null || typed.trim() === CONFIRM_WORD;

  if (unavailable) {
    return (
      <View style={styles.container}>
        <Text style={styles.text}>{unavailable}</Text>
        <TouchableOpacity style={styles.primary} onPress={onCancel}>
          <Text style={styles.primaryText}>{CANCEL_BUTTON_TEXT}</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.text}>
        {forgottenPinConsentText(info.restorePlan)}
      </Text>
      {rows.map((row, i) => (
        <Text key={`n-${i}`} style={styles.row}>
          {row.label} ({row.shortAddress}): {row.text}
        </Text>
      ))}
      {warning && (
        <>
          <Text style={[styles.text, { color: colors.error }]}>
            {warning.text}
          </Text>
          {warning.rows.map((row, i) => (
            <View key={`w-${i}`}>
              <Text style={styles.row}>
                {row.label} ({row.shortAddress})
              </Text>
              {row.text && <Text style={styles.row}>{row.text}</Text>}
            </View>
          ))}
          <TextInput
            style={styles.input}
            value={typed}
            onChangeText={setTyped}
            autoCapitalize="characters"
            autoCorrect={false}
            placeholder={CONFIRM_WORD_HINT}
            placeholderTextColor={colors.textMuted}
            accessibilityLabel="Confirm word"
          />
        </>
      )}
      {warning ? (
        <>
          <TouchableOpacity style={styles.primary} onPress={onCancel}>
            <Text style={styles.primaryText}>{CANCEL_BUTTON_TEXT}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.secondary, !armed && styles.disabled]}
            onPress={onConfirm}
            disabled={!armed}
            accessibilityState={{ disabled: !armed }}
          >
            <Text style={styles.secondaryText}>{REMOVE_BUTTON_TEXT}</Text>
          </TouchableOpacity>
        </>
      ) : (
        <>
          <TouchableOpacity style={styles.primary} onPress={onConfirm}>
            <Text style={styles.primaryText}>{REMOVE_BUTTON_TEXT}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.secondary} onPress={onCancel}>
            <Text style={styles.secondaryText}>{CANCEL_BUTTON_TEXT}</Text>
          </TouchableOpacity>
        </>
      )}
    </View>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    container: { marginBottom: theme.spacing.lg },
    text: {
      fontSize: 15,
      color: theme.colors.text,
      marginBottom: theme.spacing.md,
    },
    row: {
      fontSize: 14,
      color: theme.colors.text,
      marginBottom: theme.spacing.xs,
    },
    input: {
      borderWidth: 1,
      borderColor: theme.colors.borderLight,
      borderRadius: 8,
      padding: theme.spacing.md,
      color: theme.colors.text,
      marginVertical: theme.spacing.md,
    },
    primary: {
      backgroundColor: theme.colors.primary,
      borderRadius: 8,
      padding: theme.spacing.md,
      alignItems: 'center',
      marginBottom: theme.spacing.sm,
    },
    primaryText: { color: theme.colors.buttonText, fontWeight: '600' },
    secondary: {
      borderWidth: 1,
      borderColor: theme.colors.borderLight,
      borderRadius: 8,
      padding: theme.spacing.md,
      alignItems: 'center',
    },
    secondaryText: { color: theme.colors.text },
    disabled: { opacity: 0.4 },
  });
