/**
 * DR-17 (FR-374): the app keeps React Native's global `fetch`.
 *
 * Since SDK 56 Expo replaces `globalThis.fetch` with expo/fetch at startup
 * unless EXPO_PUBLIC_USE_RN_FETCH is '1' or 'true':
 *   node_modules/expo/src/winter/runtime.native.ts:35-47 (expo 58.0.6)
 *     const useRnFetch =
 *       process.env.EXPO_PUBLIC_USE_RN_FETCH === '1' || ... === 'true';
 *     if (!useRnFetch) { ... install('fetch', () => require('./fetch').fetch); }
 * For node_modules Metro inlines that value at transform time from the bundler
 * process env (babel-preset-expo build/configs/expo.js:241-245), so it must be
 * set for every build: each eas.json build profile, and the local .env.
 *
 * This suite replays the bootstrap (Expo's winter runtime, then index.ts's own
 * polyfills) with each eas.json profile's env and asserts `globalThis.fetch` is
 * still RN's implementation BY IDENTITY afterwards. The control case without the
 * flag proves the check can fail.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';

type EasBuildProfile = { env?: Record<string, string> };
const eas = JSON.parse(
  readFileSync(resolve(__dirname, '../../../eas.json'), 'utf8')
) as { build: Record<string, EasBuildProfile> };

const FLAG = 'EXPO_PUBLIC_USE_RN_FETCH';

/**
 * Replays the bootstrap with `flag` set and returns RN's fetch plus the global
 * fetch left at the end.
 *
 * RN's own fetch is installed fresh inside the isolated registry, the way
 * InitializeCore does it (react-native/Libraries/Core/setUpXHR.js:
 * `polyfillGlobal('fetch', () => require('../Network/fetch').fetch)`). It can't
 * be taken from the outer registry: under jest-expo, Expo's fetch getter is
 * already on the global by the time a test file runs, so RN's fetch module
 * would capture Expo's fetch instead of its own.
 */
function bootstrap(flag: string | undefined): {
  rnFetch: unknown;
  after: unknown;
} {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  const savedFlag = process.env.EXPO_PUBLIC_USE_RN_FETCH;
  try {
    delete (globalThis as { fetch?: unknown }).fetch;
    if (flag === undefined) delete process.env.EXPO_PUBLIC_USE_RN_FETCH;
    else process.env.EXPO_PUBLIC_USE_RN_FETCH = flag;

    let rnFetch: unknown;
    jest.isolateModules(() => {
      // 1. RN core (InitializeCore → setUpXHR).
      rnFetch = require('react-native/Libraries/Network/fetch').fetch;
      (globalThis as { fetch?: unknown }).fetch = rnFetch;
      // 2. Expo's runtime (expo/src/winter, run by `expo` before the app).
      require('expo/src/winter/runtime.native');
      // 3. The app's own polyfills (index.ts:9).
      require('../../utils/polyfills');
    });
    return { rnFetch, after: globalThis.fetch };
  } finally {
    if (saved) Object.defineProperty(globalThis, 'fetch', saved);
    if (savedFlag === undefined) delete process.env.EXPO_PUBLIC_USE_RN_FETCH;
    else process.env.EXPO_PUBLIC_USE_RN_FETCH = savedFlag;
  }
}

describe('DR-17: React Native fetch is kept', () => {
  const profiles = Object.entries(eas.build);

  it('eas.json has build profiles to check', () => {
    expect(profiles.length).toBeGreaterThan(0);
  });

  it.each(profiles)(
    `eas.json profile "%s" sets ${FLAG}=1`,
    (_name, profile) => {
      expect(profile.env?.[FLAG]).toBe('1');
    }
  );

  it.each(profiles)(
    'profile "%s": globalThis.fetch is RN fetch after bootstrap',
    (_name, profile) => {
      const { rnFetch, after } = bootstrap(profile.env?.[FLAG]);
      expect(typeof rnFetch).toBe('function');
      expect(after).toBe(rnFetch);
    }
  );

  it('control: without the flag Expo replaces RN fetch', () => {
    const { rnFetch, after } = bootstrap(undefined);
    expect(typeof rnFetch).toBe('function');
    expect(typeof after).toBe('function');
    expect(after).not.toBe(rnFetch);
  });

  it('.env.example documents the flag', () => {
    const example = readFileSync(
      resolve(__dirname, '../../../.env.example'),
      'utf8'
    );
    expect(example).toMatch(/^EXPO_PUBLIC_USE_RN_FETCH=1$/m);
  });
});
