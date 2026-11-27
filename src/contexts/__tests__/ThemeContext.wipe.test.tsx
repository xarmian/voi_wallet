/**
 * TASK-469: the picked NFT names a token the previous wallet owned. A theme
 * load or an NFT pick that began before or during a wipe does not show it (or
 * save it) after the wipe's reset.
 */
import React from 'react';
import { act, render } from '@testing-library/react-native';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);
const mockLoadNFTTheme = jest.fn();
const mockSaveNFTTheme = jest.fn(async () => {});
jest.mock('@/services/theme/themeStorage', () => ({
  loadNFTTheme: () => mockLoadNFTTheme(),
  saveNFTTheme: (...args: unknown[]) => mockSaveNFTTheme(...(args as [])),
  loadNFTThemeEnabled: jest.fn(async () => true),
  saveNFTThemeEnabled: jest.fn(async () => {}),
  loadSelectedPaletteIndex: jest.fn(async () => 0),
  saveSelectedPaletteIndex: jest.fn(async () => {}),
  loadBackgroundImageEnabled: jest.fn(async () => true),
  saveBackgroundImageEnabled: jest.fn(async () => {}),
  loadOverlayIntensity: jest.fn(async () => 0.5),
  saveOverlayIntensity: jest.fn(async () => {}),
  clearNFTTheme: jest.fn(async () => {}),
}));
const mockExtract = jest.fn();
jest.mock('@/services/theme/colorExtraction', () => ({
  extractColorsWithPalettes: (url: string) => mockExtract(url),
}));
jest.mock('@/services/theme/themeGenerator', () => ({
  generateThemeFromColors: () => require('@/constants/themes').darkTheme,
}));

import { ThemeProvider, useTheme } from '../ThemeContext';
import {
  closeWipeWindow,
  openWipeWindow,
  runWipeResets,
} from '@/services/wipe/gate';

const NFT = { contractId: 1, tokenId: '7', imageUrl: 'https://x/nft.png' };
const STORED = {
  nftData: NFT,
  extractedColors: { primary: '#000' },
  theme: {},
  palettes: [{ name: 'p' }],
  selectedPaletteIndex: 0,
};

let context: ReturnType<typeof useTheme> | undefined;
function Probe() {
  context = useTheme();
  return null;
}
const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });
};

beforeEach(() => {
  context = undefined;
  mockLoadNFTTheme.mockReset();
  mockSaveNFTTheme.mockClear();
  mockExtract.mockReset();
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  closeWipeWindow();
  jest.restoreAllMocks();
});

test('a theme load in flight when the wipe resets does not show the picked NFT', async () => {
  let finishLoad: (value: unknown) => void = () => {};
  mockLoadNFTTheme.mockImplementationOnce(
    () => new Promise((resolve) => (finishLoad = resolve))
  );
  const view = await render(
    <ThemeProvider>
      <Probe />
    </ThemeProvider>
  );
  await flush();
  await act(async () => {
    runWipeResets();
  });
  finishLoad(STORED);
  await flush();
  expect(context?.nftThemeData).toBeNull();
  await view.unmount();
});

test('with no wipe the same load shows the picked NFT', async () => {
  mockLoadNFTTheme.mockResolvedValueOnce(STORED);
  const view = await render(
    <ThemeProvider>
      <Probe />
    </ThemeProvider>
  );
  await flush();
  expect(context?.nftThemeData).toEqual(NFT);
  await view.unmount();
});

test('an NFT pick that started before the wipe is neither saved nor shown', async () => {
  mockLoadNFTTheme.mockResolvedValue(null);
  const view = await render(
    <ThemeProvider>
      <Probe />
    </ThemeProvider>
  );
  await flush();
  let finishExtract: (value: unknown) => void = () => {};
  mockExtract.mockImplementationOnce(
    () => new Promise((resolve) => (finishExtract = resolve))
  );
  let picking: Promise<void> | undefined;
  await act(async () => {
    picking = context?.setNFTTheme(NFT as never);
  });
  openWipeWindow();
  await act(async () => {
    runWipeResets();
  });
  finishExtract({ primary: '#000', palettes: [{ name: 'p' }] });
  await act(async () => {
    await picking;
  });
  expect(mockSaveNFTTheme).not.toHaveBeenCalled();
  expect(context?.nftThemeData).toBeNull();
  await view.unmount();
});
