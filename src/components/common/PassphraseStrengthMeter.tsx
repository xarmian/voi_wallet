/**
 * PassphraseStrengthMeter (TASK-27 PR7)
 *
 * A small 4-segment strength bar + label for the passphrase setup/change flows.
 * GUIDANCE ONLY — the hard gate on a passphrase is the min-length floor enforced
 * by AccountSecureStorage.validateSecret. Never renders or logs the secret.
 */

import React, { useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useTheme } from '@/contexts/ThemeContext';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import {
  estimatePassphraseStrength,
  PassphraseStrengthScore,
} from '@/utils/passphraseStrength';

interface Props {
  secret: string;
  minLength: number;
}

const SEGMENTS = 4;

export function PassphraseStrengthMeter({ secret, minLength }: Props) {
  const { theme } = useTheme();
  const styles = useThemedStyles(createStyles);

  const strength = useMemo(
    () => estimatePassphraseStrength(secret, minLength),
    [secret, minLength]
  );

  // Empty field → no meter (avoids a red bar before the user has typed).
  if (!secret) {
    return null;
  }

  const colorForScore = (score: PassphraseStrengthScore): string => {
    switch (score) {
      case 0:
      case 1:
        return theme.colors.error;
      case 2:
        return theme.colors.warning;
      case 3:
        return theme.colors.primary;
      default:
        return theme.colors.success;
    }
  };

  const activeColor = colorForScore(strength.score);
  // Score 0 = "too short" (below the floor) → fill 1 segment red; else fill = score.
  const filled = strength.score === 0 ? 1 : strength.score;

  return (
    <View style={styles.container} accessibilityRole="progressbar">
      <View style={styles.bar}>
        {Array.from({ length: SEGMENTS }).map((_, i) => (
          <View
            key={i}
            style={[
              styles.segment,
              {
                backgroundColor:
                  i < filled ? activeColor : theme.colors.glassBorder,
              },
            ]}
          />
        ))}
      </View>
      <Text style={[styles.label, { color: activeColor }]}>
        {strength.meetsMinLength
          ? strength.label.charAt(0).toUpperCase() + strength.label.slice(1)
          : `At least ${minLength} characters`}
      </Text>
    </View>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    container: {
      marginTop: theme.spacing.xs,
      gap: theme.spacing.xs,
    },
    bar: {
      flexDirection: 'row',
      gap: theme.spacing.xs,
    },
    segment: {
      flex: 1,
      height: 4,
      borderRadius: 2,
    },
    label: {
      fontSize: theme.typography.caption?.fontSize ?? 12,
      fontWeight: '600',
    },
  });

export default PassphraseStrengthMeter;
