import { getColors } from 'react-native-image-colors';
import type { ImageColorsResult } from 'react-native-image-colors';

export interface ExtractedColors {
  primary: string;
  secondary: string;
  accent: string;
  background: string;
  dominant: string;
  vibrant: string;
  isDark: boolean;
  // Additional colors for palette generation
  muted?: string;
  darkVibrant?: string;
  lightVibrant?: string;
}

export interface ColorPalette {
  name: string;
  primary: string;
  secondary: string;
  accent: string;
}

export interface ExtractedColorsWithPalettes extends ExtractedColors {
  palettes: ColorPalette[];
}

/**
 * Extract colors from an NFT image URL
 */
export async function extractColorsFromImage(
  imageUrl: string
): Promise<ExtractedColors> {
  try {
    if (!imageUrl) {
      throw new Error('Image URL is required');
    }

    const colors = await getColors(imageUrl, {
      fallback: '#000000',
      cache: true,
      key: imageUrl,
    });

    return processColors(colors);
  } catch (error) {
    console.error('Failed to extract colors from image:', error);
    // Return default colors as fallback
    return getDefaultColors();
  }
}

/**
 * Extract colors and generate multiple palette variants
 */
export async function extractColorsWithPalettes(
  imageUrl: string
): Promise<ExtractedColorsWithPalettes> {
  const extractedColors = await extractColorsFromImage(imageUrl);
  const palettes = generateColorPalettes(extractedColors);

  return {
    ...extractedColors,
    palettes,
  };
}

/**
 * Process raw color extraction results into a structured palette
 */
function processColors(
  colors: ImageColorsResult
): ExtractedColors {
  // Handle different color formats returned by react-native-image-colors
  let dominant = '#000000';
  let vibrant = '#000000';
  let primary = '#000000';
  let secondary = '#000000';
  let accent = '#000000';
  let background = '#000000';
  let muted: string | undefined;
  let darkVibrant: string | undefined;
  let lightVibrant: string | undefined;

  if (colors.platform === 'android') {
    // Android returns colors object with dominant, vibrant, etc.
    dominant = colors.dominant || '#000000';
    vibrant = colors.vibrant || colors.dominant || '#000000';
    primary = colors.vibrant || colors.dominant || '#000000';
    secondary = colors.muted || colors.dominant || '#000000';
    accent = colors.darkVibrant || colors.vibrant || '#000000';
    background = colors.average || colors.dominant || '#000000';
    muted = colors.muted;
    darkVibrant = colors.darkVibrant;
    lightVibrant = colors.lightVibrant;
  } else if (colors.platform === 'ios') {
    // iOS returns colors object with background, primary, etc.
    dominant = colors.background || '#000000';
    vibrant = colors.detail || colors.background || '#000000';
    primary = colors.primary || colors.background || '#000000';
    secondary = colors.secondary || colors.primary || '#000000';
    accent = colors.detail || colors.primary || '#000000';
    background = colors.background || '#000000';
    // iOS doesn't provide these variants, we'll generate them later
  } else if (colors.platform === 'web') {
    // Web returns colors object
    dominant = colors.dominant || '#000000';
    vibrant = colors.vibrant || colors.dominant || '#000000';
    primary = colors.vibrant || colors.dominant || '#000000';
    secondary = colors.muted || colors.dominant || '#000000';
    accent = colors.darkVibrant || colors.vibrant || '#000000';
    background = colors.average || colors.dominant || '#000000';
    muted = colors.muted;
    darkVibrant = colors.darkVibrant;
    lightVibrant = colors.lightVibrant;
  }

  // Determine if the image is dark or light based on background color
  const isDark = isColorDark(background);

  return {
    primary: normalizeColor(primary),
    secondary: normalizeColor(secondary),
    accent: normalizeColor(accent),
    background: normalizeColor(background),
    dominant: normalizeColor(dominant),
    vibrant: normalizeColor(vibrant),
    muted: muted ? normalizeColor(muted) : undefined,
    darkVibrant: darkVibrant ? normalizeColor(darkVibrant) : undefined,
    lightVibrant: lightVibrant ? normalizeColor(lightVibrant) : undefined,
    isDark,
  };
}

/**
 * Check if a color is dark (for determining theme mode)
 */
function isColorDark(color: string): boolean {
  const rgb = hexToRgb(color);
  if (!rgb) return true; // Default to dark if parsing fails

  // Calculate luminance using relative luminance formula
  const luminance =
    (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;

  return luminance < 0.5;
}

/**
 * Convert hex color to RGB
 */
function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  // Remove # if present
  const cleanHex = hex.replace('#', '');

  // Handle 3-digit hex codes
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
 * Normalize color format to ensure it's a valid hex color
 */
function normalizeColor(color: string): string {
  if (!color || typeof color !== 'string') {
    return '#000000';
  }

  // Remove any whitespace
  const clean = color.trim();

  // If it's already a valid hex color, return it
  if (/^#[0-9A-F]{6}$/i.test(clean)) {
    return clean.toUpperCase();
  }

  // If it's a 3-digit hex, expand it
  if (/^#[0-9A-F]{3}$/i.test(clean)) {
    return (
      '#' +
      clean
        .slice(1)
        .split('')
        .map((char) => char + char)
        .join('')
        .toUpperCase()
    );
  }

  // If it's a hex without #, add it
  if (/^[0-9A-F]{6}$/i.test(clean)) {
    return '#' + clean.toUpperCase();
  }

  // Default to black if we can't parse it
  return '#000000';
}

/**
 * Get default colors as fallback
 */
function getDefaultColors(): ExtractedColors {
  return {
    primary: '#007AFF',
    secondary: '#5856D6',
    accent: '#007AFF',
    background: '#F7F8FA',
    dominant: '#007AFF',
    vibrant: '#5856D6',
    isDark: false,
  };
}

/**
 * Generate multiple color palette variants from extracted colors
 * Creates 3 palette options: Vibrant, Muted, and Balanced
 */
function generateColorPalettes(colors: ExtractedColors): ColorPalette[] {
  const palettes: ColorPalette[] = [];

  // Palette 1: Vibrant - Uses the most vivid colors
  palettes.push({
    name: 'Vibrant',
    primary: colors.vibrant,
    secondary: colors.secondary,
    accent: colors.darkVibrant || colors.accent,
  });

  // Palette 2: Muted - Uses softer, more subtle colors
  palettes.push({
    name: 'Muted',
    primary: colors.muted || colors.secondary,
    secondary: colors.dominant,
    accent: colors.primary,
  });

  // Palette 3: Balanced - Mix of vibrant and muted for best contrast
  palettes.push({
    name: 'Balanced',
    primary: colors.primary,
    secondary: colors.muted || colors.secondary,
    accent: colors.darkVibrant || colors.accent,
  });

  return palettes;
}

/**
 * Export hexToRgb for use in theme generator
 */
export { hexToRgb, isColorDark };
