/**
 * TASK-477 — removed-account card on the first onboarding screen.
 *
 * When the only account is removed by the boot reconcile, the wallet empties
 * and boot routes to onboarding, where Home (and its card) never mounts. These
 * tests pin the product rules for that case, using the REAL AccountSecureStorage
 * accessors over a mocked platform layer:
 *  - the card shows with the stored record intact,
 *  - starting a new wallet (or any other option) does not clear the record,
 *  - Re-import clears it and goes straight to import,
 *  - dismiss clears it and does not navigate.
 */

import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';

const mockPlainValues = new Map<string, string>();
jest.mock('@/platform', () => ({
  crypto: {
    getRandomBytes: async (n: number) => new Uint8Array(n),
    sha256: async () => 'test',
    randomUUID: () => 'test-id',
  },
  secureStorage: {
    getItem: jest.fn(async () => null),
    setItem: jest.fn(async () => {}),
    deleteItem: jest.fn(async () => {}),
  },
  storage: {
    getItem: jest.fn(async (key: string) => mockPlainValues.get(key) ?? null),
    setItem: jest.fn(async (key: string, value: string) => {
      mockPlainValues.set(key, value);
    }),
    removeItem: jest.fn(async (key: string) => {
      mockPlainValues.delete(key);
    }),
    multiRemove: jest.fn(async (keys: string[]) => {
      keys.forEach((key) => mockPlainValues.delete(key));
    }),
  },
  biometrics: {},
  deviceId: {},
}));

jest.mock('@/contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: require('@/constants/themes').lightTheme }),
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }), {
  virtual: true,
});
jest.mock('@/hooks/useReducedMotion', () => ({
  useReducedMotion: () => false,
}));
jest.mock('@/components/common/NFTBackground', () => {
  const { View } = require('react-native');
  return { NFTBackground: ({ children }: never) => <View>{children}</View> };
});
jest.mock('react-native-reanimated', () => {
  const actual = jest.requireActual('react-native-reanimated/mock');
  return { ...actual, __esModule: true, default: actual.default ?? actual };
});

import OnboardingScreen from '../OnboardingScreen';
import { AccountSecureStorage } from '@/services/secure/AccountSecureStorage';
import { formatAddress } from '@/utils/address';
import { makeAddress } from '@/__tests__/fixtures/algorand';

// A real, checksummed address: formatAddress only shortens valid ones.
const REMOVAL = {
  id: 'only-account',
  address: makeAddress('removed-only-account'),
  label: 'Savings',
};

const renderOnboarding = async () => {
  const navigation = { navigate: jest.fn() };
  const screen = await render(
    <OnboardingScreen navigation={navigation as never} />
  );
  return { navigation, screen };
};

const storedRemovals = () => AccountSecureStorage.readUnexplainedRemovals();

describe('OnboardingScreen removed-account card (TASK-477)', () => {
  beforeEach(async () => {
    mockPlainValues.clear();
    await AccountSecureStorage.recordUnexplainedRemovals([REMOVAL]);
  });

  it('shows the card with the stored record intact', async () => {
    const { screen } = await renderOnboarding();
    expect(
      await screen.findByText(
        `Savings (${formatAddress(REMOVAL.address)}) was removed from this device`
      )
    ).toBeTruthy();
    expect(await storedRemovals()).toEqual([REMOVAL]);
  });

  it('does not show a card when there is no record', async () => {
    mockPlainValues.clear();
    const { screen } = await renderOnboarding();
    await act(async () => {});
    expect(screen.queryByText('Re-import')).toBeNull();
    expect(screen.getByText('Create New Account')).toBeTruthy();
  });

  it('keeps the record when the user starts a new wallet or takes another option', async () => {
    const { navigation, screen } = await renderOnboarding();
    await screen.findByText('Re-import');
    await act(async () => {
      fireEvent.press(screen.getByText('Create New Account'));
    });
    expect(navigation.navigate).toHaveBeenCalledWith('CreateWallet');
    await act(async () => {
      fireEvent.press(screen.getByText('Continue without account'));
    });
    expect(await storedRemovals()).toEqual([REMOVAL]);
  });

  it('Re-import clears the record and goes straight to import', async () => {
    const { navigation, screen } = await renderOnboarding();
    await act(async () => {
      fireEvent.press(await screen.findByText('Re-import'));
    });
    expect(navigation.navigate).toHaveBeenCalledTimes(1);
    expect(navigation.navigate).toHaveBeenCalledWith('MnemonicImport', {
      isOnboarding: true,
    });
    expect(await storedRemovals()).toEqual([]);
  });

  it('dismiss clears the record without navigating', async () => {
    const { navigation, screen } = await renderOnboarding();
    await act(async () => {
      fireEvent.press(await screen.findByLabelText('Dismiss notice'));
    });
    expect(navigation.navigate).not.toHaveBeenCalled();
    expect(await storedRemovals()).toEqual([]);
  });
});
