// TASK-565: Home offers notifications while permission is not granted, until
// the user dismisses the offer. It stays hidden until its reads resolve, and a
// re-check on focus or on returning to the app hides it once permission is on.

import React from 'react';
import { act, render } from '@testing-library/react-native';
import { AppState, AppStateStatus, Platform } from 'react-native';
import {
  NOTIFICATIONS_OFFER_DISMISSED_KEY,
  useNotificationsOffer,
} from '../useNotificationsOffer';
import { refocus } from '@/__tests__/fixtures/navigationFocus';

jest.mock('@react-navigation/native', () =>
  require('@/__tests__/fixtures/navigationFocus').createNavigationFocusMock()
);

const mockGetPermissionState = jest.fn();
jest.mock('@/services/notifications', () => ({
  notificationService: {
    getPermissionState: () => mockGetPermissionState(),
  },
}));
let mockConfigured = true;
jest.mock('@/services/supabase', () => ({
  isSupabaseConfigured: () => mockConfigured,
}));
const mockGetItem = jest.fn();
const mockSetItem = jest.fn();
jest.mock('@/platform', () => ({
  storage: {
    getItem: (key: string) => mockGetItem(key),
    setItem: (key: string, value: string) => mockSetItem(key, value),
  },
}));

type Offer = ReturnType<typeof useNotificationsOffer>;
const Harness = ({ onValue }: { onValue: (v: Offer) => void }) => {
  onValue(useNotificationsOffer());
  return null;
};
const mount = async () => {
  const values: Offer[] = [];
  const view = await render(<Harness onValue={(v) => values.push(v)} />);
  return { values, view, last: () => values.at(-1)! };
};
const flush = () => act(async () => {});
const permission = (
  status: 'granted' | 'undetermined' | 'denied',
  canAskAgain = status !== 'denied'
) => ({ status, canAskAgain });

let appStateListeners: ((state: AppStateStatus) => void)[];

beforeEach(() => {
  jest.clearAllMocks();
  mockConfigured = true;
  jest.replaceProperty(Platform, 'OS', 'ios');
  mockGetPermissionState.mockResolvedValue(permission('undetermined'));
  mockGetItem.mockResolvedValue(null);
  mockSetItem.mockResolvedValue(undefined);
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
});
afterEach(() => jest.restoreAllMocks());

it('is hidden when permission is granted', async () => {
  mockGetPermissionState.mockResolvedValue(permission('granted'));
  const { last } = await mount();
  await flush();
  expect(last().visible).toBe(false);
});

it('is visible when permission is undetermined', async () => {
  const { last } = await mount();
  await flush();
  expect(last().visible).toBe(true);
  expect(mockGetItem).toHaveBeenCalledWith(NOTIFICATIONS_OFFER_DISMISSED_KEY);
});

it('is visible when permission is denied', async () => {
  mockGetPermissionState.mockResolvedValue(permission('denied', false));
  const { last } = await mount();
  await flush();
  expect(last().visible).toBe(true);
});

it('is hidden when the offer was dismissed before', async () => {
  mockGetItem.mockResolvedValue('1');
  const { last } = await mount();
  await flush();
  expect(last().visible).toBe(false);
});

it('counts a storage read error as not dismissed', async () => {
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  mockGetItem.mockRejectedValue(new Error('read failed'));
  const { last } = await mount();
  await flush();
  expect(last().visible).toBe(true);
});

it('dismiss() hides it at once and stores the dismissal', async () => {
  const { last } = await mount();
  await flush();
  expect(last().visible).toBe(true);

  await act(async () => {
    last().dismiss();
  });

  expect(last().visible).toBe(false);
  expect(mockSetItem).toHaveBeenCalledWith(
    NOTIFICATIONS_OFFER_DISMISSED_KEY,
    '1'
  );
});

it('dismiss() still hides it for this session when the write fails', async () => {
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  mockSetItem.mockRejectedValue(new Error('write failed'));
  const { last } = await mount();
  await flush();

  await act(async () => {
    last().dismiss();
  });
  await flush();

  expect(last().visible).toBe(false);
  // A later re-check does not bring it back in this session.
  await act(async () => {
    refocus();
  });
  await flush();
  expect(last().visible).toBe(false);
});

it('keeps a dismiss() made before the stored read resolves', async () => {
  let resolveDismissed!: (value: string | null) => void;
  mockGetItem.mockReturnValue(
    new Promise((resolve) => {
      resolveDismissed = resolve;
    })
  );
  const { last } = await mount();
  await flush();

  await act(async () => {
    last().dismiss();
  });
  await act(async () => {
    resolveDismissed(null);
  });

  expect(last().visible).toBe(false);
});

it('is hidden on web and reads nothing', async () => {
  jest.replaceProperty(Platform, 'OS', 'web');
  const { last } = await mount();
  await flush();
  expect(last().visible).toBe(false);
  expect(mockGetPermissionState).not.toHaveBeenCalled();
});

it('is hidden when notifications are not configured', async () => {
  mockConfigured = false;
  const { last } = await mount();
  await flush();
  expect(last().visible).toBe(false);
  expect(mockGetPermissionState).not.toHaveBeenCalled();
});

it('hides once a focus re-check reports granted', async () => {
  const { last } = await mount();
  await flush();
  expect(last().visible).toBe(true);

  mockGetPermissionState.mockResolvedValue(permission('granted'));
  await act(async () => {
    refocus();
  });
  await flush();

  expect(last().visible).toBe(false);
});

it('hides once returning to the app reports granted', async () => {
  const { last } = await mount();
  await flush();
  expect(last().visible).toBe(true);
  expect(appStateListeners).toHaveLength(1);

  mockGetPermissionState.mockResolvedValue(permission('granted'));
  await act(async () => {
    appStateListeners.forEach((listener) => listener('active'));
  });
  await flush();

  expect(last().visible).toBe(false);
});

it('is never visible before the reads resolve', async () => {
  let resolvePermission!: (value: unknown) => void;
  mockGetPermissionState.mockReturnValue(
    new Promise((resolve) => {
      resolvePermission = resolve;
    })
  );
  let resolveDismissed!: (value: string | null) => void;
  mockGetItem.mockReturnValue(
    new Promise((resolve) => {
      resolveDismissed = resolve;
    })
  );

  const { values, last } = await mount();
  await flush();
  expect(last().visible).toBe(false);

  await act(async () => {
    resolvePermission(permission('undetermined'));
  });
  // Every render so far, with the dismissal read still pending, was hidden.
  expect(values.every((v) => !v.visible)).toBe(true);

  await act(async () => {
    resolveDismissed(null);
  });
  expect(last().visible).toBe(true);
});

it('removes its AppState listener on unmount and does not render again', async () => {
  const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
  let resolvePermission!: (value: unknown) => void;
  mockGetPermissionState.mockReturnValue(
    new Promise((resolve) => {
      resolvePermission = resolve;
    })
  );
  const { values, view } = await mount();
  const rendersBefore = values.length;

  await view.unmount();
  await act(async () => {
    resolvePermission(permission('undetermined'));
  });

  expect(values).toHaveLength(rendersBefore);
  expect(appStateListeners).toHaveLength(0);
  expect(errors).not.toHaveBeenCalled();
});
