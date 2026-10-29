import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

const mockUpsert = jest.fn(async () => ({ error: null as unknown }));
const mockSupabaseClient = {
  schema: jest.fn(() => ({
    from: jest.fn(() => ({ upsert: mockUpsert })),
  })),
};
let mockSupabaseConfigured = true;

jest.mock('../../supabase', () => ({
  getSupabaseClient: () => (mockSupabaseConfigured ? mockSupabaseClient : null),
  isSupabaseConfigured: () => mockSupabaseConfigured,
  setDeviceId: jest.fn(),
}));

jest.mock('expo-notifications', () => ({
  getPermissionsAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
  getExpoPushTokenAsync: jest.fn(),
  setNotificationChannelAsync: jest.fn(),
  AndroidImportance: { HIGH: 4, DEFAULT: 3 },
}));
jest.mock('expo-device', () => ({ isDevice: true }));
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { extra: { eas: { projectId: 'test-project' } } } },
}));
jest.mock('react-native-toast-message', () => ({
  __esModule: true,
  default: { show: jest.fn(), hide: jest.fn() },
}));
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async () => null),
    setItem: jest.fn(async () => {}),
    removeItem: jest.fn(async () => {}),
  },
}));
jest.mock('../../../platform', () => ({
  deviceId: { getDeviceId: jest.fn(async () => 'test-device') },
}));
jest.mock('@/services/wallet/ownKeyCustody', () => ({
  probeOwnKey: jest.fn(),
}));

import { notificationService } from '../index';

const permissions = (status: 'granted' | 'undetermined' | 'denied') =>
  ({
    status,
    granted: status === 'granted',
    canAskAgain: status !== 'denied',
    expires: 'never',
  }) as Notifications.NotificationPermissionsStatus;

describe('notificationService.registerPushToken (TASK-433)', () => {
  beforeEach(() => {
    mockSupabaseConfigured = true;
    // Reset the singleton's registration state between tests.
    Object.assign(notificationService, {
      deviceId: 'test-device',
      pushToken: null,
      pushTokenWarningLogged: false,
    });
    jest.replaceProperty(Platform, 'OS', 'android');
    jest
      .mocked(Notifications.getPermissionsAsync)
      .mockResolvedValue(permissions('granted'));
    jest
      .mocked(Notifications.requestPermissionsAsync)
      .mockResolvedValue(permissions('granted'));
    jest.mocked(Notifications.getExpoPushTokenAsync).mockResolvedValue({
      type: 'expo',
      data: 'expo-token',
    });
    mockUpsert.mockResolvedValue({ error: null });
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each(['undetermined', 'denied'] as const)(
    'does not prompt or fetch a token at startup when permission is %s (negative control)',
    async (status) => {
      jest
        .mocked(Notifications.getPermissionsAsync)
        .mockResolvedValue(permissions(status));

      const token = await notificationService.registerPushToken({
        prompt: false,
      });

      expect(Notifications.getPermissionsAsync).toHaveBeenCalledTimes(1);
      expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled();
      expect(Notifications.getExpoPushTokenAsync).not.toHaveBeenCalled();
      expect(Notifications.setNotificationChannelAsync).not.toHaveBeenCalled();
      expect(mockUpsert).not.toHaveBeenCalled();
      expect(token).toBeNull();
    }
  );

  it('refreshes a token and sets up Android channels when permission is already granted', async () => {
    expect(await notificationService.registerPushToken({ prompt: false })).toBe(
      'expo-token'
    );

    expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(Notifications.setNotificationChannelAsync).toHaveBeenCalledWith(
      'default',
      expect.any(Object)
    );
    expect(Notifications.getExpoPushTokenAsync).toHaveBeenCalledWith({
      projectId: 'test-project',
    });
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        device_id: 'test-device',
        push_token: 'expo-token',
        platform: 'android',
        is_valid: true,
      }),
      { onConflict: 'device_id,push_token' }
    );
  });

  it.each([
    { code: 'E_REGISTRATION_FAILED', message: 'Native registration failed' },
    { message: 'Fetching the token failed: FIS_AUTH_ERROR' },
  ])('warns once for a known native token failure: %j', async (error) => {
    jest.mocked(Notifications.getExpoPushTokenAsync).mockRejectedValue(error);

    expect(
      await notificationService.registerPushToken({ prompt: false })
    ).toBeNull();
    expect(
      await notificationService.registerPushToken({ prompt: false })
    ).toBeNull();

    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith(
      '[Notifications] Push token unavailable:',
      'code' in error ? error.code : 'FIS_ERROR'
    );
    expect(console.error).not.toHaveBeenCalled();
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it.each(['Supabase', 'device ID'])(
    'does not touch permission APIs without %s',
    async (missing) => {
      if (missing === 'Supabase') mockSupabaseConfigured = false;
      else Object.assign(notificationService, { deviceId: null });

      expect(await notificationService.registerPushToken()).toBeNull();

      expect(Notifications.getPermissionsAsync).not.toHaveBeenCalled();
      expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled();
      expect(Notifications.getExpoPushTokenAsync).not.toHaveBeenCalled();
    }
  );

  it('still requests permission by default for the explicit Settings opt-in', async () => {
    jest
      .mocked(Notifications.getPermissionsAsync)
      .mockResolvedValue(permissions('undetermined'));

    expect(await notificationService.registerPushToken()).toBe('expo-token');

    expect(Notifications.requestPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(Notifications.getExpoPushTokenAsync).toHaveBeenCalledTimes(1);
  });

  it('keeps unexpected token failures at error level', async () => {
    const error = new Error('Unexpected token failure');
    jest.mocked(Notifications.getExpoPushTokenAsync).mockRejectedValue(error);

    expect(await notificationService.registerPushToken()).toBeNull();

    expect(console.error).toHaveBeenCalledWith(
      'Error registering push token:',
      error
    );
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('keeps Supabase upsert errors at error level', async () => {
    const error = { code: '42501', message: 'Permission denied' };
    mockUpsert.mockResolvedValue({ error });

    expect(await notificationService.registerPushToken()).toBeNull();

    expect(console.error).toHaveBeenCalledWith(
      'Failed to register push token:',
      error
    );
    expect(console.warn).not.toHaveBeenCalled();
  });
});
