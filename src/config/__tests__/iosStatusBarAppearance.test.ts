/**
 * Guard for the iOS status bar appearance setting in app.config.js.
 *
 * The app picks its own light/dark theme and sets the status bar style from
 * JavaScript (App.tsx). That only works on iOS 26 and earlier while
 * UIViewControllerBasedStatusBarAppearance is false: when it is true, the
 * top native-stack screen decides the style, and with no statusBarStyle
 * option it follows the system appearance instead of the app's theme.
 *
 * Expo's prebuild template sets the key to true from expo 58.0.24, so
 * app.config.js must pin it, or every regenerated ios/ project flips it.
 */

const appConfig = require('../../../app.config.js').default as {
  expo: { ios: { infoPlist: Record<string, unknown> } };
};

describe('iOS status bar appearance', () => {
  it('pins UIViewControllerBasedStatusBarAppearance to false over the prebuild template', () => {
    expect(
      appConfig.expo.ios.infoPlist.UIViewControllerBasedStatusBarAppearance
    ).toBe(false);
  });
});
