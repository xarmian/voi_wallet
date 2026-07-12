module.exports = function (api) {
  // The config now depends on the build environment (we only strip console.* in
  // production), so the cache key must vary by env. Using api.cache(true) would
  // freeze the first-seen env and mis-apply the console-strip plugin for later
  // builds, so key the cache on the resolved env instead.
  api.cache.using(
    () => process.env.BABEL_ENV || process.env.NODE_ENV || 'development'
  );

  const isProd =
    (process.env.BABEL_ENV || process.env.NODE_ENV) === 'production';

  return {
    // babel-preset-expo auto-adds react-native-worklets/plugin when the package
    // is installed (see babel-preset-expo index.js), and — with
    // experiments.reactCompiler enabled — inserts babel-plugin-react-compiler
    // BEFORE it. Do NOT also add the worklets plugin manually here: a top-level
    // plugin runs before the preset (so before the compiler), which is the wrong
    // order for the React Compiler + Reanimated worklets.
    presets: ['babel-preset-expo'],
    // Production-only: strip console.* from release bundles to keep app logs
    // (which can carry addresses/amounts/URIs) out of shipped builds. Preserve
    // console.error/console.warn for crash diagnostics. transform-remove-console
    // is a plain AST transform applied as a top-level plugin and does not affect
    // the preset's worklets/compiler plugin ordering described above.
    plugins: isProd
      ? [
          [
            'babel-plugin-transform-remove-console',
            { exclude: ['error', 'warn'] },
          ],
        ]
      : [],
  };
};
