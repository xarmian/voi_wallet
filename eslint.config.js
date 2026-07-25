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
      // eslint-plugin-react-hooks v7 ships the compiler's *advisory* Rules-of-React
      // diagnostics at "error"; several fire on patterns that are correct in this
      // codebase, so they are held at `warn` — visible and ratcheted (see the
      // --max-warnings pin below) rather than blocking the error gate. rules-of-
      // hooks and error-boundaries stay at their preset ERROR — those are real
      // correctness bugs. Genuine Rules-of-React bugs these advisory rules caught
      // were fixed in code, not silenced (WC param mutation, mnemonic reshuffle,
      // derivable setStates).
      //
      // EVERY COUNT BELOW IS REGENERABLE. The per-rule totals (96 / 37 / 25) are
      // the `rules` object in lint-baseline.json — run `npm run lint:baseline` and
      // read them. The structural sub-splits are recovered from the diagnostic
      // text with `npx eslint src/ -f json` grouped by message. No number here is
      // hand-carried. (The former "185/185 components (react-compiler-healthcheck)"
      // justification was STRUCK in TASK-248: that tool is in neither package.json
      // nor node_modules and no script runs it, so nobody could reproduce it.)
      //
      // react-hooks/immutability = 96 — all structural, two diagnostics under one
      // id:
      //   • 58 "This value cannot be modified" — Reanimated `useSharedValue().value
      //     = …` writes in callbacks / worklets / effects. Never during render,
      //     never React-owned state: the Reanimated SharedValue API working as
      //     designed. Stays at `warn` for as long as that API trips the rule.
      //   • 38 "Cannot access variable before it is declared" — forward-referenced
      //     deferred helper consts (a hook body referencing a `const` declared
      //     lower in the same scope, only ever invoked after mount). Runtime-safe:
      //     the reference executes after declaration, so no TDZ hit.
      //
      // react-hooks/set-state-in-effect = 37 — effect-driven setState, none a
      //   correctness bug. Two shapes (inspect the sites via `npx eslint src/ -f
      //   json`): (a) async-loader effects — `useEffect(() => { load().then(
      //   setState) }, [dep])`, the canonical RN data-fetch pattern (e.g.
      //   ThemeContext loadThemeData, the screen data loaders); the value is
      //   fetched, genuinely not derivable during render. (b) synchronous
      //   initialize / reset-on-transition effects — seeding or clearing local
      //   state when a prop / visibility / data input changes (e.g. resetting a
      //   modal's fields when it opens, UnifiedAuthModal / AssetOptInModal; seeding
      //   AccountAvatar from its account prop; SendScreen defaulting the asset id).
      //   These ARE refactorable — remounting via a `key`, or lifting/restructuring
      //   the state — so they are a retained pattern, not an immovable one; kept at
      //   `warn` because each is correct as written and the restructure is churn
      //   this PR does not take on, NOT because it is impossible. (This category
      //   was absent from the plan's original ~128 floor estimate — it is the
      //   correction from the PLAN-229 exit-gate reconciliation.)
      //
      // react-hooks/preserve-manual-memoization = 25 — all structural: React
      //   Compiler bail-outs ("Compilation Skipped: Existing memoization could not
      //   be preserved"). The compiler announces it SKIPPED optimizing a component
      //   and emits the source unchanged, so the hand-written useMemo/useCallback
      //   survives intact — zero correctness risk. Not evidence of successful
      //   compilation, just of a component the compiler declined.
      //
      // These stay `warn`, not `off`, because `npm run lint` runs under a ratchet:
      // `--max-warnings` is pinned to lint-baseline.json's total, so a new warning
      // fails CI and the ceiling only ever moves down. Regenerate with
      // `npm run lint:baseline`.
      //
      // MIGRATION POLICY: as each advisory rule reaches 0 it is promoted back to
      // `error` in a separate post-soak PR (DR-7). purity and refs were cleared to
      // 0 by TASK-242 and promoted to `error` below in TASK-248. The three above
      // remain at `warn` because their residual is structural, not debt.
      'react-hooks/immutability': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/preserve-manual-memoization': 'warn',
      // Promoted warn → error in TASK-248 (DR-7, post-soak) — both were cleared to
      // 0 by TASK-242 and have soaked on main. FIVE documented inline disables keep
      // the reported counts at 0, so `npm run lint` stays green with the rules at
      // `error` (each disable carries its full rationale at the site):
      //   refs (2): AuthContext.tsx:204 — render-body ref mirror, the inactivity-
      //     lock source of truth; deferring it into an effect reopens a suspend-
      //     before-commit lock-BYPASS window. VerifyBackupScreen.tsx:80 —
      //     account-guard write-then-read latch pinned on first render, backed by a
      //     real test.
      //   purity (3): SignerAuthModal.tsx:182 — `Date.now()` inside an async submit
      //     handler (not render). FriendListItem.tsx:32 and
      //     MessagesInboxScreen.tsx:305 — intentional coarse relative-time wall-
      //     clock reads in a list-row render, re-rendered on data/focus.
      // If either rule ever reports > 0, a real site regressed — fix the site, do
      // not downgrade the rule. (Line numbers drift; re-locate the full set with
      // `grep -rn "eslint-disable.*react-hooks/\(purity\|refs\)" src/`.)
      'react-hooks/purity': 'error',
      'react-hooks/refs': 'error',

      // import/no-named-as-default — turned OFF in TASK-248 after re-measurement.
      // The rule fires when a default import's local name matches one of the same
      // module's named exports. The ONE genuine named-vs-default ambiguity it ever
      // caught here — services/network/index.ts default-exporting an *instance*
      // while aliasing the *class* as `VoiNetworkService`, imported inconsistently
      // by utils/address.ts vs store/walletStore.ts — was disambiguated by a rename
      // in TASK-253 (PR #166) and no longer appears in the report.
      //
      // The residual after that fix — measured while the rule was still on — is 30
      // production hits + 2 test-file hits, ALL the idiomatic default-export
      // pattern this rule flags as a false positive:
      //   • 11 (production) the `export default SomeClass.getInstance()` singleton
      //     convention (mimir, messaging, price, algorand-price, snowball,
      //     rekeyManager, auth-account-discovery): the default is the shared
      //     instance, the named class export exists for typing/tests, and consumers
      //     deliberately want the instance.
      //   • 19 (production) where the default IS the named binding — `export class
      //     EnvoiService` + `export default EnvoiService` (envoi; the React
      //     components DeviceDiscovery / AccountImport / AirgapVerificationFlow);
      //     plus the third-party `@walletconnect/universal-provider`, whose named
      //     `UniversalProvider` is a `typeof` alias of its default `Provider`.
      //     Default and named resolve to the same value — zero ambiguity.
      //   • 2 (test) jest default imports of the same singletons/bindings to mock
      //     or use them (AlgorandPriceService, EnvoiService) — the pattern the
      //     former test-scoped override existed for.
      // None is a real named-vs-default mix-up, so the rule now yields only noise.
      // Re-confirm before adding new default-exported classes with the command
      // below — it reports 32 (= 30 production + 2 test) because `--rule` forces the
      // rule on everywhere, including the test files the config no longer suppresses
      // separately:
      //   npx eslint src/ --rule '{"import/no-named-as-default":"warn"}'
      'import/no-named-as-default': 'off',

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
      // (import/no-named-as-default is off globally as of TASK-248, so the former
      // test-scoped override for jest.mock default imports is no longer needed.)
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
