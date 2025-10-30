import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  ReactNode,
  useCallback,
} from 'react';
import { Appearance, ColorSchemeName } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Theme, ThemeMode, lightTheme, darkTheme } from '../constants/themes';
import {
  loadNFTTheme,
  saveNFTTheme,
  loadNFTThemeEnabled,
  saveNFTThemeEnabled,
  loadSelectedPaletteIndex,
  saveSelectedPaletteIndex,
  loadBackgroundImageEnabled,
  saveBackgroundImageEnabled,
  type NFTThemeData,
} from '../services/theme/themeStorage';
import { extractColorsWithPalettes, type ExtractedColors, type ColorPalette } from '../services/theme/colorExtraction';
import { generateThemeFromColors } from '../services/theme/themeGenerator';

interface ThemeContextType {
  theme: Theme;
  themeMode: ThemeMode;
  setThemeMode: (mode: ThemeMode) => void;
  isDark: boolean;
  nftThemeData: NFTThemeData | null;
  nftThemeEnabled: boolean;
  nftBackgroundEnabled: boolean;
  nftPalettes: ColorPalette[];
  selectedPaletteIndex: number;
  setNFTThemeEnabled: (enabled: boolean) => Promise<void>;
  setNFTBackgroundEnabled: (enabled: boolean) => Promise<void>;
  setSelectedPaletteIndex: (index: number) => Promise<void>;
  setNFTTheme: (nftData: NFTThemeData) => Promise<void>;
  clearNFTTheme: () => Promise<void>;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

const THEME_STORAGE_KEY = '@voi_wallet_theme_mode';

interface ThemeProviderProps {
  children: ReactNode;
}

export const ThemeProvider: React.FC<ThemeProviderProps> = ({ children }) => {
  const [themeMode, setThemeModeState] = useState<ThemeMode>('system');
  const [systemColorScheme, setSystemColorScheme] = useState<ColorSchemeName>(
    Appearance.getColorScheme()
  );
  const [nftThemeEnabled, setNftThemeEnabledState] = useState<boolean>(false);
  const [nftBackgroundEnabled, setNftBackgroundEnabledState] = useState<boolean>(true);
  const [selectedPaletteIndex, setSelectedPaletteIndexState] = useState<number>(0);
  const [nftThemeData, setNftThemeDataState] = useState<NFTThemeData | null>(
    null
  );
  const [nftExtractedColors, setNftExtractedColors] = useState<
    ExtractedColors | null
  >(null);
  const [nftPalettes, setNftPalettes] = useState<ColorPalette[]>([]);

  // Get current base theme mode (light or dark)
  const getCurrentBaseThemeMode = (): 'light' | 'dark' => {
    if (themeMode === 'system') {
      return systemColorScheme === 'dark' ? 'dark' : 'light';
    }
    return themeMode === 'dark' ? 'dark' : 'light';
  };

  // Regenerate NFT theme based on current base theme mode
  const regenerateNFTTheme = useCallback((): Theme | null => {
    if (!nftThemeData || !nftExtractedColors) {
      return null;
    }

    const currentMode = getCurrentBaseThemeMode();
    const selectedPalette = nftPalettes[selectedPaletteIndex];
    const backgroundUrl = nftBackgroundEnabled ? nftThemeData.imageUrl : undefined;

    return generateThemeFromColors(
      nftExtractedColors,
      currentMode,
      backgroundUrl,
      selectedPalette
    );
  }, [nftThemeData, nftExtractedColors, nftPalettes, selectedPaletteIndex, nftBackgroundEnabled, themeMode, systemColorScheme]);

  const getCurrentTheme = (): Theme => {
    // If NFT theme is enabled, regenerate it based on current base theme mode
    if (nftThemeEnabled && nftThemeData && nftExtractedColors) {
      const regeneratedTheme = regenerateNFTTheme();
      if (regeneratedTheme) {
        return regeneratedTheme;
      }
    }

    // Otherwise return base theme
    if (themeMode === 'system') {
      return systemColorScheme === 'dark' ? darkTheme : lightTheme;
    }
    return themeMode === 'dark' ? darkTheme : lightTheme;
  };

  const theme = getCurrentTheme();
  const isDark = theme.mode === 'dark';

  const setThemeMode = async (mode: ThemeMode) => {
    try {
      await AsyncStorage.setItem(THEME_STORAGE_KEY, mode);
      setThemeModeState(mode);
      // NFT theme will automatically regenerate when base theme changes
      // via the regenerateNFTTheme function in getCurrentTheme
    } catch (error) {
      console.error('Failed to save theme mode:', error);
    }
  };

  const setNFTThemeEnabled = async (enabled: boolean) => {
    try {
      await saveNFTThemeEnabled(enabled);
      setNftThemeEnabledState(enabled);

      // Note: We don't re-save the NFT theme here to avoid race conditions.
      // The theme is already saved when setNFTTheme is called, and will be
      // regenerated dynamically based on the current base theme mode.
    } catch (error) {
      console.error('Failed to save NFT theme enabled state:', error);
    }
  };

  const setNFTBackgroundEnabled = async (enabled: boolean) => {
    try {
      await saveBackgroundImageEnabled(enabled);
      setNftBackgroundEnabledState(enabled);
      // Theme will regenerate automatically via regenerateNFTTheme
    } catch (error) {
      console.error('Failed to save background image enabled state:', error);
    }
  };

  const setSelectedPaletteIndex = async (index: number) => {
    try {
      await saveSelectedPaletteIndex(index);
      setSelectedPaletteIndexState(index);
      // Theme will regenerate automatically via regenerateNFTTheme
    } catch (error) {
      console.error('Failed to save selected palette index:', error);
    }
  };

  const setNFTTheme = async (nftData: NFTThemeData) => {
    try {
      if (!nftData.imageUrl) {
        throw new Error('NFT image URL is required');
      }

      // Extract colors and generate palettes from NFT image
      const extractedData = await extractColorsWithPalettes(nftData.imageUrl);
      const { palettes, ...extractedColors } = extractedData;

      // Get current base theme mode
      const currentMode = getCurrentBaseThemeMode();

      // Use first palette by default
      const defaultPaletteIndex = 0;
      const defaultPalette = palettes[defaultPaletteIndex];

      // Generate theme from extracted colors using current base theme mode
      const generatedTheme = generateThemeFromColors(
        extractedColors,
        currentMode,
        nftData.imageUrl,
        defaultPalette
      );

      // Save NFT theme to storage (keeping preferredMode for migration)
      await saveNFTTheme(
        nftData,
        extractedColors,
        generatedTheme,
        currentMode,
        palettes,
        defaultPaletteIndex,
        true // backgroundImageEnabled defaults to true
      );

      // Update state
      setNftThemeDataState(nftData);
      setNftExtractedColors(extractedColors);
      setNftPalettes(palettes);
      setSelectedPaletteIndexState(defaultPaletteIndex);
      setNftBackgroundEnabledState(true);

      // Enable NFT theme overlay
      await setNFTThemeEnabled(true);
    } catch (error) {
      console.error('Failed to set NFT theme:', error);
      throw error;
    }
  };

  const clearNFTTheme = async () => {
    try {
      const { clearNFTTheme: clearStorage } = await import(
        '../services/theme/themeStorage'
      );
      await clearStorage();
      await saveNFTThemeEnabled(false);

      setNftThemeDataState(null);
      setNftExtractedColors(null);
      setNftPalettes([]);
      setSelectedPaletteIndexState(0);
      setNftBackgroundEnabledState(true);
      setNftThemeEnabledState(false);

      // Keep current base theme mode, just disable NFT overlay
    } catch (error) {
      console.error('Failed to clear NFT theme:', error);
      throw error;
    }
  };

  useEffect(() => {
    const loadThemeData = async () => {
      try {
        // Load theme mode
        const savedMode = await AsyncStorage.getItem(THEME_STORAGE_KEY);
        
        // Migration: Handle old 'nft' theme mode
        if (savedMode === 'nft') {
          // Load NFT theme to get preferred mode
          const storedNFTTheme = await loadNFTTheme();
          if (storedNFTTheme) {
            // Migrate to base theme based on preferred mode
            const baseMode = storedNFTTheme.preferredMode === 'dark' ? 'dark' : 'light';
            await AsyncStorage.setItem(THEME_STORAGE_KEY, baseMode);
            setThemeModeState(baseMode);

            // Set NFT theme data and enable it
            setNftThemeDataState(storedNFTTheme.nftData);
            setNftExtractedColors(storedNFTTheme.extractedColors);
            setNftThemeEnabledState(true);
            await saveNFTThemeEnabled(true);
          } else {
            // No NFT theme found, fallback to system
            await AsyncStorage.setItem(THEME_STORAGE_KEY, 'system');
            setThemeModeState('system');
          }
        } else {
          // Normal mode (not migration) - set theme mode if valid
          if (savedMode && ['light', 'dark', 'system'].includes(savedMode)) {
            setThemeModeState(savedMode as ThemeMode);
          }

          // Load NFT theme if available (only when not migrating to avoid double-load)
          const storedNFTTheme = await loadNFTTheme();
          if (storedNFTTheme) {
            setNftThemeDataState(storedNFTTheme.nftData);
            setNftExtractedColors(storedNFTTheme.extractedColors);

            // Load palettes if available, or generate them for legacy themes
            if (storedNFTTheme.palettes && storedNFTTheme.palettes.length > 0) {
              setNftPalettes(storedNFTTheme.palettes);
              setSelectedPaletteIndexState(storedNFTTheme.selectedPaletteIndex || 0);
            } else {
              // Migration: Generate palettes for existing NFT themes
              const { extractColorsWithPalettes } = await import('../services/theme/colorExtraction');
              try {
                const extractedData = await extractColorsWithPalettes(storedNFTTheme.nftData.imageUrl);
                setNftPalettes(extractedData.palettes);
                setSelectedPaletteIndexState(0);
              } catch (error) {
                console.error('Failed to generate palettes for existing NFT theme:', error);
              }
            }

            // Load background enabled state
            const bgEnabled = storedNFTTheme.backgroundImageEnabled !== undefined
              ? storedNFTTheme.backgroundImageEnabled
              : await loadBackgroundImageEnabled();
            setNftBackgroundEnabledState(bgEnabled);
          }

          // Load NFT theme enabled state
          const enabled = await loadNFTThemeEnabled();
          setNftThemeEnabledState(enabled);

          // Load palette index if not loaded from stored theme
          if (!storedNFTTheme?.selectedPaletteIndex) {
            const paletteIndex = await loadSelectedPaletteIndex();
            setSelectedPaletteIndexState(paletteIndex);
          }
        }
      } catch (error) {
        console.error('Failed to load theme data:', error);
      }
    };

    loadThemeData();
  }, []);

  useEffect(() => {
    const subscription = Appearance.addChangeListener(({ colorScheme }) => {
      setSystemColorScheme(colorScheme);
    });

    return () => subscription?.remove();
  }, []);

  const contextValue: ThemeContextType = {
    theme,
    themeMode,
    setThemeMode,
    isDark,
    nftThemeData,
    nftThemeEnabled,
    nftBackgroundEnabled,
    nftPalettes,
    selectedPaletteIndex,
    setNFTThemeEnabled,
    setNFTBackgroundEnabled,
    setSelectedPaletteIndex,
    setNFTTheme,
    clearNFTTheme,
  };

  return (
    <ThemeContext.Provider value={contextValue}>
      {children}
    </ThemeContext.Provider>
  );
};

export const useTheme = (): ThemeContextType => {
  const context = useContext(ThemeContext);
  if (context === undefined) {
    console.warn(
      'useTheme: ThemeProvider context not available, returning default theme'
    );
    // Return a default theme to prevent crashes
    return {
      theme: lightTheme,
      themeMode: 'light',
      setThemeMode: () => {},
      isDark: false,
      nftThemeData: null,
      nftThemeEnabled: false,
      nftBackgroundEnabled: true,
      nftPalettes: [],
      selectedPaletteIndex: 0,
      setNFTThemeEnabled: async () => {},
      setNFTBackgroundEnabled: async () => {},
      setSelectedPaletteIndex: async () => {},
      setNFTTheme: async () => {},
      clearNFTTheme: async () => {},
    };
  }
  return context;
};
