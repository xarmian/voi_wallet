export type ThemeMode = 'light' | 'dark' | 'system';

// Glass effect configuration for liquid-glass aesthetic
export interface GlassEffect {
  blur: number;
  opacity: number;
  tint: 'light' | 'dark' | 'chromatic';
  backgroundColor: string;
  borderColor: string;
  borderWidth: number;
}

// Shadow style type for reuse
export interface ShadowStyle {
  shadowColor: string;
  shadowOffset: { width: number; height: number };
  shadowOpacity: number;
  shadowRadius: number;
  elevation: number;
}

// Typography style preset
export interface TypographyStyle {
  fontSize: number;
  fontWeight: '400' | '500' | '600' | '700';
  lineHeight: number;
  letterSpacing: number;
}

export interface Theme {
  mode: 'light' | 'dark';
  backgroundImageUrl?: string; // NFT image URL for blurred backgrounds
  colors: {
    primary: string;
    primaryDark: string;
    secondary: string;
    background: string;
    surface: string;
    card: string;
    text: string;
    textSecondary: string;
    textMuted: string;
    placeholder: string;
    border: string;
    borderLight: string;
    success: string;
    warning: string;
    error: string;
    info: string;
    statusBar: 'light-content' | 'dark-content';
    tabIconActive: string;
    tabIconInactive: string;
    tabBackground: string;
    inputBackground: string;
    inputBorder: string;
    buttonBackground: string;
    buttonText: string;
    modalBackground: string;
    overlay: string;
    shadow: string;
    // Glass-specific colors for liquid-glass aesthetic
    glassBackground: string;
    glassBorder: string;
    glassHighlight: string;
    glassShadow: string;
    // Glow colors for interactive elements
    glowPrimary: string;
    glowSuccess: string;
    glowError: string;
    // Surface variations for depth
    surfaceElevated: string;
    surfacePressed: string;
  };
  spacing: {
    xs: number;
    sm: number;
    md: number;
    lg: number;
    xl: number;
    xxl: number;
  };
  borderRadius: {
    sm: number;
    md: number;
    lg: number;
    xl: number;
    xxl: number;
    pill: number;
  };
  shadows: {
    sm: ShadowStyle;
    md: ShadowStyle;
    lg: ShadowStyle;
  };
  // Glass effect presets for different intensity levels
  glass: {
    light: GlassEffect;
    medium: GlassEffect;
    heavy: GlassEffect;
    chromatic: GlassEffect;
  };
  // Glow shadows for interactive elements (buttons, cards with emphasis)
  glowShadows: {
    sm: ShadowStyle;
    md: ShadowStyle;
    lg: ShadowStyle;
  };
  // Gradient color arrays for various uses
  gradients: {
    primary: string[];
    glass: string[];
    background: string[];
    shimmer: string[];
  };
  // Typography presets for consistent text styling
  typography: {
    display: TypographyStyle;
    heading1: TypographyStyle;
    heading2: TypographyStyle;
    heading3: TypographyStyle;
    body: TypographyStyle;
    bodySmall: TypographyStyle;
    caption: TypographyStyle;
    mono: TypographyStyle;
  };
  // Animation timing presets
  animation: {
    duration: {
      instant: number;
      fast: number;
      normal: number;
      slow: number;
    };
    spring: {
      damping: number;
      stiffness: number;
      mass: number;
    };
  };
}

