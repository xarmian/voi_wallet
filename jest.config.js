// Jest config for unit tests (Layer 1: pure utils). Uses the jest-expo preset
// so the RN/Expo module graph resolves the same way the app does.
module.exports = {
  preset: 'jest-expo',
  setupFiles: ['<rootDir>/jest.setup.js'],
  moduleNameMapper: {
    // Mirror the tsconfig `@/*` path alias.
    '^@/(.*)$': '<rootDir>/src/$1',
    // Native Nitro module — can't load under jest; force the mock (→ @noble
    // fallback in scryptKdf) so local and CI behave identically.
    '^react-native-quick-crypto$':
      '<rootDir>/__mocks__/react-native-quick-crypto.js',
    // Native module whose reachability probe calls global.fetch — which unit
    // tests replace. Force the stub; suites that need real NetInfo semantics
    // re-mock it themselves (src/platform/__tests__/connectivity.test.ts).
    '^@react-native-community/netinfo$': '<rootDir>/__mocks__/netinfo.js',
  },
  // jest-expo's default only allow-transpiles RN/Expo packages; several deps
  // these utils import ship as untranspiled ESM and must also be transformed.
  transformIgnorePatterns: [
    'node_modules/(?!(?:jest-)?react-native|@react-native(?:-community)?|expo(?:nent)?|@expo(?:nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@scure/.*|@noble/.*|algosdk|tweetnacl|@walletconnect/.*|uint8arrays|multiformats|micro-.*)',
  ],
  testMatch: ['<rootDir>/src/**/*.test.ts', '<rootDir>/src/**/*.test.tsx'],
  // Agent worktrees live under .claude/worktrees/ (gitignored). jest-haste-map
  // scans the whole rootDir, so each sibling checkout it finds re-registers
  // __mocks__/react-native-quick-crypto.js and emits "duplicate manual mock
  // found". Harmless today only because the mock above is pinned via
  // moduleNameMapper rather than haste resolution — a mock that relied on haste
  // could resolve to a sibling checkout's copy. Inert in CI (.claude/ is
  // gitignored) and correct inside a worktree, where <rootDir> is that worktree.
  modulePathIgnorePatterns: ['<rootDir>/.claude/'],
  clearMocks: true,
};
