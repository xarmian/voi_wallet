import { useMemo } from 'react';
import { StyleSheet, ViewStyle, TextStyle } from 'react-native';
import { useTheme } from '../contexts/ThemeContext';
import { Theme, GlassEffect, TypographyStyle } from '../constants/themes';

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
      glassBackground: 'rgba(255, 255, 255, 0.72)',
      glassBorder: 'rgba(255, 255, 255, 0.5)',
      glassHighlight: 'rgba(255, 255, 255, 0.9)',
      glassShadow: 'rgba(0, 0, 0, 0.08)',
      glowPrimary: 'rgba(0, 122, 255, 0.35)',
      glowSuccess: 'rgba(48, 209, 88, 0.35)',
      glowError: 'rgba(255, 69, 58, 0.35)',
      surfaceElevated: '#FFFFFF',
      surfacePressed: 'rgba(0, 0, 0, 0.04)',
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

// Glass effect utilities
export const useThemeGlass = () => {
  const { theme } = useTheme();
  return theme.glass;
};

export const useThemeGlowShadows = () => {
  const { theme } = useTheme();
  return theme.glowShadows;
};

export const useThemeGradients = () => {
  const { theme } = useTheme();
  return theme.gradients;
};

export const useThemeTypography = () => {
  const { theme } = useTheme();
  return theme.typography;
};

export const useThemeAnimation = () => {
  const { theme } = useTheme();
  return theme.animation;
};

// Utility hook to get glass container styles for a specific variant
export const useGlassStyle = (
  variant: 'light' | 'medium' | 'heavy' | 'chromatic' = 'medium'
): ViewStyle => {
  const { theme } = useTheme();
  const glass = theme.glass[variant];

  return useMemo(
    () => ({
      backgroundColor: glass.backgroundColor,
      borderColor: glass.borderColor,
      borderWidth: glass.borderWidth,
      overflow: 'hidden' as const,
    }),
    [glass]
  );
};

// Utility hook to get typography styles
export const useTypographyStyle = (
  variant: keyof Theme['typography']
): TextStyle => {
  const { theme } = useTheme();
  const typo = theme.typography[variant];

  return useMemo(
    () => ({
      fontSize: typo.fontSize,
      fontWeight: typo.fontWeight,
      lineHeight: typo.lineHeight,
      letterSpacing: typo.letterSpacing,
      color: theme.colors.text,
    }),
    [typo, theme.colors.text]
  );
};

// Get glass effect config (blur, tint, etc.) for use with BlurView
export const useGlassConfig = (
  variant: 'light' | 'medium' | 'heavy' | 'chromatic' = 'medium'
): GlassEffect => {
  const { theme } = useTheme();
  return theme.glass[variant];
};
