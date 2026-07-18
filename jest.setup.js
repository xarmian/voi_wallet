// Crypto polyfills for the test environment, mirroring index.ts so algosdk and
// the crypto utils behave the same under jest. Buffer is required by algosdk;
// getRandomValues is provided by Node in the test runtime.
const { Buffer } = require('buffer');
if (typeof global.Buffer === 'undefined') {
  global.Buffer = Buffer;
}

// WalletConnect config (src/services/walletconnect/config.ts) throws at module
// load time if no project ID is configured. The real value comes from a .env
// file that jest does not load, so provide a harmless dummy here (setupFiles run
// before the module graph is imported) to let WalletConnect utils be unit-tested.
// Preserve a real, non-blank value if one is present; otherwise fall back to a
// dummy. (A whitespace-only value is treated as absent — config.ts trims and
// rejects blanks, so passing one through would still throw.)
const existingWcProjectId = process.env.EXPO_PUBLIC_WALLETCONNECT_PROJECT_ID;
process.env.EXPO_PUBLIC_WALLETCONNECT_PROJECT_ID =
  existingWcProjectId && existingWcProjectId.trim().length > 0
    ? existingWcProjectId
    : 'test-walletconnect-project-id';
