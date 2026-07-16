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
  },
  // jest-expo's default only allow-transpiles RN/Expo packages; several deps
  // these utils import ship as untranspiled ESM and must also be transformed.
  transformIgnorePatterns: [
    'node_modules/(?!(?:jest-)?react-native|@react-native(?:-community)?|expo(?:nent)?|@expo(?:nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@scure/.*|@noble/.*|algosdk|tweetnacl|@walletconnect/.*|uint8arrays|multiformats|micro-.*)',
  ],
  testMatch: ['<rootDir>/src/**/*.test.ts', '<rootDir>/src/**/*.test.tsx'],
  clearMocks: true,
};
