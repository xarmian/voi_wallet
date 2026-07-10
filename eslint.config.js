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
    },
  },
  {
    ignores: ['dist/**', 'node_modules/**', '.expo/**', 'android/**', 'ios/**'],
  },
];
