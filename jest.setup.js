// Crypto polyfills for the test environment, mirroring index.ts so algosdk and
// the crypto utils behave the same under jest. Buffer is required by algosdk;
// getRandomValues is provided by Node in the test runtime.
const { Buffer } = require('buffer');
if (typeof global.Buffer === 'undefined') {
  global.Buffer = Buffer;
}
