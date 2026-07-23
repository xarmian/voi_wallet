// ESLint 9 flat config. Migrated from the legacy .eslintrc.js
// (extends: ['expo', 'prettier'] + prettier/prettier: error).
//
// - eslint-config-expo/flat: Expo's React Native + React + React Hooks +
//   TypeScript preset (the flat-config form of `extends: ['expo']`).
// - eslint-plugin-prettier/recommended: runs Prettier as a lint rule and
//   disables ESLint formatting rules that would conflict (replaces the old
//   `extends: ['prettier']` + `plugins: ['prettier']` + prettier/prettier rule).
const expoConfig = require('eslint-config-expo/flat');
const prettierRecommended = require('eslint-plugin-prettier/recommended');

module.exports = [
  ...expoConfig,
  prettierRecommended,
  {
    rules: {
      // TypeScript's own module resolution (tsc --noEmit) is the source of
      // truth for imports here, and eslint-plugin-import's resolver doesn't
      // understand this project's `@/*` path alias or resolve @expo/* packages
      // without extra resolver config — so it only produces false positives.
      'import/no-unresolved': 'off',

      // React Compiler is enabled (app.config.js experiments.reactCompiler).
      // eslint-plugin-react-hooks v7 ships the compiler's *advisory* rules at
      // "error", but the actual compiler compiles 185/185 components
      // (react-compiler-healthcheck, no incompatible libraries) and tolerates
      // the patterns these flag: Reanimated `SharedValue.value = …` writes,
      // forward-referenced effect helpers (no runtime TDZ), and manual
      // memoization it can't statically prove. Keep them as WARN — visible
      // optimization hints that don't block the error gate. Genuine
      // Rules-of-React bugs these caught were fixed in code (WC param mutation,
      // mnemonic reshuffle, derivable setStates). rules-of-hooks and
      // error-boundaries stay at ERROR — those are real correctness bugs.
      //
      // MIGRATION POLICY (not permanent): as the codebase is cleaned up, tighten
      // these back toward `error` per-rule — the cheap wins first (purity,
      // set-state-in-effect where genuinely derivable), leaving immutability at
      // warn for as long as Reanimated `.value` writes trip it.
      //
      // These are `warn`, not `off`, because `npm run lint` runs under a
      // ratchet: `--max-warnings` is pinned to the count in lint-baseline.json,
      // so a new warning fails CI and the ceiling only ever moves down. Counts
      // are regenerated with `npm run lint:baseline` — see CONTRIBUTING.md.
      'react-hooks/immutability': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/preserve-manual-memoization': 'warn',
      'react-hooks/purity': 'warn',
      'react-hooks/refs': 'warn',

      // Unused-variable hygiene. eslint-config-expo/flat/utils/typescript.js
      // already configures this rule as { vars:'all', args:'none',
      // ignoreRestSiblings:true, caughtErrors:'all' }; ESLint replaces rule
      // options wholesale rather than merging, so those four are repeated here
      // verbatim and MUST stay in sync with the preset.
      //
      // Added: the `^_` escape-hatch patterns, as a FORWARD-LOOKING convention.
      // They clear ZERO warnings today — the codebase currently has no
      // `_`-prefixed unused variable, caught error, or destructured-array
      // element (verified by regenerating lint-baseline.json: no-unused-vars is
      // unchanged by this block). They exist so new code can opt a genuinely
      // unused binding out of the rule — `catch (_e)`, `const [_unused, setX]`,
      // `const _throwaway = …` — instead of accreting one-off inline disables.
      //
      // Deliberately NO `argsIgnorePattern`. The preset sets `args: 'none'`, so
      // unused PARAMETERS are already invisible to the rule; an argsIgnorePattern
      // would match nothing and clear 0 warnings, while giving the false
      // impression that parameter hygiene is enforced. WARNING: anyone who later
      // flips `args` to `'after-used'` to "tighten" this would unmask an entire
      // unmeasured wave of unused-parameter warnings across every callback in the
      // codebase — re-baseline first, do not treat it as a no-op tweak.
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          vars: 'all',
          args: 'none',
          ignoreRestSiblings: true,
          caughtErrors: 'all',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    // Test files: jest globals, and allow jest.mock() calls above the imports
    // they hoist over (which otherwise trips import/first).
    files: ['**/*.test.ts', '**/*.test.tsx', '**/__tests__/**'],
    languageOptions: {
      globals: {
        describe: 'readonly',
        it: 'readonly',
        test: 'readonly',
        expect: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        beforeAll: 'readonly',
        afterAll: 'readonly',
        jest: 'readonly',
      },
    },
    rules: {
      'import/first': 'off',
      // Tests import default exports (services/stores) to jest.mock them.
      'import/no-named-as-default': 'off',
      // Tests legitimately use require(): jest hoists jest.mock() factories above
      // the import block and forbids them from closing over out-of-scope imports,
      // so require() inside a factory is the only legal form; other specs stub or
      // late-bind a module with require() to control load order. Turning the rule
      // off here (rather than a `src/services/secure/**` carve-out) covers ALL of
      // those — including every no-require-imports hit under
      // src/services/secure/__tests__/, where the ONLY require sites live —
      // without disarming the rule over production key/mnemonic/signing code,
      // which has zero require sites of its own.
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    // Platform-adapter require()s (PLAN-12 DR-7). These three modules bridge the
    // React Native app and the browser-extension build and pick an implementation
    // at RUNTIME behind a platform guard —
    // `isMobile() ? require('./mobile/X') : require('./extension/X')`. The two
    // sides pull in mutually exclusive host deps (e.g. platform/mobile/
    // secureStorage.ts imports expo-secure-store, while platform/extension/
    // secureStorage.ts uses chrome.storage), so a static `import` of both would
    // eagerly load a module that cannot resolve on the other platform. require()
    // behind the guard is the intended pattern here, not debt — scope the rule
    // off to exactly these files (polyfills.ts likewise late-requires its
    // ponyfills so a native/global-present environment can skip them).
    files: [
      'src/platform/index.ts',
      'src/platform/detection.ts',
      'src/utils/polyfills.ts',
    ],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    ignores: ['dist/**', 'node_modules/**', '.expo/**', 'android/**', 'ios/**'],
  },
];
