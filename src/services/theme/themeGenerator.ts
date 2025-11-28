import { Theme, GlassEffect, ShadowStyle, TypographyStyle } from '@/constants/themes';
import { ExtractedColors, ColorPalette } from './colorExtraction';

/**
 * Generate a Theme object from extracted NFT colors
 */
export function generateThemeFromColors(
  colors: ExtractedColors,
  preferredMode: 'light' | 'dark' = 'light',
  backgroundImageUrl?: string,
  palette?: ColorPalette
): Theme {
  // Use the preferred mode directly
  const mode = preferredMode;
  const isDark = mode === 'dark';

  // Helper to create rgba from hex with alpha
  const hexToRgba = (hex: string, alpha: number): string => {
    const rgb = hexToRgb(hex);
    if (!rgb) return `rgba(255, 255, 255, ${alpha})`;
    return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
  };

  // Use provided palette or fall back to extracted colors
  const paletteColors = palette || {
    primary: colors.primary,
    secondary: colors.secondary,
    accent: colors.accent,
  };

  // Background colors - generate first as they're needed for contrast validation
  const background = isDark
    ? darkenColor(colors.background || colors.dominant, 0.8)
    : lightenColor(colors.background || colors.dominant, 0.95);

  const surface = isDark
    ? darkenColor(colors.background || colors.dominant, 0.7)
    : lightenColor(colors.background || colors.dominant, 0.85);

  const card = isDark
    ? darkenColor(colors.background || colors.dominant, 0.6)
    : lightenColor(colors.background || colors.dominant, 0.9);

  // Tab background for contrast validation
  const tabBackground = isDark ? surface : card;

  // Generate theme colors based on selected palette with contrast validation
  // Validate against tab background since that's where primary is most commonly used
  const primary = ensureInteractiveContrast(
    paletteColors.primary,
    tabBackground,
    isDark
  );
  const primaryDark = darkenColor(primary, 0.2);
  const secondary = paletteColors.secondary;

  // Text colors - ensure contrast for accessibility
  const text = isDark
    ? lightenColor(colors.text || colors.dominant, 0.95)
    : darkenColor(colors.text || colors.dominant, 0.95);
  
  const textSecondary = isDark
    ? lightenColor(colors.text || colors.dominant, 0.7)
    : darkenColor(colors.text || colors.dominant, 0.7);
  
  const textMuted = isDark
    ? lightenColor(colors.text || colors.dominant, 0.5)
    : darkenColor(colors.text || colors.dominant, 0.5);

  // Border colors
  const border = isDark
    ? lightenColor(colors.background || colors.dominant, 0.2)
    : darkenColor(colors.background || colors.dominant, 0.1);
  
  const borderLight = isDark
    ? lightenColor(colors.background || colors.dominant, 0.1)
    : darkenColor(colors.background || colors.dominant, 0.05);

  // Semantic colors - derive from primary or use defaults
  const success = generateSemanticColor(primary, 'success', isDark);
  const warning = generateSemanticColor(primary, 'warning', isDark);
  const error = generateSemanticColor(primary, 'error', isDark);
  const info = primary;

  // UI element colors
  const inputBackground = isDark
    ? 'rgba(255, 255, 255, 0.08)'
    : 'rgba(255, 255, 255, 0.5)';
  const inputBorder = border;
  const buttonBackground = primary;
  const buttonText = ensureContrast(primary, '#FFFFFF') ? '#FFFFFF' : text;
  const modalBackground = isDark ? surface : card;
  const overlay = isDark ? 'rgba(0, 0, 0, 0.6)' : 'rgba(0, 0, 0, 0.4)';

  // Tab colors (tabBackground already defined above for contrast validation)
  const tabIconActive = primary;
  const tabIconInactive = textMuted;

  // Status bar
  const statusBar = isDark ? 'light-content' : 'dark-content';

  // Glass-specific colors derived from primary
  const glassBackground = isDark
    ? 'rgba(255, 255, 255, 0.20)'
    : 'rgba(255, 255, 255, 0.55)';
  const glassBorder = isDark
    ? 'rgba(255, 255, 255, 0.26)'
    : 'rgba(255, 255, 255, 0.4)';
  const glassHighlight = isDark
    ? 'rgba(255, 255, 255, 0.30)'
    : 'rgba(255, 255, 255, 0.7)';
  const glassShadow = isDark
    ? 'rgba(0, 0, 0, 0.4)'
    : 'rgba(0, 0, 0, 0.1)';

  // Glow colors derived from theme colors
  const glowPrimary = hexToRgba(primary, isDark ? 0.45 : 0.35);
  const glowSuccess = hexToRgba(success, isDark ? 0.45 : 0.35);
  const glowError = hexToRgba(error, isDark ? 0.45 : 0.35);

  // Surface variations
  const surfaceElevated = isDark
    ? lightenColor(surface, 0.05)
    : surface;
  const surfacePressed = isDark
    ? 'rgba(255, 255, 255, 0.08)'
    : 'rgba(0, 0, 0, 0.04)';

  // Glass effect presets
  const glass: Theme['glass'] = {
    light: {
      blur: 24,
      opacity: isDark ? 0.18 : 0.75,
      tint: isDark ? 'dark' : 'light',
      backgroundColor: isDark ? 'rgba(255, 255, 255, 0.18)' : 'rgba(255, 255, 255, 0.75)',
      borderColor: isDark ? 'rgba(255, 255, 255, 0.24)' : 'rgba(255, 255, 255, 0.5)',
      borderWidth: 1,
    },
    medium: {
      blur: 40,
      opacity: isDark ? 0.22 : 0.80,
      tint: isDark ? 'dark' : 'light',
      backgroundColor: isDark ? 'rgba(255, 255, 255, 0.22)' : 'rgba(255, 255, 255, 0.80)',
      borderColor: isDark ? 'rgba(255, 255, 255, 0.28)' : 'rgba(255, 255, 255, 0.6)',
      borderWidth: 1,
    },
    heavy: {
      blur: 60,
      opacity: isDark ? 0.28 : 0.85,
      tint: isDark ? 'dark' : 'light',
      backgroundColor: isDark ? 'rgba(255, 255, 255, 0.28)' : 'rgba(255, 255, 255, 0.85)',
      borderColor: isDark ? 'rgba(255, 255, 255, 0.35)' : 'rgba(255, 255, 255, 0.7)',
      borderWidth: 1,
    },
    chromatic: {
      blur: 40,
      opacity: isDark ? 0.20 : 0.75,
      tint: 'chromatic',
      backgroundColor: isDark ? hexToRgba(primary, 0.20) : hexToRgba(primary, 0.15),
      borderColor: isDark ? hexToRgba(primary, 0.30) : hexToRgba(primary, 0.30),
      borderWidth: 1,
    },
  };

  // Glow shadows using primary color
  const glowShadows: Theme['glowShadows'] = {
    sm: {
      shadowColor: primary,
      shadowOffset: { width: 0, height: 0 },
      shadowOpacity: isDark ? 0.35 : 0.25,
      shadowRadius: 8,
      elevation: 2,
    },
    md: {
      shadowColor: primary,
      shadowOffset: { width: 0, height: 0 },
      shadowOpacity: isDark ? 0.45 : 0.35,
      shadowRadius: 16,
      elevation: 4,
    },
    lg: {
      shadowColor: primary,
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: isDark ? 0.55 : 0.45,
      shadowRadius: 24,
      elevation: 8,
    },
  };

  // Gradients
  const gradients: Theme['gradients'] = {
    primary: [primary, primaryDark],
    glass: isDark
      ? ['rgba(255, 255, 255, 0.1)', 'rgba(255, 255, 255, 0)']
      : ['rgba(255, 255, 255, 0.2)', 'rgba(255, 255, 255, 0)'],
    background: [background, isDark ? darkenColor(background, 0.1) : lightenColor(background, 0.05)],
    shimmer: isDark
      ? ['rgba(255, 255, 255, 0)', 'rgba(255, 255, 255, 0.15)', 'rgba(255, 255, 255, 0)']
      : ['rgba(255, 255, 255, 0)', 'rgba(255, 255, 255, 0.6)', 'rgba(255, 255, 255, 0)'],
  };

  // Typography presets
  const typography: Theme['typography'] = {
    display: { fontSize: 48, fontWeight: '700', lineHeight: 56, letterSpacing: -0.5 },
    heading1: { fontSize: 32, fontWeight: '700', lineHeight: 40, letterSpacing: -0.3 },
    heading2: { fontSize: 24, fontWeight: '600', lineHeight: 32, letterSpacing: -0.2 },
    heading3: { fontSize: 20, fontWeight: '600', lineHeight: 28, letterSpacing: 0 },
    body: { fontSize: 16, fontWeight: '400', lineHeight: 24, letterSpacing: 0 },
    bodySmall: { fontSize: 14, fontWeight: '400', lineHeight: 20, letterSpacing: 0 },
    caption: { fontSize: 12, fontWeight: '500', lineHeight: 16, letterSpacing: 0.3 },
    mono: { fontSize: 14, fontWeight: '500', lineHeight: 20, letterSpacing: 0.5 },
  };

  // Animation presets
  const animation: Theme['animation'] = {
    duration: {
      instant: 100,
      fast: 150,
      normal: 250,
      slow: 400,
    },
    spring: {
      damping: 20,
      stiffness: 200,
      mass: 1,
    },
  };

  return {
    mode,
    backgroundImageUrl,
    colors: {
      primary,
      primaryDark,
      secondary,
      background,
      surface,
      card,
      text,
      textSecondary,
      textMuted,
      placeholder: textMuted,
      border,
      borderLight,
      success,
      warning,
      error,
      info,
      statusBar,
      tabIconActive,
      tabIconInactive,
      tabBackground,
      inputBackground,
      inputBorder,
      buttonBackground,
      buttonText,
      modalBackground,
      overlay,
      shadow: '#000000',
      // Glass-specific colors
      glassBackground,
      glassBorder,
      glassHighlight,
      glassShadow,
      // Glow colors
      glowPrimary,
      glowSuccess,
      glowError,
      // Surface variations
      surfaceElevated,
      surfacePressed,
    },
    spacing: {
      xs: 4,
      sm: 8,
      md: 16,
      lg: 24,
      xl: 32,
      xxl: 48,
    },
    borderRadius: {
      sm: 8,
      md: 12,
      lg: 16,
      xl: 24,
      xxl: 32,
      pill: 9999,
    },
    shadows: {
      sm: {
        shadowColor: '#000000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: isDark ? 0.3 : 0.06,
        shadowRadius: 8,
        elevation: 2,
      },
      md: {
        shadowColor: '#000000',
        shadowOffset: { width: 0, height: 8 },
        shadowOpacity: isDark ? 0.4 : 0.1,
        shadowRadius: 24,
        elevation: 4,
      },
      lg: {
        shadowColor: '#000000',
        shadowOffset: { width: 0, height: 16 },
        shadowOpacity: isDark ? 0.5 : 0.14,
        shadowRadius: 48,
        elevation: 8,
      },
    },
    glass,
    glowShadows,
    gradients,
    typography,
    animation,
  };
}

