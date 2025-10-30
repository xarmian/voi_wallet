import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { BlurView } from 'expo-blur';
import { Ionicons } from '@expo/vector-icons';
import AccountSelector from '../account/AccountSelector';
import { useThemedStyles, useThemeColors } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import { useTheme } from '@/contexts/ThemeContext';

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
  const { theme } = useTheme();
  const hasNFTBackground = !!theme.backgroundImageUrl;

  const headerContent = (
    <>
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
    </>
  );

  if (hasNFTBackground) {
    const blurTint = theme.mode === 'dark' ? 'dark' : 'light';
    return (
      <BlurView
        tint={blurTint}
        style={styles.header}
      >
        <View
          style={[
            styles.overlay,
            {
              backgroundColor: theme.mode === 'dark'
                ? 'rgba(0, 0, 0, 0.3)'
                : 'rgba(255, 255, 255, 0.4)',
            },
          ]}
        />
        <View style={styles.headerContent}>
          {headerContent}
        </View>
      </BlurView>
    );
  }

  return (
    <View style={styles.header}>
      {headerContent}
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
      backgroundColor: theme.backgroundImageUrl ? 'transparent' : theme.colors.surface,
      position: 'relative',
    },
    overlay: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
    },
    headerContent: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      flex: 1,
      position: 'relative',
      zIndex: 1,
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
