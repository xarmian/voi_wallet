/**
 * TASK-435 — Theme as a pushed screen: choices apply live and the screen stays
 * open; "Change NFT" pushes the NFT Theme screen directly (no close-then-open
 * timer chain in SettingsScreen).
 */

import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import ThemeSettingsScreen from '../ThemeSettingsScreen';

const mockNavigate = jest.fn();
const mockGoBack = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate, goBack: mockGoBack }),
}));
const mockSetThemeMode = jest.fn();
jest.mock('@/contexts/ThemeContext', () => ({
  useTheme: () => ({
    theme: require('@/constants/themes').lightTheme,
    themeMode: 'light',
    setThemeMode: mockSetThemeMode,
    nftThemeData: null,
    nftThemeEnabled: true,
    setNFTThemeEnabled: jest.fn(),
    nftPalettes: [],
    selectedPaletteIndex: 0,
    setSelectedPaletteIndex: jest.fn(),
    nftBackgroundEnabled: false,
    setNFTBackgroundEnabled: jest.fn(),
  }),
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('react-native-safe-area-context', () => {
  const { View } = require('react-native');
  return {
    SafeAreaView: View,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});
jest.mock('expo-image', () => ({ Image: 'Image' }));
jest.mock('@/components/common/UniversalHeader', () => () => null);
jest.mock('@/components/common/NFTBackground', () => ({
  NFTBackground: ({ children }: { children: React.ReactNode }) => children,
}));

beforeEach(() => {
  mockNavigate.mockReset();
  mockGoBack.mockReset();
  mockSetThemeMode.mockReset();
});

it('pushes the NFT Theme screen synchronously on press', async () => {
  const view = await render(<ThemeSettingsScreen />);

  await fireEvent.press(view.getByText('Select NFT'));

  // Asserted with no timer advance: the old close-then-open chain only
  // opened the NFT picker after a 300 ms setTimeout.
  expect(mockNavigate).toHaveBeenCalledTimes(1);
  expect(mockNavigate).toHaveBeenCalledWith('NFTThemeSettings');
});

it('applies a base theme live and stays open', async () => {
  const view = await render(<ThemeSettingsScreen />);

  await fireEvent.press(view.getByText('Dark'));

  expect(mockSetThemeMode).toHaveBeenCalledWith('dark');
  expect(mockGoBack).not.toHaveBeenCalled();
});
