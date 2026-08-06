/**
 * `@txnlab/deflex` stub for jest.
 *
 * The package is ESM-only — its package.json `exports` map declares just
 * `import`/`types` with no `require` condition — so jest-expo's CJS resolver
 * cannot load it and throws "Cannot find module '@txnlab/deflex'". Because
 * src/services/swap/index.ts imports src/services/deflex/index.ts eagerly (to
 * register the Algorand provider), that failure blocked ANY test that touched
 * the unified swap service, which is why the Snowball adapter had no coverage
 * when the quote regression landed.
 *
 * Pinned via `moduleNameMapper` rather than haste resolution, matching netinfo
 * and react-native-quick-crypto, so a sibling worktree's copy can never win.
 *
 * The stub only has to satisfy the import: the Deflex provider is a separate
 * code path (Algorand), and no test drives it. A suite that does should mock
 * DeflexClient itself with the behaviour it needs.
 */

class DeflexClient {
  constructor() {
    throw new Error(
      'DeflexClient is stubbed under jest (@txnlab/deflex is ESM-only). ' +
        'Mock it explicitly in the suite that needs it.'
    );
  }
}

module.exports = {
  __esModule: true,
  DeflexClient,
};
