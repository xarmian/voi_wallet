// Unit tests for the F-48 splash controller (TASK-182). The module keeps a
// process-wide "already hidden" latch, so each test resets the module registry
// and re-mocks expo-splash-screen to get a fresh latch + fresh spy.

type SplashModule = typeof import('../splashController');

function loadFresh(hideImpl?: () => Promise<void>): {
  mod: SplashModule;
  hideAsync: jest.Mock;
  preventAutoHideAsync: jest.Mock;
} {
  jest.resetModules();
  const hideAsync = jest.fn(hideImpl ?? (() => Promise.resolve()));
  const preventAutoHideAsync = jest.fn(() => Promise.resolve());
  jest.doMock('expo-splash-screen', () => ({
    hideAsync,
    preventAutoHideAsync,
  }));
  const mod = require('../splashController') as SplashModule;
  return { mod, hideAsync, preventAutoHideAsync };
}

describe('hideSplashScreen', () => {
  it('dismisses the native splash exactly once', async () => {
    const { mod, hideAsync } = loadFresh();

    await mod.hideSplashScreen();

    expect(hideAsync).toHaveBeenCalledTimes(1);
  });

  it('is idempotent — repeat calls never fire hideAsync again', async () => {
    const { mod, hideAsync } = loadFresh();

    await mod.hideSplashScreen();
    await mod.hideSplashScreen();
    await mod.hideSplashScreen();

    expect(hideAsync).toHaveBeenCalledTimes(1);
  });

  it('latches even under concurrent callers (single hideAsync)', async () => {
    const { mod, hideAsync } = loadFresh();

    await Promise.all([
      mod.hideSplashScreen(),
      mod.hideSplashScreen(),
      mod.hideSplashScreen(),
    ]);

    expect(hideAsync).toHaveBeenCalledTimes(1);
  });

  it('swallows a hideAsync rejection instead of propagating it', async () => {
    const { mod, hideAsync } = loadFresh(() =>
      Promise.reject(new Error('already hidden'))
    );

    await expect(mod.hideSplashScreen()).resolves.toBeUndefined();
    expect(hideAsync).toHaveBeenCalledTimes(1);
  });

  it('stays latched after a rejection (no retry that could re-throw)', async () => {
    const { mod, hideAsync } = loadFresh(() =>
      Promise.reject(new Error('already hidden'))
    );

    await mod.hideSplashScreen();
    await mod.hideSplashScreen();

    expect(hideAsync).toHaveBeenCalledTimes(1);
  });
});

describe('armSplashWatchdog', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('does not hide before the watchdog interval elapses', () => {
    const { mod, hideAsync } = loadFresh();

    mod.armSplashWatchdog();
    jest.advanceTimersByTime(mod.SPLASH_WATCHDOG_MS - 1);

    expect(hideAsync).not.toHaveBeenCalled();
  });

  it('force-hides once the watchdog interval elapses', () => {
    const { mod, hideAsync } = loadFresh();

    mod.armSplashWatchdog();
    jest.advanceTimersByTime(mod.SPLASH_WATCHDOG_MS);

    expect(hideAsync).toHaveBeenCalledTimes(1);
  });

  it('is a no-op once the readiness owner has already hidden the splash', async () => {
    const { mod, hideAsync } = loadFresh();

    await mod.hideSplashScreen();
    mod.armSplashWatchdog();
    jest.advanceTimersByTime(mod.SPLASH_WATCHDOG_MS);

    expect(hideAsync).toHaveBeenCalledTimes(1);
  });
});
