const { getDefaultConfig } = require('expo/metro-config');
const { NON_INLINED_REQUIRES } = require('./metro.inlineRequires');
const { createDevOnlyResolver } = require('./metro.devOnlyResolver');

const config = getDefaultConfig(__dirname);

// Add polyfills for Node.js modules needed by algosdk and wallet tooling
config.resolver.alias = {
  ...(config.resolver.alias || {}),
  stream: 'readable-stream',
  buffer: 'buffer',
};

// Ensure these modules are resolved
config.resolver.platforms = ['native', 'web', 'default'];

// DR-18 (FR-374): release bundles (dev=false) get an empty module for anything
// under src/dev/ (the dev-only crypto self-test). Every other request, and
// every request in a dev bundle, goes to the upstream resolver unchanged.
// See ./metro.devOnlyResolver.js.
config.resolver.resolveRequest = createDevOnlyResolver(
  __dirname,
  config.resolver.resolveRequest
);

// F-01 (TASK-176): enable Metro inline requires so per-module factories evaluate
// on first use instead of eagerly at cold boot, cutting time-to-first-frame.
// Expo SDK 54 ships this OFF (inlineRequires:false, ExpoMetroConfig.js:319-323);
// experimentalImportSupport is already ON in Expo's default, so we preserve it
// and flip inlineRequires on.
//
// CRITICAL: inlineRequires must NOT defer bootstrap side-effect modules whose
// evaluation order is load-bearing — index.ts installs the crypto polyfills
// BEFORE anything that touches algosdk, and client.ts side-effect-imports
// @walletconnect/react-native-compat. `nonInlinedRequires` pins those eager.
// NOTE: supplying this array REPLACES Metro's built-in default ignore list, so
// NON_INLINED_REQUIRES re-includes Metro's base entries (React/react-native/…).
// See ./metro.inlineRequires.js for the allowlist + rationale.
config.transformer.getTransformOptions = async () => ({
  transform: {
    experimentalImportSupport: true,
    inlineRequires: true,
    nonInlinedRequires: NON_INLINED_REQUIRES,
  },
});

module.exports = config;
