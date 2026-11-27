// TASK-478: the Home notice for keys found on this device, and the summary the
// Settings row reads on focus. Real storage, wallet service and reconcile over
// the in-memory platform; neither surface reads a key.
import React from 'react';
import { Text } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

jest.mock('@/platform', () =>
  require('@/services/secure/__tests__/fixtures/task478Platform').createTask478Platform()
);
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async () => null),
    setItem: jest.fn(async () => {}),
    removeItem: jest.fn(async () => {}),
    multiRemove: jest.fn(async () => {}),
    multiSet: jest.fn(async () => {}),
    getAllKeys: jest.fn(async () => []),
  },
}));
jest.mock('@/store/walletStore', () => ({
  removePersistedBalanceCaches: jest.fn(async () => {}),
}));
jest.mock('@react-navigation/native', () =>
  require('@/__tests__/fixtures/navigationFocus').createNavigationFocusMock()
);
jest.mock('@/contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: require('@/constants/themes').lightTheme }),
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }), {
  virtual: true,
});
jest.mock('@/hooks/useReducedMotion', () => ({
  useReducedMotion: () => false,
}));
jest.mock('react-native-reanimated', () => {
  const actual = jest.requireActual('react-native-reanimated/mock');
  return { ...actual, __esModule: true, default: actual.default ?? actual };
});

import FoundAccountsNoticeHost from '../FoundAccountsNoticeHost';
import { useFoundAccountsSummary } from '@/hooks/useFoundAccountsSummary';
import { refocus } from '@/__tests__/fixtures/navigationFocus';
import {
  boot,
  pinDeviceWithTwoOrphans,
  resetAll,
  spyDecryptors,
  unlock,
  writeUnboundKey,
} from '@/services/secure/__tests__/fixtures/task478Helpers';

function SettingsProbe() {
  const { summary, error } = useFoundAccountsSummary();
  return (
    <Text>{error ? 'error' : `found ${summary?.presentCount ?? '-'}`}</Text>
  );
}

beforeEach(() => {
  resetAll();
  jest.restoreAllMocks();
});

describe('FoundAccountsNoticeHost', () => {
  it('shows once', async () => {
    await pinDeviceWithTwoOrphans();
    const reads = spyDecryptors();
    const onReview = jest.fn();
    const view = await render(<FoundAccountsNoticeHost onReview={onReview} />);
    await view.findByText('2 accounts found on this device');

    await act(async () => {
      fireEvent.press(view.getByText('Not now'));
    });
    await waitFor(() =>
      expect(view.queryByText('2 accounts found on this device')).toBeNull()
    );
    await act(async () => {
      refocus();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(view.queryByText(/found on this device/)).toBeNull();

    // A key found later is announced again.
    await writeUnboundKey('orphan-later');
    await boot();
    unlock();
    await act(async () => {
      refocus();
    });
    await view.findByText('3 accounts found on this device');
    fireEvent.press(view.getByText('Review'));
    expect(onReview).toHaveBeenCalledTimes(1);
    expect(reads.total()).toBe(0);
  });

  it('Home and Settings focus read no key', async () => {
    await pinDeviceWithTwoOrphans();
    const reads = spyDecryptors();
    const view = await render(
      <>
        <FoundAccountsNoticeHost onReview={jest.fn()} />
        <SettingsProbe />
      </>
    );
    await view.findByText('found 2');
    await view.findByText('2 accounts found on this device');
    for (let i = 0; i < 3; i++)
      await act(async () => {
        refocus();
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    await view.findByText('found 2');
    expect(reads.total()).toBe(0);
  });
});
