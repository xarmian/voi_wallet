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
      'react-hooks/immutability': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/preserve-manual-memoization': 'warn',
      'react-hooks/purity': 'warn',
      'react-hooks/refs': 'warn',
    },
  },
  {
    ignores: ['dist/**', 'node_modules/**', '.expo/**', 'android/**', 'ios/**'],
  },
];
