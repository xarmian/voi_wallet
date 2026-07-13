// Verifies useSecureScreen's cross-target behavior WITHOUT any component
// renderer — this suite is deliberately Layer-1 (pure logic; no React rendering
// infra, which is planned separately).
//
// useSecureScreen is a module-level platform binding: on the web/extension
// target it resolves to a no-op, and on native it delegates to
// expo-screen-capture's usePreventScreenCapture. The important regression guard
// is that the WEB path never touches the native module (a native call on web
// throws UnavailabilityError and would crash the extension/web build).
//
// The hook calls React's useId() unconditionally, which requires a render
// dispatcher; we mock useId so the hook can be invoked directly and we can
// assert the platform binding rather than React lifecycle behavior.

jest.mock('expo-screen-capture', () => ({
  usePreventScreenCapture: jest.fn(),
  preventScreenCaptureAsync: jest.fn(),
}));

jest.mock('react', () => {
  const actual = jest.requireActual('react');
  return { ...actual, useId: () => 'test-key' };
});

type ScreenCaptureModule = typeof import('expo-screen-capture');

/**
 * Re-import the hook under a specific Platform.OS. The platform binding is read
 * at module-load time, so each case runs in an isolated module registry with
 * Platform.OS set beforehand.
 */
const loadHookForPlatform = (os: string) => {
  let useSecureScreen!: () => void;
  let screenCapture!: ScreenCaptureModule;
  jest.isolateModules(() => {
    const RN = require('react-native');
    RN.Platform.OS = os;
    screenCapture = require('expo-screen-capture');
    useSecureScreen = require('../useSecureScreen').useSecureScreen;
  });
  return { useSecureScreen, screenCapture };
};

describe('useSecureScreen', () => {
  it('is a no-op on the web/extension target: never touches the native module', () => {
    const { useSecureScreen, screenCapture } = loadHookForPlatform('web');

    expect(() => useSecureScreen()).not.toThrow();
    expect(screenCapture.usePreventScreenCapture).not.toHaveBeenCalled();
    expect(screenCapture.preventScreenCaptureAsync).not.toHaveBeenCalled();
  });

  it('engages native screen-capture prevention with a per-instance key', () => {
    const { useSecureScreen, screenCapture } = loadHookForPlatform('ios');

    useSecureScreen();

    expect(screenCapture.usePreventScreenCapture).toHaveBeenCalledTimes(1);
    expect(screenCapture.usePreventScreenCapture).toHaveBeenCalledWith(
      'test-key'
    );
  });
});
