/**
 * Decorative-layer accessibility tests (TASK-42).
 *
 * `NFTBackground` (~29 sites) and `BlurredContainer` (~20 sites) both wrap the
 * caller's children, so the risk when hiding their chrome from the
 * accessibility tree is hiding the *content* along with it. These tests pin
 * both halves of the contract: the decorative layers are hidden, and the
 * children stay reachable.
 */

import React from 'react';
import { Text, View } from 'react-native';
import { render } from '@testing-library/react-native';

import { BlurredContainer } from '../BlurredContainer';
import { NFTBackground } from '../NFTBackground';
import { lightTheme } from '@/constants/themes';

const mockTheme = {
  theme: lightTheme,
  nftBackgroundEnabled: true,
  nftOverlayIntensity: 0.5,
};

jest.mock('@/contexts/ThemeContext', () => ({
  useTheme: () => mockThemeValue(),
}));

const mockThemeValue = jest.fn(() => mockTheme);

jest.mock('expo-image', () => ({
  Image: require('react-native').View,
}));

const withNFTTheme = () => {
  mockThemeValue.mockReturnValue({
    ...mockTheme,
    theme: {
      ...lightTheme,
      backgroundImageUrl: 'https://example.test/nft.png',
    },
  });
};

beforeEach(() => {
  mockThemeValue.mockReturnValue(mockTheme);
});

/** All descendants (inclusive) carrying an explicit a11y-hidden marker. */
const hiddenNodes = (root: { queryAll: (p: (n: any) => boolean) => any[] }) =>
  root.queryAll(
    (node: any) =>
      node.props?.importantForAccessibility === 'no-hide-descendants' ||
      node.props?.accessibilityElementsHidden === true
  );

describe('NFTBackground decorative layers', () => {
  it('hides the whole decorative layer stack from the a11y tree', async () => {
    withNFTTheme();
    const { container } = await render(
      <NFTBackground>
        <Text>Balance</Text>
      </NFTBackground>
    );

    const hidden = hiddenNodes(container);
    expect(hidden.length).toBeGreaterThan(0);
    expect(
      hidden.every(
        (node: any) =>
          node.props.accessibilityElementsHidden === true &&
          node.props.importantForAccessibility === 'no-hide-descendants'
      )
    ).toBe(true);
  });

  it('keeps its children reachable', async () => {
    withNFTTheme();
    const { getByText } = await render(
      <NFTBackground>
        <Text>Balance</Text>
      </NFTBackground>
    );

    expect(getByText('Balance')).toBeTruthy();
  });

  it('renders no decorative layers at all without an NFT theme', async () => {
    const { container, getByText } = await render(
      <NFTBackground>
        <Text>Balance</Text>
      </NFTBackground>
    );

    expect(hiddenNodes(container)).toHaveLength(0);
    expect(getByText('Balance')).toBeTruthy();
  });
});

describe('BlurredContainer decorative layers', () => {
  it('hides the highlight and inner-border chrome but not the content', async () => {
    const { container, getByText } = await render(
      <BlurredContainer showHighlight showInnerBorder>
        <View>
          <Text>Recipient</Text>
        </View>
      </BlurredContainer>
    );

    expect(hiddenNodes(container).length).toBeGreaterThan(0);
    expect(getByText('Recipient')).toBeTruthy();
  });

  it('hides the tint overlay on the NFT-themed (blurred) branch', async () => {
    withNFTTheme();
    const { container, getByText } = await render(
      <BlurredContainer>
        <Text>Recipient</Text>
      </BlurredContainer>
    );

    expect(hiddenNodes(container).length).toBeGreaterThan(0);
    expect(getByText('Recipient')).toBeTruthy();
  });
});
