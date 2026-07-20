/**
 * F-01 (TASK-176) regression guard for the Metro inlineRequires side-effect
 * allowlist. inlineRequires must never defer the bootstrap polyfill modules that
 * index.ts relies on running in source order (crypto polyfills BEFORE algosdk),
 * nor @walletconnect/react-native-compat. This test fails if the allowlist loses
 * a bootstrap module, or if metro.config.js stops wiring it into inlineRequires.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';

// Plain-CJS module shared with metro.config.js. require() keeps tsc from needing
// a declaration file for the root config module.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const inlineRequiresConfig = require('../../../metro.inlineRequires') as {
  NON_INLINED_REQUIRES: string[];
  METRO_BASE_NON_INLINED: string[];
  BOOTSTRAP_SIDE_EFFECT_MODULES: string[];
};
const {
  NON_INLINED_REQUIRES,
  METRO_BASE_NON_INLINED,
  BOOTSTRAP_SIDE_EFFECT_MODULES,
} = inlineRequiresConfig;

describe('Metro inlineRequires allowlist (F-01)', () => {
  it('pins every bootstrap side-effect module eager', () => {
    // These are the modules whose require-time side effects are order-sensitive.
    // Losing any one from the allowlist risks inlineRequires deferring it and
    // breaking index.ts crypto-before-algosdk ordering.
    for (const mod of [
      'react-native-get-random-values',
      'buffer',
      './src/utils/polyfills',
      '@walletconnect/react-native-compat',
    ]) {
      expect(BOOTSTRAP_SIDE_EFFECT_MODULES).toContain(mod);
      expect(NON_INLINED_REQUIRES).toContain(mod);
    }
  });

  it("re-includes Metro's base ignore list (supplying nonInlinedRequires replaces it)", () => {
    // Supplying transform.nonInlinedRequires REPLACES Metro's built-in default
    // list, so React/react-native must be re-listed or they'd become deferrable.
    for (const mod of ['React', 'react', 'react-native']) {
      expect(METRO_BASE_NON_INLINED).toContain(mod);
      expect(NON_INLINED_REQUIRES).toContain(mod);
    }
  });

  it('is wired into metro.config.js with inlineRequires enabled', () => {
    const configSource = readFileSync(
      resolve(__dirname, '../../../metro.config.js'),
      'utf8'
    );
    expect(configSource).toContain('inlineRequires: true');
    expect(configSource).toContain('nonInlinedRequires: NON_INLINED_REQUIRES');
  });
});
