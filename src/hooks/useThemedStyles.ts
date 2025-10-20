import { useMemo } from 'react';
import { StyleSheet } from 'react-native';
import { useTheme } from '../contexts/ThemeContext';
import { Theme } from '../constants/themes';

export const useThemedStyles = <T extends StyleSheet.NamedStyles<T>>(
  styleFactory: (theme: Theme) => T
): T => {
  const { theme } = useTheme();

  return useMemo(() => {
    try {
      return styleFactory(theme);
    } catch (error) {
      console.warn(
        'useThemedStyles: Error creating styles, using empty styles'
      );
      return {} as T;
    }
  }, [theme, styleFactory]);
};

export const useThemeColors = () => {
  try {
    const { theme } = useTheme();
    return theme.colors;
  } catch (error) {
    console.warn(
      'useThemeColors: Theme context not available, using default theme'
    );
    // Return a default theme to prevent crashes
    return {
      primary: '#007AFF',
      primaryDark: '#0051D8',
      secondary: '#5856D6',
      background: '#FFFFFF',
      surface: '#F8F9FA',
      card: '#FFFFFF',
      text: '#000000',
      textSecondary: '#3C3C43',
      textMuted: '#8E8E93',
      placeholder: '#8E8E93',
      border: '#C6C6C8',
      borderLight: '#E5E5EA',
      success: '#34C759',
      warning: '#FF9500',
      error: '#FF3B30',
      info: '#007AFF',
      statusBar: 'dark-content' as const,
      tabIconActive: '#007AFF',
      tabIconInactive: '#8E8E93',
      tabBackground: '#FFFFFF',
      inputBackground: '#FFFFFF',
      inputBorder: '#C6C6C8',
      buttonBackground: '#007AFF',
      buttonText: '#FFFFFF',
      modalBackground: '#FFFFFF',
      overlay: 'rgba(0, 0, 0, 0.4)',
      shadow: '#000000',
    };
  }
};

export const useThemeSpacing = () => {
  const { theme } = useTheme();
  return theme.spacing;
};

export const useThemeBorderRadius = () => {
  const { theme } = useTheme();
  return theme.borderRadius;
};

export const useThemeShadows = () => {
  const { theme } = useTheme();
  return theme.shadows;
};
