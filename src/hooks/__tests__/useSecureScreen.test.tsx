import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

jest.mock('expo-screen-capture', () => ({
  usePreventScreenCapture: jest.fn(),
}));

// NOTE: useSecureScreen binds its implementation at module-load time based on
// `Platform.OS` (so the web/extension bundle never calls the native module).
// Tests that need a specific platform therefore (re-)require the hook inside
// `jest.isolateModules` after setting `Platform.OS` on that isolated module
// graph.

describe('useSecureScreen (native)', () => {
  it('engages screen-capture prevention with a unique, stable key', () => {
    // jest-expo defaults Platform.OS to 'ios'.
    const screenCapture = require('expo-screen-capture');
    const { useSecureScreen } = require('../useSecureScreen');

    function Probe() {
      useSecureScreen();
      return null;
    }

    let renderer: ReturnType<typeof TestRenderer.create>;
    act(() => {
      renderer = TestRenderer.create(<Probe />);
    });

    expect(screenCapture.usePreventScreenCapture).toHaveBeenCalledTimes(1);
    const key = screenCapture.usePreventScreenCapture.mock.calls[0][0];
    expect(typeof key).toBe('string');
    expect(key.length).toBeGreaterThan(0);

    act(() => {
      renderer.unmount();
    });
  });
});

describe('useSecureScreen (web/extension)', () => {
  it('no-ops: never calls the native module and does not throw', () => {
    jest.isolateModules(() => {
      const RN = require('react-native');
      RN.Platform.OS = 'web';

      // Require React and the renderer INSIDE the isolated graph so the hook's
      // `useId` and the renderer share one React instance (JSX/`TestRenderer`
      // from the outer scope would use a different React copy → dispatcher
      // mismatch), and use `createElement` rather than JSX for the same reason.
      const ReactIsolated = require('react');
      const RendererIsolated = require('react-test-renderer');
      const screenCapture = require('expo-screen-capture');
      const { useSecureScreen } = require('../useSecureScreen');

      function Probe() {
        useSecureScreen();
        return null;
      }

      expect(() => {
        let renderer: ReturnType<typeof RendererIsolated.create>;
        RendererIsolated.act(() => {
          renderer = RendererIsolated.create(
            ReactIsolated.createElement(Probe)
          );
        });
        RendererIsolated.act(() => {
          renderer.unmount();
        });
      }).not.toThrow();

      expect(screenCapture.usePreventScreenCapture).not.toHaveBeenCalled();
    });
  });
});
