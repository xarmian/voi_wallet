import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useViewMode, useWalletStore } from '@/store/walletStore';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';

interface ViewModeToggleProps {
  size?: 'small' | 'medium' | 'large';
  showLabel?: boolean;
  disabled?: boolean;
}

export default function ViewModeToggle({
  size = 'medium',
  showLabel = true,
  disabled = false,
}: ViewModeToggleProps) {
  const viewMode = useViewMode();
  const toggleViewMode = useWalletStore((state) => state.toggleViewMode);
  const styles = useThemedStyles(createStyles);

  const isMultiNetwork = viewMode === 'multi-network';

  const sizeStyles = {
    small: {
      iconSize: 16,
      fontSize: 12,
      padding: 6,
    },
    medium: {
      iconSize: 20,
      fontSize: 14,
      padding: 8,
    },
    large: {
      iconSize: 24,
      fontSize: 16,
      padding: 10,
    },
  }[size];

  const handleToggle = () => {
    if (!disabled) {
      toggleViewMode();
    }
  };

  return (
    <TouchableOpacity
      style={[
        styles.container,
        { padding: sizeStyles.padding },
        isMultiNetwork && styles.activeContainer,
        disabled && styles.disabledContainer,
      ]}
      onPress={handleToggle}
      disabled={disabled}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel={`Switch to ${isMultiNetwork ? 'single' : 'multi'} network view`}
      accessibilityHint="Toggles between viewing assets from one network or all networks combined"
    >
      <View style={styles.content}>
        <Ionicons
          name={isMultiNetwork ? 'layers' : 'layers-outline'}
          size={sizeStyles.iconSize}
          color={isMultiNetwork ? styles.activeIcon.color : styles.icon.color}
        />
        {showLabel && (
          <Text
            style={[
              styles.label,
              { fontSize: sizeStyles.fontSize },
              isMultiNetwork && styles.activeLabel,
              disabled && styles.disabledLabel,
            ]}
          >
            {isMultiNetwork ? 'All Networks' : 'Current Network'}
          </Text>
        )}
      </View>
    </TouchableOpacity>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    container: {
      flexDirection: 'row',
      alignItems: 'center',
      borderRadius: theme.borderRadius.md,
      backgroundColor: theme.colors.surface,
      borderWidth: 1,
      borderColor: theme.colors.border,
    },
    activeContainer: {
      backgroundColor: theme.colors.surface,
      borderColor: theme.colors.primary,
    },
    disabledContainer: {
      opacity: 0.5,
    },
    content: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
    },
    icon: {
      color: theme.colors.textSecondary,
    },
    activeIcon: {
      color: theme.colors.primary,
    },
    label: {
      fontWeight: '500',
      color: theme.colors.text,
    },
    activeLabel: {
      color: theme.colors.primary,
      fontWeight: '600',
    },
    disabledLabel: {
      color: theme.colors.textMuted,
    },
  });
