/**
 * ListFooterSpinner - shared "loading more" footer for virtualized lists.
 *
 * Replaces the near-identical inline footer that was duplicated across every
 * paginated list in the app. Pass `visible` so callers can keep using
 * `ListFooterComponent={<ListFooterSpinner visible={isLoadingMore} />}`
 * without re-implementing the null case.
 */

import React from 'react';
import {
  ActivityIndicator,
  StyleProp,
  StyleSheet,
  Text,
  View,
  ViewStyle,
} from 'react-native';
import { useTheme } from '@/contexts/ThemeContext';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';

interface ListFooterSpinnerProps {
  /** Render nothing when false (default true). */
  visible?: boolean;
  /** Optional label rendered under the spinner. */
  text?: string;
  size?: 'small' | 'large';
  /** Spinner color (defaults to the theme primary). */
  color?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export const ListFooterSpinner: React.FC<ListFooterSpinnerProps> = ({
  visible = true,
  text,
  size = 'small',
  color,
  style,
  testID,
}) => {
  const styles = useThemedStyles(createStyles);
  const { theme } = useTheme();

  if (!visible) {
    return null;
  }

  return (
    <View style={[styles.container, style]} testID={testID}>
      <ActivityIndicator size={size} color={color ?? theme.colors.primary} />
      {!!text && <Text style={styles.text}>{text}</Text>}
    </View>
  );
};

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    container: {
      paddingVertical: theme.spacing.md,
      alignItems: 'center',
    },
    text: {
      fontSize: 14,
      color: theme.colors.textSecondary,
      marginTop: theme.spacing.xs,
    },
  });

export default ListFooterSpinner;
