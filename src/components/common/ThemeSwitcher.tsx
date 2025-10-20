import React, { useMemo } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Modal,
  FlatList,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Theme } from '@/constants/themes';
import { EdgeInsets, useSafeAreaInsets } from 'react-native-safe-area-context';

interface ThemeSwitcherProps {
  visible: boolean;
  onClose: () => void;
  currentTheme: 'light' | 'dark' | 'system';
  onThemeSelect: (theme: 'light' | 'dark' | 'system') => void;
  theme: Theme;
}

interface ThemeItemProps {
  themeValue: 'light' | 'dark' | 'system';
  label: string;
  isSelected: boolean;
  onSelect: (theme: 'light' | 'dark' | 'system') => void;
  theme: Theme;
  styles: ReturnType<typeof createStyles>;
}

const THEME_OPTIONS: ReadonlyArray<{
  label: string;
  value: 'light' | 'dark' | 'system';
}> = [
  { label: 'Light', value: 'light' },
  { label: 'Dark', value: 'dark' },
  { label: 'System Default', value: 'system' },
];

const ThemeItem: React.FC<ThemeItemProps> = ({
  themeValue,
  label,
  isSelected,
  onSelect,
  theme,
  styles,
}) => {
  return (
    <TouchableOpacity
      style={[styles.themeItem, isSelected && styles.selectedThemeItem]}
      onPress={() => onSelect(themeValue)}
      disabled={isSelected}
    >
      <View style={styles.themeItemContent}>
        {/* Theme Icon */}
        <View style={styles.themeIcon}>
          <Ionicons
            name={
              themeValue === 'light'
                ? 'sunny'
                : themeValue === 'dark'
                ? 'moon'
                : 'phone-portrait'
            }
            size={20}
            color={theme.colors.text}
          />
        </View>

        {/* Theme Info */}
        <View style={styles.themeInfo}>
          <Text
            style={[
              styles.themeName,
              isSelected && styles.selectedThemeText,
            ]}
          >
            {label}
          </Text>
        </View>

        {/* Selected Indicator */}
        {isSelected && (
          <Ionicons
            name="checkmark-circle"
            size={24}
            color={theme.colors.primary}
            style={styles.selectedIcon}
          />
        )}
      </View>
    </TouchableOpacity>
  );
};

export default function ThemeSwitcher({
  visible,
  onClose,
  currentTheme,
  onThemeSelect,
  theme,
}: ThemeSwitcherProps) {
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => createStyles(theme, insets), [theme, insets]);

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View style={styles.container}>
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.title}>Theme</Text>

          <View style={styles.headerActions}>
            <TouchableOpacity style={styles.closeButton} onPress={onClose}>
              <Ionicons name="close" size={24} color={theme.colors.text} />
            </TouchableOpacity>
          </View>
        </View>

        {/* Theme List */}
        <FlatList
          data={THEME_OPTIONS}
          keyExtractor={(item) => item.value}
          renderItem={({ item }) => (
            <ThemeItem
              themeValue={item.value}
              label={item.label}
              isSelected={item.value === currentTheme}
              onSelect={onThemeSelect}
              theme={theme}
              styles={styles}
            />
          )}
          contentContainerStyle={styles.listContainer}
        />
      </View>
    </Modal>
  );
}

const createStyles = (theme: Theme, insets: EdgeInsets) =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: theme.colors.background,
      paddingTop: insets.top,
    },
    header: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingHorizontal: 20,
      paddingTop: 20,
      paddingBottom: 16,
      backgroundColor: theme.colors.surface,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
    },
    title: {
      fontSize: 24,
      fontWeight: '600',
      color: theme.colors.text,
    },
    headerActions: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 16,
    },
    closeButton: {
      padding: 4,
    },
    listContainer: {
      paddingTop: 16,
      paddingBottom: 16 + insets.bottom,
    },
    themeItem: {
      backgroundColor: theme.colors.surface,
      marginHorizontal: 16,
      marginVertical: 4,
      borderRadius: 12,
      padding: 16,
      borderWidth: 1,
      borderColor: theme.colors.border,
    },
    selectedThemeItem: {
      borderColor: theme.colors.primary,
      backgroundColor: theme.colors.surface,
    },
    themeItemContent: {
      flexDirection: 'row',
      alignItems: 'center',
    },
    themeIcon: {
      width: 40,
      height: 40,
      borderRadius: 20,
      backgroundColor: theme.colors.background,
      justifyContent: 'center',
      alignItems: 'center',
      marginRight: 12,
    },
    themeInfo: {
      flex: 1,
    },
    themeName: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.text,
    },
    selectedThemeText: {
      color: theme.colors.primary,
    },
    selectedIcon: {
      marginTop: 4,
    },
  });
