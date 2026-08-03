/**
 * `@react-native-community/netinfo` stub for jest (TASK-191).
 *
 * NetInfo is a NATIVE module. Loading the real one under jest starts its
 * internal reachability probe, which calls `global.fetch` — and unit tests
 * routinely replace `global.fetch` with a mock that knows nothing about
 * NetInfo, producing failures inside node_modules that have nothing to do with
 * the test. This became reachable when the offline gate
 * (src/services/network/offline.ts) started priming the connectivity adapter
 * lazily from shared service code.
 *
 * Pinned via `moduleNameMapper` rather than haste resolution, matching
 * react-native-quick-crypto, so a sibling worktree's copy can never win.
 *
 * Reports a plain online state and never emits, so the gate reads `online`
 * (never `offline`) and no test is gated by accident. Tests that need real
 * NetInfo semantics mock it themselves — see
 * src/platform/__tests__/connectivity.test.ts.
 */

const state = {
  isConnected: true,
  isInternetReachable: true,
  type: 'wifi',
};

const netInfo = {
  fetch: () => Promise.resolve({ ...state }),
  addEventListener: () => () => {},
  refresh: () => Promise.resolve({ ...state }),
  configure: () => {},
  useNetInfo: () => ({ ...state }),
};

module.exports = {
  __esModule: true,
  default: netInfo,
  ...netInfo,
};
