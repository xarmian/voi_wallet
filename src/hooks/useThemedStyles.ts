import { useMemo } from 'react';
import { StyleSheet, ViewStyle, TextStyle } from 'react-native';
import { useTheme } from '../contexts/ThemeContext';
import { Theme, GlassEffect } from '../constants/themes';

export const useThemedStyles = <T extends StyleSheet.NamedStyles<T>>(
  styleFactory: (theme: Theme) => T
): T => {
  const { theme } = useTheme();

  return useMemo(() => {
    try {
      return styleFactory(theme);
    } catch {
      console.warn(
        'useThemedStyles: Error creating styles, using empty styles'
      );
      return {} as T;
    }
  }, [theme, styleFactory]);
};

export const useThemeColors = () => {
  // useTheme() never throws — it already falls back to lightTheme when the
  // ThemeProvider is absent (see ThemeContext) — so the previous try/catch was
  // unreachable and violated rules-of-hooks (hook called inside a try block).
  const { theme } = useTheme();
  return theme.colors;
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