/**
 * Lighten a hex color by a percentage
 */
function lightenColor(hex: string, amount: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;

  const r = Math.min(255, Math.round(rgb.r + (255 - rgb.r) * amount));
  const g = Math.min(255, Math.round(rgb.g + (255 - rgb.g) * amount));
  const b = Math.min(255, Math.round(rgb.b + (255 - rgb.b) * amount));

  return rgbToHex(r, g, b);
}

/**
 * Darken a hex color by a percentage
 */
function darkenColor(hex: string, amount: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;

  const r = Math.max(0, Math.round(rgb.r * (1 - amount)));
  const g = Math.max(0, Math.round(rgb.g * (1 - amount)));
  const b = Math.max(0, Math.round(rgb.b * (1 - amount)));

  return rgbToHex(r, g, b);
}

/**
 * Convert hex to RGB
 */
function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const cleanHex = hex.replace('#', '');
  const fullHex =
    cleanHex.length === 3
      ? cleanHex
          .split('')
          .map((char) => char + char)
          .join('')
      : cleanHex;

  const result = /^([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(fullHex);
  return result
    ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16),
      }
    : null;
}

/**
 * Convert RGB to hex
 */
function rgbToHex(r: number, g: number, b: number): string {
  return (
    '#' +
    [r, g, b]
      .map((x) => {
        const hex = x.toString(16);
        return hex.length === 1 ? '0' + hex : hex;
      })
      .join('')
      .toUpperCase()
  );
}

