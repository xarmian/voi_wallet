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

  // TEST-ENV ONLY: rewrite dynamic `import(x)` -> `Promise.resolve().then(() =>
  // require(x))`. Under jest, `babel-preset-expo` reports
  // `supportsDynamicImport: true`, so it leaves `import()` as a native VM import;
  // but jest's CommonJS runtime provides no dynamic-import callback, so any
  // source that executes `await import(...)` throws
  // ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING_FLAG. Lowering it to `require()` keeps
  // jest's module registry (and `jest.mock`) in charge, matching how static
  // imports already resolve. This is the zero-dependency equivalent of
  // `babel-plugin-dynamic-import-node`. It is scoped to `env.test` (jest sets
  // NODE_ENV=test), so production and dev/Metro bundles are byte-identical and
  // keep native `import()` for real code-splitting.
  const dynamicImportToRequire = ({ types: t }) => ({
    name: 'test-dynamic-import-to-require',
    visitor: {
      CallExpression(path) {
        if (!t.isImport(path.node.callee)) return;
        const source = path.node.arguments[0];
        path.replaceWith(
          t.callExpression(
            t.memberExpression(
              t.callExpression(
                t.memberExpression(
                  t.identifier('Promise'),
                  t.identifier('resolve')
                ),
                []
              ),
              t.identifier('then')
            ),
            [
              t.arrowFunctionExpression(
                [],
                t.callExpression(t.identifier('require'), [source])
              ),
            ]
          )
        );
      },
    },
  });

  return {
    env: {
      test: {
        plugins: [dynamicImportToRequire],
      },
    },
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
