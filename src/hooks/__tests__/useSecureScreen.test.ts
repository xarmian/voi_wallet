// Verifies useSecureScreen's cross-target behavior.
//
// useSecureScreen is a module-level platform binding: on the web/extension
// target the capture half resolves to a no-op, and on native it delegates to
// expo-screen-capture's usePreventScreenCapture. The important regression guard
// is that the WEB path never touches the native module (a native call on web
// throws UnavailabilityError and would crash the extension/web build).
//
// TASK-493: one call also keeps the screen out of the iOS app-switcher
// snapshot (screen-capture prevention does not cover it). The two halves ship
// in the same hook so a secret screen cannot take one and miss the other.
//
// The platform binding is read at module-load time, so each case loads the hook
// (and the renderer, so both share one React instance) in an isolated module
// registry with Platform.OS set beforehand.

jest.mock('expo-screen-capture', () => ({
  usePreventScreenCapture: jest.fn(),
  preventScreenCaptureAsync: jest.fn(),
  enableAppSwitcherProtectionAsync: jest.fn(() => Promise.resolve()),
  disableAppSwitcherProtectionAsync: jest.fn(() => Promise.resolve()),
}));

import React from 'react';
import { renderHook } from '@testing-library/react-native';

type ScreenCaptureModule = typeof import('expo-screen-capture');

// Loads the hook for one platform. The hook needs only `Platform` from
// react-native, so each case gives it a minimal react-native whose Platform.OS
// is fixed BEFORE the module-level binding is read (mutating the real Platform
// does not stick under jest-expo). The isolated registry reuses this file's
// React instance (doMock) so the top-level renderer and the freshly loaded hook
// share one dispatcher.
const loadHookForPlatform = (os: string) => {
  let useSecureScreen!: () => void;
  let screenCapture!: ScreenCaptureModule;
  jest.isolateModules(() => {
    jest.doMock('react', () => React);
    jest.doMock('react-native', () => ({ Platform: { OS: os } }));
    screenCapture = require('expo-screen-capture');
    useSecureScreen = require('../useSecureScreen').useSecureScreen;
  });
  return { useSecureScreen, screenCapture, renderHook };
};

describe('useSecureScreen', () => {
  it('is a no-op on the web/extension target: never touches the native module', async () => {
    const { useSecureScreen, screenCapture, renderHook } =
      loadHookForPlatform('web');

    await renderHook(() => useSecureScreen());

    expect(screenCapture.usePreventScreenCapture).not.toHaveBeenCalled();
    expect(screenCapture.preventScreenCaptureAsync).not.toHaveBeenCalled();
    expect(
      screenCapture.enableAppSwitcherProtectionAsync
    ).not.toHaveBeenCalled();
    expect(
      screenCapture.disableAppSwitcherProtectionAsync
    ).not.toHaveBeenCalled();
  });

  it('engages native screen-capture prevention with a per-instance key', async () => {
    const { useSecureScreen, screenCapture, renderHook } =
      loadHookForPlatform('ios');

    await renderHook(() => useSecureScreen());

    expect(screenCapture.usePreventScreenCapture).toHaveBeenCalledTimes(1);
    expect(screenCapture.usePreventScreenCapture).toHaveBeenCalledWith(
      expect.any(String)
    );
  });

  describe('iOS app-switcher protection (TASK-493)', () => {
    it('turns the switcher blur on at mount and off at unmount', async () => {
      const { useSecureScreen, screenCapture, renderHook } =
        loadHookForPlatform('ios');

      const view = await renderHook(() => useSecureScreen());
      expect(
        screenCapture.enableAppSwitcherProtectionAsync
      ).toHaveBeenCalledTimes(1);
      expect(
        screenCapture.disableAppSwitcherProtectionAsync
      ).not.toHaveBeenCalled();

      await view.unmount();
      expect(
        screenCapture.disableAppSwitcherProtectionAsync
      ).toHaveBeenCalledTimes(1);
    });

    it('two nested guards release the blur only when both have unmounted', async () => {
      const { useSecureScreen, screenCapture, renderHook } =
        loadHookForPlatform('ios');

      const outer = await renderHook(() => useSecureScreen());
      const inner = await renderHook(() => useSecureScreen());
      // One global switch: enabled once, however many guards are mounted.
      expect(
        screenCapture.enableAppSwitcherProtectionAsync
      ).toHaveBeenCalledTimes(1);

      await inner.unmount();
      expect(
        screenCapture.disableAppSwitcherProtectionAsync
      ).not.toHaveBeenCalled();

      await outer.unmount();
      expect(
        screenCapture.disableAppSwitcherProtectionAsync
      ).toHaveBeenCalledTimes(1);
    });

    it('re-enables the blur for a screen mounted after everything was released', async () => {
      const { useSecureScreen, screenCapture, renderHook } =
        loadHookForPlatform('ios');

      const first = await renderHook(() => useSecureScreen());
      await first.unmount();
      await renderHook(() => useSecureScreen());

      expect(
        screenCapture.enableAppSwitcherProtectionAsync
      ).toHaveBeenCalledTimes(2);
    });

    it('does not change anything on Android (FLAG_SECURE already blanks the preview)', async () => {
      const { useSecureScreen, screenCapture, renderHook } =
        loadHookForPlatform('android');

      const view = await renderHook(() => useSecureScreen());
      await view.unmount();

      expect(screenCapture.usePreventScreenCapture).toHaveBeenCalledTimes(1);
      expect(
        screenCapture.enableAppSwitcherProtectionAsync
      ).not.toHaveBeenCalled();
      expect(
        screenCapture.disableAppSwitcherProtectionAsync
      ).not.toHaveBeenCalled();
    });

    it('a rejected native call never throws into the screen', async () => {
      const { useSecureScreen, screenCapture, renderHook } =
        loadHookForPlatform('ios');
      jest
        .mocked(screenCapture.enableAppSwitcherProtectionAsync)
        .mockRejectedValueOnce(new Error('native unavailable'));

      const view = await renderHook(() => useSecureScreen());
      await expect(view.unmount()).resolves.not.toThrow();
    });
  });
});