/**
 * Generate semantic colors (success, warning, error) based on primary color
 */
function generateSemanticColor(
  primary: string,
  type: 'success' | 'warning' | 'error',
  isDark: boolean
): string {
  const rgb = hexToRgb(primary);
  if (!rgb) {
    // Fallback to default semantic colors
    return type === 'success'
      ? isDark
        ? '#30D158'
        : '#34C759'
      : type === 'warning'
      ? isDark
        ? '#FF9F0A'
        : '#FF9500'
      : isDark
      ? '#FF453A'
      : '#FF3B30';
  }

  // Generate semantic colors by adjusting hue
  let targetHue: number;
  if (type === 'success') {
    targetHue = 120; // Green
  } else if (type === 'warning') {
    targetHue = 40; // Orange
  } else {
    targetHue = 0; // Red
  }

  // Convert RGB to HSL for hue manipulation
  const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
  
  // Adjust hue toward target, keep saturation and lightness
  const adjustedHsl = {
    h: lerpHue(hsl.h, targetHue, 0.7),
    s: Math.min(100, hsl.s * 1.2), // Increase saturation slightly
    l: isDark ? 50 : 55, // Adjust lightness for visibility
  };

  return hslToHex(adjustedHsl.h, adjustedHsl.s, adjustedHsl.l);
}

