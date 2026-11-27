/**
 * The bundler refuses to start without EXPO_PUBLIC_USE_RN_FETCH.
 *
 * Metro inlines that variable into Expo's winter runtime at transform time
 * from the bundler's own environment (see rnFetchOptOut.test.ts). A bundle
 * built without it, for example an `eas update` published from a checkout
 * with no .env, silently swaps React Native's fetch for expo/fetch. The guard
 * runs when metro.config.js loads, so every bundle (dev server, export,
 * update, release embed) fails instead of shipping that swap.
 */
const { assertRnFetchFlag } = require('../../../metro.rnFetchGuard') as {
  assertRnFetchFlag: (env?: Record<string, string | undefined>) => void;
};

const FLAG = 'EXPO_PUBLIC_USE_RN_FETCH';

describe('Metro RN fetch guard', () => {
  it.each([['1'], ['true']])('accepts %s', (value) => {
    expect(() => assertRnFetchFlag({ [FLAG]: value })).not.toThrow();
  });

  it.each([[undefined], [''], ['0'], ['false'], ['yes'], [' 1']])(
    'refuses %p',
    (value) => {
      expect(() => assertRnFetchFlag({ [FLAG]: value })).toThrow(FLAG);
    }
  );

  it('reads process.env by default', () => {
    const saved = process.env.EXPO_PUBLIC_USE_RN_FETCH;
    try {
      delete process.env.EXPO_PUBLIC_USE_RN_FETCH;
      expect(() => assertRnFetchFlag()).toThrow(FLAG);
      process.env.EXPO_PUBLIC_USE_RN_FETCH = '1';
      expect(() => assertRnFetchFlag()).not.toThrow();
    } finally {
      if (saved === undefined) delete process.env.EXPO_PUBLIC_USE_RN_FETCH;
      else process.env.EXPO_PUBLIC_USE_RN_FETCH = saved;
    }
  });

  describe('metro.config.js', () => {
    function loadConfig(value: string | undefined): void {
      const saved = process.env.EXPO_PUBLIC_USE_RN_FETCH;
      try {
        if (value === undefined) delete process.env.EXPO_PUBLIC_USE_RN_FETCH;
        else process.env.EXPO_PUBLIC_USE_RN_FETCH = value;
        jest.isolateModules(() => {
          require('../../../metro.config');
        });
      } finally {
        if (saved === undefined) delete process.env.EXPO_PUBLIC_USE_RN_FETCH;
        else process.env.EXPO_PUBLIC_USE_RN_FETCH = saved;
      }
    }

    it('does not load without the flag', () => {
      expect(() => loadConfig(undefined)).toThrow(FLAG);
    });

    it('loads with the flag', () => {
      expect(() => loadConfig('1')).not.toThrow();
    });
  });
});