export const lightTheme: Theme = {
  mode: 'light',
  colors: {
    // Core colors - Premium light with subtle warmth
    primary: '#007AFF',
    primaryDark: '#0051D8',
    secondary: '#5856D6',
    background: '#F5F5F7',
    surface: '#FFFFFF',
    card: '#FFFFFF',
    text: '#1D1D1F',
    textSecondary: '#48484A',
    textMuted: '#8E8E93',
    placeholder: '#AEAEB2',
    border: 'rgba(0, 0, 0, 0.08)',
    borderLight: 'rgba(0, 0, 0, 0.04)',
    success: '#30D158',
    warning: '#FF9F0A',
    error: '#FF453A',
    info: '#007AFF',
    statusBar: 'dark-content',
    tabIconActive: '#007AFF',
    tabIconInactive: '#8E8E93',
    tabBackground: 'rgba(255, 255, 255, 0.85)',
    inputBackground: 'rgba(255, 255, 255, 0.5)',
    inputBorder: 'rgba(0, 0, 0, 0.08)',
    buttonBackground: '#007AFF',
    buttonText: '#FFFFFF',
    modalBackground: 'rgba(255, 255, 255, 0.95)',
    overlay: 'rgba(0, 0, 0, 0.4)',
    shadow: '#000000',
    // Glass-specific colors
    glassBackground: 'rgba(255, 255, 255, 0.55)',
    glassBorder: 'rgba(255, 255, 255, 0.4)',
    glassHighlight: 'rgba(255, 255, 255, 0.7)',
    glassShadow: 'rgba(0, 0, 0, 0.08)',
    // Glow colors
    glowPrimary: 'rgba(0, 122, 255, 0.35)',
    glowSuccess: 'rgba(48, 209, 88, 0.35)',
    glowError: 'rgba(255, 69, 58, 0.35)',
    // Surface variations
    surfaceElevated: '#FFFFFF',
    surfacePressed: 'rgba(0, 0, 0, 0.04)',
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
      shadowOpacity: 0.06,
      shadowRadius: 8,
      elevation: 2,
    },
    md: {
      shadowColor: '#000000',
      shadowOffset: { width: 0, height: 8 },
      shadowOpacity: 0.1,
      shadowRadius: 24,
      elevation: 4,
    },
    lg: {
      shadowColor: '#000000',
      shadowOffset: { width: 0, height: 16 },
      shadowOpacity: 0.14,
      shadowRadius: 48,
      elevation: 8,
    },
  },
  glass: {
    light: {
      blur: 24,
      opacity: 0.75,
      tint: 'light',
      backgroundColor: 'rgba(255, 255, 255, 0.75)',
      borderColor: 'rgba(255, 255, 255, 0.5)',
      borderWidth: 1,
    },
    medium: {
      blur: 40,
      opacity: 0.80,
      tint: 'light',
      backgroundColor: 'rgba(255, 255, 255, 0.80)',
      borderColor: 'rgba(255, 255, 255, 0.6)',
      borderWidth: 1,
    },
    heavy: {
      blur: 60,
      opacity: 0.85,
      tint: 'light',
      backgroundColor: 'rgba(255, 255, 255, 0.85)',
      borderColor: 'rgba(255, 255, 255, 0.7)',
      borderWidth: 1,
    },
    chromatic: {
      blur: 40,
      opacity: 0.75,
      tint: 'chromatic',
      backgroundColor: 'rgba(255, 255, 255, 0.75)',
      borderColor: 'rgba(255, 255, 255, 0.5)',
      borderWidth: 1,
    },
  },
  glowShadows: {
    sm: {
      shadowColor: '#007AFF',
      shadowOffset: { width: 0, height: 0 },
      shadowOpacity: 0.25,
      shadowRadius: 8,
      elevation: 2,
    },
    md: {
      shadowColor: '#007AFF',
      shadowOffset: { width: 0, height: 0 },
      shadowOpacity: 0.35,
      shadowRadius: 16,
      elevation: 4,
    },
    lg: {
      shadowColor: '#007AFF',
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.45,
      shadowRadius: 24,
      elevation: 8,
    },
  },
  gradients: {
    primary: ['#007AFF', '#0051D8'],
    glass: ['rgba(255, 255, 255, 0.2)', 'rgba(255, 255, 255, 0)'],
    background: ['#F5F5F7', '#E8E8ED'],
    shimmer: ['rgba(255, 255, 255, 0)', 'rgba(255, 255, 255, 0.6)', 'rgba(255, 255, 255, 0)'],
  },
  typography: {
    display: { fontSize: 48, fontWeight: '700', lineHeight: 56, letterSpacing: -0.5 },
    heading1: { fontSize: 32, fontWeight: '700', lineHeight: 40, letterSpacing: -0.3 },
    heading2: { fontSize: 24, fontWeight: '600', lineHeight: 32, letterSpacing: -0.2 },
    heading3: { fontSize: 20, fontWeight: '600', lineHeight: 28, letterSpacing: 0 },
    body: { fontSize: 16, fontWeight: '400', lineHeight: 24, letterSpacing: 0 },
    bodySmall: { fontSize: 14, fontWeight: '400', lineHeight: 20, letterSpacing: 0 },
    caption: { fontSize: 12, fontWeight: '500', lineHeight: 16, letterSpacing: 0.3 },
    mono: { fontSize: 14, fontWeight: '500', lineHeight: 20, letterSpacing: 0.5 },
  },
  animation: {
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
  },
};

