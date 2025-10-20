import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import AccountSelector from '../account/AccountSelector';
import { useThemedStyles, useThemeColors } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';

interface UniversalHeaderProps {
  title: string;
  subtitle?: string;
  onAccountSelectorPress: () => void;
  showAccountSelector?: boolean;
  showBackButton?: boolean;
  onBackPress?: () => void;
}

export default function UniversalHeader({
  title,
  subtitle,
  onAccountSelectorPress,
  showAccountSelector = true,
  showBackButton = false,
  onBackPress,
}: UniversalHeaderProps) {
  const styles = useThemedStyles(createStyles);
  const themeColors = useThemeColors();

  return (
    <View style={styles.header}>
      {showBackButton && (
        <TouchableOpacity
          style={styles.backButton}
          onPress={onBackPress}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Ionicons name="chevron-back" size={28} color={themeColors.text} />
        </TouchableOpacity>
      )}

      <View style={styles.titleContainer}>
        <Text style={styles.title}>{title}</Text>
        {subtitle && <Text style={styles.subtitle}>{subtitle}</Text>}
      </View>

      {showAccountSelector && (
        <View style={styles.accountSelectorContainer}>
          <AccountSelector
            onPress={onAccountSelectorPress}
            compact={true}
            showBalance={false}
          />
        </View>
      )}
    </View>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    header: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingHorizontal: 20,
      paddingVertical: 15,
      backgroundColor: theme.colors.surface,
    },
    backButton: {
      marginRight: 12,
      padding: 4,
    },
    titleContainer: {
      flex: 1,
    },
    title: {
      fontSize: 24,
      fontWeight: 'bold',
      color: theme.colors.text,
    },
    subtitle: {
      fontSize: 14,
      color: theme.colors.textSecondary,
      marginTop: 2,
    },
    accountSelectorContainer: {
      maxWidth: 200,
      minWidth: 140,
    },
  });
