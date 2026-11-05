/**
 * The old-PIN step of an onboarding restore (TASK-504, DOC-507 section 3).
 * Shown when the device has a PIN credential but no accounts, before a backup
 * file is chosen. It only collects the PIN and reports the result; the caller
 * owns the vault. While PIN entry is paused it performs NO write: it reads the
 * stored throttle, renders, and counts down to the stored end time.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
} from 'react-native';
import { useThemedStyles, useThemeColors } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import {
  OLD_PIN_NORMAL_TEXT,
  OLD_PIN_WRONG_TEXT,
  oldPinLockedText,
} from '@/services/backup/oldPinCopy';
import { FORGOT_LINK_TEXT } from '@/services/backup/forgottenPinCopy';
import type { RestoreUnlockResult } from '@/contexts/AuthContext';

interface Props {
  unlock: (secret: string) => Promise<RestoreUnlockResult>;
  /** The stored lockout end (epoch ms), or null when PIN entry is open. A read
   *  of the stored throttle, never a screen counter. */
  readLockedUntil: () => Promise<number | null>;
  onVerified: (epoch: number) => void;
  /** "I don't remember it": leads only to the forgotten-PIN step, which needs a
   *  verified backup file and its password. Offered while PIN entry is paused
   *  too, so the screen never dead-ends. */
  onForgotten: () => void;
  now?: () => number;
}

export default function OldPinStep({
  unlock,
  readLockedUntil,
  onVerified,
  onForgotten,
  now = Date.now,
}: Props) {
  const styles = useThemedStyles(createStyles);
  const colors = useThemeColors();
  const [pin, setPin] = useState('');
  const [wrong, setWrong] = useState(false);
  const [busy, setBusy] = useState(false);
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const [tick, setTick] = useState(now());

  const refresh = useCallback(async () => {
    try {
      setLockedUntil(await readLockedUntil());
    } catch {
      // An unreadable throttle is shown as open: verifyPin itself refuses while
      // locked, without hashing or counting.
      setLockedUntil(null);
    }
  }, [readLockedUntil]);

  // The first read of the stored throttle, when the step opens.
  useEffect(() => {
    let cancelled = false;
    readLockedUntil()
      .then((value) => {
        if (!cancelled) setLockedUntil(value);
      })
      .catch(() => {
        if (!cancelled) setLockedUntil(null);
      });
    return () => {
      cancelled = true;
    };
  }, [readLockedUntil]);

  // Live countdown to the STORED end time; at the end the step returns to its
  // normal state without a relaunch.
  useEffect(() => {
    if (lockedUntil === null) return;
    const id = setInterval(() => {
      const t = now();
      setTick(t);
      if (t >= lockedUntil) {
        clearInterval(id);
        void refresh();
      }
    }, 1000);
    return () => clearInterval(id);
  }, [lockedUntil, now, refresh]);

  const locked = lockedUntil !== null && tick < lockedUntil;

  const submit = useCallback(async () => {
    if (busy || locked || !pin) return;
    setBusy(true);
    setWrong(false);
    try {
      const result = await unlock(pin);
      if (result.status === 'verified') {
        setPin('');
        onVerified(result.epoch);
        return;
      }
      setPin('');
      if (result.status === 'invalid') setWrong(true);
      await refresh();
    } finally {
      setBusy(false);
    }
  }, [busy, locked, pin, unlock, onVerified, refresh]);

  return (
    <View style={styles.container}>
      <Text style={styles.text}>
        {locked
          ? oldPinLockedText((lockedUntil ?? 0) - tick)
          : OLD_PIN_NORMAL_TEXT}
      </Text>
      {!locked && wrong && (
        <Text style={styles.error}>{OLD_PIN_WRONG_TEXT}</Text>
      )}
      {!locked && (
        <>
          <TextInput
            style={styles.input}
            value={pin}
            onChangeText={setPin}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="PIN"
            placeholderTextColor={colors.textMuted}
            accessibilityLabel="Old PIN"
            editable={!busy}
            onSubmitEditing={submit}
          />
          <TouchableOpacity
            style={styles.button}
            onPress={submit}
            disabled={busy || !pin}
            accessibilityRole="button"
          >
            <Text style={styles.buttonText}>Continue</Text>
          </TouchableOpacity>
        </>
      )}
      <TouchableOpacity
        onPress={onForgotten}
        style={styles.link}
        accessibilityRole="button"
      >
        <Text style={styles.linkText}>{FORGOT_LINK_TEXT}</Text>
      </TouchableOpacity>
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
    error: {
      fontSize: 14,
      color: theme.colors.error,
      marginBottom: theme.spacing.sm,
    },
    input: {
      borderWidth: 1,
      borderColor: theme.colors.borderLight,
      borderRadius: 8,
      padding: theme.spacing.md,
      color: theme.colors.text,
      marginBottom: theme.spacing.md,
    },
    button: {
      backgroundColor: theme.colors.primary,
      borderRadius: 8,
      padding: theme.spacing.md,
      alignItems: 'center',
    },
    link: { marginTop: theme.spacing.md, alignItems: 'center' },
    linkText: { color: theme.colors.primary },
    buttonText: { color: theme.colors.buttonText, fontWeight: '600' },
  });
