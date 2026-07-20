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

  // Hardening (F-48): latch ONLY after a confirmed hide. A hideAsync that rejects
  // while the splash may still be visible must NOT latch — otherwise a failed
  // early caller would neuter the watchdog and could strand the user.
  it('does not permanently latch after a rejection — a later call retries', async () => {
    let calls = 0;
    const { mod, hideAsync } = loadFresh(() => {
      calls += 1;
      // First attempt rejects (splash may still be visible); second succeeds.
      return calls === 1
        ? Promise.reject(new Error('still visible'))
        : Promise.resolve();
    });

    await mod.hideSplashScreen(); // attempt 1: rejects, does NOT latch
    await mod.hideSplashScreen(); // attempt 2: resolves, latches
    await mod.hideSplashScreen(); // now genuinely hidden: no-op

    expect(hideAsync).toHaveBeenCalledTimes(2);
  });

  it('latches once a hideAsync resolves — no double-hide spam afterward', async () => {
    const { mod, hideAsync } = loadFresh();

    await mod.hideSplashScreen();
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

  it('force-hides once the watchdog interval elapses (bounds a hung cascade)', () => {
    const { mod, hideAsync } = loadFresh();

    // Readiness never fires (a gate silently hangs) — the watchdog is the only
    // thing that hides the splash, and it does so within its bound.
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

  it('still fires/retries if an earlier hide attempt rejected while visible', async () => {
    // A non-watchdog caller fires first and its hideAsync REJECTS while the
    // splash is still visible. Because the latch is on-resolve, the watchdog must
    // still be able to retry — it is not neutered by the failed attempt.
    const { mod, hideAsync } = loadFresh(() =>
      Promise.reject(new Error('still visible'))
    );

    await mod.hideSplashScreen(); // failed early attempt (does not latch)
    expect(hideAsync).toHaveBeenCalledTimes(1);

    mod.armSplashWatchdog();
    jest.advanceTimersByTime(mod.SPLASH_WATCHDOG_MS);

    // Watchdog retried — the user is not stranded on the splash.
    expect(hideAsync).toHaveBeenCalledTimes(2);
  });
});

describe('isColdBootContentReady', () => {
  // Baseline: an existing-wallet cold boot lands on the Main route in normal
  // (non-signer) wallet mode. The splash must cover ALL THREE gates.
  const existingWalletMain = {
    routeResolved: true,
    isMainRoute: true,
    signerInitialized: true,
    isSignerMode: false,
    walletInitialized: true,
  };

  it('is not ready until the initial route resolves (gate 1)', () => {
    const { mod } = loadFresh();
    expect(
      mod.isColdBootContentReady({
        ...existingWalletMain,
        routeResolved: false,
      })
    ).toBe(false);
  });

  it('is not ready on Main until the remote-signer gate hydrates (gate 2)', () => {
    const { mod } = loadFresh();
    expect(
      mod.isColdBootContentReady({
        ...existingWalletMain,
        signerInitialized: false,
      })
    ).toBe(false);
  });

  // The core P2 assertion: after route + remote-signer resolve but BEFORE the
  // wallet store hydrates, the splash must NOT lift — otherwise it reveals Home's
  // "Loading wallet..." placeholder.
  it('is NOT ready on normal-wallet Main until the wallet store hydrates (gate 3)', () => {
    const { mod } = loadFresh();
    expect(
      mod.isColdBootContentReady({
        ...existingWalletMain,
        walletInitialized: false,
      })
    ).toBe(false);
  });

  it('is ready on normal-wallet Main only once all three gates resolve', () => {
    const { mod } = loadFresh();
    expect(mod.isColdBootContentReady(existingWalletMain)).toBe(true);
  });

  it('does not require the wallet gate in signer mode (no wallet placeholder)', () => {
    const { mod } = loadFresh();
    expect(
      mod.isColdBootContentReady({
        routeResolved: true,
        isMainRoute: true,
        signerInitialized: true,
        isSignerMode: true,
        walletInitialized: false, // airgap Home has no "Loading wallet..." gate
      })
    ).toBe(true);
  });

  it('is ready on a non-Main route as soon as the route resolves', () => {
    const { mod } = loadFresh();
    // Onboarding / Lock: no signer or wallet gate — requiring them would strand
    // the splash since nothing on those routes ever flips them.
    expect(
      mod.isColdBootContentReady({
        routeResolved: true,
        isMainRoute: false,
        signerInitialized: false,
        isSignerMode: false,
        walletInitialized: false,
      })
    ).toBe(true);
  });
});
