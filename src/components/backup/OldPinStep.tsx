/**
 * The old-PIN step of an onboarding restore (TASK-504, DOC-507 section 3).
 * Shown when the device has a PIN credential but no accounts, before a backup
 * file is chosen. It only collects the PIN and reports the result; the caller
 * owns the vault. While PIN entry is paused it performs NO write: it reads the
 * stored throttle, renders, and counts down to the stored end time.
 *
 * TASK-509: when the caller can offer it, a biometric button reads the old PIN
 * saved for biometric unlock (on a reinstalled phone the keychain keeps it) and
 * the caller checks it exactly as a typed PIN. The step only sees the result;
 * the secret never reaches it. Nothing is read until the button is tapped.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useThemedStyles, useThemeColors } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import {
  BIOMETRIC_CANCELLED_TEXT,
  BIOMETRIC_INVALID_TEXT,
  BIOMETRIC_NO_ITEM_TEXT,
  BIOMETRIC_UNAVAILABLE_TEXT,
  BIOMETRIC_UNLOCK_LABEL,
  OLD_PIN_NORMAL_TEXT,
  OLD_PIN_WRONG_TEXT,
  oldPinLockedText,
} from '@/services/backup/oldPinCopy';
import { FORGOT_LINK_TEXT } from '@/services/backup/forgottenPinCopy';
import type {
  BiometricRestoreUnlockResult,
  RestoreUnlockResult,
} from '@/contexts/AuthContext';

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
  /** Whether to show the biometric button. Run once when the step opens; it
   *  must only read, never prompt. A throw hides the button. */
  canOfferBiometric?: () => Promise<boolean>;
  /** Run on a tap of the biometric button. */
  unlockWithBiometric?: () => Promise<BiometricRestoreUnlockResult>;
  now?: () => number;
}

const BIOMETRIC_LINES: Partial<
  Record<BiometricRestoreUnlockResult['status'], string>
> = {
  no_item: BIOMETRIC_NO_ITEM_TEXT,
  biometric_cancelled: BIOMETRIC_CANCELLED_TEXT,
  invalid: BIOMETRIC_INVALID_TEXT,
  cancelled: BIOMETRIC_CANCELLED_TEXT,
  unavailable: BIOMETRIC_UNAVAILABLE_TEXT,
};

// After these the button is hidden for the rest of the step: a stale saved PIN
// would cost another try, and a missing or unusable one would only prompt
// again. A cancelled prompt or check keeps the button for a retry.
const BIOMETRIC_HIDE_AFTER: ReadonlySet<
  BiometricRestoreUnlockResult['status']
> = new Set(['invalid', 'no_item', 'unavailable']);

export default function OldPinStep({
  unlock,
  readLockedUntil,
  onVerified,
  onForgotten,
  canOfferBiometric,
  unlockWithBiometric,
  now = Date.now,
}: Props) {
  const styles = useThemedStyles(createStyles);
  const colors = useThemeColors();
  const [pin, setPin] = useState('');
  const [wrong, setWrong] = useState(false);
  const [busy, setBusy] = useState(false);
  const [biometricOffered, setBiometricOffered] = useState(false);
  const [biometricLine, setBiometricLine] = useState<string | null>(null);
  // Set before the first await, so a second tap that lands before React
  // re-renders with `busy` cannot start a second check (and a second prompt).
  const biometricInFlight = useRef(false);
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

  // Whether the biometric button is offered, read once when the step opens.
  useEffect(() => {
    if (!canOfferBiometric) return;
    let cancelled = false;
    canOfferBiometric()
      .then((value) => {
        if (!cancelled) setBiometricOffered(value === true);
      })
      .catch(() => {
        if (!cancelled) setBiometricOffered(false);
      });
    return () => {
      cancelled = true;
    };
  }, [canOfferBiometric]);

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
    setBiometricLine(null);
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

  // One authentication at a time: shares `busy` with the PIN submit. The
  // forgotten link does not wait on it.
  const submitBiometric = useCallback(async () => {
    if (biometricInFlight.current || busy || locked || !unlockWithBiometric) {
      return;
    }
    biometricInFlight.current = true;
    setBusy(true);
    setWrong(false);
    setBiometricLine(null);
    try {
      const result = await unlockWithBiometric();
      if (result.status === 'verified') {
        setPin('');
        onVerified(result.epoch);
        return;
      }
      // A stale saved PIN counts as a wrong try, so the throttle is re-read
      // after every outcome, as after a PIN submit.
      const line = BIOMETRIC_LINES[result.status];
      if (line) setBiometricLine(line);
      if (BIOMETRIC_HIDE_AFTER.has(result.status)) setBiometricOffered(false);
      await refresh();
    } catch {
      setBiometricLine(BIOMETRIC_CANCELLED_TEXT);
    } finally {
      biometricInFlight.current = false;
      setBusy(false);
    }
  }, [busy, locked, unlockWithBiometric, onVerified, refresh]);

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
      {!locked && !wrong && biometricLine && (
        <Text style={styles.error}>{biometricLine}</Text>
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
          {biometricOffered && unlockWithBiometric && (
            <TouchableOpacity
              style={styles.biometricButton}
              onPress={submitBiometric}
              disabled={busy}
              accessibilityRole="button"
            >
              <Ionicons name="finger-print" size={24} color={colors.primary} />
              <Text style={styles.biometricText}>{BIOMETRIC_UNLOCK_LABEL}</Text>
            </TouchableOpacity>
          )}
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
    biometricButton: {
      marginTop: theme.spacing.md,
      padding: theme.spacing.md,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: theme.colors.primary,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
    },
    biometricText: {
      color: theme.colors.primary,
      fontWeight: '600',
      marginLeft: theme.spacing.sm,
    },
    link: { marginTop: theme.spacing.md, alignItems: 'center' },
    linkText: { color: theme.colors.primary },
    buttonText: { color: theme.colors.buttonText, fontWeight: '600' },
  });