/**
 * Convert RGB to HSL
 */
function rgbToHsl(r: number, g: number, b: number): {
  h: number;
  s: number;
  l: number;
} {
  r /= 255;
  g /= 255;
  b /= 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);

    switch (max) {
      case r:
        h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
        break;
      case g:
        h = ((b - r) / d + 2) * 60;
        break;
      case b:
        h = ((r - g) / d + 4) * 60;
        break;
    }
  }

  return { h, s: s * 100, l: l * 100 };
}

/**
 * Convert HSL to hex
 */
function hslToHex(h: number, s: number, l: number): string {
  s /= 100;
  l /= 100;

  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;

  let r = 0;
  let g = 0;
  let b = 0;

  if (h >= 0 && h < 60) {
    r = c;
    g = x;
    b = 0;
  } else if (h >= 60 && h < 120) {
    r = x;
    g = c;
    b = 0;
  } else if (h >= 120 && h < 180) {
    r = 0;
    g = c;
    b = x;
  } else if (h >= 180 && h < 240) {
    r = 0;
    g = x;
    b = c;
  } else if (h >= 240 && h < 300) {
    r = x;
    g = 0;
    b = c;
  } else if (h >= 300 && h < 360) {
    r = c;
    g = 0;
    b = x;
  }

  r = Math.round((r + m) * 255);
  g = Math.round((g + m) * 255);
  b = Math.round((b + m) * 255);

  return rgbToHex(r, g, b);
}

/**
 * Interpolate between two hue values (considering circular nature of hue)
 */
function lerpHue(h1: number, h2: number, t: number): number {
  // Normalize hues to 0-360
  h1 = h1 % 360;
  h2 = h2 % 360;

  // Find shortest path
  let diff = h2 - h1;
  if (Math.abs(diff) > 180) {
    diff = diff > 0 ? diff - 360 : diff + 360;
  }

  return (h1 + diff * t + 360) % 360;
}

/**
 * Check if two colors have sufficient contrast
 */
function ensureContrast(color1: string, color2: string): boolean {
  const rgb1 = hexToRgb(color1);
  const rgb2 = hexToRgb(color2);
  
  if (!rgb1 || !rgb2) return true;

  const lum1 = getLuminance(rgb1.r, rgb1.g, rgb1.b);
  const lum2 = getLuminance(rgb2.r, rgb2.g, rgb2.b);

  const ratio =
    lum1 > lum2 ? (lum1 + 0.05) / (lum2 + 0.05) : (lum2 + 0.05) / (lum1 + 0.05);

  // WCAG AA requires at least 4.5:1 for normal text
  return ratio >= 4.5;
}

/**
 * Calculate relative luminance
 */
function getLuminance(r: number, g: number, b: number): number {
  const [rs, gs, bs] = [r, g, b].map((val) => {
    val = val / 255;
    return val <= 0.03928 ? val / 12.92 : Math.pow((val + 0.055) / 1.055, 2.4);
  });

  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

/**
 * Calculate contrast ratio between two colors
 */
function getContrastRatio(color1: string, color2: string): number {
  const rgb1 = hexToRgb(color1);
  const rgb2 = hexToRgb(color2);

  if (!rgb1 || !rgb2) return 1;

  const lum1 = getLuminance(rgb1.r, rgb1.g, rgb1.b);
  const lum2 = getLuminance(rgb2.r, rgb2.g, rgb2.b);

  return lum1 > lum2 ? (lum1 + 0.05) / (lum2 + 0.05) : (lum2 + 0.05) / (lum1 + 0.05);
}

/**
 * Ensure interactive element has sufficient contrast against background
 * Automatically adjusts color to meet WCAG AA standards (4.5:1 ratio)
 */
function ensureInteractiveContrast(
  color: string,
  backgroundColor: string,
  isDark: boolean
): string {
  const minContrastRatio = 4.5; // WCAG AA standard
  let adjustedColor = color;
  let attempts = 0;
  const maxAttempts = 20;

  while (getContrastRatio(adjustedColor, backgroundColor) < minContrastRatio && attempts < maxAttempts) {
    // If dark mode, lighten the color; if light mode, darken it
    if (isDark) {
      adjustedColor = lightenColor(adjustedColor, 0.1);
    } else {
      adjustedColor = darkenColor(adjustedColor, 0.1);
    }
    attempts++;
  }

  // If we still don't have enough contrast after max attempts, use high-contrast fallback
  if (getContrastRatio(adjustedColor, backgroundColor) < minContrastRatio) {
    return isDark ? '#FFFFFF' : '#000000';
  }

  return adjustedColor;
}
