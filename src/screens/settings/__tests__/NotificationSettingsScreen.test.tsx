// TASK-565: when notifications are off for the app in device settings and the
// app can no longer ask, the screen says so and opens the device settings. A
// return to the app re-reads the permission, so turning it on there clears the
// notice.

import React from 'react';
import { AppState, AppStateStatus, Linking } from 'react-native';
import { act, fireEvent, render } from '@testing-library/react-native';
import NotificationSettingsScreen from '../NotificationSettingsScreen';

const NOTICE = 'Notifications are off for Voi Wallet in your device settings.';

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: jest.fn(), navigate: jest.fn() }),
}));
const mockGetPermissionState = jest.fn();
jest.mock('@/services/notifications', () => {
  const types = jest.requireActual('@/services/notifications/types');
  return {
    ...types,
    notificationService: {
      getPermissionState: () => mockGetPermissionState(),
      getPreferences: jest.fn(async () => null),
    },
  };
});
jest.mock('@/services/supabase', () => ({ isSupabaseConfigured: () => true }));
const mockAccount = { id: 'a1', address: 'ADDR1', type: 'standard' };
jest.mock('@/store/walletStore', () => ({
  useActiveAccount: () => mockAccount,
  useAccounts: () => [mockAccount],
}));
jest.mock('@/contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: require('@/constants/themes').lightTheme }),
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('react-native-safe-area-context', () => {
  const { View } = require('react-native');
  return {
    SafeAreaView: View,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});
jest.mock('@/components/common/UniversalHeader', () => () => null);
jest.mock('@/components/account/AccountListModal', () => () => null);
jest.mock('@/components/common/NFTBackground', () => ({
  NFTBackground: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('@/components/common/GlassCard', () => ({
  GlassCard: ({ children }: { children: React.ReactNode }) => children,
}));

let appStateListeners: ((state: AppStateStatus) => void)[];

beforeEach(() => {
  jest.clearAllMocks();
  appStateListeners = [];
  jest.spyOn(AppState, 'addEventListener').mockImplementation(((
    _type: string,
    listener: (state: AppStateStatus) => void
  ) => {
    appStateListeners.push(listener);
    return {
      remove: () => {
        appStateListeners = appStateListeners.filter((l) => l !== listener);
      },
    };
  }) as typeof AppState.addEventListener);
  jest.spyOn(Linking, 'openSettings').mockResolvedValue(undefined);
});
afterEach(() => jest.restoreAllMocks());

const mount = async () => {
  const view = await render(<NotificationSettingsScreen />);
  await act(async () => {});
  return view;
};

it('shows the device-settings notice when denied and the app cannot ask again; Open Settings opens them', async () => {
  mockGetPermissionState.mockResolvedValue({
    status: 'denied',
    canAskAgain: false,
  });
  const view = await mount();

  expect(view.getByText(NOTICE)).toBeTruthy();
  await fireEvent.press(view.getByRole('button', { name: 'Open Settings' }));
  expect(Linking.openSettings).toHaveBeenCalledTimes(1);
});

it.each([
  ['granted', true],
  ['undetermined', true],
  ['denied', true],
] as const)(
  'shows no notice when permission is %s and the app can ask again (canAskAgain %s)',
  async (status, canAskAgain) => {
    mockGetPermissionState.mockResolvedValue({ status, canAskAgain });
    const view = await mount();

    expect(view.getByText('Enable Push Notifications')).toBeTruthy();
    expect(view.queryByText(NOTICE)).toBeNull();
    expect(view.queryByRole('button', { name: 'Open Settings' })).toBeNull();
  }
);

it('shows no notice when permission is granted even if canAskAgain is false', async () => {
  mockGetPermissionState.mockResolvedValue({
    status: 'granted',
    canAskAgain: false,
  });
  const view = await mount();

  expect(view.getByText('Enable Push Notifications')).toBeTruthy();
  expect(view.queryByText(NOTICE)).toBeNull();
});

it('clears the notice when the app returns active with permission turned on', async () => {
  mockGetPermissionState.mockResolvedValue({
    status: 'denied',
    canAskAgain: false,
  });
  const view = await mount();
  expect(view.getByText(NOTICE)).toBeTruthy();

  mockGetPermissionState.mockResolvedValue({
    status: 'granted',
    canAskAgain: true,
  });
  await act(async () => {
    appStateListeners.forEach((listener) => listener('active'));
  });

  expect(view.queryByText(NOTICE)).toBeNull();
});

it('shows the notice when the app returns active after permission was turned off', async () => {
  mockGetPermissionState.mockResolvedValue({
    status: 'granted',
    canAskAgain: true,
  });
  const view = await mount();
  expect(view.queryByText(NOTICE)).toBeNull();

  mockGetPermissionState.mockResolvedValue({
    status: 'denied',
    canAskAgain: false,
  });
  await act(async () => {
    appStateListeners.forEach((listener) => listener('background'));
  });
  expect(view.queryByText(NOTICE)).toBeNull();
  await act(async () => {
    appStateListeners.forEach((listener) => listener('active'));
  });

  expect(view.getByText(NOTICE)).toBeTruthy();
});

it('ignores an older permission read that resolves after a newer one', async () => {
  // The mount read is slow and reports denied; the user turns permission on
  // and returns before it resolves, and that newer read reports granted.
  let resolveMountRead: (value: {
    status: string;
    canAskAgain: boolean;
  }) => void = () => {};
  mockGetPermissionState.mockReturnValueOnce(
    new Promise((resolve) => {
      resolveMountRead = resolve;
    })
  );
  const view = await mount();

  mockGetPermissionState.mockResolvedValue({
    status: 'granted',
    canAskAgain: true,
  });
  await act(async () => {
    appStateListeners.forEach((listener) => listener('active'));
  });
  expect(view.queryByText(NOTICE)).toBeNull();

  await act(async () => {
    resolveMountRead({ status: 'denied', canAskAgain: false });
  });

  expect(view.queryByText(NOTICE)).toBeNull();
});
