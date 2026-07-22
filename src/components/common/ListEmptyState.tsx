/**
 * ListEmptyState - shared icon + title + subtitle empty state for lists.
 *
 * Consolidates the near-identical empty states that were re-declared per
 * screen. Designed to be passed by reference as `ListEmptyComponent` so the
 * list only evaluates it when the data set is actually empty.
 */

import React from 'react';
import { StyleProp, StyleSheet, Text, View, ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/contexts/ThemeContext';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';

interface ListEmptyStateProps {
  /** Ionicons glyph rendered above the title. */
  icon?: React.ComponentProps<typeof Ionicons>['name'];
  iconSize?: number;
  /** Icon color (defaults to the theme muted text color). */
  iconColor?: string;
  title: string;
  subtitle?: string;
  /** Optional call-to-action rendered below the subtitle. */
  action?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export const ListEmptyState: React.FC<ListEmptyStateProps> = ({
  icon,
  iconSize = 64,
  iconColor,
  title,
  subtitle,
  action,
  style,
  testID,
}) => {
  const styles = useThemedStyles(createStyles);
  const { theme } = useTheme();

  return (
    <View style={[styles.container, style]} testID={testID}>
      {!!icon && (
        <Ionicons
          name={icon}
          size={iconSize}
          color={iconColor ?? theme.colors.textMuted}
        />
      )}
      <Text style={styles.title}>{title}</Text>
      {!!subtitle && <Text style={styles.subtitle}>{subtitle}</Text>}
      {action}
    </View>
  );
};

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    container: {
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: theme.spacing.xl,
      paddingHorizontal: theme.spacing.xl,
    },
    title: {
      fontSize: 20,
      fontWeight: '600',
      color: theme.colors.text,
      marginTop: theme.spacing.md,
      marginBottom: theme.spacing.xs,
      textAlign: 'center',
    },
    subtitle: {
      fontSize: 16,
      color: theme.colors.textMuted,
      textAlign: 'center',
      lineHeight: 22,
      paddingHorizontal: theme.spacing.md,
    },
  });

export default ListEmptyState;
