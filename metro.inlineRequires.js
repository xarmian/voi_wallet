// F-01 (TASK-176) — inlineRequires side-effect allowlist.
//
// When metro.config.js supplies `transform.nonInlinedRequires`, it REPLACES
// Metro's built-in default list (metro/src/lib/transformHelpers.js
// `baseIgnoredInlineRequires`) rather than extending it. So this array must
// re-include Metro's base entries AND add the app's bootstrap side-effect
// modules that must never be deferred.
//
// Shared between metro.config.js (the real bundler config) and its regression
// test so the two can never drift.

// Metro's own defaults — re-listed because supplying nonInlinedRequires drops
// them. React/react-native are referenced from nearly every module and must not
// be inline-deferred.
const METRO_BASE_NON_INLINED = [
  'React',
  'react',
  'react/jsx-dev-runtime',
  'react/jsx-runtime',
  'react-compiler-runtime',
  'react-native',
];

// Bootstrap / side-effect polyfill modules whose evaluation ORDER is
// load-bearing. index.ts installs the crypto polyfills BEFORE anything that
// touches algosdk; @walletconnect/react-native-compat installs WC globals.
// inlineRequires must keep these eager so require-time side effects still run in
// source order. See index.ts (2/3/9) and src/services/walletconnect/client.ts:3.
const BOOTSTRAP_SIDE_EFFECT_MODULES = [
  'react-native-get-random-values', // index.ts:2 — crypto.getRandomValues polyfill
  'buffer', // index.ts:3 — global.Buffer for algosdk
  './src/utils/polyfills', // index.ts:9 — atob/btoa/TextEncoder/streams/url polyfills
  '@walletconnect/react-native-compat', // client.ts:3 — WalletConnect RN globals
];

const NON_INLINED_REQUIRES = [
  ...METRO_BASE_NON_INLINED,
  ...BOOTSTRAP_SIDE_EFFECT_MODULES,
];

module.exports = {
  NON_INLINED_REQUIRES,
  METRO_BASE_NON_INLINED,
  BOOTSTRAP_SIDE_EFFECT_MODULES,
};