export const darkTheme: Theme = {
  mode: 'dark',
  colors: {
    // Core colors - Premium dark with depth
    primary: '#0A84FF',
    primaryDark: '#0066CC',
    secondary: '#5E5CE6',
    background: '#0A0A0F',
    surface: '#141419',
    card: '#1C1C24',
    text: '#FFFFFF',
    textSecondary: 'rgba(255, 255, 255, 0.78)',
    textMuted: 'rgba(255, 255, 255, 0.48)',
    placeholder: 'rgba(255, 255, 255, 0.32)',
    border: 'rgba(255, 255, 255, 0.1)',
    borderLight: 'rgba(255, 255, 255, 0.06)',
    success: '#30D158',
    warning: '#FF9F0A',
    error: '#FF453A',
    info: '#0A84FF',
    statusBar: 'light-content',
    tabIconActive: '#0A84FF',
    tabIconInactive: 'rgba(255, 255, 255, 0.48)',
    tabBackground: 'rgba(20, 20, 25, 0.85)',
    inputBackground: 'rgba(255, 255, 255, 0.06)',
    inputBorder: 'rgba(255, 255, 255, 0.12)',
    buttonBackground: '#0A84FF',
    buttonText: '#FFFFFF',
    modalBackground: 'rgba(28, 28, 36, 0.95)',
    overlay: 'rgba(0, 0, 0, 0.65)',
    shadow: '#000000',
    // Glass-specific colors - optimized for dark mode glass effects
    glassBackground: 'rgba(255, 255, 255, 0.06)',
    glassBorder: 'rgba(255, 255, 255, 0.12)',
    glassHighlight: 'rgba(255, 255, 255, 0.18)',
    glassShadow: 'rgba(0, 0, 0, 0.4)',
    // Glow colors - vibrant on dark backgrounds
    glowPrimary: 'rgba(10, 132, 255, 0.45)',
    glowSuccess: 'rgba(48, 209, 88, 0.45)',
    glowError: 'rgba(255, 69, 58, 0.45)',
    // Surface variations
    surfaceElevated: '#1E1E26',
    surfacePressed: 'rgba(255, 255, 255, 0.08)',
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
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.3,
      shadowRadius: 8,
      elevation: 2,
    },
    md: {
      shadowColor: '#000000',
      shadowOffset: { width: 0, height: 8 },
      shadowOpacity: 0.4,
      shadowRadius: 24,
      elevation: 4,
    },
    lg: {
      shadowColor: '#000000',
      shadowOffset: { width: 0, height: 16 },
      shadowOpacity: 0.5,
      shadowRadius: 48,
      elevation: 8,
    },
  },
  glass: {
    light: {
      blur: 24,
      opacity: 0.18,
      tint: 'dark',
      backgroundColor: 'rgba(255, 255, 255, 0.18)',
      borderColor: 'rgba(255, 255, 255, 0.24)',
      borderWidth: 1,
    },
    medium: {
      blur: 40,
      opacity: 0.22,
      tint: 'dark',
      backgroundColor: 'rgba(255, 255, 255, 0.22)',
      borderColor: 'rgba(255, 255, 255, 0.28)',
      borderWidth: 1,
    },
    heavy: {
      blur: 60,
      opacity: 0.28,
      tint: 'dark',
      backgroundColor: 'rgba(255, 255, 255, 0.28)',
      borderColor: 'rgba(255, 255, 255, 0.35)',
      borderWidth: 1,
    },
    chromatic: {
      blur: 40,
      opacity: 0.20,
      tint: 'chromatic',
      backgroundColor: 'rgba(255, 255, 255, 0.20)',
      borderColor: 'rgba(255, 255, 255, 0.26)',
      borderWidth: 1,
    },
  },
  glowShadows: {
    sm: {
      shadowColor: '#0A84FF',
      shadowOffset: { width: 0, height: 0 },
      shadowOpacity: 0.35,
      shadowRadius: 12,
      elevation: 2,
    },
    md: {
      shadowColor: '#0A84FF',
      shadowOffset: { width: 0, height: 0 },
      shadowOpacity: 0.5,
      shadowRadius: 20,
      elevation: 4,
    },
    lg: {
      shadowColor: '#0A84FF',
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.6,
      shadowRadius: 32,
      elevation: 8,
    },
  },
  gradients: {
    primary: ['#0A84FF', '#0066CC'],
    glass: ['rgba(255, 255, 255, 0.12)', 'rgba(255, 255, 255, 0)'],
    background: ['#0A0A0F', '#12121A'],
    shimmer: ['rgba(255, 255, 255, 0)', 'rgba(255, 255, 255, 0.15)', 'rgba(255, 255, 255, 0)'],
  },
  typography: {
    display: { fontSize: 48, fontWeight: '700', lineHeight: 56, letterSpacing: -0.5 },
    heading1: { fontSize: 32, fontWeight: '700', lineHeight: 40, letterSpacing: -0.3 },
    heading2: { fontSize: 24, fontWeight: '600', lineHeight: 32, letterSpacing: -0.2 },
    heading3: { fontSize: 20, fontWeight: '600', lineHeight: 28, letterSpacing: 0 },
    body: { fontSize: 16, fontWeight: '400', lineHeight: 24, letterSpacing: 0 },
    bodySmall: { fontSize: 14, fontWeight: '400', lineHeight: 20, letterSpacing: 0 },
    caption: { fontSize: 12, fontWeight: '500', lineHeight: 16, letterSpacing: 0.3 },
    mono: { fontSize: 14, fontWeight: '500', lineHeight: 20, letterSpacing: 0.5 },
  },
  animation: {
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
  },
};
