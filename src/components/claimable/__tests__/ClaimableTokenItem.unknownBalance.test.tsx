/**
 * TASK-188: a failed owner-balance lookup must render as unknown, not as zero.
 *
 * The row previously derived its badge from `isClaimable` alone, and the store
 * fed it a fabricated '0' balance whenever the lookup failed — so a transient
 * network error told the user, in red, that a claimable token was
 * "Insufficient". The unknown case now has its own presentation.
 */

import React from 'react';
import { StyleSheet } from 'react-native';
import { render } from '@testing-library/react-native';

import ClaimableTokenItem from '../ClaimableTokenItem';
import { lightTheme, darkTheme } from '@/constants/themes';
import type { ClaimableItem } from '@/types/claimable';

// Which theme the component renders against, switchable per test.
let mockUseDarkTheme = false;

jest.mock('expo-image', () => ({ Image: () => null }));

jest.mock(
  '@expo/vector-icons',
  () => ({
    Ionicons: () => null,
  }),
  { virtual: true }
);

jest.mock('@/contexts/ThemeContext', () => ({
  useTheme: () => {
    const themes = require('@/constants/themes');
    return { theme: mockUseDarkTheme ? themes.darkTheme : themes.lightTheme };
  },
}));

const baseItem: ClaimableItem = {
  id: '1_OWNER',
  contractId: 1,
  tokenName: 'Test Token',
  tokenSymbol: 'TT',
  tokenDecimals: 0,
  tokenVerified: false,
  owner: 'OWNEROWNEROWNEROWNER',
  amount: 100n,
  ownerBalance: 0n,
  isClaimable: false,
  approval: {
    owner: 'OWNEROWNEROWNEROWNER',
    round: 1,
    amount: '100',
    spender: 'SPENDER',
    timestamp: 1,
    contractId: 1,
    transactionId: 'TX',
  },
};

beforeEach(() => {
  mockUseDarkTheme = false;
  expect(lightTheme).toBeDefined();
});

describe('ClaimableTokenItem unknown balance (TASK-188)', () => {
  it('renders "Unavailable" and never "Insufficient" when the balance is unknown', () => {
    const { queryByText } = render(
      <ClaimableTokenItem
        item={{ ...baseItem, ownerBalanceUnknown: true }}
        onPress={jest.fn()}
      />
    );

    expect(queryByText('Unavailable')).toBeTruthy();
    expect(queryByText('Insufficient')).toBeNull();
  });

  it('still renders "Insufficient" for a genuinely insufficient balance', () => {
    const { queryByText } = render(
      <ClaimableTokenItem
        item={{ ...baseItem, ownerBalanceUnknown: false }}
        onPress={jest.fn()}
      />
    );

    expect(queryByText('Insufficient')).toBeTruthy();
    expect(queryByText('Unavailable')).toBeNull();
  });

  it('gives the unknown badge a valid background in the DARK theme too', () => {
    // Regression guard for `theme.colors.textMuted + '20'`: `textMuted` is
    // `rgba(...)` in the dark theme, so an appended alpha suffix produces an
    // invalid color string and the badge silently loses its background.
    mockUseDarkTheme = true;
    const { getByTestId } = render(
      <ClaimableTokenItem
        item={{ ...baseItem, ownerBalanceUnknown: true }}
        onPress={jest.fn()}
      />
    );

    const style = StyleSheet.flatten(
      getByTestId('claimable-unknown-badge').props.style
    );
    expect(typeof style.backgroundColor).toBe('string');
    expect(style.backgroundColor).not.toMatch(/^rgba\(.*\)[0-9a-f]+$/i);
    expect(darkTheme.colors.surfaceAlt).toBe(style.backgroundColor);
  });

  it('renders no badge at all for a claimable item', () => {
    const { queryByText } = render(
      <ClaimableTokenItem
        item={{ ...baseItem, ownerBalance: 500n, isClaimable: true }}
        onPress={jest.fn()}
      />
    );

    expect(queryByText('Insufficient')).toBeNull();
    expect(queryByText('Unavailable')).toBeNull();
  });
});
