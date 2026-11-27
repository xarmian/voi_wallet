/**
 * The app keeps React Native's global `fetch`. Since SDK 56, Expo's winter
 * runtime (node_modules/expo/src/winter/runtime.native.ts) replaces it with
 * expo/fetch unless EXPO_PUBLIC_USE_RN_FETCH is '1' or 'true'. Metro inlines
 * that value from the bundler's environment when it transforms node_modules,
 * so a bundle built without it (a dev server, `expo export`, `eas update`, or a
 * release build's embedded bundle) silently ships expo/fetch.
 *
 * metro.config.js calls this before anything else, so every bundle without
 * the flag fails to start instead. Set it in .env (see .env.example) or in
 * the build profile's env in eas.json.
 */
const FLAG = 'EXPO_PUBLIC_USE_RN_FETCH';

function assertRnFetchFlag(env = process.env) {
  const value = env[FLAG];
  // The same two values Expo's runtime accepts.
  if (value === '1' || value === 'true') return;
  throw new Error(
    `${FLAG} must be set to 1 for every bundle (found ${JSON.stringify(value)}). ` +
      "Without it Expo replaces React Native's fetch with expo/fetch. " +
      'Set it in .env (see .env.example) or in the eas.json build profile.'
  );
}

module.exports = { assertRnFetchFlag };
