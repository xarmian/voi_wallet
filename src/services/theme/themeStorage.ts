import AsyncStorage from '@react-native-async-storage/async-storage';
import { Theme } from '@/constants/themes';
import { ExtractedColors, ColorPalette } from './colorExtraction';

const NFT_THEME_STORAGE_KEY = '@voi_wallet_nft_theme';
const NFT_THEME_COLORS_STORAGE_KEY = '@voi_wallet_nft_theme_colors';
const NFT_THEME_PREFERRED_MODE_KEY = '@voi_wallet_nft_theme_mode';
const NFT_THEME_ENABLED_KEY = '@voi_wallet_nft_theme_enabled';
const NFT_THEME_PALETTE_INDEX_KEY = '@voi_wallet_nft_theme_palette_index';
const NFT_THEME_BACKGROUND_ENABLED_KEY = '@voi_wallet_nft_theme_background_enabled';
const NFT_THEME_OVERLAY_INTENSITY_KEY = '@voi_wallet_nft_theme_overlay_intensity';

export interface NFTThemeData {
  contractId: number;
  tokenId: string;
  imageUrl: string;
  nftName?: string;
}

export interface StoredNFTTheme {
  nftData: NFTThemeData;
  extractedColors: ExtractedColors;
  theme: Theme;
  preferredMode: 'light' | 'dark'; // Kept for migration purposes
  timestamp: number;
  palettes?: ColorPalette[]; // Available color palettes
  selectedPaletteIndex?: number; // Currently selected palette (0-2)
  backgroundImageEnabled?: boolean; // Whether to show background image
}

/**
 * Save NFT theme data to storage
 */
export async function saveNFTTheme(
  nftData: NFTThemeData,
  extractedColors: ExtractedColors,
  theme: Theme,
  preferredMode: 'light' | 'dark' = 'light',
  palettes?: ColorPalette[],
  selectedPaletteIndex?: number,
  backgroundImageEnabled?: boolean
): Promise<void> {
  try {
    const storedTheme: StoredNFTTheme = {
      nftData,
      extractedColors,
      theme,
      preferredMode,
      timestamp: Date.now(),
      palettes,
      selectedPaletteIndex,
      backgroundImageEnabled,
    };

    await AsyncStorage.setItem(NFT_THEME_STORAGE_KEY, JSON.stringify(storedTheme));
  } catch (error) {
    console.error('Failed to save NFT theme:', error);
    throw error;
  }
}

/**
 * Load NFT theme data from storage
 */
export async function loadNFTTheme(): Promise<StoredNFTTheme | null> {
  try {
    const storedData = await AsyncStorage.getItem(NFT_THEME_STORAGE_KEY);
    if (!storedData) {
      return null;
    }

    const storedTheme: StoredNFTTheme = JSON.parse(storedData);
    
    // Validate the stored theme has all required fields
    if (
      !storedTheme.nftData ||
      !storedTheme.extractedColors ||
      !storedTheme.theme
    ) {
      console.warn('Invalid NFT theme data in storage, clearing it');
      await clearNFTTheme();
      return null;
    }

    return storedTheme;
  } catch (error) {
    console.error('Failed to load NFT theme:', error);
    return null;
  }
}

/**
 * Clear NFT theme data from storage
 */
export async function clearNFTTheme(): Promise<void> {
  try {
    await AsyncStorage.multiRemove([
      NFT_THEME_STORAGE_KEY,
      NFT_THEME_COLORS_STORAGE_KEY,
      NFT_THEME_PREFERRED_MODE_KEY,
    ]);
  } catch (error) {
    console.error('Failed to clear NFT theme:', error);
    throw error;
  }
}

/**
 * Check if an NFT theme is currently stored
 */
export async function hasNFTTheme(): Promise<boolean> {
  try {
    const storedData = await AsyncStorage.getItem(NFT_THEME_STORAGE_KEY);
    return storedData !== null;
  } catch (error) {
    console.error('Failed to check NFT theme:', error);
    return false;
  }
}

/**
 * Get the stored NFT theme data without loading the full theme
 */
export async function getNFTThemeData(): Promise<NFTThemeData | null> {
  try {
    const storedTheme = await loadNFTTheme();
    return storedTheme?.nftData || null;
  } catch (error) {
    console.error('Failed to get NFT theme data:', error);
    return null;
  }
}

/**
 * Load NFT theme enabled state from storage
 */
export async function loadNFTThemeEnabled(): Promise<boolean> {
  try {
    const value = await AsyncStorage.getItem(NFT_THEME_ENABLED_KEY);
    return value === 'true';
  } catch (error) {
    console.error('Failed to load NFT theme enabled state:', error);
    return false;
  }
}

/**
 * Save NFT theme enabled state to storage
 */
export async function saveNFTThemeEnabled(enabled: boolean): Promise<void> {
  try {
    await AsyncStorage.setItem(NFT_THEME_ENABLED_KEY, enabled ? 'true' : 'false');
  } catch (error) {
    console.error('Failed to save NFT theme enabled state:', error);
    throw error;
  }
}

/**
 * Load selected palette index from storage
 */
export async function loadSelectedPaletteIndex(): Promise<number> {
  try {
    const value = await AsyncStorage.getItem(NFT_THEME_PALETTE_INDEX_KEY);
    return value ? parseInt(value, 10) : 0;
  } catch (error) {
    console.error('Failed to load selected palette index:', error);
    return 0;
  }
}

/**
 * Save selected palette index to storage
 */
export async function saveSelectedPaletteIndex(index: number): Promise<void> {
  try {
    await AsyncStorage.setItem(NFT_THEME_PALETTE_INDEX_KEY, index.toString());
  } catch (error) {
    console.error('Failed to save selected palette index:', error);
    throw error;
  }
}

/**
 * Load background image enabled state from storage
 */
export async function loadBackgroundImageEnabled(): Promise<boolean> {
  try {
    const value = await AsyncStorage.getItem(NFT_THEME_BACKGROUND_ENABLED_KEY);
    // Default to true if not set
    return value === null ? true : value === 'true';
  } catch (error) {
    console.error('Failed to load background image enabled state:', error);
    return true;
  }
}

/**
 * Save background image enabled state to storage
 */
export async function saveBackgroundImageEnabled(enabled: boolean): Promise<void> {
  try {
    await AsyncStorage.setItem(NFT_THEME_BACKGROUND_ENABLED_KEY, enabled ? 'true' : 'false');
  } catch (error) {
    console.error('Failed to save background image enabled state:', error);
    throw error;
  }
}

/**
 * Load overlay intensity from storage
 * @returns intensity value between 0 and 1, defaults to 0.5
 */
export async function loadOverlayIntensity(): Promise<number> {
  try {
    const value = await AsyncStorage.getItem(NFT_THEME_OVERLAY_INTENSITY_KEY);
    return value !== null ? parseFloat(value) : 0.5;
  } catch (error) {
    console.error('Failed to load overlay intensity:', error);
    return 0.5;
  }
}

/**
 * Save overlay intensity to storage
 * @param intensity value between 0 and 1
 */
export async function saveOverlayIntensity(intensity: number): Promise<void> {
  try {
    await AsyncStorage.setItem(NFT_THEME_OVERLAY_INTENSITY_KEY, intensity.toString());
  } catch (error) {
    console.error('Failed to save overlay intensity:', error);
    throw error;
  }
}
